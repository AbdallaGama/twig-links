import type { App } from './apps.ts';
import { appForHost, createApp, deleteApp, getApp, getAppByPublicKey, getAppBySecret, listApps, primaryHost, rotateSecret, setDomains, updateApp } from './apps.ts';
import { appleAppSiteAssociation, assetLinks } from './association.ts';
import { breakdown, linkStats, parseRange, recentEvents, summary, timeseries, topLinks } from './analytics.ts';
import type { User } from './auth.ts';
import { bearerToken, changePassword, completeSetup, createUser, currentUser, deleteUser, listUsers, login, logout, requireUser, sessionCookie, userCount } from './auth.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { createWebhook, deleteWebhook, listWebhooks, logEvent, recentDeliveries, updateWebhook } from './events.ts';
import type { StoredLink } from './links.ts';
import { createLink, deleteLink, getLinkByCode, linkUrl, listLinks, updateLink } from './links.ts';
import type { Ecc } from './qr.ts';
import { encodeQr, qrToPng, qrToSvg } from './qr.ts';
import { handleEvent, handleIdentity, handleOpen, handleWebOpen } from './sessions.ts';
import type { Ctx, Router } from './util/http.ts';
import { HttpError, obj, sendBytes, sendJson, str } from './util/http.ts';

export interface ApiDeps {
  db: Db;
  config: Config;
  secret: string;
}

export function appJson(app: App): Record<string, unknown> {
  return {
    id: app.id,
    name: app.name,
    public_key: app.publicKey,
    secret_hint: `tw_secret_…${app.secretHint}`,
    config: app.config,
    domains: app.domains,
    created_at: app.createdAt,
  };
}

function linkJson(deps: ApiDeps, app: App, link: StoredLink): Record<string, unknown> {
  return {
    id: link.id,
    code: link.code,
    url: linkUrl(app, link, deps.config.publicUrl),
    data: link.data,
    channel: link.channel,
    feature: link.feature,
    campaign: link.campaign,
    stage: link.stage,
    tags: link.tags,
    is_alias: link.isAlias,
    source: link.source,
    disabled: link.disabled,
    created_at: link.createdAt,
  };
}

function userJson(user: User): Record<string, unknown> {
  return { id: user.id, email: user.email, name: user.name, role: user.role, created_at: user.createdAt };
}

// ------------------------------------------------------------ public SDK API

async function sdkApp(deps: ApiDeps, ctx: Ctx): Promise<{ app: App; body: Record<string, unknown> }> {
  const body = ctx.method === 'GET' ? Object.fromEntries(ctx.query) : obj(await ctx.body());
  const app = getAppByPublicKey(deps.db, str(body.key, 64) ?? ctx.query.get('key'));
  if (!app) throw new HttpError(401, 'invalid_key', 'Unknown or missing public key');
  return { app, body };
}

