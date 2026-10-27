/**
 * One-click ad account connection: GET /api/oauth/google-ads/callback and /api/oauth/meta/callback
 * Ads > Ad accounts > "Connect with Google / Facebook" opens consentUrl(); after the user approves, the callback
 * exchanges the code for a token, finds every ad account that login can reach, saves them (credentials sealed)
 * and starts their first sync. No token or account ID has to be copied by hand.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const adsync = require('../services/adsync');
const tenants = require('../services/tenants');
const { accessProblem, hasModule } = require('../modules');
const { HttpError } = require('../utils/helpers');

const router = express.Router();
const AUD = 'ads-oauth';
// Meta permissions: campaigns + spend, pause/budget, and lead-form leads from the Pages that run the ads.
const META_SCOPES = ['ads_read', 'ads_management', 'business_management', 'leads_retrieval', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads'];
const NAMES = { google: 'Google Ads', meta: 'Meta (Facebook / Instagram) Ads' };
const redirectUri = (platform) => `${config.publicUrl}/api/oauth/${platform === 'google' ? 'google-ads' : 'meta'}/callback`;

// account (optional): the CRM ad account the sign-in started from; it gets the first reachable account if its own ID isn't.
function consentUrl(platform, company, account) {
  if (!NAMES[platform]) throw new HttpError(404, 'Unknown ad platform');
  if (!adsync.signInReady(platform)) {
    throw new HttpError(400, platform === 'google'
      ? 'One-click Google connect needs GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET and PUBLIC_URL in .env. Until then, paste a refresh token in Connect API.'
      : 'One-click Facebook connect needs META_APP_ID, META_APP_SECRET and PUBLIC_URL in .env. Until then, paste a System User token in Connect API.');
  }
  const state = jwt.sign({ p: platform, c: String(company), ...(account && { a: String(account) }) }, config.jwt.accessSecret, { expiresIn: '15m', audience: AUD });
  if (platform === 'google') {
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: config.googleAds.clientId, redirect_uri: redirectUri('google'), response_type: 'code', scope: 'https://www.googleapis.com/auth/adwords',
      access_type: 'offline', prompt: 'consent', state, // prompt=consent: Google only returns a refresh token on consent
    })}`;
  }
  const m = config.metaApp;
  return `https://www.facebook.com/${config.metaGraphVersion}/dialog/oauth?${new URLSearchParams({
    client_id: m.appId, redirect_uri: redirectUri('meta'), response_type: 'code', state,
    ...(m.loginConfigId ? { config_id: m.loginConfigId, override_default_response_type: 'true' } : { scope: META_SCOPES.join(',') }),
  })}`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (res, platform, ok, msg) => res.status(ok ? 200 : 400).type('html').send(
  `<!doctype html><meta charset="utf-8"><title>${esc(NAMES[platform] || 'Ads')}</title><body style="font:16px system-ui;padding:40px;text-align:center;max-width:640px;margin:auto">`
  + `<h2>${ok ? `${esc(NAMES[platform])} connected` : `Could not connect ${esc(NAMES[platform] || 'the ad account')}`}</h2><p>${esc(msg)}</p>`
  + `<p style="color:#666">You can close this window. ${ok ? 'The CRM updates by itself.' : 'Start again from Ads &gt; Ad accounts.'}</p></body>`);

async function getJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || data.error_description || data.error || `HTTP ${r.status}`);
  return data;
}

// Returns { found, tokenExpiresAt } for the signed-in user.
const EXCHANGE = {
  async google(code) {
    const g = config.googleAds;
    const data = await getJson('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: redirectUri('google') }),
    });
    if (!data.refresh_token) throw new Error('Google did not return a refresh token. Remove this app from your Google account permissions and try again.');
    return { refreshToken: data.refresh_token, found: await adsync.googleDiscover(data.refresh_token) };
  },
  async meta(code) {
    const m = config.metaApp;
    const G = `https://graph.facebook.com/${config.metaGraphVersion}/oauth/access_token`;
    let tok = await getJson(`${G}?${new URLSearchParams({ client_id: m.appId, client_secret: m.appSecret, redirect_uri: redirectUri('meta'), code })}`);
    // Short-lived user tokens (~2 h) are swapped for a 60-day one; Login for Business system-user tokens have no expiry.
    if (tok.expires_in && tok.expires_in < 7 * 86400) {
      tok = await getJson(`${G}?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: m.appId, client_secret: m.appSecret, fb_exchange_token: tok.access_token })}`);
    }
    return { found: await adsync.metaDiscover(tok.access_token), tokenExpiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : undefined };
  },
};

async function callback(req, res, platform) {
  if (req.query.error) return page(res, platform, false, String(req.query.error_description || req.query.error));
  let st;
  try { st = jwt.verify(String(req.query.state || ''), config.jwt.accessSecret, { audience: AUD }); } catch { st = null; }
  if (!st || st.p !== platform) return page(res, platform, false, 'This sign-in link has expired. Start again from the CRM.');
  const co = await tenants.getCompany(st.c);
  if (accessProblem(co) || !hasModule(co, 'ads')) return page(res, platform, false, 'The Ads module is not active for this company.');
  try {
    const { found, tokenExpiresAt, refreshToken } = await EXCHANGE[platform](String(req.query.code || ''));
    // Google with no reachable client account yet (e.g. a test-level developer token): keep the login on the starting account.
    if (platform === 'google' && !found.length && st.a) {
      const acc = await adsync.storeGoogleToken(st.c, st.a, refreshToken);
      return page(res, platform, true, `Signed in for "${acc.name}". No other accounts were found automatically; check its customer ID and press "Sync now".`);
    }
    const accs = await adsync.connectDiscovered(st.c, platform, st.a, found, { tokenExpiresAt });
    const until = tokenExpiresAt ? ` This login is valid until ${tokenExpiresAt.toISOString().slice(0, 10)}; you will be reminded a week before.` : '';
    page(res, platform, true, `${accs.length} ad account${accs.length === 1 ? '' : 's'} connected: ${accs.map((a) => a.name).join(', ')}. Campaigns, spend and leads are syncing now.${until}`);
  } catch (e) {
    page(res, platform, false, e.message);
  }
}

router.get('/google-ads/callback', (req, res) => callback(req, res, 'google'));
router.get('/meta/callback', (req, res) => callback(req, res, 'meta'));

module.exports = router;
module.exports.consentUrl = consentUrl;
