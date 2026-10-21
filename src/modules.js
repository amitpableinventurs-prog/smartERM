// Sellable modules. The platform owner switches them on per company; dashboard, users, company settings,
// audit log and notifications are always available.
const MODULES = {
  crm: { label: 'CRM & Sales', desc: 'Leads, customers, deals, tasks, campaigns and workflow automation' },
  hub: { label: 'Communication Hub', desc: 'Bulk SMS / WhatsApp, IVR calls, AI bot and shared inbox' },
  ads: { label: 'Ads Manager', desc: 'Ad accounts, campaigns, creatives, spend and lead attribution' },
  hr: { label: 'HR & Payroll', desc: 'Employees, attendance, leave, payroll and My Space' },
  ai: { label: 'AI Assistant', desc: 'Smart search, forecasts, churn risk and content generation' },
  reports: { label: 'Reports', desc: 'Funnel, revenue, conversion, team and campaign reports' },
};
const MODULE_KEYS = Object.keys(MODULES);

// Companies created before modules existed have every module.
const modulesOf = (co) => co?.modules ?? MODULE_KEYS;
const hasModule = (co, key) => modulesOf(co).includes(key);

// Why a company may not use the system right now, or null when it may.
function accessProblem(co) {
  if (!co) return 'Company not found';
  if (co.status === 'suspended') return `Account suspended${co.suspendReason ? `: ${co.suspendReason}` : ''}. Contact your provider.`;
  if (co.validUntil && co.validUntil < new Date()) return 'Licence expired. Contact your provider to renew.';
  return null;
}

module.exports = { MODULES, MODULE_KEYS, modulesOf, hasModule, accessProblem };
