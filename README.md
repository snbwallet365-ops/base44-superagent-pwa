# Elowen · Superagent PWA

A mobile-first Next.js 15 workspace inspired by Base44 Superagent. It includes an installable PWA shell, Supabase Auth and private conversation storage, realtime message updates, and server-side Browser Use Cloud v3 task dispatch.

## Run locally

1. Install Node.js 20.9 or newer.
2. Copy `.env.example` to `.env.local` and fill in the values for the services you use.
3. Install packages with `npm install`.
4. Apply `supabase/migrations/202610030001_initial_schema.sql` in the Supabase SQL editor.
5. In Supabase Auth, enable email OTP and add `http://localhost:3000/auth/callback` to the allowed redirect URLs.
6. Start the app with `npm run dev` and visit `http://localhost:3000`.

The interface works in device-local mode without credentials. Cloud sync and live agent execution require Supabase Auth, the migration, and the server-side environment values. The Supabase service-role key and Browser Use API key must never use a `NEXT_PUBLIC_` prefix.

## Integrations

- **Supabase:** magic-link sign-in, private Postgres data protected by row-level security, Realtime message inserts, and private file storage. Attachments are limited to five files of at most 10 MB each and are shared with the configured agent through expiring signed links. The migration adds `owner_id` to the requested records so each account's conversations remain private.
- **Browser Use Cloud:** when `BROWSER_USE_API_KEY` is set, tasks are dispatched from `/api/agent` to `POST https://api.browser-use.com/api/v3/sessions` using `X-Browser-Use-API-Key`. The returned session is polled server-side through the session endpoint. Each task has a configurable cost cap (`BROWSER_USE_MAX_COST_USD`, default $2, maximum $25). API keys are never sent to the browser.
- **Base44:** set `BASE44_AGENT_URL`, `BASE44_AGENT_ID`, and `BASE44_API_KEY` to a trusted server-side webhook/adapter you control. Elowen posts `{ agent_id, message, conversation_id }` using a Bearer token. `BASE44_BASE_URL` is retained for deployments using the Base44 SDK, but the SDK's agent conversations require a Base44-authenticated user session; a project API key alone is not a documented generic agent invoke endpoint. When the Base44 adapter is configured, it takes precedence over Browser Use for task execution.
- **WhatsApp:** set `NEXT_PUBLIC_BASE44_APP_ID` and `NEXT_PUBLIC_BASE44_AGENT_NAME` to enable the Base44 SDK's official WhatsApp authorization link and QR flow. Authorization happens on Base44; this app does not receive WhatsApp credentials or messages.
- **Automation skills:** install `@playwright/cli` on a trusted Node.js runner, set `PLAYWRIGHT_CLI_ENABLED=true`, and ensure the runner has a headed-browser display if using **Open headed browser**. The route requires an authenticated Supabase user, checks that target URLs resolve to public IPs, limits actions to the listed CLI operations, and records results in private execution traces. Screenshots and trace files are written under `outputs/playwright/`; use a trusted persistent runner or attached persistent storage if those files must survive redeploys. Keep runner network egress restricted: URL validation is an additional safeguard, not a substitute for deployment-level isolation.
- **Evaluation:** live task results can be checked with local deterministic rules; set `AGENT_EVALUATOR_URL` and `AGENT_EVALUATOR_API_KEY` to use a private evaluator endpoint instead.

## PWA

The app serves its manifest at `/manifest.webmanifest`, a 512px PNG app icon plus SVG fallback, and registers a network-first service worker at `/sw.js`. The service worker intentionally does not cache API responses. On iPhone/iPad, open the page in Safari and use **Share → Add to Home Screen**. On Chrome, use the browser's **Install app** action.

## Deploy

Deploy this directory to a Node.js host that supports Next.js App Router (for example Vercel). Set the same environment values in the hosting dashboard and add the deployed `/auth/callback` URL to Supabase's allowed redirect URLs. Do not expose the service-role or integration keys in client code.

## Repository setup

The project is committed on `main` in the private repository [snbwallet365-ops/base44-superagent-pwa](https://github.com/snbwallet365-ops/base44-superagent-pwa). Clone it before following the local setup steps above.
