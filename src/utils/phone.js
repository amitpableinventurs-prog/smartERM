// Phone numbers arrive in every shape ("98765 43210", "+91-98765-43210", "whatsapp:+9198..."),
// so contacts are matched on the last 10 digits and messages are sent to E.164.

const cc = () => (process.env.DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '');

function normalize(raw, countryCode = cc()) {
  if (raw == null) return '';
  const s = String(raw).trim().replace(/^(whatsapp|tel|sms):/i, '');
  const d = s.replace(/\D/g, '');
  if (d.length < 6) return '';
  if (s.startsWith('+')) return '+' + d;
  if (d.startsWith('00')) return '+' + d.slice(2);
  if (d.length === 10) return '+' + countryCode + d;
  if (d.length === 11 && d.startsWith('0')) return '+' + countryCode + d.slice(1);
  return '+' + d;
}

function phoneKey(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 6 ? d.slice(-10) : undefined;
}

// Matches a stored phone whose digits end with `key`, whatever separators it uses (for records saved before phoneKey existed).
const looseRegex = (key) => new RegExp(key.split('').join('\\D*') + '\\D*$');

module.exports = { normalize, phoneKey, looseRegex };
