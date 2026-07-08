'use strict';

const config = require('./config');

/**
 * Dynamics 365 (Dataverse) reader.
 *
 * Reads Lead records from the org's Web API (OData v4) using an app-only
 * (client-credentials) token — the app authenticates as ITSELF, so no user
 * sign-in is involved and this is fully independent of the Outlook/Graph MSAL
 * flow. Access is granted by an "Application User" created in the Dynamics
 * environment (see .env.example / CLAUDE.md for the setup).
 *
 * Degrades gracefully: when DYNAMICS_* env vars are unset, isConfigured() is
 * false and getLeads() returns [] — the app never hard-crashes.
 */

const API_VERSION = 'v9.2';

// Cached app-only token: { token, expiresAt(ms epoch) }. Reused until ~1 min
// before expiry to avoid a token call on every request.
let tokenCache = null;

function isConfigured() {
  return config.dynamics.configured;
}

/** Acquire (and cache) an app-only access token for the Dataverse Web API. */
async function getToken() {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt - 60_000 > now) {
    return tokenCache.token;
  }

  const { tenantId, clientId, clientSecret, url } = config.dynamics;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    // .default asks for the app's configured permissions on this resource.
    scope: `${url}/.default`,
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(
      `Dynamics token request failed (${res.status}): ${data.error_description || data.error || 'unknown error'}`
    );
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: now + Number(data.expires_in || 3600) * 1000,
  };
  return tokenCache.token;
}

// OData annotation suffix that carries the human-readable label for a coded
// field (statuscode → "New") or a lookup (_ownerid_value → the owner's name).
// Requesting these needs the `odata.include-annotations` Prefer header below.
const FMT = '@OData.Community.Display.V1.FormattedValue';

// Fields we read from each Lead. Keep in sync with the UI columns. `companyname`
// + `address1_city` aren't shown as columns — they feed the BIS match cascade
// (email → name → facility) when a lead is opened in the sidebar.
const LEAD_SELECT =
  'firstname,lastname,emailaddress1,createdon,statuscode,_ownerid_value,companyname,address1_city';

/**
 * Fetch ALL Lead records with their display fields. Follows the OData
 * `@odata.nextLink` pages so we return everything, not just the first server
 * page — capped at `max` rows as a safety backstop against huge orgs. The UI
 * paginates/searches this full set client-side.
 * @param {number} max hard cap on rows fetched (default 5000)
 * @returns {Promise<Array<{id,firstName,lastName,email,createdOn,status,owner}>>}
 */
async function getLeads(max = 5000) {
  if (!isConfigured()) return [];

  const token = await getToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
    // maxpagesize for paging + include-annotations for the "..FormattedValue"
    // labels (owner name, status text) we surface below.
    Prefer: 'odata.maxpagesize=500,odata.include-annotations="*"',
  };

  let url =
    `${config.dynamics.url}/api/data/${API_VERSION}/leads?$select=${LEAD_SELECT}`;
  const out = [];

  while (url && out.length < max) {
    const res = await fetch(url, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `Dynamics leads request failed (${res.status}): ${data.error?.message || 'unknown error'}`
      );
    }
    for (const l of data.value || []) {
      out.push({
        id: l.leadid || '',
        firstName: l.firstname || '',
        lastName: l.lastname || '',
        email: l.emailaddress1 || '',
        createdOn: l.createdon || '', // raw ISO — the UI formats it
        status: l['statuscode' + FMT] || '',
        owner: l['_ownerid_value' + FMT] || '',
        company: l.companyname || '', // for the facility match
        city: l.address1_city || '',
      });
    }
    // Dynamics returns the next page's URL here when there are more rows.
    url = data['@odata.nextLink'] || null;
  }

  return out;
}

module.exports = { isConfigured, getLeads };
