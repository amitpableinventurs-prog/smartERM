/**
 * OAuth sign-in for ad networks: GET /api/oauth/google-ads/callback
 * Ads > Ad accounts > Connect API > "Sign in with Google" opens googleConsentUrl(); Google sends the user back
 * here with a code, which is exchanged for a refresh token and stored (sealed) on the ad account.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../config');
const adsync = require('../services/adsync');
const { HttpError } = require('../utils/helpers');

const router = express.Router();
const AUD = 'google-ads-oauth';
const redirectUri = () => `${config.publicUrl}/api/oauth/google-ads/callback`;

function googleConsentUrl(company, account) {
  const g = config.googleAds;
  if (!g.clientId || !g.clientSecret || !config.publicUrl) throw new HttpError(400, 'Google sign-in needs GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET and PUBLIC_URL in .env; paste a refresh token instead');
  const state = jwt.sign({ c: String(company), a: String(account) }, config.jwt.accessSecret, { expiresIn: '15m', audience: AUD });
  const q = new URLSearchParams({
    client_id: g.clientId, redirect_uri: redirectUri(), response_type: 'code', scope: 'https://www.googleapis.com/auth/adwords',
    access_type: 'offline', prompt: 'consent', state, // prompt=consent: Google only returns a refresh token on consent
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (res, ok, msg) => res.status(ok ? 200 : 400).type('html').send(
  `<!doctype html><meta charset="utf-8"><title>Google Ads</title><body style="font:16px system-ui;padding:40px;text-align:center">`
  + `<h2>${ok ? 'Google Ads connected' : 'Could not connect Google Ads'}</h2><p>${esc(msg)}</p><p>You can close this window and press "Sync now" in the CRM.</p></body>`);

router.get('/google-ads/callback', async (req, res) => {
  if (req.query.error) return page(res, false, String(req.query.error));
  let st;
  try { st = jwt.verify(String(req.query.state || ''), config.jwt.accessSecret, { audience: AUD }); } catch { return page(res, false, 'This sign-in link has expired. Start again from the CRM.'); }
  const g = config.googleAds;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({ grant_type: 'authorization_code', code: String(req.query.code || ''), client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: redirectUri() }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.refresh_token) return page(res, false, data.error_description || data.error || 'Google did not return a refresh token.');
  const acc = await adsync.storeGoogleToken(st.c, st.a, data.refresh_token);
  page(res, true, `"${acc.name}" can now sync campaigns and spend.`);
});

module.exports = router;
module.exports.googleConsentUrl = googleConsentUrl;
