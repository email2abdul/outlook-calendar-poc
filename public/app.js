'use strict';

/**
 * Frontend controller. Single source of truth = which "view" is visible.
 * No framework on purpose — keeps the POC dependency-free and easy to read.
 */

const views = ['login', 'loading', 'error', 'empty', 'events'];

/**
 * Topbar tools that are hidden for now.
 *
 * The Email Sheet and the Leads modal both still work — their routes, their
 * fetches and their tables are untouched — they are simply not on the topbar
 * while the pre-meeting brief is what the app is being shown for. Flip a flag
 * back to true and the button returns; nothing else has to change.
 */
const TOPBAR_TOOLS = {
  emailSheet: false,
  leads: false,
};

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

  // The server's ladder (src/meeting-match.js) has usually already answered
  // this, and its answer is more specific than anything guessed here: it either
  // NAMES the physician it resolved, or says how many people share the name.
  const m = ev.match;
  if (m && m.status === 'matched' && (m.physicians || []).length) {
    const who = listNames(m.physicians.map((p) => p.name).filter(Boolean));
    return m.via === 'rep-choice'
      ? `🩺 ${who} — your pick for this meeting, click to open`
      : `🩺 ${who} — BIS intelligence, click to open`;
  }
  if (m && m.status === 'choose') {
    const g = (m.groups || []).find((x) => x.total > 1);
    return g
      ? `🔢 ${g.total} possible matches for “${g.name}” — click to pick`
      : '🔢 Possible physician matches — click to pick';
  }

  if (m && m.status === 'partial_name') {
    const half = m.nameIncomplete?.name;
    return half
      ? `✍️ Only “${half}” on this meeting — click to complete the name`
      : '✍️ Half a name on this meeting — click to complete it';
  }

  if (m && m.status === 'needs_external') {
    const who = (m.names || []).map((n) => n.name).filter(Boolean);
    return who.length
      ? `🔎 ${listNames(who)} — not in BIS, click for a registry lookup`
      : '🔎 Not in BIS — click for a registry lookup';
  }

  // Only set once a lookup has run and come back with a non-physician; the
  // ladder itself never decides this.
  if (m && m.status === 'not_doctor') {
    return '🚫 Not a physician — click to see why';
  }

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
  const m = ev.match;
  return (
    matchedPhysiciansOf(ev).length > 0 ||
    (m && (m.status === 'matched' || m.status === 'choose' || m.status === 'partial_name')) ||
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
async function sendBriefingFor(block, physician, event, { source = null } = {}) {
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
          // For a physician the master does not have, the server re-assembles
          // the brief from this source rather than trusting the browser's copy.
          source: source || undefined,
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

/**
 * One self-contained physician block — for a physician in the master, and for
 * one who is not.
 *
 * An outside physician gets the same block on purpose: notes are keyed by NPI
 * and they have one, and "email me this briefing" is exactly as useful for a
 * registry profile as for a BIS row. Only three things differ, and each for a
 * reason:
 *   · the brief is already rendered (assembled from the public sources), so it
 *     is injected rather than fetched;
 *   · there is no inbox intelligence to show — the Email Sheet is keyed to BIS
 *     physicians;
 *   · "Schedule a call" needs an address to invite, and NPPES has no email
 *     field at all, so it is hidden rather than left there to fail.
 *
 * @param {object} physician        BIS row, or an outside candidate/record
 * @param {object} event
 * @param {object} [opts]
 * @param {boolean} [opts.scheduleOpen]
 * @param {string}  [opts.briefHtml] pre-rendered brief (outside physicians)
 * @param {boolean} [opts.outside]   skip inbox intel; hide scheduling with no email
 * @param {string}  [opts.source]    which public source the brief came from
 */
function buildPhysicianBlock(physician, event, { scheduleOpen = false, briefHtml = null, outside = false, source = null } = {}) {
  const block = physBlockTpl.content.firstElementChild.cloneNode(true);
  block.dataset.npi = physician.npi;
  if (outside) block.dataset.outside = 'true';

  block.querySelector('.physician-block__name').textContent = physician.name || `NPI ${physician.npi}`;
  block.querySelector('.physician-block__specialty').textContent =
    physician.specialty || physician.primaryTaxonomy || '';

  const photo = block.querySelector('.physician-block__photo');
  if (physician.photoUrl) {
    photo.src = physician.photoUrl;
    photo.hidden = false;
  }

  const briefBox = block.querySelector('.physician-block__brief');
  if (briefHtml) briefBox.innerHTML = `<h3>Pre-meeting brief</h3>${briefHtml}`;
  else loadBriefInto(briefBox, physician.npi);

  if (!outside) loadIntelInto(block, physician);
  loadNotesInto(block, physician, event);

  // Actions.
  block.querySelector('.mom-form').addEventListener('submit', (e) => submitMomFor(e, block, physician, event));
  block
    .querySelector('.briefing__send')
    .addEventListener('click', () => sendBriefingFor(block, physician, event, { source }));

  const sched = block.querySelector('.physician-block__schedule');
  if (outside && !physician.email) {
    // Nothing to invite: say so instead of offering a form that cannot work.
    sched.hidden = true;
    const why = document.createElement('p');
    why.className = 'muted';
    why.style.fontSize = '12px';
    why.textContent =
      'Scheduling needs an email address, and the public registries do not publish one — ' +
      'add it to the meeting as an attendee to invite them.';
    sched.after(why);
  } else {
    if (scheduleOpen) sched.open = true;
    wireScheduleForm(block.querySelector('.schedule-form'), physician);
  }

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
function buildNoMatch(detail, ev, { intro: introText } = {}) {
  const intro = document.createElement('p');
  intro.className = 'muted event__detail-intro';
  intro.textContent =
    introText || 'Nobody on this meeting matched the BIS directory. Pick who the meeting is with:';
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
  appendSearchBox(detail, pick);

  detail.appendChild(pickedWrap);
}

/**
 * Remember (or forget) which physician this meeting is with.
 *
 * The brief is rendered optimistically before this resolves — the rep asked to
 * see the person, and a slow write should not hold that up — so the caller
 * reports what happened instead of pretending it saved.
 *
 * @param {object} ev
 * @param {string|null} npi  null clears the choice
 */
async function saveMeetingChoice(ev, npi, source) {
  const res = await fetch('/api/meetings/choose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    // `source` is required for an NPI the master does not have: the server
    // re-fetches the details from that source rather than trusting the browser.
    body: JSON.stringify({ eventId: ev.id, npi, source: source || undefined }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'The choice could not be saved.');
  return data;
}

/**
 * Re-run the ladder for one meeting and rebuild its panel.
 *
 * Reads the CURRENT event back through /api/meetings/match, so this doubles as
 * the honest way to reflect a meeting the rep has just edited — or a choice
 * they just cleared.
 */
async function refreshMatch(ev, detail) {
  try {
    const res = await fetch(`/api/meetings/match?eventId=${encodeURIComponent(ev.id)}`, {
      headers: { Accept: 'application/json' },
    });
    if (res.ok) ev.match = await res.json();
  } catch {
    /* keep the panel we have rather than blanking it */
  }
  buildDetail(detail, ev);
}

/** A free-text physician search, wired to `onPick`. Used by more than one path. */
function appendSearchBox(detail, onPick) {
  const searchWrap = physSearchTpl.content.firstElementChild.cloneNode(true);
  const input = searchWrap.querySelector('.physician-inline__search');
  const results = searchWrap.querySelector('.physician-results');
  let deb = null;
  input.addEventListener('input', (e) => {
    clearTimeout(deb);
    const q = e.target.value;
    deb = setTimeout(() => searchPhysicians(q, results, onPick), 250);
  });
  detail.appendChild(searchWrap);
}

/**
 * Several physicians in the master share the name the meeting gives.
 *
 * This is a question, not an answer: the rep is the only one who knows which
 * "Abdul Khan" they are seeing, so nothing is briefed until they pick. The
 * cards lead with facility and city because that — not the name — is what
 * tells same-named physicians apart, and the true total is stated even though
 * only the first few are listed: "3 of 12" is honest, "3" is not.
 */
function buildChoose(detail, ev) {
  const m = ev.match || {};

  // Half a name reaches this path too ("Dr Khan" → 62 physicians in the master).
  appendNameTag(detail, m.nameIncomplete, (m.groups || [])[0]?.total);

  const pickedWrap = document.createElement('div');
  pickedWrap.className = 'event__detail-picked';

  async function pick(p) {
    pickedWrap.innerHTML = '';

    // The answer to the shortlist is worth keeping: without it the next page
    // load asks again, and the reminder email never learns who was picked.
    const status = document.createElement('p');
    status.className = 'muted event__detail-intro';
    status.textContent = `Remembering ${p.name || p.npi} for this meeting…`;
    pickedWrap.appendChild(status);
    pickedWrap.appendChild(buildPhysicianBlock(p, ev));
    pickedWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      const saved = await saveMeetingChoice(ev, p.npi);
      status.textContent =
        `✔ ${p.name || p.npi} is now the physician for this meeting — the reminder brief ` +
        'will use them too.' +
        // Be specific about WHERE it was kept: until the setup SQL is run the
        // store falls back to a local file, which is fine for testing but is
        // not shared with anything else.
        (saved.storedIn === 'sqlite'
          ? ' (Kept on this server for now — run supabase/outside-physician-setup.sql to keep it in Supabase.)'
          : '');
    } catch (err) {
      status.textContent = `⚠️ ${err.message} The brief below is still correct; the choice was not saved.`;
    }
  }

  for (const g of m.groups || []) {
    if (!(g.candidates || []).length) continue;

    const head = document.createElement('p');
    head.className = 'muted event__detail-intro';
    // One line, in the rep's own words: say the name, say how many records it
    // brought back, and ask which one the pre-meeting notes are for.
    if (g.total > g.candidates.length) {
      head.textContent =
        `Due to the name “${g.name}” I have ${g.total} matching records ` +
        `(closest ${g.candidates.length} shown) — choose the one you want the ` +
        'pre-meeting notes for.';
    } else if (g.total > 1) {
      head.textContent =
        `Due to the name “${g.name}” I have ${g.total} matching records — choose the ` +
        'one you want the pre-meeting notes for.';
    } else {
      head.textContent = `“${g.name}” — one match in the BIS directory:`;
    }
    detail.appendChild(head);

    const ul = document.createElement('ul');
    ul.className = 'physician-results';
    // City/state ride along as the match hint — the renderer already shows it.
    renderPhysicianResults(
      ul,
      g.candidates.map((p) => ({
        ...p,
        matchHint: [p.facility && p.facility.city, p.facility && p.facility.state]
          .filter(Boolean)
          .join(', ') || null,
      })),
      pick
    );
    detail.appendChild(ul);
  }

  if ((m.unresolvedNames || []).length) {
    const note = document.createElement('p');
    note.className = 'muted event__detail-intro';
    note.textContent = `${m.unresolvedNames.join(', ')} — not in the BIS directory by that name.`;
    detail.appendChild(note);
  }

  // Nothing above is binding: the rep can always search for someone else.
  appendSearchBox(detail, pick);
  detail.appendChild(pickedWrap);
}

/**
 * The meeting gave half a name — say which half is missing.
 *
 * This is the one problem in the whole ladder that the REP can fix instantly,
 * and only they can: no registry will turn "Khan" into a person. So the ask is
 * specific, and it says how many people the half-name matches, because that is
 * what makes it obvious why the app is asking.
 */
function appendNameTag(detail, incomplete, total) {
  if (!incomplete || !incomplete.name) return;
  const p = document.createElement('p');
  p.className = 'muted event__detail-intro';
  const which =
    incomplete.missing === 'first'
      ? 'the first name is missing'
      : incomplete.missing === 'last'
        ? 'the last name is missing'
        : 'the full name is not written out';
  const many = total > 1 ? ` “${incomplete.name}” alone matches ${total} physicians.` : '';
  p.textContent =
    `✍️ Please write the physician's full name on the meeting — ${which}.${many} ` +
    'With the full name this can be matched exactly.';
  detail.appendChild(p);
}

/** One candidate → the list row a rep reads, with its confidence. */
function candidateRow(c, threshold, onPick) {
  const li = document.createElement('li');
  li.className = 'physician-result';

  const name = document.createElement('strong');
  const pct = Number.isFinite(c.confidence) ? ` — ${c.confidence}%` : '';
  name.textContent = `${c.inBis ? '🩺 ' : ''}${c.name || `NPI ${c.npi}`}${pct}`;

  const meta = document.createElement('span');
  meta.className = 'muted';
  // Primary taxonomy leads: with five people who share a surname, "what kind of
  // doctor" is what tells the rep which one they are meeting.
  meta.textContent = [
    c.primaryTaxonomy || c.specialty,
    [c.city, c.state].filter(Boolean).join(', '),
    c.npi ? `NPI ${c.npi}` : null,
    c.inBis ? 'in your BIS directory' : c.externalSource,
    Number.isFinite(c.confidence) && c.confidence < threshold ? 'below the confidence bar' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  li.append(name, meta);
  if (!c.npi) li.classList.add('physician-result--noemail');
  li.addEventListener('click', () => onPick(c));
  return li;
}

/**
 * Nobody on this meeting is in the BIS directory — ask the public sources.
 *
 * This is the only path in the panel that leaves the building, so it runs when
 * the rep OPENS the meeting, never on page load for a whole day of them.
 *
 * Three things it must keep straight:
 *  · a source that could not be reached is not a source that found nobody — the
 *    first gets a retry, the second gets "not in the registry";
 *  · a candidate whose NPI turns out to be in BIS is the best possible outcome
 *    and is labelled as such, not quietly mixed in;
 *  · nothing is briefed until the rep picks, because a name can belong to
 *    several real physicians.
 */
async function buildOutside(detail, ev) {
  const head = document.createElement('p');
  head.className = 'muted event__detail-intro';
  head.textContent =
    'Nobody on this meeting is in the BIS directory — checking the public registries…';
  detail.appendChild(head);

  const list = document.createElement('div');
  detail.appendChild(list);

  const picked = document.createElement('div');
  picked.className = 'event__detail-picked';

  async function load() {
    list.innerHTML = '';
    try {
      const res = await fetch(`/api/meetings/outside?eventId=${encodeURIComponent(ev.id)}`, {
        headers: { Accept: 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'The registry lookup failed.');

      // The registry answered, and the answer is that this person is not a
      // physician. That IS the finding — it is stated, with what they are and
      // the page that proves it, instead of an empty panel or a brief nobody
      // should read.
      if (data.notDoctor) {
        head.textContent = 'Not in the BIS directory, and the public registries say this is not a physician:';
        const box = document.createElement('div');
        box.className = 'physician-analytics';
        box.innerHTML = data.notDoctor.html || '';
        list.appendChild(box);
      }

      const rawGroups = data.groups || [];
      const groups = rawGroups.filter((g) => (g.candidates || []).length);
      const failed = data.failures || [];
      const threshold = data.threshold || 70;
      // Everyone the registries returned, including the ones held back — the
      // count the rep needs to hear, and the count the name tag quotes.
      const held = rawGroups.reduce((n, g) => n + (g.dropped || 0), 0);
      const returned = rawGroups.reduce((n, g) => n + (g.total || 0) + (g.dropped || 0), 0);
      appendNameTag(list, data.nameIncomplete, returned);
      const names = (data.names || []).length
        ? data.names
        : (data.groups || []).map((g) => g.name).filter(Boolean);
      const who = names.length ? `“${names.join('”, “')}”` : 'that name';

      if (data.notDoctor) {
        // heading already set above
      } else if (groups.length) {
        head.textContent = data.brief
          ? `Not in the BIS directory. Best match shown below at ${data.confidence}% confidence — ` +
            'anything less certain is listed as an option.'
          : `Not in the BIS directory. ${(data.sources || []).map((x) => x.name).join(', ')} ` +
            'answered — pick who this meeting is with:';
      } else if (failed.length) {
        // The claim "nobody by that name" would be about the PERSON, on evidence
        // that is only about the network. Say what actually happened.
        head.textContent =
          `Not in the BIS directory, and the public registries could not be reached — ` +
          `so nothing is known yet about ${who}.`;
      } else if (held) {
        // They were FOUND — they just did not match this meeting closely enough.
        // "the registries have nobody by that name" would be plainly false, and
        // would send the rep looking for a different spelling.
        head.textContent =
          `Not in the BIS directory. The registries returned ${held} ${
            held > 1 ? 'people' : 'person'
          } named ${who}, but nothing in this meeting says which one — so none is shown. Add the ` +
          'first name, the taxonomy (what kind of doctor), the city or the practice address.';
      } else {
        head.textContent = `Not in the BIS directory, and the public registries have nobody by ${who}.`;
      }

      for (const g of groups) {
        const line = document.createElement('p');
        line.className = 'muted event__detail-intro';
        line.textContent =
          g.total > 1
            ? `Due to the name “${g.name}” I have ${g.total} matching records — choose the one ` +
              'you want the pre-meeting notes for.'
            : `“${g.name}” — one match in the public registries:`;
        list.appendChild(line);

        // Above the bar: shown. Below it: an option the rep opens on purpose —
        // a 55% guess must not sit on screen looking like an answer.
        const strong = g.candidates.filter((c) => (c.confidence ?? 100) >= threshold);
        const weak = g.candidates.filter((c) => (c.confidence ?? 100) < threshold);

        if (strong.length) {
          const ul = document.createElement('ul');
          ul.className = 'physician-results';
          for (const c of strong) ul.appendChild(candidateRow(c, threshold, (x) => pickOutside(x, ev, picked)));
          list.appendChild(ul);
        }

        if ((g.refused || []).length) {
          const note = document.createElement('p');
          note.className = 'muted event__detail-intro';
          const roles = g.refused.map((r) => r.taxonomy).filter(Boolean);
          note.textContent =
            `${g.refused.length} further match${g.refused.length > 1 ? 'es are' : ' is'} not a ` +
            `physician${roles.length ? ` (${roles.join(', ')})` : ''} and ${
              g.refused.length > 1 ? 'were' : 'was'
            } not offered.`;
          list.appendChild(note);
        }

        if (g.dropped > 0) {
          const note = document.createElement('p');
          note.className = 'muted event__detail-intro';
          note.textContent =
            `${g.dropped} further match${g.dropped > 1 ? 'es were' : ' was'} under ` +
            `${threshold - 10}% and not shown — add the first name, the taxonomy, the city or ` +
            'the practice address to the meeting to narrow it down.';
          list.appendChild(note);
        }

        if (weak.length) {
          const box = document.createElement('details');
          const sum = document.createElement('summary');
          sum.textContent = strong.length
            ? `Other possible matches (${weak.length}) — under ${threshold}% confidence`
            : `${weak.length} possible match${weak.length > 1 ? 'es' : ''}, none over ${threshold}% ` +
              '— open to see them';
          box.appendChild(sum);
          const ul = document.createElement('ul');
          ul.className = 'physician-results';
          for (const c of weak) ul.appendChild(candidateRow(c, threshold, (x) => pickOutside(x, ev, picked)));
          box.appendChild(ul);
          list.appendChild(box);
        }
      }

      // One candidate cleared the bar and stood clear of the rest: its notes are
      // already assembled, so show them without making the rep click.
      if (data.brief) {
        const best =
          (groups.flatMap((g) => g.candidates).find((c) => c.npi === (groups.find((g) => g.primaryNpi) || {}).primaryNpi)) ||
          groups[0]?.candidates[0] ||
          {};
        list.appendChild(
          buildPhysicianBlock(best, ev, {
            briefHtml: data.brief,
            outside: !best.inBis,
            source: best.externalSource,
          })
        );
      }

      // Say which source went missing, and offer the retry — silence here reads
      // as "this person does not exist".
      for (const f of data.failures || []) {
        const warn = document.createElement('p');
        warn.className = 'muted event__detail-intro';
        warn.textContent = `📡 ${f.error} — this is not a finding about this person. `;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn btn--ghost';
        retry.textContent = '↻ Retry';
        retry.addEventListener('click', () => {
          retry.disabled = true;
          load();
        });
        warn.appendChild(retry);
        list.appendChild(warn);
      }
    } catch (err) {
      head.textContent = `⚠️ ${err.message}`;
    }
  }

  await load();

  // The rep can always look someone up by hand instead.
  appendSearchBox(detail, (p) => {
    picked.innerHTML = '';
    picked.appendChild(buildPhysicianBlock(p, ev));
  });
  detail.appendChild(picked);
}

/**
 * The rep picked someone the master does not have.
 *
 * The choice is saved (so the next tick and the reminder follow it), and the
 * notes come back with the save — same sections as a BIS brief, with "Data not
 * available" wherever the registry had nothing, and the registry's extras
 * tagged as extra.
 */
async function pickOutside(candidate, ev, picked) {
  picked.innerHTML = '';

  const status = document.createElement('p');
  status.className = 'muted event__detail-intro';
  status.textContent = `Remembering ${candidate.name || candidate.npi} for this meeting…`;
  picked.appendChild(status);
  picked.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  let saved;
  try {
    saved = await saveMeetingChoice(ev, candidate.npi, candidate.externalSource);
  } catch (err) {
    status.textContent = `⚠️ ${err.message}`;
    return;
  }

  // The rep's click is honoured either way; what changes is whether a brief
  // exists to show them.
  if (saved.notDoctor) {
    status.textContent =
      `Recorded ${saved.physician?.name || candidate.name} as this meeting's contact — ` +
      'but no pre-meeting brief is produced for them.';
    const box = document.createElement('section');
    box.className = 'physician-block';
    const body = document.createElement('div');
    body.className = 'physician-analytics';
    body.innerHTML = saved.html || '';
    box.appendChild(body);
    picked.appendChild(box);
    return;
  }

  status.textContent =
    `✔ ${saved.physician?.name || candidate.name} is now the physician for this meeting.` +
    (saved.storedIn === 'sqlite'
      ? ' (Kept on this server for now — run supabase/outside-physician-setup.sql to keep it in Supabase.)'
      : '');

  // In the master after all → the standard block, with everything it carries.
  if (saved.inBis) {
    picked.appendChild(buildPhysicianBlock(candidate, ev));
    return;
  }

  // The same block a BIS physician gets — notes, "email me this briefing" and
  // all — with the brief that was just assembled injected into it.
  picked.appendChild(
    buildPhysicianBlock(
      { ...candidate, ...(saved.physician || {}) },
      ev,
      { briefHtml: saved.html, outside: true, source: candidate.externalSource }
    )
  );
}

/**
 * What the expanded meeting shows, in the ladder's own order: an exact email
 * match, then a name the master resolved to exactly one physician, then a
 * shortlist to pick from, then the gate's "this is a normal meeting", then the
 * old no-match path (external lookup + search).
 */
function buildDetail(detail, ev) {
  detail.innerHTML = '';

  const matched = matchedPhysiciansOf(ev);
  if (matched.length) {
    for (const p of matched) detail.appendChild(buildPhysicianBlock(p, ev));
    return;
  }

  const m = ev.match;

  if (m && m.status === 'matched' && (m.physicians || []).length) {
    // Say HOW this person was identified. A name match is weaker evidence than
    // an email match, and a choice the rep made is stronger than both — they
    // are entitled to know which one they are looking at before acting on it.
    const via = document.createElement('p');
    via.className = 'muted event__detail-intro';

    if (m.via === 'rep-choice') {
      const who = m.physicians[0];
      via.textContent = `✔ You picked ${who.name || who.npi} for this meeting. `;

      // The choice has to be undoable, or a mis-click is permanent: clearing it
      // puts the meeting back on the ladder and re-renders whatever it says.
      const change = document.createElement('button');
      change.type = 'button';
      change.className = 'btn btn--ghost';
      change.textContent = 'Change';
      change.addEventListener('click', async () => {
        change.disabled = true;
        change.textContent = 'Clearing…';
        try {
          await saveMeetingChoice(ev, null);
          await refreshMatch(ev, detail);
        } catch (err) {
          via.textContent = `⚠️ ${err.message} `;
          change.disabled = false;
          change.textContent = 'Change';
        }
      });
      via.appendChild(change);
    } else {
      const names = m.names || [];
      const named = names.map((n) => `“${n.name}” (${n.source})`).join(', ');
      via.textContent =
        `Matched by name: ${named} — ` +
        (names.length > 1
          ? 'each resolves to exactly one physician in the BIS directory. '
          : 'exactly one physician in the BIS directory. ') +
        'No attendee email on this meeting is in the directory.';
    }
    detail.appendChild(via);

    for (const p of m.physicians) detail.appendChild(buildPhysicianBlock(p, ev));
    return;
  }

  if (m && m.status === 'choose') {
    buildChoose(detail, ev);
    return;
  }

  // Gate open, name read, and the master has nobody — the public registries are
  // the next rung, and they are asked here rather than on page load.
  if (m && (m.status === 'needs_external' || m.status === 'partial_name')) {
    buildOutside(detail, ev);
    return;
  }

  if (m && m.status === 'gate_blocked') {
    buildNoMatch(detail, ev, {
      intro:
        'Normal meeting: no attendee email is in the BIS directory, and the title does not ' +
        'say “Dr” or “Doctor” — so no physician lookup was run. Add “Dr” to the title (or the ' +
        'physician as an attendee), or search below.',
    });
    return;
  }

  buildNoMatch(detail, ev);
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
  document.getElementById('emailSheetBtn').hidden = !TOPBAR_TOOLS.emailSheet;
  document.getElementById('leadsBtn').hidden = !TOPBAR_TOOLS.leads;

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
