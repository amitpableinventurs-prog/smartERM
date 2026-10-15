const nodemailer = require('nodemailer');
const config = require('../config');
const { Communication } = require('../models');
const providers = require('./providers');
const { normalize } = require('../utils/phone');
const { isOptedOut } = require('./contacts');

let transport;
const mailer = () => (transport ||= nodemailer.createTransport({
  host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
  auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
}));

// Delivers through the company's provider for the channel (see Communication Hub > Providers),
// otherwise marks the message "simulated". Returns { status, providerId }.
async function deliver(company, channel, to, subject, body, opts) {
  if (channel === 'email') {
    if (!config.smtp.host) return { status: 'simulated' };
    await mailer().sendMail({ from: config.smtp.from, to, subject: subject || '(no subject)', text: body });
    return { status: 'sent' };
  }
  return providers.sendMessage(await providers.resolve(company, channel), channel, to, body, opts);
}

async function send({ company, channel, to, subject, body, relatedTo, by, campaign, workflowRun, conversation, broadcast, bot, mediaUrl, waTemplate, ignoreDnd }) {
  let status, providerId, error;
  if (channel === 'sms' || channel === 'whatsapp') to = normalize(to) || to;
  try {
    if (!to) throw new Error('Recipient has no address for this channel');
    if (channel !== 'email' && !ignoreDnd && (await isOptedOut(company, to, channel))) throw new Error('Recipient has opted out (DND)');
    ({ status, providerId } = await deliver(company, channel, to, subject, body, { mediaUrl, waTemplate }));
  } catch (e) {
    status = 'failed';
    error = e.message;
  }
  const doc = await Communication.create({
    company, channel, direction: 'outbound', to, subject, body, status, relatedTo, by, campaign, workflowRun,
    conversation, broadcast, bot: !!bot, providerId, summary: error,
  });
  if (status === 'failed') {
    const err = new Error(error);
    err.comm = doc;
    throw err;
  }
  return doc;
}

// Pick the right address for a channel from a lead/customer document.
const addressFor = (channel, person) => (channel === 'email' ? person?.email : person?.phone);

module.exports = { send, addressFor };
