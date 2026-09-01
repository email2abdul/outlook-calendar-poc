'use strict';

require('isomorphic-fetch');
const { Client } = require('@microsoft/microsoft-graph-client');
const config = require('./config');
const verify = require('./enrichment/verify');

/**
 * Graph module — everything that talks to Microsoft Graph lives here so it can
 * be reused as-is by the future AI-agent integration. Functions take a raw
 * access token, keeping them decoupled from Express/sessions.
 */

/**
 * Create a Graph client that authenticates each call with the given token.
 * @param {string} accessToken
 */
function getGraphClient(accessToken) {
  return Client.init({
    baseUrl: config.graph.baseUrl,
    authProvider: (done) => done(null, accessToken),
  });
}

/**
 * Return the GMT offset (e.g. "-07:00") for an IANA time zone at `date`.
 * Used to express "today" as an offset-aware ISO range Graph understands.
 */
function offsetForTimeZone(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(date);

  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+00:00';
  const match = tzName.match(/GMT([+-]\d{2}:\d{2})/);
  return match ? match[1] : '+00:00';
}

/**
 * Compute the [start, end) ISO bounds of one calendar day in the given IANA
 * time zone, each tagged with the correct UTC offset.
 * @param {string} timeZone
 * @param {string} [dateYmd] "YYYY-MM-DD"; defaults to today in `timeZone`.
 * @returns {{ startDateTime: string, endDateTime: string, timeZone: string }}
 */
function dayRange(timeZone, dateYmd) {
  const now = new Date();

  // YYYY-MM-DD — either the requested day, or "today" as seen in the zone.
  const ymd =
    dateYmd ||
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);

  // Resolve the zone's offset *on that day* (DST-safe): use noon UTC as the
  // reference instant so we never land on the wrong side of a transition.
  const offset = offsetForTimeZone(timeZone, dateYmd ? new Date(`${ymd}T12:00:00Z`) : now);

  // Tomorrow's date for the exclusive upper bound.
  const tomorrow = new Date(`${ymd}T00:00:00${offset}`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(tomorrow);

  // Convert the offset-tagged local boundaries to UTC instants (…Z). Sending a
  // "+05:30" offset in the query string breaks — the "+" is read as a space by
  // the server. UTC has no "+", and the Prefer: outlook.timezone header still
  // returns event times converted back to the caller's zone.
  return {
    startDateTime: new Date(`${ymd}T00:00:00${offset}`).toISOString(),
    endDateTime: new Date(
      `${tomorrowYmd}T00:00:00${offsetForTimeZone(timeZone, tomorrow)}`
    ).toISOString(),
    date: ymd,
    timeZone,
  };
}

/**
 * Map a raw Graph event onto the lean shape our frontend (and agent) consumes.
 */
function normalizeEvent(event) {
  return {
    id: event.id,
    title: event.subject || '(No title)',
    start: event.start?.dateTime || null,
    end: event.end?.dateTime || null,
    timeZone: event.start?.timeZone || null,
    isAllDay: Boolean(event.isAllDay),
    // Recurrence identity. `calendarView` expands a recurring series into one
    // event per occurrence, each with its OWN id — so an occurrence-keyed
    // dedupe reads a weekly meeting as N unrelated meetings. Every occurrence
    // (and every edited "exception") carries the same `seriesMasterId`; that is
    // what tells "29 occurrences of one meeting" from "29 meetings". Null on a
    // single, non-recurring event.
    type: event.type || 'singleInstance', // singleInstance|occurrence|exception|seriesMaster
    seriesMasterId: event.seriesMasterId || null,
    location: event.location?.displayName || null,
    // bodyPreview is plain text — safe and concise for a list view.
    description: event.bodyPreview?.trim() || null,
    organizer: {
      name: event.organizer?.emailAddress?.name || null,
      email: event.organizer?.emailAddress?.address || null,
    },
    // Everyone on the invite, with their RSVP status.
    attendees: (event.attendees || []).map((a) => ({
      name: a.emailAddress?.name || null,
      email: a.emailAddress?.address || null,
      type: a.type || 'required', // required | optional | resource
      response: a.status?.response || 'none', // accepted | declined | tentativelyAccepted | none…
    })),
    onlineMeetingUrl: event.onlineMeeting?.joinUrl || null,
    webLink: event.webLink || null,
  };
}

/**
 * Fetch all of the signed-in user's calendar events for one day.
 *
 * Uses `calendarView`, which (unlike `/events`) expands recurring series into
 * concrete occurrences within the time window — exactly what "that day's
 * events" should mean.
 *
 * @param {string} accessToken
 * @param {string} [timeZone] IANA time zone (defaults to the server's).
 * @param {string} [dateYmd] "YYYY-MM-DD"; defaults to today in `timeZone`.
 * @returns {Promise<{ date: string, timeZone: string, events: object[] }>}
 */
async function getEventsForDay(accessToken, timeZone, dateYmd) {
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const { startDateTime, endDateTime, date } = dayRange(tz, dateYmd);

  const client = getGraphClient(accessToken);

  const response = await client
    .api('/me/calendarView')
    .query({ startDateTime, endDateTime })
    // Return start/end times already converted to the user's time zone.
    .header('Prefer', `outlook.timezone="${tz}"`)
    .select('subject,start,end,location,bodyPreview,isAllDay,type,seriesMasterId,organizer,attendees,onlineMeeting,webLink')
    .orderby('start/dateTime')
    .top(100)
    .get();

  const events = (response.value || [])
    .map(normalizeEvent)
    // Defensive secondary sort in case the API returns ties out of order.
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));

  return {
    date,
    timeZone: tz,
    events,
  };
}

/** Escape a string for safe interpolation into the HTML event body. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Offset (ms) between a wall-clock-as-UTC instant and how `timeZone` reads it. */
function tzOffsetMs(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(instant).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour; // some engines emit 24 at midnight
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second);
  return asUTC - instant.getTime();
}

/**
 * Resolve a Graph dateTime string + its timeZone to an absolute Date.
 * Graph gives meeting times in different zones depending on the call: the
 * reminder scan forces UTC (Prefer header) while a freshly-created event echoes
 * the organizer's local zone. Collapsing both to an instant lets us format them
 * identically so the auto-brief and the reminder show the SAME meeting time.
 */
function toInstant(dateTimeStr, timeZone) {
  if (!dateTimeStr) return null;
  const clean = String(dateTimeStr).replace(/\.\d+$/, '').replace(/Z$/, '');
  if (!timeZone || timeZone.toUpperCase() === 'UTC') return new Date(`${clean}Z`);
  const guess = new Date(`${clean}Z`);
  if (Number.isNaN(guess.getTime())) return null;
  return new Date(guess.getTime() - tzOffsetMs(guess, timeZone));
}

/**
 * Human-readable, timezone-stable meeting time for the briefing emails. Returns
 * a consistent UTC-labelled string ("1 Jul 2026, 09:30 UTC") regardless of the
 * zone Graph returned, so the schedule-time brief and the pre-meeting reminder
 * match exactly. Falls back to the raw string if it can't be parsed.
 */
function formatMeetingTime(dateTimeStr, timeZone) {
  const inst = toInstant(dateTimeStr, timeZone);
  if (!inst || Number.isNaN(inst.getTime())) return dateTimeStr || '';
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(inst) + ' UTC'
  );
}

/**
 * The Email cell, with how far that address can be trusted.
 *
 * No public registry publishes physician emails (NPPES has no such field), so
 * every address in the master is either rep-confirmed in app_contacts or an
 * unverified vendor value — and the brief has to say which, or the rep mails a
 * dead address. Inline-styled: the badge must survive an email client.
 */
function emailCellHtml(trust) {
  const BADGE = {
    verified: ['#0b6b3a', '✅ verified'],
    unverified: ['#8a6d00', '⚠️ unverified'],
    suspect: ['#b42318', '⚠️ unverified · likely stale'],
  };
  const [colour, label] = BADGE[trust.status] || BADGE.unverified;
  return (
    `${escapeHtml(trust.address)} ` +
    `<span style="color:${colour};white-space:nowrap">${label}</span>` +
    `<br><span style="color:#666;font-size:12px">${escapeHtml(trust.note)}</span>`
  );
}

/**
 * HTML details table for a physician profile (shared by invite + briefing).
 * @param {object} physician
 * @param {object} [opts]
 * @param {object} [opts.contact]      app_contacts overlay — a verified email wins
 * @param {object} [opts.verification] enrichment/verify.verifyPhysician() output
 */
