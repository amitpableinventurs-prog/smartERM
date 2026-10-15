const { ZodError } = require('zod');
const { AuditLog } = require('../models');

const validate = (schema, where = 'body') => (req, _res, next) => {
  req[where] = schema.parse(req[where]);
  next();
};

function notFound(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Validation failed', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
  if (err.name === 'CastError') return res.status(400).json({ error: `Invalid ${err.path}` });
  if (err.code === 11000) return res.status(409).json({ error: 'Duplicate value', details: err.keyValue });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message, details: err.details });
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
