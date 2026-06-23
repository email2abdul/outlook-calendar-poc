'use strict';

const physiciansDir = require('./physicians');
const entityMatcher = require('./entity-matcher');
const crm = require('./crm-store');
const intelStore = require('./email-intel-store');
const intelExtractor = require('./intel-extractor');
const supabase = require('./supabase');

/**
 * Email Intelligence brain (feature/old-email-read).
 *
 * Turns one ingested Outlook email into a flat "sheet" row in app_email_intel:
 * who the physician/facility is, the meeting it relates to (date + with whom),
 * and — added in step 2 — the CPT/other business points the email mentions plus
 * which of those are NEW vs the bis_* master data.
 *
 * Scope: physician-related mail only. If we can't tie an email to a physician
 * (sender, subject entity-match, or a linked activity), we skip it — keeps the
 * sheet clean of newsletters/noise.
 *
 * Used by BOTH the one-off backfill (scripts/intel-backfill.js) and the live
 * ingest tick, so the sheet seeds the recent window and then keeps growing.
 */

/**
 * Resolve the physician an email concerns, most reliable first:
 *  1) the sender, if a physician is replying from their own address,
 *  2) an entity match on the subject (+ a little body), since briefing/meeting
 *     mail carries the physician name.
 * @returns {{npi:string|null, physician:object|null}}
 */
async function resolvePhysician(msg) {
  const sender = msg.fromEmail ? physiciansDir.getByEmail(msg.fromEmail) : null;
  if (sender) return { npi: sender.npi, physician: sender };

  const text = [msg.subject, (msg.bodyText || '').slice(0, 400)].filter(Boolean).join('. ');
  if (text.trim()) {
    try {
      const analysis = await entityMatcher.analyze(text);
      const m = analysis.matched_entities.find((x) => x.entity_type === 'person');
      if (m) {
        const physician = physiciansDir.getByNpi(m.master_id);
        if (physician) return { npi: physician.npi, physician };
      }
    } catch {
      /* matcher failure → unresolved */
    }
  }
  return { npi: null, physician: null };
}

/** The meeting (app_activity) this email relates to: by thread, else by subject. */
async function resolveMeeting(ownerUserId, msg) {
  if (!crm.enabled) return null;
  try {
    return (
      (await crm.findActivityByThread(ownerUserId, msg.threadId)) ||
      (await crm.findActivityBySubject(ownerUserId, msg.subject))
    );
  } catch {
    return null;
  }
}

/**
 * Build the base intel row for one message (step 1: identity + meeting context;
 * the AI CPT/other-notes + new-to-db cross-check are layered on in step 2).
 * Returns null for non-physician mail (skipped).
 */
async function buildRow({ msg, user }) {
  if (!msg.providerMsgId) return null;

  const { npi, physician } = await resolvePhysician(msg);
  const meeting = await resolveMeeting(user.homeAccountId, msg);

  // Physician-related only: need either a resolved physician or a linked meeting.
  if (!physician && !meeting?.physician_npi) return null;

  const resolvedNpi = npi || meeting?.physician_npi || null;
  const resolvedPhysician = physician || (resolvedNpi ? physiciansDir.getByNpi(resolvedNpi) : null);

  const withWhom =
    resolvedPhysician?.name || meeting?.title || msg.fromName || msg.fromEmail || null;

  return {
    provider_msg_id: msg.providerMsgId,
    provider: 'outlook',
    owner_user_id: user.homeAccountId,
    physician_npi: resolvedNpi,
    physician_name: resolvedPhysician?.name || null,
    facility_name: resolvedPhysician?.facility?.name || null,
    cpt_items: [],
    other_notes: [],
    new_to_db: [],
    meeting_date: meeting?.meeting_date || (msg.receivedAt ? msg.receivedAt.slice(0, 10) : null),
    meeting_datetime: msg.receivedAt || null,
    with_whom: withWhom,
    email_subject: msg.subject || null,
    received_at: msg.receivedAt || null,
    extracted: false,
  };
}

// ── DB cross-check (the "what's new vs my data" part) ────────────────────────

/** The set of CPT codes bis_procedure_volumes has for one physician. */
async function physicianCptSet(npi) {
  const set = new Set();
  if (!supabase || !npi) return set;
  try {
    const { data } = await supabase
      .from('bis_procedure_volumes')
      .select('cpt_code')
      .eq('physician_npi', String(npi));
    for (const r of data || []) if (r.cpt_code) set.add(String(r.cpt_code).trim());
  } catch {
    /* table unreachable → empty set (everything reads as new) */
  }
  return set;
}

