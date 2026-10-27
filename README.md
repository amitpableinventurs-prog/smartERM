# Smart CRM API

Node.js + Express + MongoDB REST API: multi-company CRM with a workflow automation engine and AI features.

## Run

```bash
npm install
cp .env.example .env      # set MONGODB_URI and the JWT secrets
npm start                 # or: npm run dev
npm test                  # end-to-end smoke test (uses an in-memory MongoDB, no setup needed)
npm run tunnel            # dev server on a public https address, for real Twilio calls from localhost
```

Every `/api/*` route except `/api/auth/*` and `/api/webhooks/*` needs `Authorization: Bearer <accessToken>`.
Data is isolated per company. Lists accept `?page=&limit=&sort=&q=` plus per-resource filters.

AI works without keys (rule-based fallback; responses say `"engine":"heuristic"`). Set `OPENAI_API_KEY` or `GEMINI_API_KEY` (+ `AI_PROVIDER`) for LLM output.
Email is logged as `simulated` until SMTP is set. SMS, WhatsApp and voice use the provider chosen per company under Communication Hub › Channel Providers (simulated by default; the `TWILIO_*` variables still work as a fallback for SMS/WhatsApp).

## Web panels

Open `http://localhost:5000/` after `npm start`. Register a company (you become Super Admin), then create users under Team & Users. Each role signs in to its own panel with its own menu (Super Admin/Admin, Manager, Sales, Support).

## Owner console, licensing, desktop app and client domains

You (the platform owner) sit above every company. Data for all clients stays in this server's one database.

**Owner console** at `/owner.html`. Create the first owner with `npm run owner:create -- you@example.com "StrongPass123" "Your Name"` (`npm run seed` also creates `owner@demo.com` / `Demo@1234`). From the console you can:

- create a client company together with its super admin login;
- choose its modules: `crm`, `hub`, `ads`, `hr`, `ai`, `reports`. The dashboard, users, company settings, audit log and notifications are always on;
- set an expiry date, a maximum number of active users and a maximum number of desktop computers;
- set the app name and colour that client sees;
- suspend or reactivate the company, which takes effect within seconds;
- open the client's panel as their super admin. This is recorded in the client's audit log.

| What the licence controls | Where it is enforced |
|---|---|
| Modules | Module gates in `src/app.js` return 403 for API routes outside the plan. Panel menus hide those pages. |
| Suspended / expired | Every API call, login and token refresh is refused. Public form, SMS and WhatsApp webhooks are refused. Automation stops, and running broadcasts and drip campaigns are paused. |
| Max users / computers | Creating or reactivating a user beyond the limit fails, and so does activating one computer too many. |

Set `ALLOW_SIGNUP=false` to switch off public company sign-up, so that only you create companies.

**Windows desktop app** (`desktop/`, Electron). One installer serves every client:

1. Build it with `SERVER_URL=https://crm.example.com npm run desktop:build`, or in PowerShell `$env:SERVER_URL="https://crm.example.com"; npm run desktop:build`. The installer is written to `downloads/SmartCRM-Setup-<version>.exe`, the server offers it at `/downloads/...`, and the owner console links to it. The installer adds a desktop shortcut and a Start-menu shortcut. Without `SERVER_URL` the app asks for the server address on first start.
2. Send the client the installer and their **activation key**, which you find in the owner console under the client's *Desktop app* section.
3. On first start the app asks for the key. It registers the computer (shown under *Activated computers*), and from then on it shows only that client's modules.
4. The app checks its licence at every start and every 30 minutes. Revoking a computer or suspending the company locks the app. Without internet the app keeps working for `OFFLINE_GRACE_DAYS` (7 by default) since its last successful check. Issuing a new key does not affect computers that are already activated.

`npm run desktop:dev` runs the app without building an installer. The build downloads about 300 MB of tools. If drive C is short of space, point the caches elsewhere first, for example in PowerShell: `$env:npm_config_cache="D:\cache\npm"; $env:ELECTRON_CACHE="D:\cache\electron"; $env:ELECTRON_BUILDER_CACHE="D:\cache\electron-builder"`. The installer is not code-signed, so Windows SmartScreen shows "unknown publisher" until you sign it with a code-signing certificate (electron-builder `win.certificateFile`).

**Offline mode** (`public/offline.js`, used by the desktop app and the browser):