function physicianDetailsTable(physician, opts = {}) {
  const trust = verify.emailTrust(physician, opts.contact || null, opts.verification || null);

  const rows = [
    ['Name', physician.name],
    ['NPI', physician.npi],
    ['Specialty', physician.specialty],
    // Pre-rendered (badge markup), so it must not be escaped again below.
    ['Email', trust ? { html: emailCellHtml(trust) } : null],
    trust?.masterEmail
      ? [
          'BIS master email',
          {
            html:
              `${escapeHtml(trust.masterEmail)} ` +
              '<span style="color:#8a6d00">⚠️ superseded by the verified address above</span>',
          },
        ]
      : null,
    ['Phone', physician.phone],
    ['ESD Procedure', physician.esdProcedure ? 'Yes' : 'No'],
    ['Facility', physician.facility?.name],
    [
      'Facility Address',
      physician.facility
        ? [physician.facility.address, physician.facility.city, physician.facility.state, physician.facility.zip]
            .filter(Boolean)
            .join(', ')
        : null,
    ],
    // Identified from the facility (see src/territory.js): health system from the
    // facility-name brand ("Independent" when none is detected), territory from
    // the state.
    ['Health System', physician.facility ? physician.facility.healthSystem || 'Independent / unaffiliated' : null],
    ['Territory', physician.facility?.territory],
    ['LinkedIn', physician.linkedinUrl],
  ]
    .filter(Boolean)
    .filter(([, v]) => v);

  const table = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 12px 2px 0;vertical-align:top"><b>${escapeHtml(k)}</b></td>` +
        `<td>${v && v.html ? v.html : escapeHtml(v)}</td></tr>`
    )
    .join('');

  return `<table>${table}</table>`;
}

/**
 * HTML "Data check" section — BIS master vs the NPPES registry.
 *
 * BIS is purchased data and goes stale: when a physician changes practice the
 * master keeps the old facility, phone and email (the email being the one that
 * bounces). NPPES is free, authoritative for practice location, and keyed by
 * the same NPI — so the brief can say "these two disagree, don't trust the
 * contact details" instead of presenting a dead address as fact.
 *
 * Renders nothing when the registry could not be reached (see verify.js).
 */
function dataCheckHtml(verification) {
  if (!verification) return '';
  const td = 'style="padding:2px 12px 2px 0;vertical-align:top"';
  const reg = verification.registry;
  const link = reg.sourceUrl
    ? ` — <a href="${escapeHtml(reg.sourceUrl)}">verify on NPPES</a>`
    : '';

  if (!verification.stale) {
    return (
      '<p style="color:#0b6b3a;margin:10px 0 0">' +
      `✅ Practice location matches the NPPES registry (${escapeHtml(
        [reg.city, reg.state].filter(Boolean).join(', ') || 'checked'
      )})${link}</p>`
    );
  }

  const bisLine = [verification.bis.facility, verification.bis.city, verification.bis.state]
    .filter(Boolean)
    .join(' — ');
  const regLine =
    [reg.address, reg.phone].filter(Boolean).join(' · ') +
    (reg.lastUpdated ? ` (registry updated ${reg.lastUpdated})` : '');

  return (
    '<div style="border-left:4px solid #b42318;background:#fff6f5;padding:8px 12px;margin:12px 0">' +
    '<p style="margin:0 0 6px"><b>⚠️ Data check — BIS and the NPPES registry disagree</b></p>' +
    '<table>' +
    `<tr><td ${td}><b>BIS master</b></td><td>${escapeHtml(bisLine || '—')}</td></tr>` +
    `<tr><td ${td}><b>NPPES registry</b></td><td>${escapeHtml(regLine || '—')}</td></tr>` +
    '</table>' +
    `<p style="margin:6px 0 0">${escapeHtml(
      `${verification.reasons.join('; ')}. The facility, phone and especially the EMAIL above ` +
        'come from the BIS master and may belong to a practice this physician has left — ' +
        'confirm before contacting.'
    )}${link}</p>` +
    '</div>'
  );
}

/**
 * Build the HTML body of a meeting invite from a physician profile, so the
 * invitee's details travel with the event itself.
 * @param {object} physician normalized profile from src/physicians.js
 * @param {string} [notes] free-text agenda from the organizer
 * @param {object} [previousNote] latest meeting note from src/notes.js — appended as a
 *   "Previous call summary" so both sides get context in the invite.
 */
function buildPhysicianBody(physician, notes, previousNote) {
  const previousSection = previousNote
    ? [
        `<p><b>Previous call summary (${escapeHtml(
          previousNote.meetingDate || (previousNote.createdAt || '').slice(0, 10)
        )})</b></p>`,
        `<p>${escapeHtml(previousNote.notes).replace(/\n/g, '<br>')}</p>`,
      ].join('')
    : '';

  return [
    notes ? `<p>${escapeHtml(notes)}</p>` : '',
    previousSection,
    '<p class="brief-h"><b>Physician details</b></p>',
    physicianDetailsTable(physician),
  ].join('');
}

/**
 * HTML "Procedure Intelligence" section — procedure-family volumes
 * (Colonoscopy / ESD / EMR / EUS) the rep needs at a glance (Lumendi spec).
 * Returns '' when no family data is available.
 */
function procedureIntelligenceHtml(byFamily) {
  if (!byFamily?.families?.length) return '';
  const num = (v) => Number(v || 0).toLocaleString();
  const td = 'style="padding:2px 12px 2px 0"';

  const rows = byFamily.families
    .map((f) => {
      const share = byFamily.total ? Math.round((f.volume / byFamily.total) * 100) : 0;
      const codes = f.cptCodes.length ? ` <span style="color:#888">(CPT ${escapeHtml(f.cptCodes.join(', '))})</span>` : '';
      return (
        `<tr><td ${td}><b>${escapeHtml(f.label)}</b></td>` +
        `<td ${td}>${num(f.volume)} (${share}%)</td><td>${codes}</td></tr>`
      );
    })
    .join('');

  return (
    '<p class="brief-h"><b>Procedure Intelligence</b></p>' +
    `<table>${rows}</table>`
  );
}

/**
 * HTML "Commercial Signals" section (Lumendi spec) — volume growth trend,
 * emerging advanced techniques (ESD/EMR/EUS), and therapeutic adoption.
 * Returns '' when no signals are available.
 * @param {object} signals from analytics.commercialSignals
 * @param {object} [summary] analytics.summary (for snare share)
 */
function commercialSignalsHtml(signals, summary, lumendiAccount) {
  if (!signals && !lumendiAccount) return '';
  const pct = (v) => `${v >= 0 ? '+' : ''}${v}%`;
  const items = [];

  const g = signals?.growthTrend;
  if (g && g.yoyPct != null) {
    const arrow = g.direction === 'up' ? '▲' : g.direction === 'down' ? '▼' : '▬';
    const color = g.direction === 'up' ? '#0a0' : g.direction === 'down' ? '#c00' : '#888';
    const overall =
      g.overallPct != null && g.firstYear !== g.latestYear
        ? ` · ${pct(g.overallPct)} since ${g.firstYear}`
        : '';
    // Year range, not "YoY" — the physician's populated years may be non-consecutive.
    items.push(
      `<li><b>Growth trend:</b> <span style="color:${color}">${arrow} ${pct(g.yoyPct)}</span> ` +
        `(${g.prevYear}→${g.latestYear})${overall}</li>`
    );
  }

  const advanced = (signals?.emerging || []).filter((e) => e.isRecent);
  if (advanced.length) {
    const parts = advanced.map((e) => {
      const tag = e.isNew ? ' <span style="color:#0a0">🟢 new</span>' : '';
      return `${escapeHtml(e.family)} (${Number(e.recentVolume).toLocaleString()})${tag}`;
    });
    items.push(`<li><b>Advanced techniques (ESD/EMR/EUS):</b> ${parts.join(', ')}</li>`);
  }

  if (signals?.therapeuticShare != null) {
    const snare =
      summary && summary.snareShare != null
        ? ` · snare used ${Math.round(summary.snareShare * 100)}%`
        : '';
    items.push(
      `<li><b>Therapeutic adoption:</b> ${Math.round(signals.therapeuticShare * 100)}% of categorized volume${snare}</li>`
    );
  }

  // Existing Lumendi account status (P5).
  if (lumendiAccount) {
    const label = lumendiAccount.isActiveUser ? 'Lumendi account' : 'Lumendi status';
    const product = lumendiAccount.product ? ` — ${escapeHtml(lumendiAccount.product)}` : '';
    const status = lumendiAccount.status ? escapeHtml(lumendiAccount.status) : 'unknown';
    const since = lumendiAccount.sinceDate ? ` since ${escapeHtml(lumendiAccount.sinceDate)}` : '';
    items.push(`<li><b>${label}:</b> ${status}${product}${since}</li>`);
  }

  if (!items.length) return '';
  return '<p class="brief-h"><b>Commercial Signals</b></p>' + `<ul style="margin:4px 0">${items.join('')}</ul>`;
}

/**
 * HTML "Account Opportunity" section (Lumendi spec) — other physicians at the
 * facility and the procedures they perform, so the rep knows who else to engage.
 * Returns '' when there are no peers.
 * @param {object} opp from analytics.accountOpportunity
 */
