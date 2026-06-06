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

function renderHeaderDate(dateStr, timeZone) {
  const label = document.getElementById('dateLabel');
  const d = dateStr ? new Date(`${dateStr}T12:00:00`) : new Date();
  label.textContent = d.toLocaleDateString([], {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  if (timeZone) label.textContent += ` · ${timeZone}`;
}

// ── Inline physician panel ───────────────────────────────────────────────────
// A single panel instance, moved beneath whichever event the user is acting
// on: matched attendee chip → details; "Schedule call" → search first.

const inlinePanel = document
  .getElementById('physician-inline-template')
  .content.firstElementChild.cloneNode(true);

const $panel = (sel) => inlinePanel.querySelector(sel);

let selectedPhysician = null;
let searchDebounce = null;
// The event the panel was opened from — call notes get linked to it.
let currentEventCtx = null;
// 'view'    → matched attendee: meeting already exists, show details + notes only.
// 'schedule'→ from "Schedule call": include the scheduling form.
let panelMode = 'view';

function closeInlinePanel() {
  selectedPhysician = null;
  currentEventCtx = null;
  inlinePanel.remove();
}

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

/** Attach the panel under an event card (it disappears from anywhere else). */
function attachInlinePanel(eventLi) {
  eventLi.querySelector('.event__body').appendChild(inlinePanel);
  $panel('.schedule-status').hidden = true;
  const dateInput = $panel('.schedule-form__date');
  if (!dateInput.value) dateInput.value = todayYmd();
}

/** Matched attendee → details + call notes only (meeting already exists). */
function openPhysicianDetails(eventLi, physician, ev) {
  attachInlinePanel(eventLi);
  currentEventCtx = ev || null;
  panelMode = 'view';
  $panel('.physician-inline__title').textContent = 'Physician details';
  $panel('.physician-inline__search-wrap').hidden = true;
  selectPhysician(physician);
}

/** Unmatched attendee → empty inline search under the event. */
function openPhysicianSearch(eventLi, ev) {
  attachInlinePanel(eventLi);
  currentEventCtx = ev || null;
  panelMode = 'schedule';
  $panel('.physician-inline__title').textContent = 'Physician directory';
  selectedPhysician = null;
  $panel('.physician-profile').hidden = true;
  $panel('.physician-inline__search-wrap').hidden = false;

  // Start blank — prefilling (e.g. with the organizer's own email) just
  // surfaces irrelevant results; let the user type who they're looking for.
  const input = $panel('.physician-inline__search');
  input.value = '';
  renderPhysicianResults([]);
  input.focus();
}

function renderPhysicianResults(results) {
  const list = $panel('.physician-results');
  list.innerHTML = '';

  for (const p of results) {
    const li = document.createElement('li');
    li.className = 'physician-result';

    const name = document.createElement('strong');
    name.textContent = p.name || `NPI ${p.npi}`;

    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = [p.specialty, p.email || 'no email'].filter(Boolean).join(' · ');

    li.append(name, meta);
    if (!p.email) li.classList.add('physician-result--noemail');
    li.addEventListener('click', () => selectPhysician(p));
    list.appendChild(li);
  }
}

function renderProfileDetails(p) {
  const dl = $panel('.physician-profile__details');
  dl.innerHTML = '';

  const facilityAddress = p.facility
    ? [p.facility.address, p.facility.city, p.facility.state, p.facility.zip].filter(Boolean).join(', ')
    : null;

  const rows = [
    ['NPI', p.npi],
    ['Email', p.email || '— not on file —'],
    ['Phone', p.phone],
    ['ESD Procedure', p.esdProcedure ? 'Yes' : 'No'],
    ['Facility', p.facility?.name],
    ['Facility Type', p.facility?.type],
    ['Address', facilityAddress],
    ['LinkedIn', p.linkedinUrl],
  ];

  for (const [label, value] of rows) {
    if (!value) continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    if (label === 'LinkedIn') {
      const a = document.createElement('a');
      a.href = value;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = value;
      dd.appendChild(a);
    } else {
      dd.textContent = value;
    }
    dl.append(dt, dd);
  }
}

function selectPhysician(p) {
  selectedPhysician = p;
  $panel('.physician-results').innerHTML = '';

  $panel('.physician-profile__name').textContent = p.name || `NPI ${p.npi}`;
  $panel('.physician-profile__specialty').textContent = p.specialty || '';

  const photo = $panel('.physician-profile__photo');
  photo.hidden = !p.photoUrl;
  if (p.photoUrl) photo.src = p.photoUrl;

  renderProfileDetails(p);

  // The scheduling form only makes sense in the "Schedule call" flow — for a
  // matched attendee the meeting already exists, so show data + notes only.
  const form = $panel('.schedule-form');
  form.hidden = panelMode !== 'schedule';

  if (panelMode === 'schedule') {
    // Sensible defaults for the form.
    $panel('.schedule-form__subject').value = `Call with ${p.name || 'physician'}`;
    const status = $panel('.schedule-status');
    status.hidden = true;

    const canInvite = Boolean(p.email);
    $panel('.schedule-form__submit').disabled = !canInvite;
    if (!canInvite) {
      status.textContent = 'This physician has no email on file — invite cannot be sent.';
      status.className = 'schedule-status schedule-status--error';
      status.hidden = false;
    }
  }

  // Reset note UI for this physician, then load their history.
  $panel('.mom-form__text').value = '';
  $panel('.mom-form__status').hidden = true;
  $panel('.briefing__status').hidden = true;
  renderNotes([]);
  loadNotes(p.npi);

  // Procedure analytics load asynchronously; hidden until data arrives.
  $panel('.physician-analytics').hidden = true;
  loadAnalytics(p.npi);

  $panel('.physician-profile').hidden = false;
}

// ── Procedure analytics ─────────────────────────────────────────────────────

const fmtNum = (n) => Number(n || 0).toLocaleString();

function renderAnalytics(a) {
  // Summary chips.
  const summary = $panel('.physician-analytics__summary');
  summary.innerHTML = '';
  const chips = [
    [`${fmtNum(a.summary.totalVolume)}`, 'total procedures'],
    [`${a.summary.firstYear}–${a.summary.lastYear}`, 'active years'],
    [`${a.summary.distinctProcedures}`, 'CPT codes'],
    [`${Math.round(a.summary.snareShare * 100)}%`, 'snare used'],
  ];
  for (const [value, label] of chips) {
    const chip = document.createElement('div');
    chip.className = 'stat-chip';
    const v = document.createElement('strong');
    v.textContent = value;
    const l = document.createElement('span');
    l.className = 'muted';
    l.textContent = label;
    chip.append(v, l);
    summary.appendChild(chip);
  }

  // Volume by year — horizontal bars scaled to the busiest year.
  const years = $panel('.physician-analytics__years');
  years.innerHTML = '';
  const maxYear = Math.max(...a.byYear.map((y) => y.volume), 1);
  for (const y of a.byYear) {
    const li = document.createElement('li');
    li.className = 'bar-row';
    const label = document.createElement('span');
    label.className = 'bar-row__label';
    label.textContent = y.year;
    const track = document.createElement('span');
    track.className = 'bar-row__track';
    const fill = document.createElement('span');
    fill.className = 'bar-row__fill';
    fill.style.width = `${Math.max(4, Math.round((y.volume / maxYear) * 100))}%`;
    track.appendChild(fill);
    const val = document.createElement('span');
    val.className = 'bar-row__value muted';
    val.textContent = fmtNum(y.volume);
    li.append(label, track, val);
    years.appendChild(li);
  }

  // Payer mix.
  const payers = $panel('.physician-analytics__payers');
  payers.innerHTML = '';
  const totalPayer = a.byPayer.reduce((s, p) => s + p.volume, 0) || 1;
  for (const p of a.byPayer) {
    const li = document.createElement('li');
    li.className = 'payer-row';
    const name = document.createElement('span');
    name.textContent = p.payer || 'Unknown';
    const share = document.createElement('span');
    share.className = 'muted';
    share.textContent = `${fmtNum(p.volume)} (${Math.round((p.volume / totalPayer) * 100)}%)`;
    li.append(name, share);
    payers.appendChild(li);
  }

  // Top procedures table.
  const tbody = $panel('.physician-analytics__procs tbody');
  tbody.innerHTML = '';
  const money = (v) => (v == null ? '—' : `$${fmtNum(v)}`);
  for (const proc of a.topProcedures) {
    const tr = document.createElement('tr');
    for (const text of [
      proc.cptCode,
      proc.description || '—',
      fmtNum(proc.volume),
      money(proc.medicarePhysicianRate),
      money(proc.commercialRate),
    ]) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  // Facilities they operate at.
  const facilities = $panel('.physician-analytics__facilities');
  facilities.innerHTML = '';
  for (const f of a.facilities) {
    const li = document.createElement('li');
    li.className = 'payer-row';
    const name = document.createElement('span');
    name.textContent = [f.name, [f.city, f.state].filter(Boolean).join(', ')].filter(Boolean).join(' — ');
    const vol = document.createElement('span');
    vol.className = 'muted';
    vol.textContent = `${fmtNum(f.volume)} procedures`;
    li.append(name, vol);
    facilities.appendChild(li);
  }

  $panel('.physician-analytics').hidden = false;
}

async function loadAnalytics(npi) {
  try {
    const res = await fetch(`/api/physicians/${encodeURIComponent(npi)}/analytics`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    // Guard against a stale response after switching physicians.
    if (data.analytics && selectedPhysician?.npi === npi) renderAnalytics(data.analytics);
  } catch {
    /* analytics is best-effort */
  }
}

// ── Call notes ──────────────────────────────────────────────────────────────

function renderNotes(notes) {
  const list = $panel('.physician-history__list');
  list.innerHTML = '';

  // Heading carries the count so a long history is obvious at a glance.
  $panel('.physician-history h3').textContent = notes.length
    ? `Call notes (${notes.length})`
    : 'Call notes';

  if (!notes.length) {
    const li = document.createElement('li');
    li.className = 'physician-history__empty muted';
    li.textContent = 'No previous call notes yet.';
    list.appendChild(li);
  } else {
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

  // "Last call" reminder above the schedule form.
  const box = $panel('.schedule-form__lastnote');
  const latest = notes[0];
  box.hidden = !latest;
  if (latest) {
    $panel('.schedule-form__lastnote-date').textContent = noteDateLabel(latest);
    $panel('.schedule-form__lastnote-text').textContent = latest.notes;
  }
}

async function loadNotes(npi) {
  try {
    const res = await fetch(`/api/physicians/${encodeURIComponent(npi)}/notes`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    // Guard against a stale response after switching physicians.
    if (selectedPhysician?.npi === npi) renderNotes(data.notes || []);
  } catch {
    /* history is best-effort */
  }
}

async function submitMom(evt) {
  evt.preventDefault();
  if (!selectedPhysician) return;

  const text = $panel('.mom-form__text');
  const status = $panel('.mom-form__status');
  const notes = text.value.trim();
  if (!notes) return;

  status.textContent = 'Saving…';
  status.hidden = false;

  try {
    const res = await fetch(`/api/physicians/${encodeURIComponent(selectedPhysician.npi)}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        notes,
        eventId: currentEventCtx?.id || null,
        // Tie the note to the meeting's day (fall back to the selected date).
        meetingDate:
          (currentEventCtx?.start || '').slice(0, 10) ||
          document.getElementById('dateInput').value ||
          todayYmd(),
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);

    text.value = '';
    status.textContent = '✅ Note saved';
    loadNotes(selectedPhysician.npi);
  } catch (err) {
    status.textContent = `❌ ${err.message || 'Failed to save note'}`;
  }
}

async function searchPhysicians(q) {
  if (q.trim().length < 2) {
    renderPhysicianResults([]);
    return;
  }
  try {
    const res = await fetch(`/api/physicians/search?q=${encodeURIComponent(q)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const data = await res.json();
    renderPhysicianResults(data.results || []);
  } catch {
    /* search is best-effort; ignore transient errors */
  }
}

async function submitSchedule(evt) {
  evt.preventDefault();
  if (!selectedPhysician) return;

  const status = $panel('.schedule-status');
  const btn = $panel('.schedule-form__submit');

  const date = $panel('.schedule-form__date').value;
  const time = $panel('.schedule-form__time').value;
  const duration = Number($panel('.schedule-form__duration').value);

  const start = `${date}T${time}:00`;
  const endDate = new Date(`${start}`);
  endDate.setMinutes(endDate.getMinutes() + duration);
  const pad = (n) => String(n).padStart(2, '0');
  const end = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:00`;

  btn.disabled = true;
  status.textContent = 'Sending invite…';
  status.className = 'schedule-status';
  status.hidden = false;

  try {
    const res = await fetch('/api/calendar/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        npi: selectedPhysician.npi,
        subject: $panel('.schedule-form__subject').value,
        start,
        end,
        timeZone: getBrowserTimeZone(),
        notes: $panel('.schedule-form__notes').value,
        includePreviousNotes: $panel('.schedule-form__include-notes').checked,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);

    status.textContent = `✅ Invite sent to ${data.invitee.name} (${data.invitee.email})`;
    status.className = 'schedule-status schedule-status--ok';
    // Let the user read the confirmation, then refresh the day's events.
    setTimeout(loadCalendar, 1500);
  } catch (err) {
    status.textContent = `❌ ${err.message || 'Failed to schedule'}`;
    status.className = 'schedule-status schedule-status--error';
  } finally {
    btn.disabled = false;
  }
}

/** Email the organizer this physician's details + full call-note history. */
async function sendBriefing() {
  if (!selectedPhysician) return;

  const btn = $panel('.briefing__send');
  const status = $panel('.briefing__status');

  btn.disabled = true;
  status.textContent = 'Sending…';
  status.className = 'briefing__status muted';
  status.hidden = false;

  try {
    const res = await fetch(
      `/api/physicians/${encodeURIComponent(selectedPhysician.npi)}/send-briefing`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          eventTitle: currentEventCtx?.title || null,
          // Readable "2026-06-05 15:00" instead of the raw ISO string.
          eventStart: (currentEventCtx?.start || '').slice(0, 16).replace('T', ' ') || null,
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

// Wire the panel's controls once — the instance is reused across events.
$panel('.physician-inline__close').addEventListener('click', closeInlinePanel);
$panel('.briefing__send').addEventListener('click', sendBriefing);
$panel('.schedule-form').addEventListener('submit', submitSchedule);
$panel('.mom-form').addEventListener('submit', submitMom);
$panel('.physician-inline__search').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const q = e.target.value;
  searchDebounce = setTimeout(() => searchPhysicians(q), 250);
});

// ── Event list ───────────────────────────────────────────────────────────────

function renderEvents(events) {
  closeInlinePanel(); // re-render detaches the panel anyway; reset state too
  const list = document.getElementById('eventList');
  const tpl = document.getElementById('event-template');
  list.innerHTML = '';

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
          // Known physician — clickable chip showing details under this event.
          chip.classList.add('event__attendee--physician');
          chip.title = 'In physician directory — click to view details';
          chip.textContent = `🩺 ${rsvpIcon[a.response] || ''} ${label}`.replace(/\s+/g, ' ');
          if (a.lastNote) {
            // Reminder of the organizer's last recorded call with them.
            const hint = document.createElement('span');
            hint.className = 'event__attendee-lastcall';
            hint.textContent = `📝 last: ${a.lastNote.meetingDate || (a.lastNote.createdAt || '').slice(0, 10)}`;
            chip.appendChild(hint);
          }
          chip.addEventListener('click', () => openPhysicianDetails(li, a.physician, ev));
        } else {
          chip.title = `${a.type} · ${a.response} · not in physician directory`;
          chip.textContent = `${rsvpIcon[a.response] || ''} ${label}`.trim();

          // Offer "Schedule call" only when the attendee has no email at all —
          // someone with an email is already reachable through this meeting.
          if (!a.email) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'event__schedule-call';
            btn.textContent = '📞 Schedule call';
            btn.addEventListener('click', () => openPhysicianSearch(li, ev));
            chip.appendChild(btn);
          }
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

    list.appendChild(node);
  }
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
      document.getElementById('emptyTitle').textContent =
        data.date === todayYmd() ? 'No events today' : `No events on ${data.date}`;
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

  // Reveal the date filter, defaulted to today.
  document.getElementById('dateFilter').hidden = false;
  document.getElementById('dateInput').value = todayYmd();

  await loadCalendar();
}

// ── Wire up controls
document.getElementById('retryBtn').addEventListener('click', loadCalendar);

document.getElementById('dateInput').addEventListener('change', () => {
  if (document.getElementById('dateInput').value) loadCalendar();
});

document.getElementById('todayBtn').addEventListener('click', () => {
  document.getElementById('dateInput').value = todayYmd();
  loadCalendar();
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.reload();
});

init();
