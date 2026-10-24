require('dotenv').config();

const env = process.env;

module.exports = {
  port: +env.PORT || 5000,
  mongoUri: env.MONGODB_URI || 'mongodb://127.0.0.1:27017/smart_crm',
  jwt: {
    accessSecret: env.JWT_ACCESS_SECRET || 'dev-access-secret',
    refreshSecret: env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    accessTtl: env.ACCESS_TTL || '15m',
    refreshDays: +env.REFRESH_TTL_DAYS || 7,
  },
  corsOrigin: env.CORS_ORIGIN || '*',
  ai: {
    provider: env.AI_PROVIDER || 'openai',
    openaiKey: env.OPENAI_API_KEY,
    openaiModel: env.OPENAI_MODEL || 'gpt-4o-mini',
    geminiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL || 'gemini-2.0-flash',
  },
  smtp: {
    host: env.SMTP_HOST,
    port: +env.SMTP_PORT || 587,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM || 'crm@example.com',
  },
  twilio: {
    sid: env.TWILIO_ACCOUNT_SID,
    token: env.TWILIO_AUTH_TOKEN,
    smsFrom: env.TWILIO_SMS_FROM,
    waFrom: env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
  },
  // Ad network APIs (Ads > Ad accounts > Connect API). Google values here are the defaults for every company;
  // a company can override them on its account. The OAuth client lets companies connect with "Sign in with Google".
  googleAds: {
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
    clientId: env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
    loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    apiVersion: env.GOOGLE_ADS_API_VERSION || 'v26',
  },
  metaGraphVersion: env.META_GRAPH_VERSION || 'v23.0',
  webhookSecret: env.WEBHOOK_SECRET || 'dev-webhook-secret',
  // Public base URL of this server (https://crm.example.com). Needed for outbound IVR calls and delivery callbacks.
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  // Encrypts channel-provider credentials at rest. Falls back to a key derived from JWT_ACCESS_SECRET.
  encryptionKey: env.ENCRYPTION_KEY,
  defaultCountryCode: (env.DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, ''),
  schedulerEnabled: env.SCHEDULER_ENABLED !== 'false',
  // false = only the platform owner creates companies (owner console at /owner.html).
  allowSignup: env.ALLOW_SIGNUP !== 'false',
  ownerTokenTtl: env.OWNER_TOKEN_TTL || '12h',
  // Desktop installs: how long the app keeps working offline before it must re-check its licence.
  offlineGraceDays: +env.OFFLINE_GRACE_DAYS || 7,
  // Built desktop installers are served from here at /downloads.
  downloadsDir: env.DOWNLOADS_DIR || require('path').join(__dirname, '..', 'downloads'),
};
