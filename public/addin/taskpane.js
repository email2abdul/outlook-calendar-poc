'use strict';

/**
 * Outlook Add-in task pane logic.
 *
 * Reads the currently-open calendar meeting (subject + attendees) via Office.js,
 * then asks the server's token-gated /embed/meeting-brief for the BIS
 * pre-meeting brief and renders it. Works in both read mode (opening an existing
 * meeting) and compose mode (organiser editing) — attendees come back as plain
 * arrays in read mode and via getAsync in compose mode.
 */

Office.onReady(function () {
  run();
});

function el(id) {
  return document.getElementById(id);
}

function setStatus(msg) {
  var s = el('status');
  s.textContent = msg || '';
  s.hidden = !msg;
}

function dedupe(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

function run() {
  var item = Office.context.mailbox && Office.context.mailbox.item;
  if (!item) {
    setStatus('Open a meeting to see its BIS brief.');
    return;
  }
  readMeeting(item, loadBrief);
}

/** Collect attendee emails + subject, handling read vs compose mode. */
function readMeeting(item, cb) {
  // Compose mode → async getters.
  if (item.requiredAttendees && typeof item.requiredAttendees.getAsync === 'function') {
    var emails = [];
    item.requiredAttendees.getAsync(function (r) {
      if (r.status === 'succeeded') emails = emails.concat((r.value || []).map(addr));
      item.optionalAttendees.getAsync(function (o) {
        if (o.status === 'succeeded') emails = emails.concat((o.value || []).map(addr));
        item.subject.getAsync(function (s) {
          var subject = (s.status === 'succeeded' ? s.value : '') || '';
          cb(dedupe(emails), subject);
        });
      });
    });
    return;
  }

  // Read mode → plain properties.
  var e = [];
  (item.requiredAttendees || []).forEach(function (a) {
    e.push(addr(a));
  });
  (item.optionalAttendees || []).forEach(function (a) {
    e.push(addr(a));
  });
  if (item.organizer) e.push(addr(item.organizer));
  cb(dedupe(e), item.subject || '');
}

function addr(a) {
  return a && a.emailAddress ? a.emailAddress : '';
}

function apiUrl(params) {
  var t = (window.__BIS_ADDIN__ && window.__BIS_ADDIN__.token) || '';
  return '/embed/meeting-brief?token=' + encodeURIComponent(t) + '&' + params;
}

function loadBrief(emails, subject) {
  setStatus('Loading BIS intelligence…');
  fetch(apiUrl('emails=' + encodeURIComponent(emails.join(',')) + '&subject=' + encodeURIComponent(subject)), {
    headers: { Accept: 'application/json' },
  })
    .then(function (r) {
      return r.json();
    })
    .then(render)
    .catch(function () {
      setStatus('Could not load BIS data. Please try again.');
    });
}

function loadNpi(npi) {
  setStatus('Loading…');
  fetch(apiUrl('npi=' + encodeURIComponent(npi)), { headers: { Accept: 'application/json' } })
    .then(function (r) {
      return r.json();
    })
    .then(render)
    .catch(function () {
      setStatus('Could not load. Please try again.');
    });
}

function render(data) {
  var root = el('content');
  root.innerHTML = '';

  if (!data || !data.ok) {
    setStatus('BIS add-in is not configured on the server (missing embed token).');
    return;
  }

  if (data.blocks && data.blocks.length) {
    setStatus('');
    data.blocks.forEach(function (b) {
      root.appendChild(renderBlock(b));
    });
    return;
  }

  if (data.suggestions && data.suggestions.length) {
    setStatus('No exact match. Possible physicians from the meeting — tap one:');
    var ul = document.createElement('ul');
    ul.className = 'addin-suggestions';
    data.suggestions.forEach(function (s) {
      var li = document.createElement('li');
      li.textContent =
        '🩺 ' +
        [s.name, s.facility].filter(Boolean).join(' · ') +
        (s.matchHint ? ' · 📍 ' + s.matchHint : '');
      li.addEventListener('click', function () {
        loadNpi(s.npi);
      });
      ul.appendChild(li);
    });
    root.appendChild(ul);
    return;
  }

  setStatus('No matching physician found in the BIS database for this meeting.');
}

function renderBlock(b) {
  var wrap = document.createElement('div');
  wrap.className = 'addin-block';

  var h = document.createElement('h2');
  h.className = 'addin-block__name';
  h.textContent = b.name + (b.specialty ? ' · ' + b.specialty : '');
  wrap.appendChild(h);

  // Brief HTML is server-rendered (physicianBriefHtml) — same body as the email.
  var body = document.createElement('div');
  body.className = 'physician-analytics';
  body.innerHTML = '<h3>Pre-meeting brief</h3>' + (b.html || '<p class="muted">No brief data.</p>');
  wrap.appendChild(body);

  return wrap;
}
