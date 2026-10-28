# Deployment

Twig runs on Cloudflare Workers with a D1 database (or on any machine with Node 22, see the end):

```
 user taps https://twig.<account>.workers.dev/AbC123
        │
 Cloudflare Worker "twig"   (server/src/worker.ts — HTTPS hostname on workers.dev)
        │                    + static assets (dashboard, Web SDK)
 D1 database "twig"         (SQLite: apps, links, clicks, devices, events, webhooks, users)
        ▲
 Cron trigger (every minute: webhook delivery; hourly: purge old click fingerprints)

 Worker "twig-alt"          same code + same database on a second hostname
                            (twig-alt.<account>.workers.dev = the iOS alternate domain)
```

## Resource usage

Compare these with the limits of your Cloudflare plan:

| Resource | Twig usage |
|----------|------------|
| Worker requests | one per click, app open, event or dashboard call |
| Worker CPU | redirects use ~1–3 ms; logins (password hashing) ~7 ms |
| D1 storage | ~1 KB per click/event row |
| D1 rows read | dashboard analytics scan the events of the selected range |
| D1 rows written | ~3 per click, ~4 per install |
| Cron triggers | 1 per minute |
| `workers.dev` hostnames | primary + alternate = 2 Workers per app |

## Domains

Each Worker gets an HTTPS hostname: `<worker-name>.<your-subdomain>.workers.dev`.

* `twig.<sub>.workers.dev` — dashboard, API and the first app's **primary** link domain.
* `twig-alt.<sub>.workers.dev` — the first app's **alternate** link domain.
* More apps / customers: add another pair of environments in `server/wrangler.toml` (copy the
  `[env.alt]` block twice with new names, e.g. `acme` and `acme-alt`) and deploy them with
  `npx wrangler deploy --env acme`. All Workers share the same D1 database and dashboard.
* A domain you own can be added to Cloudflare and attached to the Worker as a
  Custom Domain; add it to the app in the dashboard.

## First deploy

```bash
cd server
npm install
npx wrangler login
```

```bash
npx wrangler d1 create twig
```

Copy `wrangler.example.toml` to `wrangler.toml` (it is git-ignored, so your account details stay
local) and paste the printed `database_id` into both `database_id` lines:

```bash
cp wrangler.example.toml wrangler.toml
```

```bash
npm run cf:deploy
```

This builds the static assets, applies the D1 migrations, and deploys `twig` and `twig-alt`.
Wrangler prints both `workers.dev` URLs.

Set the dashboard URL (used for secure cookies and generated links) and, optionally, the owner
account:

```bash
npx wrangler secret put PUBLIC_URL
```

Enter `https://twig.<sub>.workers.dev`. Optionally also `ADMIN_EMAIL` and `ADMIN_PASSWORD`;
otherwise read the one-time setup token from the logs on the first request:

```bash
npx wrangler tail twig
```

Open `https://twig.<sub>.workers.dev/dashboard`, create the owner, create an app, and add the
two hostnames as its primary and alternate domains.

### Checks

```bash
curl -s https://twig.<sub>.workers.dev/.well-known/apple-app-site-association
```

```bash
curl -s https://twig.<sub>.workers.dev/.well-known/assetlinks.json
```

## Updating

```bash
cd server && npm run cf:deploy
```

New schema changes ship as files in `server/migrations/`; `cf:deploy` applies them first.

## Local development

Node (fast, uses node:sqlite with the same schema):

```bash
cd server && npm run dev
```

Cloudflare's local runtime with a local D1 database:

```bash
cd server && npx wrangler d1 migrations apply twig --local && npm run cf:dev
```

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PUBLIC_URL` | request origin | dashboard/API base; `https://` enables secure cookies |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | – | create the owner on first start (use `wrangler secret put`) |
| `MATCH_WINDOW_SECONDS` | `7200` | default deferred-deep-link window |
| `CLICK_RETENTION_DAYS` | `30` | purge raw click fingerprints after N days |
| `SDK_RATE_LIMIT_PER_MINUTE` | `240` | per-IP limit on `/v1/*` (per Worker isolate) |
| `TRUST_PROXY` | `false` | Node only: trust `X-Forwarded-*` behind a reverse proxy |
| `DATABASE_PATH` | `server/data/twig.db` | Node only: SQLite file |

## Notes

* Client IP and country come from Cloudflare (`CF-Connecting-IP`, `CF-IPCountry`).
* The dashboard password hash uses PBKDF2 with 60,000 iterations to stay within the Workers CPU limit.
  For extra protection, put `/dashboard*` and `/api/*` behind **Cloudflare Access** with email
  one-time codes.
* Backups: `npx wrangler d1 export twig --remote --output backup.sql`, or D1 Time Travel
  (point-in-time restore).
* The same server also runs on any machine with Node 22 (`npm start`) without Cloudflare.
