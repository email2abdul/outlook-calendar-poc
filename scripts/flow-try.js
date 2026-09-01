'use strict';

require('dotenv').config();

const physicians = require('../src/physicians');
const meetingMatch = require('../src/meeting-match');
const sources = require('../src/outside-sources');
const score = require('../src/outside-sources/score');
const assembleProfile = require('../src/outside-sources/profile');
const store = require('../src/outside-physician-store');
const graph = require('../src/graph');
const enrichment = require('../src/enrichment');
const analytics = require('../src/analytics');
const contactsStore = require('../src/contacts-store');
const verify = require('../src/enrichment/verify');

/**
 * Drive the WHOLE "who is this meeting with" flow from the command line.
 *
 *   npm run flow:try -- "Meeting with Dr John Abernathy"
 *   npm run flow:try -- "Case obs with Dr Aaron Baas"
 *   npm run flow:try -- "Review NPI 1003000126"
 *   npm run flow:try -- "Endoscopy sync" --email nshaheen@med.unc.edu
 *   npm run flow:try -- "Meeting with Dr Khan" --city Houston --state TX --save
 *
 * Why this exists: every other way of seeing this flow needs a Microsoft
 * sign-in (the calendar) and a browser. This needs neither — it builds the same
 * normalized event the Graph client would, runs the same ladder the day view
 * runs, asks the same public sources, renders the same brief, and (with --save)
 * writes the same decision row. So the flow can be watched end to end, on real
 * data, before any of that is wired up — and diagnosed when it misbehaves.
 *
 * Flags:
 *   --email <addr>   add an attendee, as an invite would
 *   --city / --state hints the meeting would otherwise carry in its title
 *   --taxonomy <t>   e.g. "Dentist" — what NPPES calls the primary taxonomy
 *   --address <a>    e.g. "200 CASENTINI ST" — the primary practice address
 *   --zip / --phone  the other two fields that separate same-named providers
 *   --body <text>    put anything in the meeting description instead of a flag
 *   --save           write the decision (Supabase if the table exists, else SQLite)
 *   --brief          print the whole brief as text, not just its shape
 *
 * Anything the meeting TEXT mentions counts on its own — "Dr Aagaard (Dentist)"
 * needs no --taxonomy — because the scorer looks for each candidate's own values
 * in the meeting rather than trying to parse fields out of a title.
 */

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1] || true;
};
const title = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true)[0];

const REP = process.env.FLOW_REP_EMAIL || 'rep@lumendi-example.com';
const line = (n = 74) => console.log('─'.repeat(n));
const h = (s) => {
  line();
  console.log(s);
  line();
};

/** The same shape src/graph.js normalizeEvent produces. */
function buildEvent() {
  const email = flag('email');
  return {
    id: `FLOW-${Date.now()}`,
    title: title || 'Meeting with Dr John Abernathy',
    start: new Date(Date.now() + 3600_000).toISOString().replace(/\.\d+Z$/, ''),
    end: new Date(Date.now() + 7200_000).toISOString().replace(/\.\d+Z$/, ''),
    timeZone: 'UTC',
    isAllDay: false,
    type: 'singleInstance',
    seriesMasterId: null,
    location: null,
    description: flag('body') || null,
    organizer: { name: 'Sales Rep', email: REP },
    attendees:
      typeof email === 'string'
        ? [{ name: flag('name') || null, email, type: 'required', response: 'none' }]
        : [],
    onlineMeetingUrl: null,
    webLink: null,
  };
}

