'use strict';

const express = require('express');
const config = require('../config');
const physicians = require('../physicians');
const analytics = require('../analytics');
const contactsStore = require('../contacts-store');
const graph = require('../graph');
const leadMatch = require('../lead-match');

/**
 * Part 2 — embed the lead BIS brief INSIDE Dynamics 365.
 *
 * `GET /embed/lead-brief?email=&firstName=&lastName=&company=&token=` returns a
 * standalone HTML page (NOT JSON) — the same BIS match + pre-meeting brief as
 * the in-app sidebar, so both surfaces show identical data. It has no Outlook
 * session: a shared `token` (DYNAMICS_EMBED_TOKEN) gates it, and a
 * `frame-ancestors` CSP lets the Dynamics iframe/side pane embed it.
 */

const router = express.Router();

function esc(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/** Wrap body HTML in a minimal, self-contained page that links the app CSS
 *  (loaded from our own origin, so the brief styling matches the in-app one). */
function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/styles.css">
<style>
  body { margin: 0; padding: 16px; font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #111827; }
  .embed-head { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
  .embed-head h2 { font-size: 17px; margin: 0; }
  .embed-badge { align-self: flex-start; padding: 2px 10px; border-radius: 999px; background: #dbeafe; color: #1e40af; font-size: 12px; font-weight: 600; }
  .lead-people { list-style: none; margin: 0; padding: 0; }
  .lead-people li { padding: 8px 0; border-bottom: 1px solid #e5e7eb; }
  .lead-people li:last-child { border-bottom: none; }
  .lead-people .name { font-weight: 600; }
  .lead-people .spec { color: #6b7280; font-size: 13px; }
  .muted { color: #6b7280; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

router.get('/lead-brief', async (req, res, next) => {
  try {
    // Let Dynamics embed us in an iframe / side pane.
    res.set('Content-Security-Policy', `frame-ancestors ${config.dynamics.embedFrameAncestors}`);

    const expected = config.dynamics.embedToken;
    if (!expected) {
      return res
        .status(403)
        .type('html')
        .send(page('Not configured', '<p class="muted">Embed not configured — set DYNAMICS_EMBED_TOKEN on the server.</p>'));
    }
    if (req.query.token !== expected) {
      return res.status(403).type('html').send(page('Forbidden', '<p class="muted">Invalid or missing token.</p>'));
    }

    const { email, firstName, lastName, company } = req.query;
    const who = `${firstName || ''} ${lastName || ''}`.trim() || email || company || 'Lead';
    const result = await leadMatch.matchLeadToBis({ email, firstName, lastName, company });

    // Physician hit → the full pre-meeting brief (same body as email/in-app).
    if (result.matchedBy === 'email' || result.matchedBy === 'name') {
      const physician = physicians.getByNpi(result.physician.npi) || result.physician;
      const [analyticsData, contact] = await Promise.all([
        analytics.getLabelledAnalytics(physician.npi),
        contactsStore.getContact(physician.npi),
      ]);
      const brief = graph.physicianBriefHtml({ physician, analytics: analyticsData, contact });
      return res.type('html').send(
        page(
          who,
          `<div class="embed-head"><h2>${esc(who)}</h2><span class="embed-badge">Matched by ${esc(result.matchedBy)}</span></div>` +
            `<div class="physician-analytics">${brief}</div>`
        )
      );
    }

    // Facility hit → facility + physicians there.
    if (result.matchedBy === 'facility') {
      const people = (result.candidates || [])
        .map(
          (c) =>
            `<li><div class="name">${esc(c.name)}</div>${c.specialty ? `<div class="spec">${esc(c.specialty)}</div>` : ''}</li>`
        )
        .join('');
      const facLine = result.facility?.name
        ? `Facility: ${esc(result.facility.name)}${result.facility.city ? ' — ' + esc(result.facility.city) : ''}`
        : `Facility match for "${esc(company)}"`;
      return res.type('html').send(
        page(
          who,
          `<div class="embed-head"><h2>${esc(who)}</h2><span class="embed-badge">Matched by facility</span></div>` +
            `<p>${facLine}</p><ul class="lead-people">${people}</ul>`
        )
      );
    }

    // No match.
    return res.type('html').send(
      page(
        who,
        `<div class="embed-head"><h2>${esc(who)}</h2></div>` +
          '<p class="muted">No matching physician or facility found in the BIS database.</p>'
      )
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
