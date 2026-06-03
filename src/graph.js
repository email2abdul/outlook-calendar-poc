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
 * Compute the [start, end) ISO bounds of "today" in the given IANA time zone,
 * each tagged with the correct UTC offset.
 * @returns {{ startDateTime: string, endDateTime: string, timeZone: string }}
 */
function todayRange(timeZone) {
  const now = new Date();

  // YYYY-MM-DD for "today" as seen in the target time zone.
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

  const offset = offsetForTimeZone(timeZone, now);

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
    organizer: event.organizer?.emailAddress?.name || null,
    onlineMeetingUrl: event.onlineMeeting?.joinUrl || null,
    webLink: event.webLink || null,
  };
}

/**
 * Fetch all of the signed-in user's calendar events for today.
 *
 * Uses `calendarView`, which (unlike `/events`) expands recurring series into
 * concrete occurrences within the time window — exactly what "today's events"
 * should mean.
 *
 * @param {string} accessToken
 * @param {string} [timeZone] IANA time zone (defaults to the server's).
 * @returns {Promise<{ date: string, timeZone: string, events: object[] }>}
 */
async function getTodaysEvents(accessToken, timeZone) {
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const { startDateTime, endDateTime, date } = todayRange(tz);

  const client = getGraphClient(accessToken);

  const response = await client
    .api('/me/calendarView')
    .query({ startDateTime, endDateTime })
    // Return start/end times already converted to the user's time zone.
    .header('Prefer', `outlook.timezone="${tz}"`)
    .select('subject,start,end,location,bodyPreview,isAllDay,organizer,onlineMeeting,webLink')
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

module.exports = { getTodaysEvents, getMe, getGraphClient };
