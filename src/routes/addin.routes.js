'use strict';

const express = require('express');
const config = require('../config');

/**
 * Outlook Add-in task pane host.
 *
 * `GET /addin/taskpane` returns the add-in's page — loaded by Outlook inside its
 * own iframe when the rep clicks the ribbon button on a calendar meeting. It
 * pulls in Office.js (Microsoft CDN), reads the open meeting's attendees, then
 * calls the token-gated /embed/meeting-brief for the BIS pre-meeting brief.
 *
 * The shared embed token is injected server-side (window.__BIS_ADDIN__) so it
 * never lives in a committed static file. A CSP with `frame-ancestors` lets the
 * Outlook hosts frame the page (and allows Office.js from the Microsoft CDN).
 */

const router = express.Router();

router.get('/taskpane', (req, res) => {
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://appsforoffice.microsoft.com 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      `frame-ancestors ${config.addin.frameAncestors}`,
    ].join('; ')
  );

  const token = JSON.stringify(config.addin.token || '');
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BIS pre-meeting brief</title>
<link rel="stylesheet" href="/styles.css">
<style>
  body { margin: 0; padding: 14px; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #111827; background: #fff; }
  .addin-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .addin-head h1 { font-size: 15px; margin: 0; }
  .addin-status { color: #6b7280; font-size: 13px; margin: 10px 0; }
  .addin-block { border: 1px solid #e5e7eb; border-left: 3px solid #0f6cbd; border-radius: 10px; padding: 12px; margin-bottom: 14px; }
  .addin-block__name { font-size: 16px; margin: 0 0 8px; color: #0a4f8a; }
  .addin-suggestions { list-style: none; margin: 8px 0 0; padding: 0; }
  .addin-suggestions li { border: 1px solid #0f6cbd; background: #eaf3fb; color: #0a4f8a; border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; cursor: pointer; font-weight: 600; }
  .addin-suggestions li:hover { background: #d8e9f8; }
</style>
</head>
<body>
  <div class="addin-head"><span aria-hidden="true">🩺</span><h1>BIS pre-meeting brief</h1></div>
  <p class="addin-status" id="status">Loading…</p>
  <div id="content"></div>
  <script>window.__BIS_ADDIN__ = { token: ${token} };</script>
  <script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>
  <script src="/addin/taskpane.js"></script>
</body>
</html>`);
});

module.exports = router;
