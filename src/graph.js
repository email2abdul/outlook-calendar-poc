'use strict';

require('isomorphic-fetch');
const { Client } = require('@microsoft/microsoft-graph-client');
const config = require('./config');

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
    .select('subject,start,end,location,bodyPreview,isAllDay,organizer,attendees,onlineMeeting,webLink')
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

/** HTML details table for a physician profile (shared by invite + briefing). */
function physicianDetailsTable(physician) {
  const rows = [
    ['Name', physician.name],
    ['NPI', physician.npi],
    ['Specialty', physician.specialty],
    ['Email', physician.email],
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
  ].filter(([, v]) => v);

  const table = rows
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0"><b>${escapeHtml(k)}</b></td><td>${escapeHtml(v)}</td></tr>`)
    .join('');

  return `<table>${table}</table>`;
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
    '<p><b>Physician details</b></p>',
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
    '<p><b>Procedure Intelligence</b></p>' +
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
  return '<p><b>Commercial Signals</b></p>' + `<ul style="margin:4px 0">${items.join('')}</ul>`;
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
    '<p><b>Account Opportunity</b></p>' +
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

  return '<p><b>Contact Intelligence</b></p>' + table + metaLine;
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
      ? `<p><b>Recommended product</b></p><p><i>${escapeHtml(fit.note)}</i></p>`
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
    '<p><b>Recommended product</b></p>' +
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

  return '<p><b>What to Discuss</b></p>' + blocks;
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
    '<p><b>Volume by year</b></p><table>' +
    a.byYear.map((y) => `<tr><td ${td}>${y.year}</td><td>${num(y.volume)}</td></tr>`).join('') +
    '</table>';

  const totalPayer = a.byPayer.reduce((s, p) => s + p.volume, 0) || 1;
  const payers =
    '<p><b>Payer mix</b></p><table>' +
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
    '<p><b>Top procedures</b></p><div class="table-scroll"><table class="brief-proc brief-cards">' +
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
    '<p><b>Facilities</b></p><table>' +
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
    '<p><b>Procedure analytics</b></p>',
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
function physicianBriefHtml({ physician, analytics, contact }) {
  return [
    '<p><b>Physician details</b></p>',
    physicianDetailsTable(physician),
    contactIntelligenceHtml(physician, contact),
    analyticsHtml(analytics),
    accountOpportunityHtml(analytics?.accountOpportunity),
    productFitHtml(analytics?.productFit),
    productContextHtml(analytics?.productContext),
  ].join('');
}

async function sendPhysicianBriefing(
  accessToken,
  { toEmail, physician, notes, analytics, event, subject, intro, contact }
) {
  const client = getGraphClient(accessToken);

  const history = notes.length
    ? notes
        .map(
          (n) =>
            `<p><b>${escapeHtml(n.meetingDate || (n.createdAt || '').slice(0, 10))}</b><br>` +
            `${escapeHtml(n.notes).replace(/\n/g, '<br>')}</p>`
        )
        .join('')
    : '<p><i>No meeting notes recorded yet.</i></p>';

  const meetingLine = event?.title
    ? `<p><b>Meeting:</b> ${escapeHtml(event.title)}${
        event.start ? ` — ${escapeHtml(event.start)}` : ''
      }</p>`
    : '';

  const content = [
    `<p>${escapeHtml(intro || `Briefing for ${physician.name || `NPI ${physician.npi}`}`)}</p>`,
    meetingLine,
    physicianBriefHtml({ physician, analytics, contact }),
    '<p><b>Meeting notes</b></p>',
    history,
  ].join('');

  // Deliver to a real Microsoft mailbox when configured. The sign-in identity
  // (toEmail) can be a federated/Gmail address that Microsoft routes externally
  // — a sendMail-to-self then only appears in Sent, never the Outlook Inbox.
  // BRIEFING_TO_EMAIL (an outlook.com/Microsoft address) is delivered internally
  // so the briefing lands in the Inbox. Notes elsewhere stay keyed by toEmail.
  const sendTo = config.briefingToEmail || toEmail;

  await client.api('/me/sendMail').post({
    message: {
      subject:
        subject ||
        `Briefing: ${physician.name || physician.npi}${event?.title ? ` — ${event.title}` : ''}`,
      body: { contentType: 'HTML', content },
      toRecipients: [{ emailAddress: { address: sendTo } }],
    },
    saveToSentItems: true,
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
    .select('subject,start,end,location,bodyPreview,isAllDay,organizer,attendees,onlineMeeting,webLink')
    .orderby('start/dateTime')
    .top(50)
    .get();

  return (response.value || []).map(normalizeEvent);
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
  getEventsForDay,
  getUpcomingEvents,
  getInboxDelta,
  getInboxMessages,
  getRecentSent,
  getMe,
  getGraphClient,
  createMeetingWithPhysician,
  sendPhysicianBriefing,
  physicianBriefHtml,
  analyticsHtml, // exported for brief-rendering tests
  commercialSignalsHtml, // exported for brief-rendering tests
  accountOpportunityHtml, // exported for brief-rendering tests
  productFitHtml, // exported for brief-rendering tests
  productContextHtml, // exported for brief-rendering tests
  contactIntelligenceHtml, // exported for brief-rendering tests
};
