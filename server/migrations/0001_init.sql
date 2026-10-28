-- Twig schema (Cloudflare D1 / SQLite). Apply with: npx wrangler d1 migrations apply twig --remote
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  secret_hint TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE domains (
  host TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('primary', 'alternate'))
);
CREATE INDEX domains_app ON domains(app_id);

CREATE TABLE links (
  id INTEGER PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  data TEXT NOT NULL,
  channel TEXT, feature TEXT, campaign TEXT, stage TEXT, tags TEXT,
  is_alias INTEGER NOT NULL DEFAULT 0,
  dedupe_hash TEXT,
  source TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (app_id, code)
);
CREATE INDEX links_dedupe ON links(app_id, dedupe_hash);
CREATE INDEX links_created ON links(app_id, created_at);

CREATE TABLE clicks (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  link_id INTEGER,
  link_data TEXT NOT NULL,
  link_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  match_window_sec INTEGER NOT NULL,
  ip_hash TEXT, ip_prefix_hash TEXT,
  os TEXT, os_version TEXT, model TEXT, browser TEXT, in_app TEXT,
  language TEXT, country TEXT, browser_id TEXT, referrer TEXT,
  route TEXT NOT NULL,
  claimed_at INTEGER, claimed_by TEXT
);
CREATE INDEX clicks_ip ON clicks(app_id, ip_hash, created_at);
CREATE INDEX clicks_prefix ON clicks(app_id, ip_prefix_hash, created_at);
CREATE INDEX clicks_browser ON clicks(app_id, browser_id, created_at);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  hardware_id TEXT,
  platform TEXT, os_version TEXT, model TEXT, brand TEXT, app_version TEXT, sdk TEXT,
  identity TEXT,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  install_link_id INTEGER, install_data TEXT,
  last_touch_data TEXT, last_touch_at INTEGER
);
CREATE INDEX devices_hw ON devices(app_id, hardware_id);
CREATE INDEX devices_identity ON devices(app_id, identity);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  link_id INTEGER, click_id TEXT, device_id TEXT, identity TEXT,
  channel TEXT, feature TEXT, campaign TEXT, platform TEXT,
  revenue REAL, currency TEXT,
  data TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX events_app_time ON events(app_id, created_at);
CREATE INDEX events_link ON events(link_id, kind);

CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE webhook_deliveries (
  id INTEGER PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX deliveries_due ON webhook_deliveries(status, next_attempt_at);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at INTEGER NOT NULL
);

CREATE TABLE user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
