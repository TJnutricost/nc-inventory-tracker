// Google sign-in (D-10, docs/briefs/google-sign-in.md): the OAuth 2.0 / OpenID Connect authorization-code flow with PKCE, beside the
// email + password login. This module only talks to Google and checks what Google answers; who may sign in (an active employee's work
// email with an active login) is src/accounts.js googleAccount, and the session is set by the route, exactly as POST /api/login sets it.
//
// The ID token comes straight from Google's token endpoint over TLS, in exchange for our client secret, so its signature is not checked:
// OpenID Connect Core 1.0 §3.1.3.7 accepts TLS server validation in place of the signature for a token received this way. Every claim
// that matters is checked: issuer, audience, expiry, nonce, a verified email and the Workspace domain (`hd`). No new npm dependency.
//
// Off unless GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set (the routes answer 404, the login screen shows no button).
// GOOGLE_HOSTED_DOMAIN (default nutricost.com) is the only Workspace domain let in; the Internal consent screen already limits sign-in to
// the organization, this is the app's own backstop.
const crypto = require('crypto');

// Google's endpoints. Tests point `token` at a local fake (test/google-sign-in.test.js); nothing else changes them.
const endpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
};
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const PENDING_MS = 10 * 60e3; // a sign-in must come back from Google within 10 minutes
const TIMEOUT_MS = 10e3;

// A refusal the route turns into `/#/login?error=<code>` (public/app.js has the words for each code).
class SignInError extends Error {
  constructor(code, detail) { super(detail || code); this.signInCode = code; }
}

function config(env = process.env) {
  const clientId = (env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  const domain = (env.GOOGLE_HOSTED_DOMAIN || 'nutricost.com').trim().toLowerCase();
  return { clientId, clientSecret, domain };
}

const random = () => crypto.randomBytes(32).toString('base64url');
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// GET /auth/google: where to send the browser, and what the session keeps until Google sends it back (state, nonce, PKCE verifier).
function start(cfg, redirectUri, now = Date.now()) {
  const pending = { state: random(), nonce: random(), verifier: random(), at: now };
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email',
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: crypto.createHash('sha256').update(pending.verifier).digest('base64url'),
    code_challenge_method: 'S256',
    hd: cfg.domain, // a hint for Google's account chooser only; the `hd` claim is what is checked
    prompt: 'select_account',
  });
  return { url: `${endpoints.auth}?${params}`, pending };
}

function decodeIdToken(idToken) {
  const parts = typeof idToken === 'string' ? idToken.split('.') : [];
  if (parts.length !== 3) throw new SignInError('token', 'malformed ID token');
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw new SignInError('token', 'unreadable ID token'); }
}

// The claims of a token from Google's token endpoint, checked; returns the verified email, trimmed and lower-cased.
function checkClaims(cfg, claims, nonce, now = Date.now()) {
  const sec = Math.floor(now / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!ISSUERS.includes(claims.iss)) throw new SignInError('token', 'issuer');
  if (!aud.includes(cfg.clientId) || (aud.length > 1 && claims.azp !== cfg.clientId)) throw new SignInError('token', 'audience');
  if (!(Number(claims.exp) > sec)) throw new SignInError('token', 'expired');
  if (!sameText(claims.nonce, nonce)) throw new SignInError('token', 'nonce');
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || !(claims.email_verified === true || claims.email_verified === 'true')) throw new SignInError('unverified');
  const hd = typeof claims.hd === 'string' ? claims.hd.toLowerCase() : '';
  if (hd !== cfg.domain || !email.endsWith(`@${cfg.domain}`)) throw new SignInError('domain');
  return email;
}

// GET /auth/google/callback: `pending` is what start() left in the session (already removed from it by the route: single use), `query`
// is Google's redirect. Exchanges the code and returns the verified email; throws SignInError for anything refused.
async function finish(cfg, { pending, query, redirectUri, now = Date.now() }) {
  if (!pending || !sameText(String(query.state || ''), pending.state) || now - pending.at > PENDING_MS) throw new SignInError('state');
  if (query.error) throw new SignInError('cancelled', String(query.error));
  if (!query.code) throw new SignInError('state', 'no code');
  let res;
  try {
    res = await fetch(endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code: String(query.code), client_id: cfg.clientId, client_secret: cfg.clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: pending.verifier,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new SignInError('google', e.message);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id_token) throw new SignInError('google', `token endpoint ${res.status} ${body.error || ''}`.trim());
  return checkClaims(cfg, decodeIdToken(body.id_token), pending.nonce, now);
}

module.exports = { config, start, finish, checkClaims, SignInError, endpoints };