const asText = (html) =>
  String(html || '')
    .replace(/<\/(p|tr|table|h3)>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();

async function main() {
  await physicians.ready;

  const ev = buildEvent();
  h(`MEETING  "${ev.title}"${ev.attendees.length ? `  ·  attendee: ${ev.attendees[0].email}` : ''}`);
  console.log(`directory: ${physicians.getAllPhysicians().length} physicians  ·  decisions stored in: ${store.backendName()}`);

  // ── The ladder, exactly as the day view runs it ────────────────────────────
  const match = meetingMatch.matchMeeting(ev, { selfEmail: REP });
  h('LADDER');
  console.log(`status : ${match.status}${match.via ? `  (via ${match.via})` : ''}`);
  if (match.npi) console.log(`npi    : ${match.npi} (written on the meeting)`);
  if (match.nameIncomplete) {
    const which = {
      first: 'the FIRST name is missing',
      last: 'the LAST name is missing',
      unknown: 'the full name is not written out',
    }[match.nameIncomplete.missing];
    console.log(`⚠️  half a name: “${match.nameIncomplete.name}” — ${which}`);
  }
  console.log(`reason : ${match.reason}`);
  for (const p of match.physicians) {
    console.log(`✅ resolved: ${p.name} (NPI ${p.npi}) · ${p.specialty || 'no specialty'} · ${p.facility?.name || 'no facility'}`);
  }
  for (const g of match.groups || []) {
    if (!g.candidates.length) continue;
    console.log(`\nBIS candidates for “${g.name}” — ${g.total} total, showing ${g.candidates.length}:`);
    for (const c of g.candidates) {
      console.log(`   · ${c.name} · ${c.specialty || '—'} · ${c.facility?.city || '?'}, ${c.facility?.state || '?'} · NPI ${c.npi}`);
    }
  }

  // A physician the master holds gets the STANDARD brief — the same one the
  // email and the meeting body carry. Printing it here is the point of the
  // exercise: "in Supabase" has to mean "all the details are there".
  if (match.status === 'matched' && match.physicians.length) {
    for (const card of match.physicians) {
      const p = physicians.getByNpi(card.npi);
      const [a, contact, verification] = await Promise.all([
        analytics.getLabelledAnalytics(p.npi),
        contactsStore.getContact(p.npi),
        verify.verifyPhysician(p),
      ]);
      const html = graph.physicianBriefHtml({ physician: p, analytics: a, contact, verification });
      h(`PRE-MEETING NOTES (from Supabase) — ${p.name}`);
      const text = asText(html);
      console.log(flag('brief') ? text : text.split('\n').slice(0, 30).join('\n'));
      console.log(
        `\n… brief is ${html.length} bytes · ` +
          `${(text.match(/Data not available/g) || []).length} "Data not available" · ` +
          `analytics: ${a ? `${(a.byFamily || []).length} procedure families, ${(a.facilities || []).length} facilities` : 'none'}`
      );
    }
  }

  if (match.status !== 'needs_external' && match.status !== 'partial_name') {
    const done = {
      matched: 'DONE — resolved inside the master; the standard brief applies.',
      choose: 'DONE — the master has several candidates; the rep picks one, then the standard brief applies.',
      gate_blocked: 'DONE — a normal meeting: no attendee in the master and no "Dr"/"Doctor" in the title, so nothing was looked up.',
      no_name: 'DONE — the title says "Dr" but carries no readable name; nothing to look up.',
    };
    h(done[match.status] || `DONE — ${match.status}`);
    return;
  }

  // ── Outside the master ────────────────────────────────────────────────────
  const names = match.unresolvedNames.length ? match.unresolvedNames : [];
  const hints = { city: flag('city') || null, state: flag('state') || null };

  let best = null;
  if (match.npi) {
    h(`SOURCES — by NPI ${match.npi} (nothing to disambiguate)`);
    best = { npi: match.npi, confidence: 100, matchReasons: ['the NPI was written on the meeting itself'] };
  } else {
    for (const name of names) {
      const { firstName, lastName } = meetingMatch.nameSearchKey(name, match.nameIncomplete);
      h(`SOURCES — searching “${name}” (first: ${firstName || '—'}, last: ${lastName})`);
      // Wide fetch, then score and trim — see the note in api.routes.js.
      const found = await sources.searchByName(
        { firstName, lastName, city: hints.city, state: hints.state },
        { limit: 20 }
      );
      for (const f of found.failures) console.log(`📡 ${f.name}: ${f.error}`);

      const ranked = score.rankCandidates(
        found.candidates.map((c) => {
          const bis = c.npi ? physicians.getByNpi(c.npi) : null;
          return bis ? { ...c, ...store.mirrorFromPhysician(bis), inBis: true } : c;
        }),
        {
          firstName,
          lastName,
          city: hints.city,
          state: hints.state,
          taxonomy: flag('taxonomy'),
          address: flag('address'),
          zip: flag('zip'),
          phone: flag('phone'),
          text: [ev.title, ev.description].filter(Boolean).join(' · '),
        },
        { max: meetingMatch.MAX_CANDIDATES }
      );

      if (!ranked.ranked.length) {
        console.log(found.failures.length ? 'no candidates (see the outage above)' : 'no candidates — the registry answered and has nobody by that name');
        continue;
      }
      console.log(
        `${found.candidates.length} returned by the source(s) · show bar ${score.CONFIDENCE_SHOW}% · offer bar ` +
          `${score.CONFIDENCE_OFFER}%${ranked.ambiguous ? ' · AMBIGUOUS, nothing auto-shown' : ''}`
      );
      for (const c of ranked.offered) {
        const mark = c.confidence >= score.CONFIDENCE_SHOW ? '✅' : '👀';
        console.log(`${mark} ${String(c.confidence).padStart(3)}%  ${c.name} · ${c.primaryTaxonomy || c.specialty || '—'} · ${c.city || '?'}, ${c.state || '?'} · NPI ${c.npi}${c.inBis ? ' · IN BIS' : ''}`);
        console.log(`        ${c.matchReasons.join(', ')}`);
      }
      if (ranked.dropped) {
        console.log(`   … ${ranked.dropped} more under ${score.CONFIDENCE_OFFER}% — not shown (add the first name, taxonomy, city or address)`);
      }
      if (ranked.primary && !best) best = ranked.primary;
    }
  }

  if (!best) {
    h('NO PRIMARY — every candidate is below the bar or too close to call; the rep picks.');
    return;
  }

  // ── Assemble and render, as the endpoint does ─────────────────────────────
  h(`PROFILE — NPI ${best.npi}: identity + CMS claims by year`);
  const profile = await assembleProfile(best.npi, best.externalSource);
  if (!profile) {
    console.log('no source could describe this NPI');
    return;
  }
  for (const f of profile.failures) console.log(`📡 ${f.name}: ${f.error}`);
  console.log(`identity : ${profile.record.name || '—'} · ${profile.record.specialty || '—'} · ${profile.record.city || '?'}, ${profile.record.state || '?'}`);
  console.log(`agreement: ${profile.agreement.confirmed ? `confirmed by ${profile.agreement.by.join(' and ')} (${profile.agreement.on.join(', ')})` : 'not cross-confirmed'}`);
  for (const y of profile.cms?.years || []) {
    console.log(`CMS ${y.year} : ${y.services} services · ${y.beneficiaries} patients · $${y.allowed.toLocaleString('en-US')} allowed · ${y.codes} codes`);
  }
  if ((profile.cms?.unreachableYears || []).length) {
    console.log(`CMS blind: ${profile.cms.unreachableYears.join(', ')} (source outage, not "no billing")`);
  }

  const html = graph.outsideBriefHtml({
    record: profile.record,
    extra: profile.extra,
    cms: profile.cms,
    agreement: profile.agreement,
    confidence: best.confidence,
    matchReasons: best.matchReasons,
    nameIncomplete: match.nameIncomplete
      ? { ...match.nameIncomplete, total: (match.groups[0] || {}).total }
      : null,
    sourceName: profile.sourceName,
    sourceUrl: profile.sourceUrl,
  });

  h('PRE-MEETING NOTES');
  const text = asText(html);
  console.log(flag('brief') ? text : text.split('\n').slice(0, 26).join('\n'));
  const missing = (text.match(/Data not available/g) || []).length;
  console.log(`\n… ${missing} field(s) render as "Data not available" · brief is ${html.length} bytes`);

  // ── The decision row ─────────────────────────────────────────────────────
  if (flag('save')) {
    const rec = { ...profile.record };
    delete rec.extra;
    const saved = await store.record({
      ownerUserId: `flow-try:${REP}`,
      ownerEmail: REP,
      event: ev,
      ...rec,
      source: 'user',
      decidedBy: 'user',
      confidence: best.confidence,
      status: 'briefed',
      reason: `flow:try — ${best.matchReasons?.join(', ') || 'confirmed'}`,
    });
    h(`SAVED — ${store.backendName()} row ${saved.id}`);
    const latest = await store.latestForEvent(`flow-try:${REP}`, ev.id);
    console.log(`read back: ${latest.name} · ${latest.confidence}% · ${latest.source}/${latest.decidedBy} · ${latest.createdAt}`);
    const nulls = Object.entries(latest).filter(([, v]) => v === null).map(([k]) => k);
    console.log(`null (→ "Data not available"): ${nulls.join(', ')}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('\nflow:try failed:', err.message);
    process.exit(1);
  }
);
