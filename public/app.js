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

function renderEvents(events) {
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
    const res = await fetch(`/api/calendar/today?timeZone=${encodeURIComponent(tz)}`, {
      headers: { Accept: 'application/json' },
    });

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

  // Reveal the physician scheduler and default the date picker to today.
  document.getElementById('physicianPanel').hidden = false;
  document.getElementById('meetingDate').value = new Date().toLocaleDateString('en-CA');

  await loadCalendar();
}

// ── Physician directory + scheduler ─────────────────────────────────────────

let selectedPhysician = null;
let searchDebounce = null;

function renderPhysicianResults(results) {
  const list = document.getElementById('physicianResults');
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
  const dl = document.getElementById('profileDetails');
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
  document.getElementById('physicianResults').innerHTML = '';
  document.getElementById('physicianSearch').value = p.name || p.npi;

  document.getElementById('profileName').textContent = p.name || `NPI ${p.npi}`;
  document.getElementById('profileSpecialty').textContent = p.specialty || '';

  const photo = document.getElementById('profilePhoto');
  photo.hidden = !p.photoUrl;
  if (p.photoUrl) photo.src = p.photoUrl;

  renderProfileDetails(p);

  // Sensible defaults for the form.
  document.getElementById('meetingSubject').value = `Meeting with ${p.name || 'physician'}`;
  const status = document.getElementById('scheduleStatus');
  status.hidden = true;

  const canInvite = Boolean(p.email);
  document.getElementById('scheduleBtn').disabled = !canInvite;
  if (!canInvite) {
    status.textContent = 'This physician has no email on file — invite cannot be sent.';
    status.className = 'schedule-status schedule-status--error';
    status.hidden = false;
  }

  document.getElementById('physicianProfile').hidden = false;
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

  const status = document.getElementById('scheduleStatus');
  const btn = document.getElementById('scheduleBtn');

  const date = document.getElementById('meetingDate').value;
  const time = document.getElementById('meetingTime').value;
  const duration = Number(document.getElementById('meetingDuration').value);

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
        subject: document.getElementById('meetingSubject').value,
        start,
        end,
        timeZone: getBrowserTimeZone(),
        notes: document.getElementById('meetingNotes').value,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);

    status.textContent = `✅ Invite sent to ${data.invitee.name} (${data.invitee.email})`;
    status.className = 'schedule-status schedule-status--ok';
    await loadCalendar(); // refresh today's list in case the meeting is today
  } catch (err) {
    status.textContent = `❌ ${err.message || 'Failed to schedule'}`;
    status.className = 'schedule-status schedule-status--error';
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('physicianSearch').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const q = e.target.value;
  searchDebounce = setTimeout(() => searchPhysicians(q), 250);
});

document.getElementById('scheduleForm').addEventListener('submit', submitSchedule);

// ── Wire up controls
document.getElementById('retryBtn').addEventListener('click', loadCalendar);

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.reload();
});

init();
