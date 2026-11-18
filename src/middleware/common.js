const { ZodError } = require('zod');
const { AuditLog } = require('../models');
const errorlog = require('../services/errorlog');

const validate = (schema, where = 'body') => (req, _res, next) => {
  req[where] = schema.parse(req[where]);
  next();
};

// "dueAt" -> "Due at", "salary.basic" -> "Basic"
const label = (p = '') => { const s = String(p).split('.').pop().replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };
const TYPE_NAME = { Number: 'a number', Date: 'a valid date', ObjectId: 'a valid record', Boolean: 'yes or no', String: 'text' };

// Mongoose messages like 'Cast to Number failed for value "NaN" (type number) at path "score"' are not for end users.
function mongooseMessage(e) {
  const l = label(e.path);
  if (e.name === 'CastError') return `${l} must be ${TYPE_NAME[e.kind] || 'a valid value'}`;
  switch (e.kind) {
    case 'required': return `${l} is required`;
    case 'enum': return `${l} must be one of: ${(e.properties?.enumValues || []).join(', ')}`;
    case 'min': return `${l} must be at least ${e.properties?.min}`;
    case 'max': return `${l} must be at most ${e.properties?.max}`;
    case 'minlength': return `${l} is too short`;
    case 'maxlength': return `${l} is too long`;
    case 'regexp': return `${l} is not in the right format`;
    default: return `${l} is not valid`;
  }
}

function notFound(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    const fields = err.issues.map((i) => ({ path: i.path.join('.'), message: i.path.length ? `${label(i.path.join('.'))}: ${i.message}` : i.message }));
    return res.status(400).json({ error: fields.map((f) => f.message).join('; '), details: { fields } });
  }
  if (err.name === 'ValidationError' && err.errors) {
    const fields = Object.values(err.errors).map((e) => ({ path: e.path, message: mongooseMessage(e) }));
    return res.status(400).json({ error: fields.map((f) => f.message).join('; '), details: { fields } });
  }
  if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
  if (err.name === 'CastError') return res.status(400).json({ error: mongooseMessage(err), details: { fields: [{ path: err.path, message: mongooseMessage(err) }] } });
  if (err.code === 11000) return res.status(409).json({ error: 'Duplicate value', details: err.keyValue });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  // Server errors and refused provider calls go to Admin > Error Log; the user sees the request id as "Ref".
  const logged = status >= 500 || status === 424;
  if (logged) errorlog.fromRequest(req, err, status);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message, details: err.details, ...(logged && { requestId: req.id }) });
}

// Records every successful mutating request in the audit log.
function audit(resource) {
  return (req, res, next) => {
    if (req.method === 'GET') return next();
    res.on('finish', () => {
      if (res.statusCode >= 400 || !req.user) return;
      AuditLog.create({
        company: req.companyId, user: req.user._id, method: req.method, path: req.originalUrl,
        resource, action: req.method, docId: req.params.id, status: res.statusCode, ip: req.ip,
      }).catch(() => {});
    });
    next();
  };
}

module.exports = { validate, notFound, errorHandler, audit };
