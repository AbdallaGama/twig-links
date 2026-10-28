# Deployment

Twig is a single Node.js process with a SQLite file. Any small VPS (1 vCPU / 1 GB RAM) handles
millions of clicks per month; there are no paid services involved.

## Option A — Docker Compose with Caddy (recommended)

Caddy terminates HTTPS and obtains Let's Encrypt certificates automatically — including
**on-demand certificates for every customer link domain** you add in the dashboard. Caddy asks
Twig (`/caddy/ask`) before issuing, so only registered domains get certificates.

```bash
cd deploy
cp .env.example .env        # set TWIG_ADMIN_HOST and ACME_EMAIL
docker compose --env-file .env up -d --build
docker compose logs twig    # shows the one-time setup token
```

DNS:

| Record | Points to |
|--------|-----------|
| `links-admin.example.com` (dashboard + API) | server IP |
| each link domain, e.g. `links.customer.com`, `open.customer.com` | server IP (A/AAAA) or CNAME to the admin host |

Ports 80 and 443 must be reachable (ACME challenges and redirects).

## Option B — bare Node behind any reverse proxy

```bash
cd server
PORT=8080 PUBLIC_URL=https://links-admin.example.com TRUST_PROXY=true DATABASE_PATH=/var/lib/twig/twig.db npm start
```

Run it with systemd, pm2 or similar. The proxy must forward `Host`, `X-Forwarded-For` and
`X-Forwarded-Proto` and serve valid HTTPS for every link domain.

Requirements for Universal Links / App Links:

* `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` must be served over
  HTTPS **without redirects**, with `Content-Type: application/json` (Twig does this).
* Do not put the link domains behind a login, bot challenge or "under attack" page — Apple's CDN
  and Google's verifier must fetch the files.
* Cloudflare is fine (proxied or DNS-only); with the proxy enabled set `TRUST_PROXY=true` and
  Twig reads `CF-IPCountry` for click geography.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | listen address |
| `PUBLIC_URL` | `http://localhost:PORT` | dashboard/API base; `https://` enables secure cookies |
| `DATABASE_PATH` | `server/data/twig.db` | SQLite file (`:memory:` for tests) |
| `TRUST_PROXY` | `false` | trust `X-Forwarded-*` headers |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | – | create the owner on first start |
| `MATCH_WINDOW_SECONDS` | `7200` | default deferred-deep-link window (per-app setting overrides) |
| `CLICK_RETENTION_DAYS` | `30` | purge raw click fingerprints after N days |
| `SDK_RATE_LIMIT_PER_MINUTE` | `240` | per-IP limit on `/v1/*` |

## Backups

SQLite runs in WAL mode. Back up online with:

```bash
sqlite3 /var/lib/twig/twig.db ".backup '/backups/twig-$(date +%F).db'"
```

With Docker, the database lives in the `twig-data` volume (`/data/twig.db`).

## Scaling notes

* One instance comfortably serves thousands of requests per second for redirects; put a CDN in
  front only for `/sdk/twig.js` and `/qr/*` if needed (link redirects must not be cached).
* For multiple instances, move storage to Postgres (the SQL is portable; `db.ts` is the only
  database adapter) and share the server secret (`meta.server_secret`) so IP hashes match.
* The webhook worker runs in-process every 5 s; with several instances, run it on one.
