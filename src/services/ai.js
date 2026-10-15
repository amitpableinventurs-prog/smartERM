const config = require('../config');
const { LEAD_STAGES } = require('../models');

const hasKey = () => (config.ai.provider === 'gemini' ? !!config.ai.geminiKey : !!config.ai.openaiKey);

async function llm(system, user, { json = false } = {}) {
  if (config.ai.provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.ai.geminiModel}:generateContent?key=${config.ai.geminiKey}`;
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: json ? { responseMimeType: 'application/json' } : {},
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    return (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ai.openaiKey}` },
    body: JSON.stringify({
      model: config.ai.openaiModel,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content ?? '';
}

// Runs the LLM when a key exists; any failure (or no key) falls back to the heuristic.
async function ask(system, user, fallback, opts = {}) {
  if (!hasKey()) return { ...(await fallback()), engine: 'heuristic' };
  try {
    const out = await llm(system, user, opts);
    if (!opts.json) return { text: out, engine: config.ai.provider };
    return { ...JSON.parse(out), engine: config.ai.provider };
  } catch (e) {
    return { ...(await fallback()), engine: 'heuristic', note: `LLM unavailable: ${e.message}` };
  }
}

const brief = (o) => JSON.stringify(o, null, 0).slice(0, 4000);

// ---------- Lead scoring ----------
const SOURCE_WEIGHT = { referral: 20, website: 12, form: 12, whatsapp: 10, sms: 8, ivr: 8, event: 10, ads: 6, bulk: 4, import: 3, manual: 5 };
const STAGE_WEIGHT = { new: 0, contacted: 8, qualified: 18, proposal_sent: 28, negotiation: 38, won: 100, lost: 0 };

function heuristicScore(lead, activityCount = 0) {
  const reasons = [];
  let s = 10;
  if (lead.email) { s += 10; reasons.push('has email'); }
  if (lead.phone) { s += 10; reasons.push('has phone'); }
  if (lead.organization) { s += 5; reasons.push('company known'); }
  const src = SOURCE_WEIGHT[lead.source] ?? 5;
  s += src; reasons.push(`source ${lead.source} (+${src})`);
  if (lead.budget) { const b = Math.min(20, Math.round(Math.log10(lead.budget + 1) * 4)); s += b; reasons.push(`budget (+${b})`); }
  s += STAGE_WEIGHT[lead.status] ?? 0;
  if (lead.status !== 'new') reasons.push(`stage ${lead.status}`);
  const eng = Math.min(15, activityCount * 3);
  if (eng) { s += eng; reasons.push(`${activityCount} interactions (+${eng})`); }
  if (lead.status === 'lost') s = Math.min(s, 15);
  return { score: Math.max(0, Math.min(100, Math.round(s))), reason: reasons.join(', ') };
}

async function scoreLead(lead, activityCount = 0) {
  const base = heuristicScore(lead, activityCount);
  const r = await ask(
    'You are a CRM lead-scoring expert. Return JSON {"score":0-100,"reason":"short"} estimating conversion probability.',
    brief({ lead, interactions: activityCount }),
    async () => base,
    { json: true }
  );
  const score = Math.max(0, Math.min(100, Math.round(+r.score))) || base.score;
  return { score, reason: r.reason || base.reason, engine: r.engine };
}

// ---------- Next best action ----------
function heuristicAction(lead) {
  const p = lead.score ?? 0;
  if (lead.status === 'won' || lead.status === 'lost') return { action: 'No action needed', priority: 'low' };
  if (p >= 70) return { action: `Call today and send a tailored proposal (${p}% conversion probability)`, priority: 'high' };
  if (p >= 40) return { action: 'Send a WhatsApp follow-up and schedule a call within 2 days', priority: 'medium' };
  return { action: 'Add to email nurture sequence and re-evaluate in 7 days', priority: 'low' };
}

async function nextBestAction(lead, history = []) {
  return ask(
    'You are a sales coach. Return JSON {"action":"one concrete next step","priority":"low|medium|high","probability":0-100}.',
    brief({ lead, recentActivity: history }),
    async () => ({ ...heuristicAction(lead), probability: lead.score ?? 0 }),
    { json: true }
  );
}

// ---------- Text generation ----------
async function generateMessage({ channel, purpose, person, tone = 'friendly', context = '' }) {
  const name = person?.name || 'there';
  return ask(
    `You write concise ${channel} messages for a sales team. Tone: ${tone}. Return only the message${channel === 'email' ? ' with a first line "Subject: ..."' : ''}.`,
    `Purpose: ${purpose}\nRecipient: ${brief(person)}\nContext: ${context}`,
    async () => {
      const body = `Hi ${name}, ${purpose.replace(/^./, (c) => c.toLowerCase())}. Let me know a good time to talk.`;
      return { text: channel === 'email' ? `Subject: Following up\n\n${body}\n\nBest regards` : body };
    }
  );
}

async function suggestReply(incoming, person) {
  return ask(
    'You are a helpful sales assistant. Suggest a short reply to the customer message. Return only the reply text.',
    `Customer: ${brief(person)}\nMessage: ${incoming}`,
    async () => ({ text: `Hi ${person?.name || 'there'}, thanks for your message! I'll get back to you shortly with details.` })
  );
}

// ---------- Sentiment ----------
const POS = ['great', 'thanks', 'thank', 'good', 'love', 'excellent', 'interested', 'happy', 'perfect', 'yes', 'awesome'];
const NEG = ['bad', 'terrible', 'angry', 'cancel', 'refund', 'not interested', 'worst', 'disappointed', 'expensive', 'no', 'complaint', 'unhappy'];

async function sentiment(text) {
  return ask(
    'Classify sentiment. Return JSON {"sentiment":"positive|neutral|negative","confidence":0-1}.',
    text,
    async () => {
      const t = text.toLowerCase();
      const p = POS.filter((w) => t.includes(w)).length;
      const n = NEG.filter((w) => t.includes(w)).length;
      return { sentiment: p > n ? 'positive' : n > p ? 'negative' : 'neutral', confidence: p === n ? 0.5 : 0.7 };
    },
    { json: true }
  );
}

async function summarize(text) {
  return ask('Summarize this call/chat in 2-3 bullet points and list action items.', text, async () => {
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    return { text: sentences.slice(0, 3).join(' ') + (sentences.length > 3 ? ' …' : '') };
  });
}

// ---------- Forecast & churn (statistical; no LLM needed) ----------
function forecast(openDeals, monthlyWon) {
  const weighted = openDeals.reduce((s, d) => s + d.value * ((d.probability ?? 10) / 100), 0);
  const last = monthlyWon.slice(-3).map((m) => m.revenue);
  const trend = last.length ? last.reduce((a, b) => a + b, 0) / last.length : 0;
  return {
    pipelineValue: openDeals.reduce((s, d) => s + d.value, 0),
    weightedPipeline: Math.round(weighted),
    projectedNextMonth: Math.round(weighted * 0.5 + trend * 0.5),
    trailingAvgRevenue: Math.round(trend),
  };
}

function churnRisk(customer, daysInactive, negativeComms = 0) {
  let r = Math.min(60, daysInactive * 0.7);
  r += Math.min(30, negativeComms * 10);
  if (!(customer.purchases || []).length) r += 10;
  r = Math.max(0, Math.min(100, Math.round(r)));
  return { risk: r, level: r >= 70 ? 'high' : r >= 40 ? 'medium' : 'low' };
}

// ---------- Natural-language search ----------
const SEARCHABLE = {
  Lead: ['name', 'email', 'phone', 'organization', 'source', 'status', 'tags'],
  Customer: ['name', 'email', 'phone', 'organization', 'lifecycle', 'tags'],
  Deal: ['title', 'status', 'stage'],
};

async function nlSearchFilter(query, model) {
  const fields = SEARCHABLE[model];
  const fallback = async () => ({ text: query, filter: {} });
  const r = await ask(
    `Translate a CRM search into JSON {"filter":{...},"text":"free-text or empty"}. Allowed ${model} fields: ${fields.join(', ')}, score (number), budget (number), value (number). ` +
      `Use only equality values, or {"gte":n}/{"lte":n} for numbers. Lead statuses: ${LEAD_STAGES.join(', ')}.`,
    query,
    fallback,
    { json: true }
  );
  const filter = {};
  for (const [k, v] of Object.entries(r.filter || {})) {
    if (![...fields, 'score', 'budget', 'value'].includes(k)) continue; // whitelist: never trust LLM output as a raw query
    if (v && typeof v === 'object') {
      const range = {};
      if (Number.isFinite(+v.gte)) range.$gte = +v.gte;
      if (Number.isFinite(+v.lte)) range.$lte = +v.lte;
      if (Object.keys(range).length) filter[k] = range;
    } else if (typeof v === 'string' || typeof v === 'number') filter[k] = v;
  }
  return { filter, text: typeof r.text === 'string' ? r.text : '', engine: r.engine };
}

module.exports = {
  scoreLead, heuristicScore, nextBestAction, generateMessage, suggestReply, sentiment, summarize,
  forecast, churnRisk, nlSearchFilter, SEARCHABLE, hasKey, ask,
};