function accountOpportunityHtml(opp) {
  if (!opp || !opp.peers?.length) return '';
  const num = (v) => Number(v || 0).toLocaleString();
  const td = 'style="padding:2px 12px 2px 0"';

  const where = opp.facility?.name ? ` at <b>${escapeHtml(opp.facility.name)}</b>` : ' at this facility';
  const n = opp.performingCount;
  // Lumendi usage at the facility (P5) — e.g. "1 physician currently using a Lumendi product."
  const u = opp.lumendiUserCount || 0;
  const lumendiLine = u
    ? `<p>${u} physician${u === 1 ? '' : 's'}${where} currently use${u === 1 ? 's' : ''} a Lumendi product. ` +
      `${n} other${n === 1 ? '' : 's'} perform relevant procedures.</p>`
    : `<p>${n} other physician${n === 1 ? '' : 's'}${where} perform relevant procedures` +
      `${opp.truncated ? ' (top by volume)' : ''}.</p>`;

  const rows = opp.peers
    .map((p) => {
      const fams = p.families?.length
        ? ` <span style="color:#888">(${escapeHtml(p.families.join(', '))})</span>`
        : '';
      // nowrap span keeps the count on one line; in-app the table cell allows
      // breaking anywhere (so long emails wrap) which would otherwise split the
      // number itself. Inline style → renders identically in email.
      const activity = p.volume ? `<span style="white-space:nowrap">${num(p.volume)} proc</span>${fams}` : '—';
      const lumendi = p.lumendiProduct
        ? ` <span style="color:#0a0">● ${escapeHtml(p.lumendiProduct)}</span>`
        : '';
      const contact = [p.email, p.phone].filter(Boolean).map(escapeHtml).join(' · ') || '—';
      // data-labels drive the mobile stacked-card layout (.brief-cards); inert
      // in email clients so the emailed table is unchanged.
      return (
        `<tr><td ${td} data-label="Physician"><b>${escapeHtml(p.name || p.npi)}</b>${lumendi}</td>` +
        `<td ${td} data-label="Specialty">${escapeHtml(p.specialty || '—')}</td>` +
        `<td ${td} data-label="Volume">${activity}</td><td data-label="Contact">${contact}</td></tr>`
      );
    })
    .join('');

  return (
    '<p class="brief-h"><b>Account Opportunity</b></p>' +
    lumendiLine +
    `<table class="brief-cards">${rows}</table>`
  );
}

/**
 * HTML "Contact Intelligence" section (Lumendi spec, P4) — verified mobile /
 * LinkedIn / email plus the trust metadata (confidence, last verified, last
 * refresh) from the app_contacts overlay. Returns '' when no overlay exists
 * (the base email/phone/linkedin already appear in the physician details).
 * @param {object} physician normalized directory profile
 * @param {object} contact from contacts-store.getContact (or null)
 */
function contactIntelligenceHtml(physician, contact) {
  if (!contact) return '';
  const td = 'style="padding:2px 12px 2px 0"';
  const rows = [
    ['Verified email', contact.email],
    ['Verified mobile', contact.mobile],
    ['Verified LinkedIn', contact.linkedinUrl],
  ].filter(([, v]) => v);

  const meta = [];
  if (contact.confidenceScore != null) meta.push(`Confidence ${contact.confidenceScore}%`);
  if (contact.lastVerified) meta.push(`Verified ${escapeHtml(contact.lastVerified)}`);
  if (contact.lastRefresh) meta.push(`Refreshed ${escapeHtml(contact.lastRefresh)}`);

  if (!rows.length && !meta.length) return '';

  const table = rows.length
    ? '<table>' +
      rows
        .map(([k, v]) => `<tr><td ${td}><b>${escapeHtml(k)}</b></td><td>${escapeHtml(v)}</td></tr>`)
        .join('') +
      '</table>'
    : '';
  const metaLine = meta.length ? `<p style="color:#555">${meta.join(' · ')}</p>` : '';

  return '<p class="brief-h"><b>Contact Intelligence</b></p>' + table + metaLine;
}

/**
 * HTML "Recommended product" section — the best-fit Lumendi product for this
 * physician, scored from their procedure-family profile (src/product-fit.js).
 * Returns '' when there's no fit data. When the physician has no advanced
 * volume the scorer returns a `note` (and no recommendation) — we surface that
 * so the rep knows WHY nothing is recommended rather than seeing an empty gap.
 * @param {object} fit from analytics.productFit
 */
function productFitHtml(fit) {
  if (!fit) return '';

  if (!fit.recommended) {
    return fit.note
      ? `<p class="brief-h"><b>Recommended product</b></p><p><i>${escapeHtml(fit.note)}</i></p>`
      : '';
  }

  const r = fit.recommended;
  const fams = r.matchedFamilies?.length
    ? ` <span style="color:#888">(${escapeHtml(r.matchedFamilies.join(', '))})</span>`
    : '';
  const tag = r.isExpansion
    ? ' <span style="color:#0a7">— expansion</span>'
    : '';
  const current = fit.current
    ? `<p style="margin:2px 0 0"><i>Current account:</i> ${escapeHtml(fit.current.product)}` +
      `${fit.current.status ? ` (${escapeHtml(fit.current.status)})` : ''}</p>`
    : '';
  const others = (fit.ranked || []).filter((p) => p.productName !== r.productName);
  const alt = others.length
    ? '<p style="margin:6px 0 0"><i>Other candidates:</i> ' +
      others.map((p) => escapeHtml(p.productName)).join(', ') +
      '</p>'
    : '';

  return (
    '<p class="brief-h"><b>Recommended product</b></p>' +
    `<p style="margin:6px 0 0"><b>${escapeHtml(r.productName)}</b>${fams}${tag}` +
    `${r.strength ? ` <span style="color:#888">· ${escapeHtml(r.strength)}</span>` : ''}</p>` +
    `<p style="margin:2px 0 0">${escapeHtml(r.reason)}</p>` +
    current +
    alt
  );
}

/**
 * HTML "What to Discuss" section (Lumendi spec, Product Context Layer) —
 * product talking points matched to the physician's procedure families.
 * Returns '' when there's no matched product context.
 * @param {object} ctx from analytics.productContext
 */
function productContextHtml(ctx) {
  if (!ctx?.products?.length) return '';

  const blocks = ctx.products
    .map((p) => {
      const fams = p.matchedFamilies?.length
        ? ` <span style="color:#888">(${escapeHtml(p.matchedFamilies.join(', '))})</span>`
        : '';
      const bullets = (list, label) =>
        list?.length
          ? `<p style="margin:2px 0 0"><i>${escapeHtml(label)}:</i></p><ul style="margin:0 0 4px">` +
            list.map((t) => `<li>${escapeHtml(t)}</li>`).join('') +
            '</ul>'
          : '';
      return (
        `<p style="margin:6px 0 0"><b>${escapeHtml(p.productName)}</b>${fams}` +
        (p.summary ? ` — ${escapeHtml(p.summary)}` : '') +
        '</p>' +
        bullets(p.talkingPoints, 'Talking points') +
        bullets(p.valueProps, 'Value') +
        bullets(p.differentiation, 'Differentiation') +
        bullets(p.reimbursement, 'Reimbursement')
      );
    })
    .join('');

  return '<p class="brief-h"><b>What to Discuss</b></p>' + blocks;
}

/** HTML "Procedure analytics" section for the briefing email (or '' if none). */
function analyticsHtml(a) {
  if (!a) return '';

  const money = (v) => (v == null ? '—' : `$${Number(v).toLocaleString()}`);
  const num = (v) => Number(v || 0).toLocaleString();
  const td = 'style="padding:2px 12px 2px 0"';

  const summary =
    `<p>Total procedures: <b>${num(a.summary.totalVolume)}</b> ` +
    `(${a.summary.firstYear}–${a.summary.lastYear}) · ` +
    `${a.summary.distinctProcedures} CPT codes · ` +
    `snare used ${Math.round(a.summary.snareShare * 100)}%</p>`;

  const years =
    '<p class="brief-h"><b>Volume by year</b></p><table>' +
    a.byYear.map((y) => `<tr><td ${td}>${y.year}</td><td>${num(y.volume)}</td></tr>`).join('') +
    '</table>';

  const totalPayer = a.byPayer.reduce((s, p) => s + p.volume, 0) || 1;
  const payers =
    '<p class="brief-h"><b>Payer mix</b></p><table>' +
    a.byPayer
      .map(
        (p) =>
          `<tr><td ${td}>${escapeHtml(p.payer || 'Unknown')}</td>` +
          `<td>${num(p.volume)} (${Math.round((p.volume / totalPayer) * 100)}%)</td></tr>`
      )
      .join('') +
    '</table>';

  // The class + data-label attributes drive a mobile "stacked card" layout in
  // the in-app brief (see .brief-cards in styles.css) so this wide 5-column
  // table stays clean on phones instead of scrolling/crushing. Classes and
  // data-* are inert in email clients (and th renders bold like the old <b>
  // headers), so the emailed table is visually unchanged. thead headers carry
  // inline left-align/padding to match the previous bold-<td> header look.
  const th = 'style="text-align:left;padding:2px 12px 2px 0"';
  const procs =
    '<p class="brief-h"><b>Top procedures</b></p><div class="table-scroll"><table class="brief-proc brief-cards">' +
    `<thead><tr><th ${th}>CPT</th><th ${th}>Procedure</th><th ${th}>Volume</th>` +
    `<th ${th}>Medicare</th><th style="text-align:left">Commercial</th></tr></thead><tbody>` +
    a.topProcedures
      .map(
        (p) =>
          `<tr><td ${td} data-label="CPT">${escapeHtml(p.cptCode)}</td>` +
          `<td ${td} data-label="Procedure">${escapeHtml(p.description || '—')}</td>` +
          `<td ${td} data-label="Volume">${num(p.volume)}</td>` +
          `<td ${td} data-label="Medicare">${money(p.medicarePhysicianRate)}</td>` +
          `<td data-label="Commercial">${money(p.commercialRate)}</td></tr>`
      )
      .join('') +
    '</tbody></table></div>';

  const facilities =
    '<p class="brief-h"><b>Facilities</b></p><table>' +
    a.facilities
      .map((f) => {
        const where = [f.name, [f.city, f.state].filter(Boolean).join(', ')].filter(Boolean).join(' — ');
        return `<tr><td ${td}>${escapeHtml(where)}</td><td>${num(f.volume)} procedures</td></tr>`;
      })
      .join('') +
    '</table>';

  return [
    procedureIntelligenceHtml(a.byFamily),
    commercialSignalsHtml(a.commercialSignals, a.summary, a.lumendiAccount),
    '<p class="brief-h"><b>Procedure analytics</b></p>',
    summary,
    years,
    payers,
    procs,
    facilities,
  ].join('');
}