- Pages opened before keep showing their last data when the server cannot be reached.
- While offline, these changes are queued on the computer: creating or editing leads, customers, deals and tasks, adding notes to leads, completing tasks, and logging communications. They sync in order when the connection returns, and records created offline get their real ids.
- If the server refuses a queued change (for example a duplicate or a permission problem), it is kept for review. The pill in the bottom-left corner shows "could not sync"; click it to see these changes.
- Everything else needs a connection: sending messages, bulk sends, AI, payroll and so on.

**Client domains.** In the owner console, add a domain such as `crm.client.com` to a company. The client then creates two DNS records:

- a `CNAME` from `crm.client.com` to your server's host (taken from `PUBLIC_URL`);
- a `TXT` record at `_smartcrm-verify.crm.client.com` with the token the console shows.

When both records are in place, press **Verify**. On a verified domain:

- the sign-in page shows the client's name;
- sign-up is hidden;
- only that client's users can sign in.

For HTTPS on these domains, put Caddy in front of the server using `deploy/Caddyfile`. Caddy asks `GET /api/domains/allowed?domain=` before it issues a certificate, so only verified domains get one.

## Roles

`super_admin` > `admin` > `manager` > `ads_manager` (advertising only) / `hr_manager` / `comm_manager` (Communication Hub) / `sales` (own leads/deals/tasks/customers/chats only) > `support` / `telecaller` (inbox and own leads). See `ACL` in `src/middleware/auth.js`.

