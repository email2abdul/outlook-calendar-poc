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

  await loadCalendar();
}

// ── Wire up controls
document.getElementById('retryBtn').addEventListener('click', loadCalendar);

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  window.location.reload();
});

init();