/** True if a facility by (roughly) this name exists in bis_facilities. */
async function facilityInDb(name) {
  if (!supabase || !name) return false;
  const needle = String(name).replace(/[%_]/g, '').trim().slice(0, 40);
  if (!needle) return false;
  try {
    const { data } = await supabase
      .from('bis_facilities')
      .select('id')
      .ilike('name', `%${needle}%`)
      .limit(1);
    return Boolean(data?.[0]);
  } catch {
    return false;
  }
}

/** Resolve a physician NAME (from the email body) to a directory NPI, or null. */
async function resolveNameToNpi(name) {
  if (!name?.trim()) return null;
  try {
    const analysis = await entityMatcher.analyze(name);
    const m = analysis.matched_entities.find((x) => x.entity_type === 'person');
    return m ? m.master_id : null;
  } catch {
    return null;
  }
}

/**
 * AI pass: extract physician/facility/CPT/notes from the body, prefer the
 * physician the email is ABOUT over the sender, and flag every value the email
 * has that bis_* does NOT (the "new to my database" data). Mutates and returns
 * `row`. No-op (row unchanged, extracted stays false) when AI is disabled.
 */
async function enrich(row, { cleanedBody, msg }) {
  if (!intelExtractor.enabled || !cleanedBody) return row;

  const insight = await intelExtractor.extract({
    bodyText: cleanedBody,
    subject: msg.subject,
    fromName: msg.fromName,
  });
  if (!insight) return row;

  const newToDb = [];

  // Physician the email is about — prefer it over the sender-resolved one.
  const aiName = (insight.physician_name || '').trim();
  if (aiName) {
    const contentNpi = await resolveNameToNpi(aiName);
    if (contentNpi) {
      const cp = physiciansDir.getByNpi(contentNpi);
      row.physician_npi = contentNpi;
      row.physician_name = cp?.name || aiName;
      if (cp?.facility?.name) row.facility_name = cp.facility.name;
    } else {
      // Named physician isn't in our directory → keep the name but drop the
      // sender's NPI so name + NPI don't refer to different people. (The sender
      // is still captured in with_whom.)
      row.physician_name = aiName;
      row.physician_npi = null;
      newToDb.push(`Physician "${aiName}" — not in directory`);
    }
  }

  // Facility — prefer what the email states; flag if not in bis_facilities.
  const aiFacility = (insight.facility_name || '').trim();
  if (aiFacility) {
    row.facility_name = aiFacility;
    if (!(await facilityInDb(aiFacility))) newToDb.push(`Facility "${aiFacility}" — not in DB`);
  }

  // CPT items — flag any code this physician doesn't have in bis_procedure_volumes.
  row.cpt_items = Array.isArray(insight.cpt_items) ? insight.cpt_items : [];
  const cptSet = await physicianCptSet(row.physician_npi);
  for (const item of row.cpt_items) {
    const code = (item?.code || '').trim();
    if (!code) continue;
    if (!cptSet.has(code)) {
      const label = item.description ? `${code} (${item.description})` : code;
      newToDb.push(
        row.physician_npi
          ? `CPT ${label} — not in this physician's DB volumes`
          : `CPT ${label} — physician unresolved, not verified`
      );
    }
  }

  row.other_notes = Array.isArray(insight.other_notes) ? insight.other_notes : [];
  row.new_to_db = newToDb;
  row.extracted = true;
  return row;
}

/**
 * Process one message into the sheet (upsert). Builds the identity/meeting row,
 * applies the AI enrichment + DB cross-check when available, then upserts once.
 * Best-effort: returns 'skipped' | 'saved' | 'error'.
 */
async function processMessage({ msg, user, cleanedBody }) {
  if (!intelStore.enabled) return 'skipped';
  try {
    const row = await buildRow({ msg, user });
    if (!row) return 'skipped';
    await enrich(row, { cleanedBody, msg });
    await intelStore.upsertIntel(row);
    return 'saved';
  } catch (err) {
    console.warn('[email-intel] process failed:', err.message);
    return 'error';
  }
}

module.exports = {
  resolvePhysician,
  resolveMeeting,
  buildRow,
  enrich,
  processMessage,
  physicianCptSet,
  facilityInDb,
};