/**
 * Email the organizer (salesperson) a briefing about a physician: profile
 * details, procedure analytics, plus their full meeting-note history — sent
 * via Graph sendMail to the signed-in user's own mailbox.
 *
 * @param {string} accessToken
 * @param {object} opts
 * @param {string} opts.toEmail organizer's address
 * @param {object} opts.physician normalized profile
 * @param {object[]} opts.notes meeting-note history (newest first) from src/notes.js
 * @param {object} [opts.analytics] from src/analytics.js (facilities labelled)
 * @param {{title?: string, start?: string}} [opts.event] meeting context
 */
/**
 * The brief body (details + contact + procedure/commercial analytics + account
 * opportunity + what-to-discuss) shared by BOTH the email and the in-app brief,
 * so they always match. Each section returns '' when that physician has no data
 * for it, so nothing irrelevant is shown. Notes/intro are added by the caller.
 */
function physicianBriefHtml({ physician, analytics, contact, verification }) {
  return [
    '<p class="brief-h"><b>Physician details</b></p>',
    physicianDetailsTable(physician, { contact, verification }),
    dataCheckHtml(verification),
    contactIntelligenceHtml(physician, contact),
    analyticsHtml(analytics),
    accountOpportunityHtml(analytics?.accountOpportunity),
    productFitHtml(analytics?.productFit),
    productContextHtml(analytics?.productContext),
  ].join('');
}

/**
 * Pre-meeting notes for a physician who is NOT in the BIS master.
 *
 * Same sections, same order, same labels as physicianBriefHtml — that is the
 * whole point. A rep should not have to learn a second layout for the half of
 * their calendar that Supabase has never heard of, and a section that silently
 * disappears reads as "nothing to know here" rather than "we could not find
 * out". So every row is printed, and a field no source could fill says
 * "Data not available" in its own place.
 *
 * The EXTRA block is intelligence the master has no column for at all — licence,
 * taxonomies, NPI status today, and (later) CMS volumes and industry payments.
 * It is labelled as extra and carries the page it came from, because it is NOT
 * BIS-verified data and must never read as though it were.
 *
 * @param {object} opts
 * @param {object} opts.record        a store record (mirror fields, nulls intact)
 * @param {object} [opts.extra]       { label: value } the source could add
 * @param {object} [opts.cms]         CMS by-provider-and-service result, if any
 * @param {object} [opts.agreement]   { confirmed, on[], by[] } — do the sources agree?
 * @param {number} [opts.confidence]  0-100, how sure we are this is the person
 * @param {string[]} [opts.matchReasons]  why that number
 * @param {object} [opts.nameIncomplete] { name, missing, total } when the
 *        meeting gave only half a name — the notes ask for the rest
 * @param {string} [opts.sourceName]  e.g. "NPPES NPI Registry"
 * @param {string} [opts.sourceUrl]   the page that proves it
 */
