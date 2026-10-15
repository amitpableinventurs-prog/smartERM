class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// "Hi {{lead.name}}" -> looks up nested keys in ctx. Missing keys render as ''.
function render(tpl = '', ctx = {}) {
  return String(tpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const v = path.split('.').reduce((o, k) => (o == null ? o : o[k]), ctx);
    return v == null ? '' : String(v);
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

function toCsv(docs, fields) {
  const esc = (v) => {
    if (v == null) return '';
    if (v instanceof Date) v = v.toISOString();
    else if (typeof v === 'object') v = JSON.stringify(v);
    v = String(v);
    if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`; // neutralise spreadsheet formula injection
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return [fields.join(','), ...docs.map((d) => fields.map((f) => esc(d[f])).join(','))].join('\n');
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);

module.exports = { HttpError, render, parseCsv, toCsv, pick, addDays };