function qrResponse(ctx: Ctx, text: string, format: string | null, scaleParam: string | null, eccParam: string | null): void {
  const ecc = (['L', 'M', 'Q', 'H'].includes(eccParam ?? '') ? eccParam : 'M') as Ecc;
  const qr = encodeQr(text, ecc);
  if (format === 'png') {
    sendBytes(ctx, 200, qrToPng(qr, { scale: Number(scaleParam) || 8 }), 'image/png', { 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*' });
  } else {
    sendBytes(ctx, 200, qrToSvg(qr), 'image/svg+xml', { 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*' });
  }
}

export function registerSdkRoutes(router: Router, deps: ApiDeps): void {
  router.post('/v1/open', async (ctx) => {
    const { app, body } = await sdkApp(deps, ctx);
    sendJson(ctx, 200, handleOpen(deps.db, app, body, ctx.ip, deps.secret));
  });

  router.post('/v1/web/open', async (ctx) => {
    const { app, body } = await sdkApp(deps, ctx);
    sendJson(ctx, 200, handleWebOpen(deps.db, app, body));
  });

  router.post('/v1/url', async (ctx) => {
    const { app, body } = await sdkApp(deps, ctx);
    const link = createLink(deps.db, app, { ...body, data: obj(body.data), source: 'sdk', dedupe: true });
    if (Date.now() - link.createdAt < 2000) {
      logEvent(deps.db, { appId: app.id, kind: 'link_created', name: 'LINK_CREATED', linkId: link.id, channel: link.channel, feature: link.feature, campaign: link.campaign, data: { source: 'sdk' } });
    }
    sendJson(ctx, 200, { url: linkUrl(app, link, deps.config.publicUrl), code: link.code });
  });

  router.post('/v1/event', async (ctx) => {
    const { app, body } = await sdkApp(deps, ctx);
    sendJson(ctx, 200, handleEvent(deps.db, app, body));
  });

  router.post('/v1/identity', async (ctx) => {
    const { app, body } = await sdkApp(deps, ctx);
    sendJson(ctx, 200, handleIdentity(deps.db, app, body));
  });

  /** Public configuration for the Web SDK (smart banner, store ids, link domain). */
  router.get('/v1/config', async (ctx) => {
    const { app } = await sdkApp(deps, ctx);
    sendJson(ctx, 200, {
      name: app.name,
      link_domain: primaryHost(app),
      banner: app.config.banner,
      ios: { app_store_id: app.config.ios.appStoreId },
      android: { package_name: app.config.android.packageName },
    }, { 'cache-control': 'public, max-age=300' });
  });

  /** QR code for any URL on a registered link domain. */
  router.get('/v1/qr', (ctx) => {
    const text = ctx.query.get('url');
    let host: string | null = null;
    try { host = text ? new URL(text).hostname.toLowerCase() : null; } catch { /* invalid */ }
    if (!text || !host || !appForHost(deps.db, host)) throw new HttpError(400, 'url_not_on_link_domain');
    qrResponse(ctx, text, ctx.query.get('format'), ctx.query.get('scale'), ctx.query.get('ecc'));
  });
}

/** GET /qr/<code>.svg|png on a link domain. */
export function serveLinkQr(deps: ApiDeps, ctx: Ctx, app: App, file: string): void {
  const match = /^(.+)\.(svg|png)$/.exec(file);
  const link = match ? getLinkByCode(deps.db, app.id, match[1]!) : null;
  if (!match || !link) throw new HttpError(404, 'not_found');
  qrResponse(ctx, linkUrl(app, link, deps.config.publicUrl), match[2]!, ctx.query.get('scale'), ctx.query.get('ecc'));
}

// ------------------------------------------------------------ dashboard + server API

/** Cookie session (dashboard) or `Authorization: Bearer tw_secret_…` scoped to that app. */
function appAccess(deps: ApiDeps, ctx: Ctx, id: string, roles?: Array<'owner' | 'admin' | 'member'>): App {
  const token = bearerToken(ctx);
  if (token) {
    const app = getAppBySecret(deps.db, token);
    if (!app || app.id !== id) throw new HttpError(403, 'forbidden');
    return app;
  }
  requireUser(deps.db, ctx, roles);
  const app = getApp(deps.db, id);
  if (!app) throw new HttpError(404, 'app_not_found');
  return app;
}

function requireLink(deps: ApiDeps, app: App, code: string): StoredLink {
  const link = getLinkByCode(deps.db, app.id, code);
  if (!link) throw new HttpError(404, 'link_not_found');
  return link;
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text; // spreadsheet formula injection guard
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function registerAdminRoutes(router: Router, deps: ApiDeps): void {
  const { db, config } = deps;
  const secureCookie = config.publicUrl.startsWith('https://');

  router.get('/api/auth/state', (ctx) => {
    const user = currentUser(db, ctx);
    sendJson(ctx, 200, { setup_required: userCount(db) === 0, user: user ? userJson(user) : null });
  });

  router.post('/api/auth/setup', async (ctx) => {
    const body = obj(await ctx.body());
    completeSetup(db, body);
    const session = login(db, body.email, body.password);
    sendJson(ctx, 200, { user: userJson(session.user) }, { 'set-cookie': sessionCookie(session.token, secureCookie) });
  });

  router.post('/api/auth/login', async (ctx) => {
    const body = obj(await ctx.body());
    const session = login(db, body.email, body.password);
    sendJson(ctx, 200, { user: userJson(session.user) }, { 'set-cookie': sessionCookie(session.token, secureCookie) });
  });

  router.post('/api/auth/logout', (ctx) => {
    logout(db, ctx);
    sendJson(ctx, 200, { ok: true }, { 'set-cookie': sessionCookie('', secureCookie, 0) });
  });

  router.post('/api/auth/password', async (ctx) => {
    const user = requireUser(db, ctx);
    const body = obj(await ctx.body());
    changePassword(db, user, body.current_password, body.new_password);
    sendJson(ctx, 200, { ok: true }, { 'set-cookie': sessionCookie('', secureCookie, 0) });
  });

  router.get('/api/users', (ctx) => {
    requireUser(db, ctx);
    sendJson(ctx, 200, { users: listUsers(db).map(userJson) });
  });

  router.post('/api/users', async (ctx) => {
    const actor = requireUser(db, ctx, ['owner', 'admin']);
    const body = obj(await ctx.body());
    const role = body.role === 'admin' && actor.role === 'owner' ? 'admin' : 'member';
    sendJson(ctx, 201, { user: userJson(createUser(db, { email: body.email, name: body.name, password: body.password, role })) });
  });

  router.delete('/api/users/:id', (ctx) => {
    const actor = requireUser(db, ctx, ['owner', 'admin']);
    deleteUser(db, actor, ctx.params.id!);
    sendJson(ctx, 200, { ok: true });
  });

  router.get('/api/apps', (ctx) => {
    requireUser(db, ctx);
    sendJson(ctx, 200, { apps: listApps(db).map(appJson) });
  });

  router.post('/api/apps', async (ctx) => {
    requireUser(db, ctx, ['owner', 'admin']);
    const body = obj(await ctx.body());
    const { app, secretKey } = createApp(db, String(body.name ?? ''), body.config);
    let created = app;
    if (Array.isArray(body.domains)) {
      try {
        setDomains(db, app.id, body.domains as Array<{ host: unknown; kind?: unknown }>);
        created = getApp(db, app.id)!;
      } catch (error) {
        deleteApp(db, app.id);
        throw error;
      }
    }
    sendJson(ctx, 201, { app: appJson(created), secret_key: secretKey });
  });

  router.get('/api/apps/:id', (ctx) => {
    sendJson(ctx, 200, { app: appJson(appAccess(deps, ctx, ctx.params.id!)) });
  });

  router.patch('/api/apps/:id', async (ctx) => {
    appAccess(deps, ctx, ctx.params.id!, ['owner', 'admin']);
    const body = obj(await ctx.body());
    sendJson(ctx, 200, { app: appJson(updateApp(db, ctx.params.id!, { name: body.name, config: body.config })) });
  });

  router.delete('/api/apps/:id', (ctx) => {
    requireUser(db, ctx, ['owner', 'admin']);
    deleteApp(db, ctx.params.id!);
    sendJson(ctx, 200, { ok: true });
  });

  router.post('/api/apps/:id/domains', async (ctx) => {
    appAccess(deps, ctx, ctx.params.id!, ['owner', 'admin']);
    const body = obj(await ctx.body());
    if (!Array.isArray(body.domains)) throw new HttpError(400, 'domains_required');
    sendJson(ctx, 200, { domains: setDomains(db, ctx.params.id!, body.domains as Array<{ host: unknown; kind?: unknown }>) });
  });

  router.post('/api/apps/:id/rotate-secret', (ctx) => {
    requireUser(db, ctx, ['owner', 'admin']);
    sendJson(ctx, 200, { secret_key: rotateSecret(db, ctx.params.id!) });
  });

  router.get('/api/apps/:id/association', (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    sendJson(ctx, 200, { apple_app_site_association: appleAppSiteAssociation(app), assetlinks: assetLinks(app) });
  });

  router.get('/api/apps/:id/links', (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    const links = listLinks(db, app.id, {
      limit: Number(ctx.query.get('limit')) || 50,
      offset: Number(ctx.query.get('offset')) || 0,
      search: str(ctx.query.get('search'), 200),
    });
    sendJson(ctx, 200, { links: links.map((link) => linkJson(deps, app, link)) });
  });

  router.post('/api/apps/:id/links', async (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    const body = obj(await ctx.body());
    const source = bearerToken(ctx) ? 'api' : 'dashboard';
    const link = createLink(db, app, { ...body, data: obj(body.data), source });
    logEvent(db, { appId: app.id, kind: 'link_created', name: 'LINK_CREATED', linkId: link.id, channel: link.channel, feature: link.feature, campaign: link.campaign, data: { source } });
    sendJson(ctx, 201, { link: linkJson(deps, app, link) });
  });

  router.post('/api/apps/:id/links/bulk', async (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    const body = obj(await ctx.body());
    const items = Array.isArray(body.links) ? body.links.slice(0, 500) : [];
    const source = bearerToken(ctx) ? 'api' : 'dashboard';
    const links = db.tx(() => items.map((item) => {
      const input = obj(item);
      return createLink(db, app, { ...input, data: obj(input.data), source });
    }));
    sendJson(ctx, 201, { links: links.map((link) => linkJson(deps, app, link)) });
  });

  router.get('/api/apps/:id/links/:code', (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    sendJson(ctx, 200, { link: linkJson(deps, app, requireLink(deps, app, ctx.params.code!)) });
  });

  router.patch('/api/apps/:id/links/:code', async (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    const link = requireLink(deps, app, ctx.params.code!);
    sendJson(ctx, 200, { link: linkJson(deps, app, updateLink(db, link, obj(await ctx.body()))) });
  });

  router.delete('/api/apps/:id/links/:code', (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    deleteLink(db, requireLink(deps, app, ctx.params.code!));
    sendJson(ctx, 200, { ok: true });
  });

  router.get('/api/apps/:id/links/:code/stats', (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    const link = requireLink(deps, app, ctx.params.code!);
    sendJson(ctx, 200, { link: linkJson(deps, app, link), stats: linkStats(db, app.id, link.id, parseRange(ctx.query)) });
  });

  router.get('/api/apps/:id/analytics/summary', (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    sendJson(ctx, 200, { summary: summary(db, app.id, parseRange(ctx.query)) });
  });

  router.get('/api/apps/:id/analytics/timeseries', (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    sendJson(ctx, 200, { series: timeseries(db, app.id, parseRange(ctx.query)) });
  });

  router.get('/api/apps/:id/analytics/breakdown', (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    sendJson(ctx, 200, { rows: breakdown(db, app.id, parseRange(ctx.query), ctx.query.get('by') ?? 'channel', ctx.query.get('kind')) });
  });

  router.get('/api/apps/:id/analytics/top-links', (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    sendJson(ctx, 200, { links: topLinks(db, app.id, parseRange(ctx.query), Number(ctx.query.get('limit')) || 20) });
  });

  router.get('/api/apps/:id/events/recent', (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    sendJson(ctx, 200, { events: recentEvents(db, app.id, Number(ctx.query.get('limit')) || 100) });
  });

  router.get('/api/apps/:id/export/events.csv', (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    const range = parseRange(ctx.query);
    const rows = db.all<Record<string, unknown>>(
      `SELECT id, created_at, kind, name, link_id, click_id, device_id, identity, channel, feature, campaign, platform, revenue, currency, data
       FROM events WHERE app_id = ? AND created_at BETWEEN ? AND ? ORDER BY id LIMIT 200000`,
      app.id, range.from, range.to,
    );
    const columns = ['id', 'created_at', 'kind', 'name', 'link_id', 'click_id', 'device_id', 'identity', 'channel', 'feature', 'campaign', 'platform', 'revenue', 'currency', 'data'];
    const lines = [columns.join(',')];
    for (const row of rows) {
      lines.push(columns.map((column) => csvCell(column === 'created_at' ? new Date(Number(row.created_at)).toISOString() : row[column])).join(','));
    }
    sendBytes(ctx, 200, lines.join('\n'), 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="${app.id}-events.csv"`, 'cache-control': 'no-store' });
  });

  router.get('/api/apps/:id/webhooks', (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    sendJson(ctx, 200, { webhooks: listWebhooks(db, app.id) });
  });

  router.post('/api/apps/:id/webhooks', async (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!, ['owner', 'admin']);
    sendJson(ctx, 201, { webhook: createWebhook(db, app.id, obj(await ctx.body())) });
  });

  router.patch('/api/apps/:id/webhooks/:wid', async (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!, ['owner', 'admin']);
    sendJson(ctx, 200, { webhook: updateWebhook(db, app.id, ctx.params.wid!, obj(await ctx.body())) });
  });

  router.delete('/api/apps/:id/webhooks/:wid', (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!, ['owner', 'admin']);
    deleteWebhook(db, app.id, ctx.params.wid!);
    sendJson(ctx, 200, { ok: true });
  });

  router.get('/api/apps/:id/webhook-deliveries', (ctx) => {
    const app = appAccess(deps, ctx, ctx.params.id!);
    sendJson(ctx, 200, { deliveries: recentDeliveries(db, app.id) });
  });
}