function outsideBriefHtml({
  record,
  extra = {},
  cms = null,
  agreement = null,
  confidence = null,
  matchReasons = [],
  nameIncomplete = null,
  sourceName,
  sourceUrl,
} = {}) {
  if (!record) return '';
  const r = record;
  const td = 'style="padding:2px 12px 2px 0;vertical-align:top"';
  const NA = '<span style="color:#8a8f98">Data not available</span>';

  const cell = (v) => (v === null || v === undefined || v === '' ? NA : escapeHtml(String(v)));
  const table = (rows) =>
    `<table>${rows
      .map(([k, v]) => `<tr><td ${td}><b>${escapeHtml(k)}</b></td><td>${v && v.html ? v.html : cell(v)}</td></tr>`)
      .join('')}</table>`;

  const link = sourceUrl
    ? `<a href="${escapeHtml(sourceUrl)}">${escapeHtml(sourceName || 'source')}</a>`
    : escapeHtml(sourceName || 'a public registry');

  const out = [];

  // The first thing the rep must know: this is not your data.
  out.push(
    '<p style="margin:0 0 10px;padding:8px 10px;border-left:3px solid #8a5700;background:#fff8e6;' +
      `color:#8a5700"><b>⚠️ Not in the BIS database.</b> The notes below were assembled from ` +
      `${link}. Anything BIS would normally supply and this source could not is marked ` +
      '"Data not available".</p>'
  );

  // ── How sure are we that this is the right person? ────────────────────────
  // A brief with no number invites the rep to treat a 55% guess exactly like a
  // 95% certainty. The number and its reasons travel together, so it can be
  // argued with rather than believed.
  if (Number.isFinite(confidence)) {
    const strong = confidence >= 70;
    const [c, bg] = strong ? ['#0b6b3a', '#eefaf3'] : ['#8a5700', '#fff8e6'];
    const why = (matchReasons || []).length ? ` — ${escapeHtml(matchReasons.join(', '))}` : '';
    const confirmedBy =
      agreement?.confirmed && (agreement.by || []).length > 1
        ? ` Confirmed by ${escapeHtml(agreement.by.join(' and '))} (${escapeHtml(
            (agreement.on || []).join(', ')
          )} agree).`
        : '';
    out.push(
      `<p style="margin:0 0 10px;padding:8px 10px;border-left:3px solid ${c};background:${bg};` +
        `color:${c}"><b>${strong ? '✅' : '⚠️'} Identity confidence: ${confidence}%</b>${why}.` +
        confirmedBy +
        (strong ? '' : ' Treat as a suggestion and confirm before acting on it.') +
        '</p>'
    );
  }

  // ── The meeting only gave half a name ────────────────────────────────────
  // Nothing downstream can fix this, and the rep can — in five seconds, in the
  // invite. So the ask is specific about which half is missing.
  if (nameIncomplete?.name) {
    const which =
      nameIncomplete.missing === 'first'
        ? 'the <b>first name</b> is missing'
        : nameIncomplete.missing === 'last'
          ? 'the <b>last name</b> is missing'
          : 'the full name is not written out';
    const howMany = Number.isFinite(nameIncomplete.total) && nameIncomplete.total > 1
      ? ` “${escapeHtml(nameIncomplete.name)}” alone matches ${nameIncomplete.total} physicians.`
      : '';
    out.push(
      '<p style="margin:0 0 10px;padding:8px 10px;border-left:3px solid #7a2048;background:#fdf0f4;' +
        `color:#7a2048"><b>✍️ Please write the physician's full name on the meeting</b> — ` +
        `${which}.${howMany} With the full name this brief can be matched exactly.</p>`
    );
  }

  // NPPES already returns a full "street, city, ST zip" string, so appending the
  // parts again produced "1 Main St, Houston, TX 77002, Houston, TX, 77002".
  // Add only what the address does not already say.
  const said = String(r.facilityAddress || '').toLowerCase();
  const address =
    [r.facilityAddress, ...[r.city, r.state, r.zip].filter((v) => v && !said.includes(String(v).toLowerCase()))]
      .filter(Boolean)
      .join(', ') || null;

  out.push(
    '<p class="brief-h"><b>Physician details</b></p>',
    table([
      ['Name', r.name],
      ['NPI', r.npi],
      ['Specialty', r.specialty],
      ['Email', r.email],
      ['Phone', r.phone],
      // null means "we do not know", which is not the same as "No".
      ['ESD Procedure', r.esdProcedure == null ? null : r.esdProcedure ? 'Yes' : 'No'],
      ['Facility', r.facilityName],
      ['Facility Address', address],
      ['Health System', r.healthSystem],
      ['Territory', r.territory],
      ['LinkedIn', r.linkedinUrl],
    ])
  );

  out.push(
    '<p class="brief-h"><b>Contact intelligence</b></p>',
    table([
      ['Verified email', r.contactEmail],
      ['Mobile', r.contactMobile],
      ['LinkedIn (verified)', r.contactLinkedinUrl],
      // `== null` on purpose: a record assembled from a source has these keys
      // UNDEFINED, not null, and a strict check printed "undefined/100".
      ['Contactability', r.contactConfidenceScore == null ? null : `${r.contactConfidenceScore}/100`],
      ['Last verified', r.contactLastVerified],
    ])
  );

  // ── Procedure intelligence ────────────────────────────────────────────────
  // bis_procedure_volumes has no row for this physician, but Medicare claims do
  // — by year, per code. This is the section that turns a name into a practice,
  // so when CMS answered it is rendered in full; when it did not, the section
  // still exists and says why.
  out.push('<p class="brief-h"><b>Procedure intelligence</b></p>');

  const cmsYears = (cms?.years || []).filter((y) => (y.lines || []).length);
  if (cmsYears.length) {
    const money = (n) =>
      n === null || n === undefined ? NA : `$${Math.round(n).toLocaleString('en-US')}`;
    const count = (n) => (n === null || n === undefined ? NA : n.toLocaleString('en-US'));

    for (const y of cmsYears) {
      out.push(
        `<p style="margin:8px 0 4px"><b>${escapeHtml(y.year)}</b> — ` +
          `${count(y.services)} services · ${count(y.beneficiaries)} beneficiaries · ` +
          `${money(y.allowed)} Medicare allowed · ${count(y.codes)} distinct codes</p>`,
        '<table><tr>' +
          ['CPT/HCPCS', 'Procedure', 'Services', 'Patients', 'Avg allowed']
            .map(
              (h, i) =>
                // The number columns are narrow; without this "Avg allowed"
                // wraps to "Avg allowe / d" on a phone-width panel.
                `<td style="padding:2px 12px 2px 0;vertical-align:top` +
                `${i === 1 ? '' : ';white-space:nowrap'}"><b>${h}</b></td>`
            )
            .join('') +
          '</tr>' +
          y.lines
            .map(
              (l) =>
                `<tr><td style="padding:2px 12px 2px 0;vertical-align:top;white-space:nowrap">${cell(l.hcpcs)}</td>` +
                // CMS reports the same code twice when it was billed in both a
                // facility and an office, and the two are commercially
                // different (a hospital endoscopy suite is not a clinic room).
                // Labelling the row is why the repetition makes sense.
                `<td ${td}>${cell(l.description)}` +
                (l.placeOfService ? ` <span style="color:#5a6672">(${escapeHtml(l.placeOfService)})</span>` : '') +
                '</td>' +
                `<td style="padding:2px 12px 2px 0;vertical-align:top;white-space:nowrap">${count(l.services)}</td>` +
                `<td style="padding:2px 12px 2px 0;vertical-align:top;white-space:nowrap">${count(l.beneficiaries)}</td>` +
                `<td style="padding:2px 12px 2px 0;vertical-align:top;white-space:nowrap">${money(l.avgAllowed)}</td></tr>`
            )
            .join('') +
          '</table>' +
          (y.truncated
            ? `<p style="margin:2px 0 8px;color:#5a6672;font-size:12px">Top ${y.lines.length} of ` +
              `${count(y.codes)} codes by volume.</p>`
            : '')
      );
    }

    const cmsLink = cms.externalSourceUrl
      ? `<a href="${escapeHtml(cms.externalSourceUrl)}">CMS Medicare Physician & Other Practitioners</a>`
      : 'CMS Medicare Physician &amp; Other Practitioners';
    out.push(
      `<p style="margin:2px 0 10px;color:#5a6672;font-size:12px">Source: ${cmsLink}, ` +
        'by provider and service. Medicare fee-for-service claims only — not all payers, ' +
        `so these are a floor, not this physician's total volume.</p>`
    );
  } else {
    // Distinguish "CMS has no claims for this NPI" from "CMS could not be
    // reached": the first is a fact about the physician, the second is not.
    const blind = (cms?.unreachableYears || []).length ? cms.unreachableYears.join(', ') : null;
    out.push(
      table([
        ['CPT volumes', null],
        ['Procedure families', null],
        ['Commercial signals', null],
        ['Best-fit product', null],
      ]),
      '<p style="margin:2px 0 10px;color:#5a6672;font-size:12px">' +
        (blind
          ? `📡 CMS claims data could not be read for ${escapeHtml(blind)} — this is a source ` +
            'outage, not a finding about this physician. Retry from the meeting.'
          : cms
            ? 'CMS Medicare claims list no services for this NPI in the years read. ' +
              'Medicare fee-for-service only, so a private-payer practice can be absent.'
            : 'Volume-based sections need this physician in <code>bis_procedure_volumes</code>, ' +
              'or Medicare claims under their NPI.') +
        '</p>'
    );
  }

  out.push(
    '<p class="brief-h"><b>Account</b></p>',
    table([
      ['Lumendi product', r.accountProduct],
      ['Account status', r.accountStatus],
      ['Since', r.accountSinceDate],
    ])
  );

  // ── EXTRA — no BIS column exists for any of this ──────────────────────────
  const extraRows = Object.entries(extra || {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => [fieldLabel(k), Array.isArray(v) ? v.join('; ') : v]);

  if (extraRows.length) {
    out.push(
      '<p class="brief-h"><b>Extra intelligence</b> ' +
        '<span style="font-size:11px;color:#5b21b6;border:1px solid #c4b5fd;background:#f6f2ff;' +
        'border-radius:9px;padding:1px 6px">EXTRA · not in BIS</span></p>',
      table(extraRows),
      `<p style="margin:2px 0 10px;color:#5a6672;font-size:12px">Source: ${link}. ` +
        'Extra fields are shown for context and are not stored in your database.</p>'
    );
  }

  return out.join('');
}

// ── External (enriched) brief ────────────────────────────────────────────────

/**
 * Reading order for the enriched brief.
 *
 * The profile is built tier by tier, so its key order reflects which source
 * answered first — which rendered as "NPI, City, Name, Phone…". A physician's
 * name belongs at the top, and the facility block belongs together; mirror the
 * order physicianBriefHtml already uses so the two briefs read alike.
 * Anything not listed keeps a stable alphabetical position at the end.
 */
const FIELD_ORDER = [
  'name', 'credential', 'npi', 'specialty', 'email', 'phone',
  'address', 'city', 'state',
  'facility', 'facilityAddress', 'healthSystem', 'territory',
];

const EXTRA_ORDER = [
  'jobTitle', 'institution',
  'industryPayments', 'payingCompanies', 'paymentProducts',
  'publications', 'recentPublications', 'clinicalTrials',
  'facilityType', 'facilityOwnership', 'facilityRating', 'facilityPhone', 'facilityCcn',
  'licenseNumber', 'licenseState', 'npiEnumerated', 'taxonomies',
  'evidenceUrls', 'identityReasoning',
];

/** Field entries in reading order, unlisted keys alphabetical at the end. */
function orderedEntries(bag, order) {
  const rank = (key) => {
    const i = order.indexOf(key);
    return i === -1 ? order.length : i;
  };
  return Object.entries(bag || {}).sort(
    ([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)
  );
}

/**
 * A link whose TEXT is short and readable, with the full URL on href/title.
 *
 * Printing a raw URL as the link text broke the layout: PubMed search URLs
 * carry the whole narrowing query percent-encoded, which is ~200 characters
 * with no spaces, so it could not wrap and pushed the card past its container.
 * A hostname-plus-path label is both un-overflowable and easier to read; the
 * exact URL is still one hover (or click) away.
 *
 * `word-break` is inline as well as in the stylesheet because the same HTML is
 * emailed, where no stylesheet is loaded.
 */
function sourceLink(url, { maxLength = 52 } = {}) {
  const raw = String(url || '');
  if (!raw) return '';

  let label = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    label = `${parsed.hostname.replace(/^www\./i, '')}${path}`;
  } catch {
    /* not a parseable URL — fall back to the trimmed string */
  }
  if (label.length > maxLength) label = `${label.slice(0, maxLength - 1)}…`;

  return (
    `<a href="${escapeHtml(raw)}" title="${escapeHtml(raw)}" ` +
    `style="color:#0f6cbd;word-break:break-word">${escapeHtml(label)}</a>`
  );
}

/**
 * One provenance-tagged field as a table row: badge, value, source, and — for
 * anything sourced from the open web — a link that proves it.
 */
function provenanceRow(label, f) {
  if (!f) return '';

  // A list of proof URLs is only useful if it is clickable.
  const values = Array.isArray(f.value) ? f.value : [f.value];
  const rendered = values
    .map((v) => {
      const text = String(v);
      return /^https?:\/\//i.test(text) ? sourceLink(text) : escapeHtml(text);
    })
    .join(Array.isArray(f.value) ? '<br>' : ', ');

  const link = f.sourceUrl
    ? ` <a href="${escapeHtml(f.sourceUrl)}" style="color:#0f6cbd;text-decoration:none">🔗</a>`
    : '';
  return (
    `<tr><td style="padding:3px 12px 3px 0;vertical-align:top"><b>${escapeHtml(label)}</b></td>` +
    `<td style="padding:3px 0;vertical-align:top">${rendered}` +
    `<span style="color:#777;font-size:12px"> — ${f.badge} ${escapeHtml(f.source)}${link}</span>` +
    '</td></tr>'
  );
}

/** Labels that camelCase-splitting alone would render awkwardly. */
const FIELD_LABELS = {
  npi: 'NPI',
  npiEnumerated: 'NPI registered',
  facilityCcn: 'Facility CCN',
  evidenceUrls: 'Evidence',
  identityReasoning: 'How we identified them',
  jobTitle: 'Title',
  licenseNumber: 'License #',
  // The auto-capitaliser turns these into "Npi Status" / "Ruc Aurban".
  npiStatus: 'NPI status',
  licenseState: 'License state',
  ruralUrban: 'Practice area',
  medicareParticipating: 'Medicare participating',
  paymentProducts: 'Products paid for',
  recentPublications: 'Recent publications',
};

/** Turn a camelCase profile key into a readable label. */
function fieldLabel(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const words = key.replace(/([A-Z])/g, ' $1').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The pre-meeting brief for someone who is NOT in the BIS master — assembled
 * from public registries and the open web by src/enrichment.
 *
 * Deliberately a sibling of physicianBriefHtml rather than a branch inside it:
 * this brief carries things the BIS one never does — a per-field source badge,
 * proof links, disagreements between sources, and an "Extra Intelligence"
 * section for facts bis_* has no column for. The rep must always be able to see
 * at a glance which numbers are theirs and which came from outside.
 *
 * @param {object} result the object returned by enrichment.enrich()
 */
function externalBriefHtml(result) {
  if (!result) return '';
  const profile = result.profile || { fields: {}, extra: {}, conflicts: [], notes: [], sources: [] };
  const out = [];

  // ── Origin banner — the first thing the rep must know ─────────────────────
  const banners = {
    external: ['#8a5700', '#fff8e6', '⚠️', 'Not in your BIS database — profile assembled from external sources.'],
    ambiguous: ['#8a5700', '#fff8e6', '⚠️', `Possible match only (${result.confidence}% confident) — confirm before using.`],
    facility_only: ['#8a5700', '#fff8e6', '⚠️', 'Person could not be identified — facility information only.'],
    unresolved: ['#7a2048', '#fdf0f4', '❔', 'Could not identify this person from the available sources.'],
    // Distinct from `unresolved` on purpose: one is an answer, the other is the
    // absence of one. Showing the "could not identify" banner for a DNS failure
    // tells the rep something false about the physician.
    lookup_failed: ['#7a2048', '#fdf0f4', '📡', 'Lookup could not run — the provider registries were unreachable from this server. This is NOT a finding about this person; retry once connectivity is restored.'],
    not_physician: ['#7a2048', '#fdf0f4', '🚫', 'Identified as a non-physician — no physician brief produced.'],
    recovered_in_bis: ['#0b6b3a', '#eefaf3', '✅', 'Matched into BIS by NPI — the physician IS in the master; the address or name on the meeting simply did not match it.'],
    in_bis: ['#0b6b3a', '#eefaf3', '✅', 'Already in your BIS database.'],
  };
  const [colour, bg, icon, text] = banners[result.status] || banners.unresolved;
  out.push(
    `<p style="margin:0 0 10px;padding:8px 10px;border-left:3px solid ${colour};` +
      `background:${bg};color:${colour}"><b>${icon} ${escapeHtml(text)}</b></p>`
  );

  // A source that never answered is called out even when the rest of the
  // cascade produced a usable profile — otherwise a thin brief looks like a
  // complete one, and the rep reads a gap as a fact.
  if ((result.sourcesDown || []).length) {
    const down = result.sourcesDown
      .map((o) => `${escapeHtml(o.source)}${o.host ? ` (${escapeHtml(o.host)})` : ''}`)
      .join(', ');
    out.push(
      `<p style="margin:0 0 10px;padding:8px 10px;border-left:3px solid #8a5700;background:#fff8e6;` +
        `color:#8a5700"><b>📡 Incomplete — source unreachable:</b> ${down}. ` +
        'Anything those sources supply is missing from this brief, not missing from the registry.</p>'
    );
  }

  if (result.matchedFacility) {
    out.push(
      `<p style="margin:0 0 10px;padding:8px 10px;border-left:3px solid #0b6b3a;background:#eefaf3;` +
        `color:#0b6b3a"><b>🟢 Facility found in BIS:</b> ${escapeHtml(result.matchedFacility.name)} ` +
        `(${escapeHtml(result.matchedFacility.id)}) — volumes, territory and colleagues below are your own data.</p>`
    );
  }

  // ── Identity ──────────────────────────────────────────────────────────────
  const fieldRows = orderedEntries(profile.fields, FIELD_ORDER)
    .map(([key, f]) => provenanceRow(fieldLabel(key), f))
    .join('');
  if (fieldRows) {
    // With no person resolved the same table holds only facility data — calling
    // it "Physician details" would promise something the brief doesn't have.
    const identified = Boolean(result.npi || profile.fields.name);
    out.push(
      `<p class="brief-h"><b>${identified ? 'Physician details' : 'Facility details'}</b></p>`,
      `<table>${fieldRows}</table>`
    );
  }

  // ── Extra Intelligence — no BIS counterpart ──────────────────────────────
  const extraRows = orderedEntries(profile.extra, EXTRA_ORDER)
    .map(([key, f]) => provenanceRow(fieldLabel(key), f))
    .join('');
  if (extraRows) {
    out.push(
      '<p class="brief-h"><b>Extra Intelligence</b> ' +
        '<span style="font-size:12px;color:#7a2048;background:#fdf0f4;padding:1px 6px;border-radius:3px">' +
        '+ EXTRA — not held in BIS</span></p>',
      `<table>${extraRows}</table>`
    );
  }

  // ── Conflicts — never resolved silently ──────────────────────────────────
  if (profile.conflicts?.length) {
    out.push(
      '<p class="brief-h"><b>Source disagreements</b></p><ul style="margin:4px 0">' +
        profile.conflicts
          .map(
            (c) =>
              `<li>${escapeHtml(fieldLabel(c.key))}: kept <b>${escapeHtml(String(c.kept.value))}</b> ` +
              `(${escapeHtml(c.kept.source)}) over <i>${escapeHtml(String(c.discarded.value))}</i> ` +
              `(${escapeHtml(c.discarded.source)})</li>`
          )
          .join('') +
        '</ul>'
    );
  }

  // ── BIS colleagues — the payoff when the person themselves is absent ─────
  if (result.colleagues?.length) {
    out.push(
      '<p class="brief-h"><b>Colleagues at this facility</b> ' +
        '<span style="font-size:12px;color:#0b6b3a">🟢 from BIS</span></p>',
      '<table>' +
        result.colleagues
          .map(
            (c) =>
              `<tr><td style="padding:2px 12px 2px 0"><b>${escapeHtml(c.name || c.npi)}</b></td>` +
              `<td>${escapeHtml([c.specialty, c.email].filter(Boolean).join(' · '))}</td></tr>`
          )
          .join('') +
        '</table>'
    );
  }

  // ── Candidates to confirm ────────────────────────────────────────────────
  if (result.alternatives?.length) {
    out.push(
      '<p class="brief-h"><b>Other possible matches</b></p><ul style="margin:4px 0">' +
        result.alternatives
          .map((a) => {
            const who = [a.name, a.specialty, [a.city, a.state].filter(Boolean).join(', ')]
              .filter(Boolean)
              .join(' · ');
            const link = a.sourceUrl
              ? ` <a href="${escapeHtml(a.sourceUrl)}" style="color:#0f6cbd;text-decoration:none">🔗</a>`
              : '';
            return `<li>${escapeHtml(who)}${link}</li>`;
          })
          .join('') +
        '</ul>'
    );
  }

  // ── Where every field came from ──────────────────────────────────────────
  if (profile.sources?.length) {
    out.push(
      '<p class="brief-h"><b>Sources</b></p><ul style="margin:4px 0;font-size:13px">' +
        profile.sources
          .map((s) => {
            const link = s.url ? sourceLink(s.url) : '<i>no public URL</i>';
            return (
              `<li style="word-break:break-word">${s.badge} <b>${escapeHtml(s.source)}</b> — ${link}<br>` +
              `<span style="color:#777">${escapeHtml(s.fields.join(', '))}</span></li>`
            );
          })
          .join('') +
        '</ul>'
    );
  }

  if (profile.notes?.length) {
    out.push(
      '<p style="color:#555;font-size:13px;margin-top:10px">' +
        profile.notes.map((n) => escapeHtml(n)).join('<br>') +
        '</p>'
    );
  }

  return out.join('');
}

/**
 * Email the rep a brief for someone who is NOT in the BIS master.
 *
 * The counterpart to sendPhysiciansBriefing for attendees the directory has
 * never heard of: same delivery rules (BRIEFING_TO_EMAIL honoured, saved to
 * Sent), same rendering as the in-app card, so email and app match — the
 * invariant the rest of the briefs already keep.
 *
 * @param {string} accessToken
 * @param {object} opts
 * @param {string} opts.toEmail        the rep
 * @param {object[]} opts.enrichments  enrich() results, one per attendee
 * @param {{title?:string, start?:string, timeZone?:string}} [opts.event]
 */
async function sendExternalBriefing(accessToken, { toEmail, enrichments, event }) {
  const list = (enrichments || []).filter(Boolean);
  if (!list.length || !toEmail) return null;

  const nameOf = (r) =>
    r.profile?.fields?.name?.value || r.matchedFacility?.name || r.query?.email || 'unknown contact';
  const names = list.map(nameOf);

  const meetingWhen = event?.start ? formatMeetingTime(event.start, event.timeZone) : '';
  const sections = list
    .map((r) => {
      const banner =
        list.length > 1
          ? `<h2 style="font-size:18px;margin:26px 0 8px;padding-bottom:5px;` +
            `border-bottom:2px solid #0f6cbd">${escapeHtml(nameOf(r))}</h2>`
          : '';
      return banner + externalBriefHtml(r);
    })
    .join('');

  const content = [
    `<p>${escapeHtml(
      `An attendee on "${event?.title || 'your meeting'}" is not in the BIS directory. ` +
        'Here is what we could establish about them from public sources.'
    )}</p>`,
    event?.title
      ? `<p><b>Meeting:</b> ${escapeHtml(event.title)}${
          meetingWhen ? ` — ${escapeHtml(meetingWhen)}` : ''
        }</p>`
      : '',
    sections,
  ].join('');

  const client = getGraphClient(accessToken);
  const sendTo = config.briefingToEmail || toEmail;

  await client.api('/me/sendMail').post({
    message: {
      subject: `🔎 Outside BIS: ${names.join(' & ')}${event?.title ? ` — ${event.title}` : ''}`,
      body: { contentType: 'HTML', content },
      toRecipients: [{ emailAddress: { address: sendTo } }],
    },
    saveToSentItems: true,
  });

  return sendTo;
}

/** One physician's meeting-note history as HTML (or a placeholder). */
function meetingNotesHtml(notes) {
  return notes && notes.length
    ? notes
        .map(
          (n) =>
            `<p><b>${escapeHtml(n.meetingDate || (n.createdAt || '').slice(0, 10))}</b><br>` +
            `${escapeHtml(n.notes).replace(/\n/g, '<br>')}</p>`
        )
        .join('')
    : '<p><i>No meeting notes recorded yet.</i></p>';
}

/**
 * Send ONE briefing email covering one OR MORE physicians. A meeting booked
 * with several physicians produces a SINGLE email containing every physician's
 * details (each as its own section), not one email per physician.
 *
 * @param {object} opts
 * @param {string} opts.toEmail organizer's address
 * @param {Array<{physician:object, notes:object[], analytics?:object, contact?:object,
 *          verification?:object}>} opts.physicians
 * @param {{title?:string, start?:string, timeZone?:string}} [opts.event]
 * @param {string} [opts.subject]
 * @param {string} [opts.intro]
 */
/** Physician name for headings/subjects. */
function briefName(p) {
  return p.name || `NPI ${p.npi}`;
}

/**
 * Build the HTML body of a (possibly multi-physician) briefing email. Pure —
 * exported so it can be rendered/tested without a Graph client. For a single
 * physician the output is byte-for-byte the old single-brief layout (no name
 * banner); with several, each physician gets a ruled name banner (inline-styled
 * so it renders in email clients, which don't load the app stylesheet).
 */
function buildBriefingContent({ physicians, event, intro }) {
  const list = (physicians || []).filter((b) => b && b.physician);
  const multi = list.length > 1;
  const names = list.map((b) => briefName(b.physician));

  const meetingWhen = event?.start ? formatMeetingTime(event.start, event.timeZone) : '';
  const meetingLine = event?.title
    ? `<p><b>Meeting:</b> ${escapeHtml(event.title)}${
        meetingWhen ? ` — ${escapeHtml(meetingWhen)}` : ''
      }</p>`
    : '';

  const sections = list
    .map(({ physician, analytics, contact, notes, verification }) => {
      const banner = multi
        ? `<h2 style="font-size:18px;margin:26px 0 8px;padding-bottom:5px;` +
          `border-bottom:2px solid #0f6cbd">${escapeHtml(briefName(physician))}</h2>`
        : '';
      return [
        banner,
        physicianBriefHtml({ physician, analytics, contact, verification }),
        '<p class="brief-h"><b>Meeting notes</b></p>',
        meetingNotesHtml(notes),
      ].join('');
    })
    .join('');

  const defaultIntro = multi
    ? `Briefing for ${list.length} physicians on this meeting: ${names.join(', ')}.`
    : `Briefing for ${names[0]}`;

  return [`<p>${escapeHtml(intro || defaultIntro)}</p>`, meetingLine, sections].join('');
}

async function sendPhysiciansBriefing(accessToken, { toEmail, physicians, event, subject, intro }) {
  const client = getGraphClient(accessToken);
  const list = (physicians || []).filter((b) => b && b.physician);
  if (!list.length) return null;

  const names = list.map((b) => briefName(b.physician));
  const content = buildBriefingContent({ physicians: list, event, intro });

  // Deliver to a real Microsoft mailbox when configured. The sign-in identity
  // (toEmail) can be a federated/Gmail address that Microsoft routes externally
  // — a sendMail-to-self then only appears in Sent, never the Outlook Inbox.
  // BRIEFING_TO_EMAIL (an outlook.com/Microsoft address) is delivered internally
  // so the briefing lands in the Inbox. Notes elsewhere stay keyed by toEmail.
  const sendTo = config.briefingToEmail || toEmail;

  await client.api('/me/sendMail').post({
    message: {
      subject:
        subject || `Briefing: ${names.join(' & ')}${event?.title ? ` — ${event.title}` : ''}`,
      body: { contentType: 'HTML', content },
      toRecipients: [{ emailAddress: { address: sendTo } }],
    },
    saveToSentItems: true,
  });

  // Return the address the brief actually went to — callers surface this so the
  // rep sees where it landed (esp. when BRIEFING_TO_EMAIL redirects it, or a
  // federated sign-in makes a self-send land only in Sent, not the Inbox).
  return sendTo;
}

/** Single-physician briefing — thin wrapper over the combined sender so the
 *  manual "Email me this briefing" and schedule-invite paths are unchanged. */
/**
 * Email a brief for a physician the master does not have.
 *
 * A sibling of sendPhysiciansBriefing rather than a branch inside it: the body
 * is already rendered (outsideBriefHtml, assembled from whichever public
 * sources answered), and the subject has to say plainly that this is NOT your
 * data — a rep skimming their inbox must not mistake a registry profile for the
 * master's own.
 *
 * The rep's own note history rides along, exactly as it does in a BIS brief:
 * notes are keyed by NPI, and an outside physician has one.
 *
 * @param {string} accessToken
 * @param {object} opts
 * @param {string} opts.toEmail
 * @param {string} opts.name       who the brief is about
 * @param {string} opts.html       the rendered brief
 * @param {object[]} [opts.notes]  this rep's meeting notes for them
 * @param {object} [opts.event]    { title, start, timeZone }
 * @returns {Promise<string|null>} the address it actually went to
 */
async function sendOutsideBriefing(accessToken, { toEmail, name, html, notes, event }) {
  if (!toEmail || !html) return null;
  const client = getGraphClient(accessToken);

  const meetingWhen = event?.start ? formatMeetingTime(event.start, event.timeZone) : '';
  const who = name || 'this contact';

  const content = [
    `<p>${escapeHtml(
      `${who} is not in the BIS directory. Everything below was assembled from public ` +
        'sources, and anything those sources could not supply is marked "Data not available".'
    )}</p>`,
    event?.title
      ? `<p><b>Meeting:</b> ${escapeHtml(event.title)}${meetingWhen ? ` — ${escapeHtml(meetingWhen)}` : ''}</p>`
      : '',
    html,
    '<p class="brief-h"><b>Meeting notes</b></p>',
    meetingNotesHtml(notes || []),
  ].join('');

  // Same delivery rule as every other brief — see sendPhysiciansBriefing.
  const sendTo = config.briefingToEmail || toEmail;
  await client.api('/me/sendMail').post({
    message: {
      subject: `🔎 Outside BIS: ${who}${event?.title ? ` — ${event.title}` : ''}`,
      body: { contentType: 'HTML', content },
      toRecipients: [{ emailAddress: { address: sendTo } }],
    },
    saveToSentItems: true,
  });
  return sendTo;
}

async function sendPhysicianBriefing(
  accessToken,
  { toEmail, physician, notes, analytics, event, subject, intro, contact }
) {
  return sendPhysiciansBriefing(accessToken, {
    toEmail,
    physicians: [{ physician, notes, analytics, contact }],
    event,
    subject,
    intro,
  });
}

/**
 * The signed-in user's events starting within the next `withinMinutes` —
 * times returned in UTC so callers can compute "minutes until start"
 * reliably. Used by the reminder engine.
 */
async function getUpcomingEvents(accessToken, withinMinutes = 180) {
  const client = getGraphClient(accessToken);
  const now = new Date();
  const until = new Date(now.getTime() + withinMinutes * 60000);

  const response = await client
    .api('/me/calendarView')
    .query({ startDateTime: now.toISOString(), endDateTime: until.toISOString() })
    .header('Prefer', 'outlook.timezone="UTC"')
    .select('subject,start,end,location,bodyPreview,isAllDay,type,seriesMasterId,organizer,attendees,onlineMeeting,webLink')
    .orderby('start/dateTime')
    .top(50)
    .get();

  return (response.value || []).map(normalizeEvent);
}

/**
 * One event by id, normalized like every other event this module returns.
 *
 * The calendar list the browser already holds is a snapshot; a meeting the rep
 * has just edited (added the real attendee, fixed the title) is only current in
 * Graph. Anything that decides WHO a meeting is with reads it from here, so the
 * decision is never made on a stale title.
 */
async function getEventById(accessToken, eventId) {
  const client = getGraphClient(accessToken);
  const event = await client
    .api(`/me/events/${eventId}`)
    .header('Prefer', 'outlook.timezone="UTC"')
    .select('subject,start,end,location,bodyPreview,isAllDay,type,seriesMasterId,organizer,attendees,onlineMeeting,webLink')
    .get();
  return normalizeEvent(event);
}

// Hidden marker that makes brief injection idempotent (never inject twice).
const BRIEF_MARKER = '<!-- bis-pre-meeting-brief -->';

/**
 * Embed the BIS pre-meeting brief INTO a calendar event's own body, so opening
 * the meeting in Outlook shows the brief inline (no add-in needed; works on any
 * account, including personal outlook.com). Idempotent via BRIEF_MARKER, and it
 * PREPENDS to the existing body so the Teams join info etc. is preserved.
 *
 * PATCH on /me/events/{id} updates the organiser's own copy and does not send a
 * meeting update to attendees, so the brief stays private to the rep. Returns
 * true if it injected, false if the brief was already present (or no body).
 */
async function injectBriefIntoEvent(accessToken, eventId, innerHtml) {
  if (!eventId || !innerHtml) return false;
  const client = getGraphClient(accessToken);

  const existing = await client.api(`/me/events/${eventId}`).select('body').get();
  const current = existing?.body?.content || '';
  if (current.includes(BRIEF_MARKER)) return false;

  const block =
    `${BRIEF_MARKER}` +
    '<div style="border:1px solid #0f6cbd;border-radius:10px;padding:12px 14px;margin:0 0 14px;' +
    'background:#f5f9fd;font-family:-apple-system,Segoe UI,Roboto,sans-serif">' +
    '<div style="font-weight:700;color:#0a4f8a;margin-bottom:8px">🩺 BIS pre-meeting brief</div>' +
    innerHtml +
    '</div><hr>';

  await client.api(`/me/events/${eventId}`).patch({
    body: { contentType: 'HTML', content: block + current },
  });
  return true;
}

/**
 * Create a calendar event with the physician as a required attendee. Graph
 * sends the invite email to the attendee automatically on creation.
 *
 * @param {string} accessToken
 * @param {object} opts
 * @param {string} opts.subject
 * @param {string} opts.start ISO local datetime, e.g. "2026-06-10T15:00:00"
 * @param {string} opts.end   ISO local datetime
 * @param {string} opts.timeZone IANA time zone for start/end
 * @param {object} opts.physician normalized profile (must have an email)
 * @param {string} [opts.notes]
 * @param {object} [opts.previousNote] latest meeting note to include in the invite
 */
async function createMeetingWithPhysician(
  accessToken,
  { subject, start, end, timeZone, physician, notes, previousNote }
) {
  const client = getGraphClient(accessToken);

  const event = await client.api('/me/events').post({
    subject,
    start: { dateTime: start, timeZone },
    end: { dateTime: end, timeZone },
    body: { contentType: 'HTML', content: buildPhysicianBody(physician, notes, previousNote) },
    attendees: [
      {
        type: 'required',
        emailAddress: { address: physician.email, name: physician.name || physician.email },
      },
    ],
    // Native Outlook reminder — fires even if our server is down.
    isReminderOn: true,
    reminderMinutesBeforeStart: Number(process.env.REMINDER_LEAD_MINUTES) || 90,
  });

  return normalizeEvent(event);
}

/** Map a raw Graph message to the lean shape app_emails stores. */
function normalizeMessage(msg) {
  return {
    providerMsgId: msg.id,
    internetMsgId: msg.internetMessageId || null,
    threadId: msg.conversationId || null,
    fromEmail: msg.from?.emailAddress?.address || null,
    fromName: msg.from?.emailAddress?.name || null,
    toEmails: (msg.toRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean),
    ccEmails: (msg.ccRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean),
    subject: msg.subject || null,
    bodyText: (msg.body?.contentType === 'html'
      ? (msg.bodyPreview || '')
      : (msg.body?.content || msg.bodyPreview || '')),
    bodyHtml: msg.body?.contentType === 'html' ? msg.body.content : null,
    bodyPreview: msg.bodyPreview || null,
    receivedAt: msg.receivedDateTime || null,
  };
}

/**
 * Inbox delta — incremental sync of received messages. Pass the previous
 * deltaLink (null on first run) and get back new/changed messages plus the
 * next deltaLink to persist. Paginates internally via @odata.nextLink.
 * @returns {Promise<{ messages: object[], deltaLink: string|null }>}
 */
async function getInboxDelta(accessToken, deltaLink) {
  const client = getGraphClient(accessToken);
  const select = 'id,internetMessageId,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,receivedDateTime';

  let req = deltaLink
    ? client.api(deltaLink)
    : client.api('/me/mailFolders/inbox/messages/delta').query({ $select: select }).top(50);

  const messages = [];
  let nextDelta = null;

  // Walk nextLink pages until we reach the deltaLink page.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await req.get();
    if (Array.isArray(page.value)) messages.push(...page.value);

    if (page['@odata.nextLink']) {
      req = client.api(page['@odata.nextLink']);
    } else {
      nextDelta = page['@odata.deltaLink'] || null;
      break;
    }
  }

  return { messages: messages.map(normalizeMessage), deltaLink: nextDelta };
}

/**
 * Historical inbox read over a recent window (newest first), independent of the
 * delta cursor. Used by the email-intelligence backfill to seed the last N days
 * (default 10, later 30) into the sheet. Paginates via @odata.nextLink up to
 * `maxPages` so a large inbox can't run unbounded.
 * @param {string} accessToken
 * @param {{ sinceDays?: number, pageSize?: number, maxPages?: number }} [opts]
 * @returns {Promise<object[]>} normalized messages
 */
async function getInboxMessages(accessToken, { sinceDays = 10, pageSize = 50, maxPages = 20 } = {}) {
  const client = getGraphClient(accessToken);
  const select = 'id,internetMessageId,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,receivedDateTime';
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  let req = client
    .api('/me/mailFolders/inbox/messages')
    .filter(`receivedDateTime ge ${since}`)
    .orderby('receivedDateTime desc')
    .select(select)
    .top(pageSize);

  const messages = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await req.get();
    if (Array.isArray(res.value)) messages.push(...res.value);
    const next = res['@odata.nextLink'];
    if (!next) break;
    req = client.api(next);
  }
  return messages.map(normalizeMessage);
}

