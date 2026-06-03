'use strict';

const { ConfidentialClientApplication, CryptoProvider, LogLevel } = require('@azure/msal-node');
const config = require('./config');

/**
 * Auth module — a thin, reusable wrapper around MSAL Node implementing the
 * OAuth 2.0 Authorization Code flow **with PKCE**.
 *
 * Design notes (why it looks like this):
 *  - Tokens never leave the server. The browser only ever holds a signed,
 *    httpOnly session cookie; access/refresh tokens live in the server-side
 *    session via MSAL's serialisable token cache.
 *  - The MSAL token cache is bound to the *current session* through a
 *    `cachePlugin`, so each user gets an isolated cache. This is what makes
 *    `acquireTokenSilent` (silent refresh) work across requests.
 *  - For a single-process demo, the cache is persisted inside the session
 *    object. For production scale-out, swap the session store for Redis
 *    (the cachePlugin code stays identical).
 */

const cryptoProvider = new CryptoProvider();

/**
 * Build an MSAL client whose token cache is wired to this request's session.
 * @param {import('express').Request} req
 */
function buildClient(req) {
  const cachePlugin = {
    beforeCacheAccess: async (cacheContext) => {
      if (req.session.msalCache) {
        cacheContext.tokenCache.deserialize(req.session.msalCache);
      }
    },
    afterCacheAccess: async (cacheContext) => {
      if (cacheContext.cacheHasChanged) {
        req.session.msalCache = cacheContext.tokenCache.serialize();
      }
    },
  };

  return new ConfidentialClientApplication({
    auth: {
      clientId: config.auth.clientId,
      authority: config.auth.authority,
      clientSecret: config.auth.clientSecret,
    },
    cache: { cachePlugin },
    system: {
      loggerOptions: {
        logLevel: config.isProduction ? LogLevel.Error : LogLevel.Warning,
        piiLoggingEnabled: false,
        loggerCallback: (level, message) => {
          if (level <= LogLevel.Warning) console.warn('[msal]', message);
        },
      },
    },
  });
}

/**
 * Step 1 of login: build the Microsoft sign-in URL and stash PKCE + CSRF state
 * in the session so we can validate the callback.
 * @returns {Promise<string>} the authorization URL to redirect the user to
 */
async function getAuthCodeUrl(req) {
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const state = cryptoProvider.createNewGuid();

  // Persisted for validation in handleRedirect().
  req.session.pkceVerifier = verifier;
  req.session.authState = state;

  const client = buildClient(req);
  return client.getAuthCodeUrl({
    scopes: config.auth.scopes,
    redirectUri: config.auth.redirectUri,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    state,
    // Lets the user pick which Microsoft account to use.
    prompt: 'select_account',
  });
}

/**
 * Step 2 of login: exchange the authorization code for tokens, validating the
 * CSRF `state` and supplying the PKCE verifier.
 * @returns {Promise<import('@azure/msal-node').AuthenticationResult>}
 */
async function handleRedirect(req) {
  const { code, state } = req.query;

  if (!code) throw new Error('Authorization response is missing the "code" parameter.');
  if (!state || state !== req.session.authState) {
    throw new Error('Invalid OAuth state — possible CSRF. Please try logging in again.');
  }

  const client = buildClient(req);
  const result = await client.acquireTokenByCode({
    code: String(code),
    scopes: config.auth.scopes,
    redirectUri: config.auth.redirectUri,
    codeVerifier: req.session.pkceVerifier,
  });

  // One-time values — drop them once consumed.
  delete req.session.pkceVerifier;
  delete req.session.authState;

  // Remember which cached account this session belongs to.
  req.session.account = {
    homeAccountId: result.account.homeAccountId,
    username: result.account.username,
    name: result.account.name,
  };

  return result;
}

/**
 * Get a valid access token for the logged-in user, refreshing silently from
 * the cached refresh token when the access token is expired.
 * @returns {Promise<string|null>} access token, or null if not authenticated
 */
async function getAccessToken(req) {
  if (!req.session.account) return null;

  const client = buildClient(req);
  const account = await client
    .getTokenCache()
    .getAccountByHomeId(req.session.account.homeAccountId);

  if (!account) return null;

  const result = await client.acquireTokenSilent({
    account,
    scopes: config.auth.scopes,
  });

  return result?.accessToken ?? null;
}

function isAuthenticated(req) {
  return Boolean(req.session.account);
}

module.exports = {
  getAuthCodeUrl,
  handleRedirect,
  getAccessToken,
  isAuthenticated,
};
