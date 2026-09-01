'use strict';

/**
 * Frontend controller. Single source of truth = which "view" is visible.
 * No framework on purpose — keeps the POC dependency-free and easy to read.
 */

const views = ['login', 'loading', 'error', 'empty', 'events'];

function showView(name) {
  for (const v of views) {
    document.getElementById(`view-${v}`).hidden = v !== name;
  }
}

function getBrowserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function formatTime(iso) {
  if (!iso) return '';
  // Graph returns local wall-clock time (we asked via Prefer header) without a
  // zone suffix; parse as local so we don't double-convert.
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Today's date as YYYY-MM-DD in the browser's local time zone. */
function todayYmd() {
  return new Date().toLocaleDateString('en-CA');
}

/**
 * What the collapsed meeting card promises is inside it.
 *
 * The hint used to stop at BIS: a meeting booked as "JOHN AALBERS" with no
 * attendee — the exact shape reps use — got the same bare "＋ Physician lookup"
 * as a meeting with nothing in it at all, even though opening it returns a full
 * registry profile (NPI, specialty, address, payments). The card looked empty,
 * so nobody opened it, and the intelligence may as well not have existed.
 *
 * Name whoever the detail region is about, so the rep can see there is
 * something here before clicking. Ordered by how sure we are: a BIS match, a
 * physician the title matched, a person the title NAMES, an attendee we can
 * look up outside BIS, then nothing.
 *
 * @param {object} ev event from /api/calendar/day
 * @returns {string}
 */
function lookupHint(ev) {
  if (matchedPhysiciansOf(ev).length) return '🩺 BIS intelligence — click to open';
  if ((ev.titleMatches || []).length) return '🔎 Possible physician matches — click to open';

  const titleNames = (ev.titlePeople || []).map((p) => p.name).filter(Boolean);
  if (titleNames.length) return `🔎 ${listNames(titleNames)} — click for external lookup`;

  const lookupAttendees = (ev.attendees || []).filter(
    (a) => a.email && !a.isOrganizer && a.type !== 'resource'
  );
  if (lookupAttendees.length > 1) {
    return `🔎 External lookup on ${lookupAttendees.length} attendees — click to open`;
  }
  if (lookupAttendees.length) return '🔎 External lookup — click to open';

  return '＋ Physician lookup — click to open';
}

/**
 * Is there anything behind this card worth opening?
 *
 * The same four sources lookupHint() ranks. Used to decide which meeting the
 * day view opens on, so the rep lands on the intelligence rather than a row of
 * identical closed cards.
 */
function hasIntel(ev) {
  return (
    matchedPhysiciansOf(ev).length > 0 ||
    (ev.titleMatches || []).length > 0 ||
    (ev.titlePeople || []).length > 0 ||
    (ev.attendees || []).some((a) => a.email && !a.isOrganizer && a.type !== 'resource')
  );
}

/** ["A","B","C"] → "A and 2 others" — kept short enough for a one-line hint. */
function listNames(names) {
  if (names.length <= 2) return names.join(' and ');
  return `${names[0]} and ${names.length - 1} others`;
}

/** "2027-03-10" → "Wednesday, 10 March 2027" in the browser's own locale. */
function humanDate(dateStr) {
  if (!dateStr) return '';
  // Midday, so a timezone shift can never move it onto the previous day.
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function renderHeaderDate(dateStr, timeZone) {
  const label = document.getElementById('dateLabel');
  label.textContent = dateStr ? humanDate(dateStr) : humanDate(todayYmd());
  if (timeZone) label.textContent += ` · ${timeZone}`;
}

// ── Physician intelligence blocks ─────────────────────────────────────────────
// Clicking a meeting expands its detail region with one self-contained block per
// matched physician — each carrying the pre-meeting brief, that physician's
// inbox email intelligence, the meeting-note history, and the actions (save
// note / email the briefing / schedule a call). Blocks share NO global state, so
// a meeting with two physicians renders two independently-working blocks.

const physBlockTpl = document.getElementById('physician-block-template');
const physSearchTpl = document.getElementById('physician-search-template');

/** "2026-06-05" style label for a note (meeting date, else when written). */
function noteDateLabel(note) {
  return note.meetingDate || (note.createdAt || '').slice(0, 10);
}

/** Friendly relative label: today / yesterday / N days ago / N months ago. */
function daysAgoLabel(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr.length === 10 ? `${dateStr}T12:00:00` : dateStr);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

/** The exact-email-matched physicians on an event, deduped by NPI. */
function matchedPhysiciansOf(ev) {
  const out = [];
  const seen = new Set();
  for (const a of ev.attendees || []) {
    if (a.physician && !seen.has(a.physician.npi)) {
      seen.add(a.physician.npi);
      out.push(a.physician);
    }
  }
  return out;
}

// Email-intel rows are fetched once and shared across every block on the page.
let intelRowsCache = null;
async function getIntelRows() {
  if (intelRowsCache) return intelRowsCache;
  try {
    const res = await fetch('/api/email-intel', { headers: { Accept: 'application/json' } });
    if (!res.ok) return (intelRowsCache = []);
    const data = await res.json();
    return (intelRowsCache = data.rows || []);
  } catch {
    return (intelRowsCache = []);
  }
}

// ── Brief (same server HTML as the email) ─────────────────────────────────────

async function loadBriefInto(box, npi) {
  try {
    const res = await fetch(`/api/physicians/${encodeURIComponent(npi)}/brief`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      box.innerHTML = '<p class="muted">Brief unavailable.</p>';
      return;
    }
    const data = await res.json();
    box.innerHTML = `<h3>Pre-meeting brief</h3>${data.html || '<p class="muted">No brief data.</p>'}`;
  } catch {
    box.innerHTML = '<p class="muted">Brief unavailable.</p>';
  }
}

// ── Email intelligence for one physician ──────────────────────────────────────

function renderIntelForBlock(block, rows) {
  const wrap = block.querySelector('.physician-block__intel');
  const list = block.querySelector('.physician-block__intel-list');
  list.innerHTML = '';
  if (!rows.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  wrap.querySelector('h3').textContent = `Email intelligence (${rows.length})`;

  for (const r of rows) {
    const li = document.createElement('li');
    li.className = 'intel-mini';

    const subj = document.createElement('div');
    subj.className = 'intel-mini__subject';
    subj.textContent = r.emailSubject || '(no subject)';

    const meta = document.createElement('div');
    meta.className = 'intel-mini__meta muted';
    meta.textContent = [r.receivedAt ? intelFmt(r.receivedAt) : '', r.withWhom].filter(Boolean).join(' · ');

    li.append(subj, meta);

    // CPT lines + free-form "other key info" as compact bullets.
    const facts = [];
    (r.cptItems || []).forEach((it) => {
      const s = [it.code, it.description, it.note].map((x) => (x || '').trim()).filter(Boolean).join(' — ');
      if (s) facts.push(`CPT: ${s}`);
    });
    (r.otherNotes || []).forEach((n) => {
      if (n) facts.push(n);
    });
    if (facts.length) {
      const ul = document.createElement('ul');
      ul.className = 'intel-mini__facts';
      facts.forEach((f) => {
        const x = document.createElement('li');
        x.textContent = f;
        ul.appendChild(x);
      });
      li.appendChild(ul);
    }

    list.appendChild(li);
  }
}

async function loadIntelInto(block, physician) {
  const rows = await getIntelRows();
  const mine = rows.filter((r) => r.physicianNpi && String(r.physicianNpi) === String(physician.npi));
  renderIntelForBlock(block, mine);
}

// ── Meeting notes ─────────────────────────────────────────────────────────────

function renderNotesInto(block, notes) {
  const list = block.querySelector('.physician-history__list');
  list.innerHTML = '';

  block.querySelector('.physician-history h3').textContent = notes.length
    ? `Meeting notes (${notes.length})`
    : 'Meeting notes';

  if (!notes.length) {
    const li = document.createElement('li');
    li.className = 'physician-history__empty muted';
    li.textContent = 'No previous meeting notes yet.';
    list.appendChild(li);
    return;
  }

  notes.forEach((n, i) => {
    const li = document.createElement('li');

    // Collapsible timeline entry — only the latest starts expanded.
    const item = document.createElement('details');
    item.className = 'physician-history__item';
    if (i === 0) item.open = true;

    const summary = document.createElement('summary');
    summary.className = 'physician-history__summary';

    const date = document.createElement('span');
    date.className = 'physician-history__date';
    date.textContent = noteDateLabel(n);

    const ago = document.createElement('span');
    ago.className = 'physician-history__ago muted';
    ago.textContent = daysAgoLabel(noteDateLabel(n));

    summary.append(date, ago);

    // AI-extracted Meeting Notes (from an email reply) get a distinct badge.
    if (n.source === 'ai') {
      const ai = document.createElement('span');
      ai.className = 'physician-history__badge physician-history__badge--ai';
      ai.textContent = '🤖 AI from reply';
      summary.appendChild(ai);
    }

    if (i === 0) {
      const badge = document.createElement('span');
      badge.className = 'physician-history__badge';
      badge.textContent = 'Latest';
      summary.appendChild(badge);
    }

    // One-line preview, visible only while collapsed.
    const firstLine = n.notes.split('\n')[0];
    const snippet = document.createElement('span');
    snippet.className = 'physician-history__snippet muted';
    snippet.textContent = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
    summary.appendChild(snippet);

    const body = document.createElement('div');
    body.className = 'physician-history__notes';
    body.textContent = n.notes;

    item.append(summary, body);
    li.appendChild(item);
    list.appendChild(li);
  });
}

async function loadNotesInto(block, physician, event) {
  try {
    const res = await fetch(`/api/physicians/${encodeURIComponent(physician.npi)}/notes`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    let notes = data.notes || [];
    // When shown under a specific meeting, keep only that meeting's notes (its
    // eventId) plus general notes with no meeting — so a reply's MOM appears
    // only under the meeting it belongs to, not every meeting with the same
    // physician.
    if (event?.id) {
      notes = notes.filter((n) => !n.eventId || n.eventId === event.id);
    }
    renderNotesInto(block, notes);
  } catch {
    /* history is best-effort */
  }
}

async function submitMomFor(evt, block, physician, event) {
  evt.preventDefault();

  const text = block.querySelector('.mom-form__text');
  const status = block.querySelector('.mom-form__status');
  const notes = text.value.trim();
  if (!notes) return;

  status.textContent = 'Saving…';
  status.hidden = false;

  try {
    const res = await fetch(`/api/physicians/${encodeURIComponent(physician.npi)}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        notes,
        eventId: event?.id || null,
        // Tie the note to the meeting's day (fall back to today).
        meetingDate: (event?.start || '').slice(0, 10) || todayYmd(),
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);

    text.value = '';
    status.textContent = '✅ Note saved';
    loadNotesInto(block, physician, event);
  } catch (err) {
    status.textContent = `❌ ${err.message || 'Failed to save note'}`;
  }
}

/** Email the organizer this physician's details + full meeting-note history. */
async function sendBriefingFor(block, physician, event) {
  const btn = block.querySelector('.briefing__send');
  const status = block.querySelector('.briefing__status');

  btn.disabled = true;
  status.textContent = 'Sending…';
  status.className = 'briefing__status muted';
  status.hidden = false;

  try {
    const res = await fetch(
      `/api/physicians/${encodeURIComponent(physician.npi)}/send-briefing`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          eventTitle: event?.title || null,
          // Readable "2026-06-05 15:00" instead of the raw ISO string.
          eventStart: (event?.start || '').slice(0, 16).replace('T', ' ') || null,
        }),
      }
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);

    status.textContent = `✅ Briefing sent to ${data.to}`;
    status.className = 'briefing__status schedule-status--ok';
  } catch (err) {
    status.textContent = `❌ ${err.message || 'Failed to send briefing'}`;
    status.className = 'briefing__status schedule-status--error';
  } finally {
    btn.disabled = false;
  }
}

// ── Schedule a call ───────────────────────────────────────────────────────────

function wireScheduleForm(form, physician) {
  const status = form.querySelector('.schedule-status');
  const subject = form.querySelector('.schedule-form__subject');
  const dateInput = form.querySelector('.schedule-form__date');
  const submitBtn = form.querySelector('.schedule-form__submit');

  if (!dateInput.value) dateInput.value = todayYmd();
  subject.value = `Call with ${physician.name || 'physician'}`;

  const canInvite = Boolean(physician.email);
  submitBtn.disabled = !canInvite;
  if (!canInvite) {
    status.textContent = 'This physician has no email on file — invite cannot be sent.';
    status.className = 'schedule-status schedule-status--error';
    status.hidden = false;
  }

  form.addEventListener('submit', async (evt) => {
    evt.preventDefault();

    const date = dateInput.value;
    const time = form.querySelector('.schedule-form__time').value;
    const duration = Number(form.querySelector('.schedule-form__duration').value);

    const start = `${date}T${time}:00`;
    const endDate = new Date(start);
    endDate.setMinutes(endDate.getMinutes() + duration);
    const pad = (n) => String(n).padStart(2, '0');
    const end = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:00`;

    submitBtn.disabled = true;
    status.textContent = 'Sending invite…';
    status.className = 'schedule-status';
    status.hidden = false;

    try {
      const res = await fetch('/api/calendar/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          npi: physician.npi,
          subject: subject.value,
          start,
          end,
          timeZone: getBrowserTimeZone(),
          notes: form.querySelector('.schedule-form__notes').value,
          includePreviousNotes: form.querySelector('.schedule-form__include-notes').checked,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);

      const briefMsg = data.briefingSent
        ? ` · 📧 Briefing emailed to ${data.briefingTo || 'you'}`
        : ` · ⚠️ Briefing not sent${data.briefingError ? ` (${data.briefingError})` : ''}`;
      status.textContent = `✅ Invite sent to ${data.invitee.name} (${data.invitee.email})${briefMsg}`;
      status.className = 'schedule-status schedule-status--ok';
      // Let the user read the confirmation, then refresh the day's events.
      setTimeout(loadCalendar, 1800);
    } catch (err) {
      status.textContent = `❌ ${err.message || 'Failed to schedule'}`;
      status.className = 'schedule-status schedule-status--error';
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ── One physician block ───────────────────────────────────────────────────────

function buildPhysicianBlock(physician, event, { scheduleOpen = false } = {}) {
  const block = physBlockTpl.content.firstElementChild.cloneNode(true);
  block.dataset.npi = physician.npi;

  block.querySelector('.physician-block__name').textContent = physician.name || `NPI ${physician.npi}`;
  block.querySelector('.physician-block__specialty').textContent = physician.specialty || '';

  const photo = block.querySelector('.physician-block__photo');
  if (physician.photoUrl) {
    photo.src = physician.photoUrl;
    photo.hidden = false;
  }

  // All three data sections load asynchronously and independently.
  loadBriefInto(block.querySelector('.physician-block__brief'), physician.npi);
  loadIntelInto(block, physician);
  loadNotesInto(block, physician, event);

  // Actions.
  block.querySelector('.mom-form').addEventListener('submit', (e) => submitMomFor(e, block, physician, event));
  block.querySelector('.briefing__send').addEventListener('click', () => sendBriefingFor(block, physician, event));

  const sched = block.querySelector('.physician-block__schedule');
  if (scheduleOpen) sched.open = true;
  wireScheduleForm(block.querySelector('.schedule-form'), physician);

  return block;
}

// ── Physician search (used only when nobody on the meeting matched) ───────────

function renderPhysicianResults(list, results, onPick) {
  list.innerHTML = '';
  for (const p of results) {
    const li = document.createElement('li');
    li.className = 'physician-result';

    const name = document.createElement('strong');
    name.textContent = p.name || `NPI ${p.npi}`;

    const meta = document.createElement('span');
    meta.className = 'muted';
    // Facility distinguishes same-name physicians; matchHint explains fallbacks.
    meta.textContent = [p.specialty, p.facility?.name, p.email || 'no email', p.matchHint && `📍 ${p.matchHint}`]
      .filter(Boolean)
      .join(' · ');

    li.append(name, meta);
    if (!p.email) li.classList.add('physician-result--noemail');
    li.addEventListener('click', () => onPick(p));
    list.appendChild(li);
  }
}

/**
 * Nothing in the BIS directory for what the rep typed.
 *
 * BIS is the GI directory Lumendi sells into — gastroenterology, general and
 * colorectal surgery. A physician outside those specialties is legitimately
 * absent from it ("Jon Aagaard", Family Medicine, is in NPPES with a full
 * profile but has no BIS row), and the list simply went blank: no message, no
 * way forward, which reads as a broken search rather than an honest "not in
 * this directory".
 *
 * The enrichment agent answers a full name from the public registries in a few
 * seconds. It sits behind a button rather than running on the search itself
 * because this fires on every keystroke — NPPES should not be queried for "j",
 * "jo", "jon". The attendee cards auto-run the same lookup, which is fine
 * there: they run once, over a bounded set of people.
 */
function renderNoBisMatch(list, query, onPick) {
  const li = document.createElement('li');
  li.className = 'physician-result physician-result--empty';

  const msg = document.createElement('span');
  msg.className = 'muted';
  msg.textContent = `No match in the BIS directory for \u201c${query}\u201d.`;

  const box = document.createElement('div');
  box.className = 'enrich__body physician-analytics';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn--ghost physician-result__lookup';
  btn.textContent = '\uD83D\uDD0E Look up in public registries';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    enrichNameInto(box, query, onPick);
  });

  li.append(msg, btn, box);
  list.appendChild(li);
}

/**
 * Run the enrichment agent for a NAME typed into the search box.
 *
 * Free tiers only: NPPES resolves a full name in a few seconds, and the paid
 * identity tier exists to recover a name from an email address — which is the
 * one thing we already have here, so it would buy nothing.
 */
async function enrichNameInto(box, name, onPick) {
  box.innerHTML = '<p class="muted">Checking public registries\u2026</p>';

  const params = new URLSearchParams({ name, useWeb: 'never' });
  let data;
  try {
    const res = await fetch(`/api/enrich?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    box.innerHTML = '<p class="muted">Enrichment unavailable.</p>';
    return;
  }

  box.innerHTML = data.html || `<p class="muted">Nothing found for \u201c${name}\u201d.</p>`;

  // The agent can find that this physician IS in BIS after all — the text
  // search just did not reach their row. Offer them like any other BIS hit, so
  // the rep gets the full brief and the schedule form.
  if (['in_bis', 'recovered_in_bis'].includes(data.status) && data.physician && onPick) {
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'btn btn--ghost physician-result__lookup';
    pick.textContent = `\u2713 Use ${data.physician.name || 'this physician'}`;
    pick.addEventListener('click', () => onPick(data.physician));
    box.appendChild(pick);
  }
}

async function searchPhysicians(q, list, onPick) {
  const query = q.trim();
  if (query.length < 2) {
    list.innerHTML = '';
    return;
  }
  try {
    const res = await fetch(`/api/physicians/search?q=${encodeURIComponent(query)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    const results = data.results || [];
    renderPhysicianResults(list, results, onPick);
    // A blank list is indistinguishable from a broken one — always say
    // something, and offer the registries when BIS has nobody.
    if (!results.length) renderNoBisMatch(list, query, onPick);
  } catch {
    /* search is best-effort; ignore transient errors */
  }
}

// ── The meeting detail region ─────────────────────────────────────────────────

// ── Enrichment: attendees who are not in the BIS directory ───────────────────

/** Meeting title + description, passed to the agent as disambiguating context. */
function meetingContextOf(ev) {
  return [ev.title, ev.description].filter(Boolean).join('. ').slice(0, 500);
}

/**
 * Run the enrichment agent for one meeting SUBJECT and render the result.
 *
 * A subject is whoever we can name: an attendee (identified by email — the
 * reliable case) or a person named in the title with no attendee at all, which
 * is how reps actually book "meeting with dr Geoffrey Aaron". The agent takes
 * either: `name` skips the paid identity tier entirely, because the one thing
 * that tier buys is a name.
 *
 * Two passes on purpose. The free tiers (BIS + NPPES + CMS) answer in 1-5s, so
 * they run automatically and the rep sees something immediately. The paid web
 * tier takes ~40s, so it stays behind a button rather than stalling the card.
 */
async function enrichAttendeeInto(box, attendee, ev, { useWeb = 'never' } = {}) {
  const deep = useWeb === 'always';
  box.innerHTML = `<p class="muted">${
    deep ? 'Searching the web for this person…' : 'Checking public registries…'
  }</p>`;

  const params = new URLSearchParams({
    context: meetingContextOf(ev),
    useWeb,
  });
  if (attendee.email) params.set('email', attendee.email);
  else if (attendee.name) params.set('name', attendee.name);

  let data;
  try {
    const res = await fetch(`/api/enrich?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    box.innerHTML = '<p class="muted">Enrichment unavailable.</p>';
    return;
  }

  box.innerHTML = data.html || '<p class="muted">Nothing found for this address.</p>';

  // A failed lookup is not a short one: spending the paid tier while this
  // server cannot reach the free registries buys nothing. Offer a plain retry.
  if (data.status === 'lookup_failed') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn--ghost enrich__deep';
    retry.textContent = '↻ Retry lookup';
    retry.addEventListener('click', () => {
      retry.disabled = true;
      enrichAttendeeInto(box, attendee, ev, { useWeb });
    });
    box.appendChild(retry);
    return;
  }

  // Offer the paid lookup only when the free tiers actually fell short.
  const needsWeb =
    !deep && Boolean(attendee.email) && ['unresolved', 'facility_only', 'ambiguous'].includes(data.status);
  if (needsWeb) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--ghost enrich__deep';
    btn.textContent = '🔎 Identify with web search';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      enrichAttendeeInto(box, attendee, ev, { useWeb: 'always' });
    });
    box.appendChild(btn);
  }
}

/**
 * Enrichment cards for every attendee who is not the organizer.
 *
 * The organizer — the person who scheduled the meeting — is never enriched, so
 * they are filtered out here as well as on the server.
 */
function buildEnrichment(detail, ev) {
  const attendees = (ev.attendees || []).filter((a) => a.email && !a.isOrganizer && a.type !== 'resource');
  // No attendee to go on (the common case for a meeting typed straight into
  // Outlook) — fall back to the people NAMED in the title, resolved server-side.
  const targets = attendees.length
    ? attendees
    : (ev.titlePeople || []).map((p) => ({ name: p.name, email: null, fromTitle: true }));
  if (!targets.length) return;

  const wrap = document.createElement('div');
  wrap.className = 'enrich';

  const head = document.createElement('h3');
  head.className = 'enrich__title';
  head.textContent = attendees.length
    ? targets.length > 1
      ? 'Attendees — external lookup'
      : 'External lookup'
    : 'From the meeting title — external lookup';
  wrap.appendChild(head);

  for (const attendee of targets) {
    const card = document.createElement('section');
    card.className = 'enrich__card';

    const who = document.createElement('p');
    who.className = 'enrich__who';
    who.textContent = attendee.email
      ? attendee.name
        ? `${attendee.name} · ${attendee.email}`
        : attendee.email
      : `${attendee.name} · named in the meeting title`;
    card.appendChild(who);

    const body = document.createElement('div');
    body.className = 'enrich__body physician-analytics';
    card.appendChild(body);

    wrap.appendChild(card);
    enrichAttendeeInto(body, attendee, ev);
  }

  detail.appendChild(wrap);
}

/** No email match → auto-enrichment, title-based suggestions, and a search box. */
function buildNoMatch(detail, ev) {
  const intro = document.createElement('p');
  intro.className = 'muted event__detail-intro';
  intro.textContent = 'Nobody on this meeting matched the BIS directory. Pick who the meeting is with:';
  detail.appendChild(intro);

  // Look the attendees up outside BIS straight away — the rep should not have
  // to ask for it.
  buildEnrichment(detail, ev);

  // Slot that holds the chosen physician's full block.
  const pickedWrap = document.createElement('div');
  pickedWrap.className = 'event__detail-picked';

  function pick(p) {
    pickedWrap.innerHTML = '';
    pickedWrap.appendChild(buildPhysicianBlock(p, ev, { scheduleOpen: true }));
    pickedWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Physicians matched from the meeting title (name / facility / email).
  if (ev.titleMatches && ev.titleMatches.length) {
    const chips = document.createElement('ul');
    chips.className = 'event__attendee-list event__detail-suggestions';
    for (const p of ev.titleMatches) {
      const chip = document.createElement('li');
      chip.className = 'event__attendee event__attendee--physician';
      chip.title = p.matchHint
        ? `${p.matchHint} — click to view details & schedule`
        : 'Matched from the meeting title — click to view details & schedule';
      chip.textContent = `🩺 ${[p.name, p.facility?.name].filter(Boolean).join(' · ')}${p.matchHint ? ' · 📍 nearby' : ''}`;
      chip.addEventListener('click', () => pick(p));
      chips.appendChild(chip);
    }
    detail.appendChild(chips);
  }

  // Free-text search — start blank, let the rep type who they're looking for.
  const searchWrap = physSearchTpl.content.firstElementChild.cloneNode(true);
  const input = searchWrap.querySelector('.physician-inline__search');
  const results = searchWrap.querySelector('.physician-results');
  let deb = null;
  input.addEventListener('input', (e) => {
    clearTimeout(deb);
    const q = e.target.value;
    deb = setTimeout(() => searchPhysicians(q, results, pick), 250);
  });
  detail.appendChild(searchWrap);

  detail.appendChild(pickedWrap);
}

function buildDetail(detail, ev) {
  detail.innerHTML = '';
  const matched = matchedPhysiciansOf(ev);
  if (matched.length) {
    for (const p of matched) detail.appendChild(buildPhysicianBlock(p, ev));
  } else {
    buildNoMatch(detail, ev);
  }
}

// ── Event list ───────────────────────────────────────────────────────────────

function renderEvents(events) {
  const list = document.getElementById('eventList');
  const tpl = document.getElementById('event-template');
  list.innerHTML = '';

  // Track every card so opening one closes the others (accordion).
  const cards = [];

  for (const ev of events) {
    const node = tpl.content.cloneNode(true);
    const li = node.querySelector('.event');

    if (ev.isAllDay) {
      li.classList.add('event--allday');
      node.querySelector('.event__start').textContent = 'All day';
      node.querySelector('.event__end').textContent = '';
    } else {
      node.querySelector('.event__start').textContent = formatTime(ev.start);
      node.querySelector('.event__end').textContent = formatTime(ev.end);
    }

    node.querySelector('.event__title').textContent = ev.title;

    if (ev.organizer && (ev.organizer.name || ev.organizer.email)) {
      const org = node.querySelector('.event__organizer');
      const who =
        ev.organizer.name && ev.organizer.email && ev.organizer.name !== ev.organizer.email
          ? `${ev.organizer.name} <${ev.organizer.email}>`
          : ev.organizer.email || ev.organizer.name;
      org.textContent = `👤 Organizer: ${who}`;
      org.hidden = false;
    }

    if (ev.location) {
      const loc = node.querySelector('.event__location');
      loc.textContent = `📍 ${ev.location}`;
      loc.hidden = false;
    }

    if (ev.description) {
      const desc = node.querySelector('.event__desc');
      desc.textContent = ev.description;
      desc.hidden = false;
    }

    // Attendee chips — informational. Physicians in the directory carry a 🩺 and
    // the "last call" hint; the full details open in the detail region below.
    if (ev.attendees && ev.attendees.length > 0) {
      const wrap = node.querySelector('.event__attendees');
      const ul = node.querySelector('.event__attendee-list');
      const rsvpIcon = {
        accepted: '✅',
        declined: '❌',
        tentativelyAccepted: '🤔',
      };
      for (const a of ev.attendees) {
        const chip = document.createElement('li');
        chip.className = 'event__attendee';
        const label = a.name && a.email && a.name !== a.email ? `${a.name} <${a.email}>` : a.email || a.name || 'Unknown';

        if (a.physician) {
          chip.classList.add('event__attendee--physician');
          chip.title = 'In physician directory — full brief below';
          chip.textContent = `🩺 ${rsvpIcon[a.response] || ''} ${label}`.replace(/\s+/g, ' ');
          if (a.lastNote) {
            const hint = document.createElement('span');
            hint.className = 'event__attendee-lastcall';
            hint.textContent = `📝 last: ${a.lastNote.meetingDate || (a.lastNote.createdAt || '').slice(0, 10)}`;
            chip.appendChild(hint);
          }
        } else {
          chip.title = `${a.type} · ${a.response} · not in physician directory`;
          chip.textContent = `${rsvpIcon[a.response] || ''} ${label}`.trim();
        }

        ul.appendChild(chip);
      }
      wrap.hidden = false;
    }

    if (ev.onlineMeetingUrl) {
      const join = node.querySelector('.event__join');
      join.href = ev.onlineMeetingUrl;
      join.hidden = false;
    }

    node.querySelector('.event__toggle').textContent = lookupHint(ev);

    // Wire the whole card as an accordion. Built lazily on first open so the
    // day view stays fast even with many meetings.
    const detail = node.querySelector('.event__detail');
    let built = false;

    const card = {
      li,
      ev,
      expand: () => expand(),
      collapse() {
        li.classList.remove('event--open');
        detail.hidden = true;
      },
    };

    function expand() {
      for (const c of cards) if (c.li !== li) c.collapse();
      li.classList.add('event--open');
      detail.hidden = false;
      if (!built) {
        built = true;
        buildDetail(detail, ev);
      }
    }

    li.addEventListener('click', (e) => {
      // Ignore clicks on real controls and anything inside the open detail
      // region — only "empty" header clicks toggle the card.
      if (e.target.closest('a, button, input, textarea, select, .event__detail')) return;
      if (li.classList.contains('event--open')) card.collapse();
      else expand();
    });

    cards.push(card);
    list.appendChild(node);
  }

  // Open the first meeting that actually has something behind it. A rep who
  // books "JOHN AALBERS" and opens the app should SEE the brief, not a row of
  // identical closed cards giving no sign that one of them holds a full
  // registry profile. Only one card opens, and only the free registry tiers
  // run behind it (~0.5s), so this costs one lookup per page load, not one per
  // meeting. Everything else stays lazy.
  const firstWithIntel = cards.find((c) => hasIntel(c.ev));
  if (firstWithIntel) firstWithIntel.expand();
}

async function loadCalendar() {
  showView('loading');
  try {
    const tz = getBrowserTimeZone();
    const date = document.getElementById('dateInput').value || todayYmd();
    const res = await fetch(
      `/api/calendar/day?timeZone=${encodeURIComponent(tz)}&date=${encodeURIComponent(date)}`,
      { headers: { Accept: 'application/json' } }
    );

    if (res.status === 401) {
      showView('login');
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `Request failed (${res.status})`);
    }

    const data = await res.json();
    renderHeaderDate(data.date, data.timeZone);

    if (!data.events || data.events.length === 0) {
      // A future date the rep picked deserves a plain sentence, not a raw ISO
      // string — "No meetings on 2027-03-10" reads like a failure, and it is
      // the one thing on screen when nothing else is.
      document.getElementById('emptyTitle').textContent =
        data.date === todayYmd()
          ? 'No meetings today'
          : `No meetings on ${humanDate(data.date)}`;
      document.getElementById('emptyBody').textContent =
        data.date === todayYmd()
          ? 'Your calendar is clear for today.'
          : 'There is nothing scheduled for this day.';
      showView('empty');
    } else {
      renderEvents(data.events);
      showView('events');
    }
  } catch (err) {
    document.getElementById('errorMessage').textContent = err.message || 'Unknown error';
    showView('error');
  }
}

async function init() {
  showView('loading');

  // Surface OAuth errors passed back as ?error=...
  const params = new URLSearchParams(window.location.search);
  if (params.has('error')) {
    const banner = document.getElementById('loginError');
    banner.textContent = params.get('error');
    banner.hidden = false;
    window.history.replaceState({}, '', window.location.pathname);
  }

  let me;
  try {
    me = await (await fetch('/api/me', { headers: { Accept: 'application/json' } })).json();
  } catch {
    me = { authenticated: false };
  }

  if (!me.authenticated) {
    renderHeaderDate();
    showView('login');
    return;
  }

  // Populate account chip.
  const account = document.getElementById('account');
  document.getElementById('accountName').textContent = me.user?.name || '';
  document.getElementById('accountEmail').textContent = me.user?.email || '';
  account.hidden = false;
  document.getElementById('emailSheetBtn').hidden = false;
  document.getElementById('leadsBtn').hidden = false;

  // Reveal the date filter, defaulted to today.
  document.getElementById('dateFilter').hidden = false;
  document.getElementById('dateInput').value = todayYmd();

  await loadCalendar();
}

// ── Wire up controls
document.getElementById('retryBtn').addEventListener('click', loadCalendar);

document.getElementById('dateInput').addEventListener('change', () => {
  // Clearing the field used to do nothing at all, leaving the previous day's
  // meetings on screen under a header for a date the rep is no longer on.
  const input = document.getElementById('dateInput');
  if (!input.value) input.value = todayYmd();
  loadCalendar();
});

document.getElementById('todayBtn').addEventListener('click', () => {
  document.getElementById('dateInput').value = todayYmd();
  loadCalendar();
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.reload();
});

// ── Email Intelligence Sheet ─────────────────────────────────────────────────
// Reads /api/email-intel (one row per physician-related inbox email) and shows a
// responsive table (desktop) / stacked cards (mobile) in an overlay, with CSV
// export. Built with createElement + textContent, so values are never injected
// as HTML.
const INTEL_COLUMNS = [
  { key: 'physicianName', label: 'Physician' },
  { key: 'facilityName', label: 'Facility' },
  { key: 'cpt', label: 'CPT(s)' },
  { key: 'otherNotes', label: 'Other key info' },
  { key: 'newToDb', label: 'New to DB?' },
  { key: 'meeting', label: 'Meeting' },
  { key: 'withWhom', label: 'With whom' },
  { key: 'emailSubject', label: 'Email subject' },
  { key: 'received', label: 'Received' },
];

let intelRows = [];

function cptLines(items) {
  return (items || [])
    .map((it) => [it.code, it.description, it.note].map((s) => (s || '').trim()).filter(Boolean).join(' — '))
    .filter(Boolean);
}

function intelFmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Returns a string OR an array of strings for a column. */
function intelCell(r, key) {
  switch (key) {
    case 'cpt': return cptLines(r.cptItems);
    case 'otherNotes': return r.otherNotes || [];
    case 'newToDb': return r.newToDb || [];
    case 'meeting': return r.meetingDate || (r.meetingDatetime || '').slice(0, 10) || '';
    case 'received': return intelFmt(r.receivedAt);
    default: return r[key] || '';
  }
}

function renderIntelTable(rows) {
  const body = document.getElementById('intelBody');
  body.innerHTML = '';
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No email intelligence yet — run the backfill or wait for new mail.';
    body.appendChild(p);
    return;
  }

  const table = document.createElement('table');
  table.className = 'intel-table';

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of INTEL_COLUMNS) {
    const th = document.createElement('th');
    th.textContent = col.label;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const col of INTEL_COLUMNS) {
      const td = document.createElement('td');
      td.setAttribute('data-label', col.label);
      const val = intelCell(r, col.key);
      if (Array.isArray(val)) {
        if (!val.length) {
          const dash = document.createElement('span');
          dash.className = 'muted';
          dash.textContent = '—';
          td.appendChild(dash);
        } else {
          val.forEach((item) => {
            const line = document.createElement('div');
            line.className = col.key === 'newToDb' ? 'intel-new' : 'intel-line';
            line.textContent = item;
            td.appendChild(line);
          });
        }
      } else {
        td.textContent = val || '';
        if (!val) td.classList.add('muted');
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.appendChild(table);
}

function csvCell(s) {
  const v = String(s ?? '');
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function intelCsv(rows) {
  const lines = [INTEL_COLUMNS.map((c) => csvCell(c.label)).join(',')];
  for (const r of rows) {
    lines.push(
      INTEL_COLUMNS.map((c) => {
        const v = intelCell(r, c.key);
        return csvCell(Array.isArray(v) ? v.join(' | ') : v);
      }).join(',')
    );
  }
  return lines.join('\n');
}

function downloadIntelCsv() {
  if (!intelRows.length) return;
  const blob = new Blob([intelCsv(intelRows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'email-intelligence-sheet.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function openEmailSheet() {
  const modal = document.getElementById('intelModal');
  const body = document.getElementById('intelBody');
  body.innerHTML = '<p class="muted">Loading…</p>';
  document.getElementById('intelSummary').textContent = '';
  modal.hidden = false;
  try {
    const res = await fetch('/api/email-intel', { headers: { Accept: 'application/json' } });
    const data = await res.json();
    intelRows = data.rows || [];
    document.getElementById('intelSummary').textContent =
      `${intelRows.length} email${intelRows.length === 1 ? '' : 's'}`;
    renderIntelTable(intelRows);
  } catch {
    body.innerHTML = '<p class="muted">Failed to load the sheet.</p>';
  }
}

function closeEmailSheet() {
  document.getElementById('intelModal').hidden = true;
}

document.getElementById('emailSheetBtn').addEventListener('click', openEmailSheet);
document.getElementById('intelCsvBtn').addEventListener('click', downloadIntelCsv);
document.querySelectorAll('[data-intel-close]').forEach((el) => el.addEventListener('click', closeEmailSheet));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('intelModal').hidden) closeEmailSheet();
});

// ── Dynamics 365 Leads ───────────────────────────────────────────────────────
// Reads /api/leads (Lead records from Dynamics 365) and shows them in an overlay
// with a name search + client-side pagination (20 per page). Phase 1: first +
// last name only. Built with createElement + textContent, so values are never
// injected as HTML.
const LEADS_PAGE_SIZE = 20;
let leadsAll = [];       // full set from the API
let leadsFiltered = [];  // after the search filter
let leadsPage = 1;

// Columns shown in the leads table. `get` returns the display string for a lead;
// the search box matches across every column's text.
const LEADS_COLUMNS = [
  { label: 'Name', get: (l) => `${l.firstName || ''} ${l.lastName || ''}`.trim() },
  { label: 'Email', get: (l) => l.email || '' },
  { label: 'Status', get: (l) => l.status || '' },
  { label: 'Owner', get: (l) => l.owner || '' },
  { label: 'Created', get: (l) => intelFmt(l.createdOn) },
];

function renderLeadsTable(leads, emptyMsg) {
  const body = document.getElementById('leadsBody');
  body.innerHTML = '';
  if (!leads.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = emptyMsg || 'No leads found.';
    body.appendChild(p);
    return;
  }

  const table = document.createElement('table');
  table.className = 'intel-table';

  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  for (const col of LEADS_COLUMNS) {
    const th = document.createElement('th');
    th.textContent = col.label;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const lead of leads) {
    const tr = document.createElement('tr');
    tr.className = 'leads-row';
    tr.title = 'Open BIS intelligence for this lead';
    tr.addEventListener('click', () => openLeadSidebar(lead));
    for (const col of LEADS_COLUMNS) {
      const td = document.createElement('td');
      td.setAttribute('data-label', col.label);
      td.textContent = col.get(lead);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.appendChild(table);
}

/** Render the current page of the filtered leads + update the pager. */
function renderLeadsPage() {
  const searching = document.getElementById('leadsSearch').value.trim() !== '';
  const total = leadsFiltered.length;
  const pages = Math.max(1, Math.ceil(total / LEADS_PAGE_SIZE));
  if (leadsPage > pages) leadsPage = pages;
  if (leadsPage < 1) leadsPage = 1;

  const start = (leadsPage - 1) * LEADS_PAGE_SIZE;
  const slice = leadsFiltered.slice(start, start + LEADS_PAGE_SIZE);
  renderLeadsTable(slice, searching ? 'No leads match your search.' : 'No leads found.');

  const pager = document.getElementById('leadsPager');
  if (total > LEADS_PAGE_SIZE) {
    pager.hidden = false;
    document.getElementById('leadsPageInfo').textContent =
      `Page ${leadsPage} of ${pages} · ${total} lead${total === 1 ? '' : 's'}`;
    document.getElementById('leadsPrev').disabled = leadsPage <= 1;
    document.getElementById('leadsNext').disabled = leadsPage >= pages;
  } else {
    pager.hidden = true;
  }
}

/** Apply the search box to the full set and reset to page 1. */
function applyLeadsSearch() {
  const q = document.getElementById('leadsSearch').value.trim().toLowerCase();
  leadsFiltered = q
    ? leadsAll.filter((l) =>
        LEADS_COLUMNS.some((c) => c.get(l).toLowerCase().includes(q))
      )
    : leadsAll.slice();
  leadsPage = 1;
  document.getElementById('leadsSummary').textContent =
    `${leadsFiltered.length} lead${leadsFiltered.length === 1 ? '' : 's'}${q ? ' (filtered)' : ''}`;
  renderLeadsPage();
}

async function openLeads() {
  const modal = document.getElementById('leadsModal');
  const body = document.getElementById('leadsBody');
  const toolbar = document.getElementById('leadsToolbar');
  const pager = document.getElementById('leadsPager');
  modal.hidden = false;
  toolbar.hidden = true;
  pager.hidden = true;
  document.getElementById('leadsSearch').value = '';
  document.getElementById('leadsSummary').textContent = 'Loading…';
  body.innerHTML = '';
  try {
    const res = await fetch('/api/leads', { headers: { Accept: 'application/json' } });
    const data = await res.json();
    if (!data.configured) {
      document.getElementById('leadsSummary').textContent = '';
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Dynamics 365 is not configured — set the DYNAMICS_* env vars.';
      body.appendChild(p);
      return;
    }
    leadsAll = data.leads || [];
    toolbar.hidden = leadsAll.length === 0;
    applyLeadsSearch();
  } catch (err) {
    document.getElementById('leadsSummary').textContent = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Could not load leads. Please try again.';
    body.appendChild(p);
  }
}

function closeLeads() {
  document.getElementById('leadsModal').hidden = true;
}

document.getElementById('leadsBtn').addEventListener('click', openLeads);
document.getElementById('leadsSearch').addEventListener('input', applyLeadsSearch);
document.getElementById('leadsPrev').addEventListener('click', () => {
  leadsPage -= 1;
  renderLeadsPage();
});
document.getElementById('leadsNext').addEventListener('click', () => {
  leadsPage += 1;
  renderLeadsPage();
});
document.querySelectorAll('[data-leads-close]').forEach((el) => el.addEventListener('click', closeLeads));

// ── Lead intelligence sidebar ────────────────────────────────────────────────
// Click a lead → match it to BIS (Supabase) data (email → name → facility) and
// show the physician's pre-meeting brief (or facility + people, or no-match).
const LEAD_MATCH_LABELS = {
  email: 'Matched by email',
  name: 'Matched by name',
  facility: 'Matched by facility',
};

function renderLeadSidebar(data, lead) {
  const body = document.getElementById('leadSbBody');
  const badge = document.getElementById('leadSbBadge');
  body.innerHTML = '';

  if (data.matchedBy && LEAD_MATCH_LABELS[data.matchedBy]) {
    badge.textContent = LEAD_MATCH_LABELS[data.matchedBy];
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }

  // Physician hit → the full pre-meeting brief (server HTML, same as email).
  if (data.matchedBy === 'email' || data.matchedBy === 'name') {
    body.classList.add('physician-analytics');
    body.innerHTML = data.html || '<p class="muted">No brief data.</p>';
    return;
  }

  body.classList.remove('physician-analytics');

  // Facility hit → facility name + physicians practising there.
  if (data.matchedBy === 'facility') {
    const fac = document.createElement('p');
    fac.className = 'lead-sidebar__facility';
    fac.textContent = data.facility?.name
      ? `Facility: ${data.facility.name}${data.facility.city ? ' — ' + data.facility.city : ''}`
      : `Facility match for "${lead.company || ''}"`;
    body.appendChild(fac);

    const list = document.createElement('ul');
    list.className = 'lead-sidebar__people';
    for (const c of data.candidates || []) {
      const li = document.createElement('li');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = c.name || '';
      const spec = document.createElement('div');
      spec.className = 'spec';
      spec.textContent = c.specialty || '';
      li.appendChild(name);
      if (c.specialty) li.appendChild(spec);
      list.appendChild(li);
    }
    if ((data.candidates || []).length) body.appendChild(list);
    return;
  }

  // No match.
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = 'No matching physician or facility found in the BIS database.';
  body.appendChild(p);
}

async function openLeadSidebar(lead) {
  const sb = document.getElementById('leadSidebar');
  const body = document.getElementById('leadSbBody');
  document.getElementById('leadSbName').textContent =
    `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || '(no name)';
  document.getElementById('leadSbBadge').hidden = true;
  sb.hidden = false;
  body.classList.remove('physician-analytics');
  body.innerHTML = '<p class="muted">Loading BIS data…</p>';
  try {
    const params = new URLSearchParams({
      email: lead.email || '',
      firstName: lead.firstName || '',
      lastName: lead.lastName || '',
      company: lead.company || '',
    });
    const res = await fetch('/api/leads/match?' + params.toString(), {
      headers: { Accept: 'application/json' },
    });
    const data = await res.json();
    renderLeadSidebar(data, lead);
  } catch (err) {
    body.classList.remove('physician-analytics');
    body.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Could not load BIS data. Please try again.';
    body.appendChild(p);
  }
}

function closeLeadSidebar() {
  document.getElementById('leadSidebar').hidden = true;
}

document.querySelectorAll('[data-lead-sb-close]').forEach((el) =>
  el.addEventListener('click', closeLeadSidebar)
);

// Escape: close the sidebar first (if open), otherwise the leads modal.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!document.getElementById('leadSidebar').hidden) {
    closeLeadSidebar();
  } else if (!document.getElementById('leadsModal').hidden) {
    closeLeads();
  }
});

init();