/**
 * Most recent Sent Items, newest first (normalized). Used to capture the rep's
 * own replies in a meeting thread — those land in Sent, not the Inbox — so the
 * AI MOM picks them up. No delta; the caller dedups on (provider, msg id).
 */
async function getRecentSent(accessToken, limit = 25) {
  const client = getGraphClient(accessToken);
  const select = 'id,internetMessageId,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,receivedDateTime';
  const res = await client
    .api("/me/mailFolders('sentitems')/messages")
    .top(limit)
    .select(select)
    .orderby('receivedDateTime desc')
    .get();
  return (res.value || []).map(normalizeMessage);
}

/**
 * Lightweight profile lookup for the signed-in user (for the header UI).
 */
async function getMe(accessToken) {
  const client = getGraphClient(accessToken);
  const me = await client.api('/me').select('displayName,mail,userPrincipalName').get();
  return {
    name: me.displayName || null,
    email: me.mail || me.userPrincipalName || null,
  };
}

module.exports = {
  getEventById,
  sendOutsideBriefing,
  outsideBriefHtml,
  getEventsForDay,
  getUpcomingEvents,
  getInboxDelta,
  getInboxMessages,
  getRecentSent,
  getMe,
  getGraphClient,
  createMeetingWithPhysician,
  injectBriefIntoEvent,
  sendPhysicianBriefing,
  sendPhysiciansBriefing,
  buildBriefingContent,
  physicianBriefHtml,
  externalBriefHtml,
  sendExternalBriefing,
  formatMeetingTime, // exported for brief-rendering tests
  analyticsHtml, // exported for brief-rendering tests
  commercialSignalsHtml, // exported for brief-rendering tests
  accountOpportunityHtml, // exported for brief-rendering tests
  productFitHtml, // exported for brief-rendering tests
  productContextHtml, // exported for brief-rendering tests
  contactIntelligenceHtml, // exported for brief-rendering tests
};