## Endpoints

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/register` `login` `refresh` (rotating) `logout` `change-password`, `GET /me` |
| Leads | CRUD `/api/leads`; `GET /duplicates`; `POST /:id/notes` `attachments` `assign` `score` `convert`; `GET /:id/timeline`. Duplicate email/phone → 409 (override `?force=true`) |
| Customers | CRUD `/api/customers`; `POST /:id/purchases` `documents`; `GET /:id/timeline` `churn` |
| Deals / pipeline | CRUD `/api/deals`; `POST /:id/win` `lose` `payments`; `GET /board/:pipelineId`; CRUD `/api/pipelines` |
| Tasks | CRUD `/api/tasks` (`?due=overdue\|today`); `POST /:id/complete` (spawns next if recurring); `GET /calendar/range?from=&to=` |
| Communication | `/api/communications` (log calls/notes); `POST /send` (email/whatsapp/sms, templates); `POST /:id/analyze`; CRUD `/api/templates` |
| Campaigns | CRUD `/api/campaigns` (1 step = blast, many = drip); `POST /preview-audience`; `POST /:id/launch` `pause`; `GET /:id/analytics` |
| Automation | CRUD `/api/workflows`; `GET /meta` (events, step types, built-in templates); `POST /from-template/:i` `/:id/toggle` `/:id/test`; `GET /:id/runs` |
| AI | `POST /api/ai/generate` `suggest-reply` `sentiment` `summarize` `search`; `GET /next-best-action/:leadId` `forecast` `churn` `status` |
| Reports | `GET /api/reports/dashboard` `leads-by-source` `funnel` `revenue` `conversion` `team` `campaigns` `automation` |
| Import/export | `POST /api/data/import/leads` (CSV body); `GET /api/data/export/leads\|customers` |
| Admin | `/api/users`, `/api/company` (+`rotate-api-key`), `/api/audit-logs`, `/api/notifications`, `/api/webhook-subscriptions` (outbound, HMAC-signed) |
| Communication Hub | `/api/hub/*`: `overview`, `providers`, `bot` (+ `bot/test`), `broadcasts` (+ `recipients/csv` `recipients/crm` `launch` `pause` `resume` `cancel` `report`), `conversations` (+ `reply` `takeover` `release` `assign` `close` `suggest`), `ivr/flows`, `ivr/calls`, `ivr/call`, `ivr/simulate`, `optouts` |
| Provider webhooks | `/api/webhooks/comm/:token/sms` `whatsapp` `status` `voice` `voice/step` `voice/status` (full URLs on the Providers page) |
| Owner (aud=owner token) | `POST /api/owner/login`; `GET /overview` `/modules` `/installer`; `GET/POST /companies`, `GET/PATCH /companies/:id`; `POST /companies/:id/activation-key` `login-as` `domains` `domains/:host/verify`; `DELETE /companies/:id/domains/:host`; `PATCH/DELETE /devices/:id` |
| Desktop licence | `POST /api/activate` (key → device secret), `POST /api/activate/check` |
| Public tenant | `GET /api/tenant` (branding for the requesting domain), `GET /api/domains/allowed?domain=` (Caddy on-demand TLS) |
| Public inbound | `POST /api/webhooks/form/:apiKey` (web form → lead), `/activity/:apiKey`; `POST /api/webhooks/whatsapp` and `/email` (header `x-webhook-secret`, body `{apiKey, from, body}`) |

## Automation

A workflow is `trigger { event, conditions[] }` + `steps[]`.

- Events: `lead.created`, `lead.status_changed`, `deal.created`, `deal.stage_changed`, `payment.received`, `followup.overdue`, `customer.inactive`, `customer.birthday`, `customer.anniversary`, `form.submitted`, `whatsapp.received`, `email.received`, `website.activity`, `sms.received`, `message.intent`, `conversation.handoff`, `call.completed`
- Steps: `assign`, `send_email|whatsapp|sms`, `create_task`, `update_field`, `add_tag`, `notify`, `ai_score`, `wait`, `condition` (`then`/`else` branches, nestable; `{type:"no_reply"}` or `{field, op, value}`)
- Messages are templated: `{{person.name}}`, `{{person.email}}`.
- `wait` suspends the run; the scheduler (60 s tick) resumes it. The scheduler also raises overdue/inactive/birthday events and sends due drip emails.

```json
{
  "name": "Welcome",
  "trigger": { "event": "lead.created" },
  "steps": [
    { "type": "assign", "strategy": "least_loaded" },
    { "type": "send_whatsapp", "body": "Hi {{person.name}}!" },
    { "type": "wait", "days": 2 },
    { "type": "condition", "if": { "type": "no_reply" },
      "then": [{ "type": "notify", "to": "owner", "title": "No reply from {{person.name}}" }] }
  ]
}
```

## Notes

- The scheduler runs inside the API process; run a single instance, or set `SCHEDULER_ENABLED=false` on extra ones.
- `update_field` in a workflow does not emit events, so workflows cannot trigger each other in a loop.

## Ads Manager panel

Sign in as `ads@demo.com` (after `npm run seed`) or create a user with role `ads_manager`. Managers and admins get the same pages under "Advertising".

- **Ad accounts** (Google, Meta, LinkedIn, TikTok, YouTube, X) with monthly budgets and spend tracking.
- **Campaigns**: objective, daily/total budget, audience, schedule. Launch, pause, resume, end, clone. A daily budget above the approval limit (default 5,000, `company.settings.adApprovalLimit`) goes to a manager for approval. A campaign auto-pauses when its total budget is spent.
- **Creatives & A/B**: several creatives per campaign, compare CTR, pick a winner.
- **Performance data**: daily impressions, clicks, spend, leads, conversions and revenue, entered manually or by CSV import (`date,campaign,impressions,clicks,spend,leads,conversions,revenue`). Not synced from the ad networks automatically; that needs each network's API credentials. Enter campaign-level rows or per-creative rows, not both.
- **Dashboard**: spend, CTR, CPC, leads, CPL, ROAS with change vs the previous period, daily chart, platform split, top campaigns.
- **Lead attribution**: campaigns get a tracking code. Form leads posted with `utm_campaign` are linked to the campaign, so the CRM shows real leads, won deals and ROAS per campaign.
- **Insights**: rule-based recommendations (high CPL, no leads, low CTR, strong ROAS, budget pacing) with one-click apply.
- **UTM builder** and form webhook setup.

API: everything is under `/api/ads/*` (`accounts`, `campaigns`, `creatives`, `metrics`, `overview`, `attribution`, `insights`).

## HR, Attendance & Payroll panel

Sign in as `hr@demo.com` (after `npm run seed`) or create a user with role `hr_manager`. Admins get the same pages under "People & Payroll". Every role (including sales, support, ads) has a **My Space** page.

- **Employees**: code, department, salary structure (basic, HRA, allowances, fixed deductions) and bank details. An employee whose email matches a login is linked to it automatically.
- **My Space (everyone)**: punch in/out (late mark after shift start + grace), month calendar, leave balance and requests, payslips once published.
- **Attendance (HR)**: daily roster with quick P / ½ / A / L marks, bulk "mark all present", manual check-in/out times, and a monthly sheet.
- **Leave**: casual / sick / earned (yearly quota) and unpaid. Overlap and balance checks. Approving writes attendance for each working day; weekly offs and holidays are skipped.
- **Holidays** and **Settings**: shift start, grace minutes, full-day hours, weekly-off days, timezone offset (India = 330), leave quotas, PF % and tax %.
- **Payroll**: run for a completed month. `paid days = present + half days × 0.5 + paid leave`, `earned = gross × paid days ÷ working days`, then PF on basic, tax, fixed deductions and one-off adjustments (bonus / recovery). Absent or unmarked past days are unpaid; days not yet happened are not penalised; mid-month joiners are pro-rated. A draft can be re-run and adjusted; finalizing publishes payslips to employees and locks the run. Bank-transfer CSV export and printable payslips.

API: `/api/hr/*` (HR roles) and `/api/me/*` (any signed-in user, own record only).

## Communication Hub (bulk SMS, WhatsApp, IVR + AI)

Sign in as `comm@demo.com` (Communication Hub panel) or `agent@demo.com` (Agent / Telecaller panel) after `npm run seed`. Managers and admins get the same pages under "Communication Hub"; sales and support get the Inbox.

Everything maps to the CRM. Each phone number is matched to a customer or lead using the last 10 digits, so any number format works, and unknown numbers become new leads. Messages, calls, intents and outcomes appear on the record's timeline.

- **Channel Providers**: one provider per channel. Options are Simulated (default), Twilio (SMS, WhatsApp, voice), Meta WhatsApp Cloud API, or a generic HTTP gateway (MSG91, Textlocal, Gupshup, Exotel…) configured with a URL and body template. Credentials are AES-GCM encrypted and shown masked. The page lists the webhook URLs to paste into the provider. Set `PUBLIC_URL` to enable delivery reports, outbound calls and Twilio signature checks.
- **Bulk SMS / WhatsApp / IVR calls**:
  - Audiences come from the CRM (status, source, tags) or a CSV upload (`phone,name,…`; extra columns become `{{vars.column}}`).
  - Broadcasts can be scheduled and are throttled to a set number per minute. DND numbers are skipped.
  - Delivery reports, replies and answered calls are tracked. The report shows the funnel, reply intents, where leads moved and ROI.
  - WhatsApp broadcasts support approved templates and media. IVR broadcasts run an IVR flow for each call.
- **AI Bot & Knowledge**:
  - Answers inbound SMS/WhatsApp from the knowledge base and detects the intent (greeting, interested, pricing, callback, not interested, complaint, support, human, opt-out, other). It also picks out name, email and call-back time.
  - Hands the chat to an agent on complaints, "talk to a person", low confidence or too many turns. The record owner gets it first, otherwise the least busy agent.
  - STOP and other opt-out keywords are always honoured.
  - Uses the LLM when `OPENAI_API_KEY`/`GEMINI_API_KEY` is set, otherwise built-in English + Hindi/Hinglish rules.
- **Intent Mapping**: for each intent, the CRM actions to run once. Available actions: set lead status (never moves backwards), add tag, create task, notify, assign, hand off, add to DND, send SMS/WhatsApp/email, update field. Automation can also use the `message.intent` and `call.completed` events.
- **Inbox**: shared WhatsApp/SMS inbox with views for needs agent, AI handling and mine. Agents can take over, hand back to AI, assign, close, use AI-suggested replies and templates, and start new chats. Sales and telecallers see only chats assigned to them; chats with their own leads are assigned to them automatically.
- **IVR Flows**: steps are say, keypad menu, AI voice agent (speech, knowledge base, goal), transfer, voicemail and hang up. Steps and keypad options can mark intents. The **call simulator** runs a flow in the browser (dial pad, typed or spoken answers, read-aloud) and maps the caller to the CRM like a real call. Real calls use TwiML (Twilio or TwiML-compatible providers).
- **Twilio voice in one click**: when `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are set in `.env`, Channel Providers › Voice shows **Connect Twilio**. It lists the account's voice numbers and verified caller IDs. Pick one as the caller ID. A bought Twilio number is also pointed at the company's IVR, so incoming calls are answered with no Twilio console setup. Verified caller IDs can only place outbound calls. A number that already answers calls for one company can't be taken by another. Trial accounts can only call numbers verified in Twilio.
  - Twilio must reach `PUBLIC_URL`, so `localhost` does not work. For local testing, run `npm run tunnel`. It opens a free Cloudflare quick tunnel (needs `cloudflared`) and starts the server with `PUBLIC_URL` set to the tunnel address. The address changes on every run, so click Connect Twilio again for incoming calls.
- **Call Logs**: every call with its path, keys pressed, transcript, intent, sentiment, AI summary and recording.
- **DND**: opt-outs come from keywords, IVR choices or intents, and can be added manually. Every send path enforces the list, including workflows; a manual send to a DND number returns `409`.

Bulk sending runs inside the scheduler: every 60 seconds, each running broadcast sends one batch of up to `ratePerMinute` messages or calls.
