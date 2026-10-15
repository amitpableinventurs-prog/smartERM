const express = require('express');
const { authorize, scopeFilter } = require('../middleware/auth');
const { audit } = require('../middleware/common');
const { HttpError } = require('./helpers');

const PROTECTED = ['_id', 'company', 'createdAt', 'updatedAt', '__v'];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const clean = (body = {}) => Object.fromEntries(Object.entries(body).filter(([k]) => !PROTECTED.includes(k) && !k.startsWith('$')));

/**
 * Generic company-scoped REST resource.
 * hooks: beforeCreate(req, data), afterCreate(req, doc), beforeUpdate(req, doc, data), afterUpdate(req, doc, before)
 * Returns { router, base } so callers can add extra routes before the /:id routes.
 */
function crud({ Model, resource, search = [], filters = [], populate = '', hooks = {}, scope = true, defaultSort = '-createdAt' }) {
  const router = express.Router();
  const base = (req) => ({ company: req.companyId, ...(scope ? scopeFilter(req, resource) : {}) });
  router.use(audit(resource));

  const find = async (req) => {
    const doc = await Model.findOne({ _id: req.params.id, ...base(req) });
    if (!doc) throw new HttpError(404, `${Model.modelName} not found`);
    return doc;
  };

  router.get('/', authorize(resource, 'r'), async (req, res) => {
    const page = Math.max(1, +req.query.page || 1);
    const limit = Math.min(100, Math.max(1, +req.query.limit || 20));
    const q = { ...base(req) };
    for (const f of filters) {
      const v = req.query[f];
      if (v === undefined || v === '') continue;
      q[f] = v === 'me' ? req.user._id : typeof v === 'string' && v.includes(',') ? { $in: v.split(',') } : v;
    }
    if (req.query.q && search.length) q.$or = search.map((f) => ({ [f]: new RegExp(escapeRe(String(req.query.q)), 'i') }));
    if (hooks.listFilter) Object.assign(q, hooks.listFilter(req));
    const sort = typeof req.query.sort === 'string' && /^-?[\w.]+$/.test(req.query.sort) ? req.query.sort : defaultSort;
    const [data, total] = await Promise.all([
      Model.find(q).sort(sort).skip((page - 1) * limit).limit(limit).populate(populate),
      Model.countDocuments(q),
    ]);
    res.json({ data, page, limit, total, pages: Math.ceil(total / limit) });
  });

  router.post('/', authorize(resource, 'c'), async (req, res) => {
    let data = clean(req.body);
    if (hooks.beforeCreate) data = (await hooks.beforeCreate(req, data)) || data;
    const doc = await Model.create({ ...data, company: req.companyId });
    if (hooks.afterCreate) await hooks.afterCreate(req, doc);
    res.status(201).json(doc);
  });

  return {
    router,
    base,
    find,
    // Call after registering custom routes so they take priority over /:id.
    finish() {
      router.get('/:id', authorize(resource, 'r'), async (req, res) => res.json(await (await find(req)).populate(populate)));
      router.patch('/:id', authorize(resource, 'u'), async (req, res) => {
        const doc = await find(req);
        const before = doc.toObject();
        let data = clean(req.body);
        if (hooks.beforeUpdate) data = (await hooks.beforeUpdate(req, doc, data)) || data;
        doc.set(data);
        await doc.save();
        if (hooks.afterUpdate) await hooks.afterUpdate(req, doc, before);
        res.json(doc);
      });
      router.delete('/:id', authorize(resource, 'd'), async (req, res) => {
        const doc = await find(req);
        if (hooks.beforeDelete) await hooks.beforeDelete(req, doc);
        await doc.deleteOne();
        res.status(204).end();
      });
      return router;
    },
  };
}

module.exports = { crud, clean, escapeRe };
