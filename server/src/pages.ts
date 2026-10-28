import { randomToken } from './util/crypto.ts';
import type { App } from './apps.ts';
import { appStoreUrl } from './apps.ts';
import type { LinkData } from './links.ts';
import { schemeUrl } from './routing.ts';

export interface Page {
  html: string;
  headers: Record<string, string>;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON safe to embed inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export interface Branding {
  title: string;
  description: string | null;
  imageUrl: string | null;
}

export function branding(app: App, data: LinkData): Branding {
  return {
    title: str(data.$og_title) ?? app.config.og.title ?? app.name,
    description: str(data.$og_description) ?? app.config.og.description,
    imageUrl: str(data.$og_image_url) ?? app.config.og.imageUrl ?? app.config.banner.iconUrl,
  };
}

const STYLE = `
:root{--bg:#f6f7fb;--card:#fff;--text:#14161f;--muted:#5d6475;--accent:#1f6feb;--accent-text:#fff;--border:#e3e6ee}
@media (prefers-color-scheme:dark){:root{--bg:#0f1117;--card:#181b24;--text:#eef0f6;--muted:#a3a9b8;--accent:#4c8dff;--border:#2a2f3c}}
*{box-sizing:border-box}html,body{margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:20px;max-width:420px;width:100%;padding:28px 24px;text-align:center;box-shadow:0 10px 30px rgba(15,17,23,.06)}
.icon{width:84px;height:84px;border-radius:20px;object-fit:cover;margin:0 auto 14px;display:block;background:var(--bg)}
h1{font-size:22px;margin:0 0 6px;line-height:1.25}p{color:var(--muted);margin:0 0 18px;line-height:1.5;font-size:15px}
.btn{display:block;width:100%;padding:15px 18px;border-radius:14px;background:var(--accent);color:var(--accent-text);font-weight:600;font-size:16px;text-decoration:none;border:0;cursor:pointer;margin-top:10px}
.btn.secondary{background:transparent;color:var(--accent);border:1px solid var(--border)}
.hint{font-size:13px;margin-top:16px}.qr{margin:8px auto 4px;width:200px;height:200px;background:#fff;padding:10px;border-radius:14px}
.qr svg{width:100%;height:100%;display:block}.stores{display:flex;gap:10px;margin-top:6px}.stores .btn{font-size:14px}
.done{display:none;color:var(--muted);font-size:14px;margin-top:12px}`;

function shell(title: string, body: string, options: { head?: string; script?: string } = {}): Page {
  const nonce = randomToken(16);
  const script = options.script ? `<script nonce="${nonce}">${options.script}</script>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>${options.head ?? ''}<style>${STYLE}</style></head>
<body>${body}${script}</body></html>`;
  return {
    html,
    headers: {
      'content-security-policy': `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'referrer-policy': 'strict-origin-when-cross-origin',
    },
  };
}

function header(brand: Branding): string {
  const icon = brand.imageUrl ? `<img class="icon" src="${escapeHtml(brand.imageUrl)}" alt="">` : '';
  const description = brand.description ? `<p>${escapeHtml(brand.description)}</p>` : '';
  return `${icon}<h1>${escapeHtml(brand.title)}</h1>${description}`;
}

/** Rich preview for crawlers (iMessage, WhatsApp, Slack, Facebook, X, ...). No click is recorded. */
export function ogPage(app: App, data: LinkData, linkUrl: string): Page {
  const brand = branding(app, data);
  const meta: Array<[string, string, string | null]> = [
    ['property', 'og:title', brand.title],
    ['property', 'og:description', brand.description],
    ['property', 'og:image', brand.imageUrl],
    ['property', 'og:url', linkUrl],
    ['property', 'og:type', str(data.$og_type) ?? 'website'],
    ['name', 'twitter:card', brand.imageUrl ? 'summary_large_image' : 'summary'],
    ['name', 'twitter:title', brand.title],
    ['name', 'twitter:description', brand.description],
    ['name', 'twitter:image', brand.imageUrl],
  ];
  const ios = app.config.ios;
  const android = app.config.android;
  const path = (str(data.$deeplink_path) ?? 'open').replace(/^\/+/, '');
  if (ios.uriScheme) meta.push(['property', 'al:ios:url', schemeUrl(ios.uriScheme, path, null)]);
  if (ios.appStoreId) meta.push(['property', 'al:ios:app_store_id', ios.appStoreId], ['name', 'twitter:app:id:iphone', ios.appStoreId]);
  if (ios.appStoreId || ios.uriScheme) meta.push(['property', 'al:ios:app_name', app.name]);
  if (android.uriScheme) meta.push(['property', 'al:android:url', schemeUrl(android.uriScheme, path, null)]);
  if (android.packageName) meta.push(['property', 'al:android:package', android.packageName], ['property', 'al:android:app_name', app.name], ['name', 'twitter:app:id:googleplay', android.packageName]);
  const tags = meta
    .filter((entry): entry is [string, string, string] => entry[2] !== null)
    .map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeHtml(value)}">`)
    .join('\n');
  return shell(brand.title, `<main class="card">${header(brand)}<a class="btn" href="${escapeHtml(linkUrl)}">Open</a></main>`, { head: tags });
}

/**
 * iOS interstitial. "Open" copies the link (with its click id) to the pasteboard so the
 * SDK can read it on first launch after install — a deterministic deferred deep link —
 * then continues to the alternate domain, where a Universal Link gets a second chance
 * and otherwise the App Store opens.
 */
export function iosDeepviewPage(app: App, data: LinkData, decision: { continueUrl: string; copyUrl: string }): Page {
  const brand = branding(app, data);
  const body = `<main class="card">${header(brand)}
<button class="btn" id="open" type="button">Open in the app</button>
<a class="btn secondary" id="skip" href="${escapeHtml(decision.continueUrl)}">Continue without copying</a>
<div class="done" id="done">Link copied — opening…</div>
<p class="hint">Tapping “Open in the app” copies this link so the app opens the right page, even right after installing it.</p>
</main>`;
  const script = `(function(){var c=${scriptJson(decision.copyUrl)},n=${scriptJson(decision.continueUrl)};
document.getElementById('open').addEventListener('click',function(){var v=c+(c.indexOf('?')<0?'?':'&')+'_cpts='+Date.now();
document.getElementById('done').style.display='block';function go(){window.location.href=n}
try{navigator.clipboard.writeText(v).then(function(){setTimeout(go,300)},go)}catch(e){go()}});})();`;
  return shell(brand.title, body, { script });
}

/** Android interstitial for in-app browsers and WebViews, where intent:// is blocked. */
export function androidDeepviewPage(app: App, data: LinkData, decision: { storeUrl: string; intentUrl: string | null }): Page {
  const brand = branding(app, data);
  const open = decision.intentUrl ? `<a class="btn" href="${escapeHtml(decision.intentUrl)}">Open in the app</a>` : '';
  const body = `<main class="card">${header(brand)}${open}
<a class="btn ${decision.intentUrl ? 'secondary' : ''}" href="${escapeHtml(decision.storeUrl)}">Get the app</a>
<p class="hint">If nothing happens, open this page in your browser.</p></main>`;
  return shell(brand.title, body);
}

/** Tries the URI scheme, then falls back unless the page was hidden (the app opened). */
export function schemeThenFallbackPage(app: App, data: LinkData, decision: { schemeUrl: string; fallbackUrl: string; timeoutMs: number }): Page {
  const brand = branding(app, data);
  const body = `<main class="card">${header(brand)}<a class="btn" href="${escapeHtml(decision.fallbackUrl)}">Continue</a></main>`;
  const script = `(function(){var s=${scriptJson(decision.schemeUrl)},f=${scriptJson(decision.fallbackUrl)},t=${Math.min(Math.max(decision.timeoutMs, 500), 10000)},left=false;
document.addEventListener('visibilitychange',function(){if(document.hidden)left=true});window.addEventListener('pagehide',function(){left=true});
setTimeout(function(){if(!left)window.location.replace(f)},t);window.location.href=s;})();`;
  return shell(brand.title, body, { script });
}

/** Desktop landing page: scan the QR code with a phone, or use the store buttons. */
export function desktopPage(app: App, data: LinkData, linkUrl: string, qrSvg: string): Page {
  const brand = branding(app, data);
  const store = appStoreUrl(app);
  const pkg = app.config.android.packageName;
  const stores = [
    store ? `<a class="btn secondary" href="${escapeHtml(store)}">App Store</a>` : '',
    pkg ? `<a class="btn secondary" href="https://play.google.com/store/apps/details?id=${escapeHtml(encodeURIComponent(pkg))}">Google Play</a>` : '',
  ].join('');
  const body = `<main class="card">${header(brand)}<div class="qr" aria-label="QR code">${qrSvg}</div>
<p class="hint">Scan with your phone camera to open it in the app.</p>${stores ? `<div class="stores">${stores}</div>` : ''}</main>`;
  return shell(brand.title, body);
}

export function notFoundPage(): Page {
  return shell('Link not found', '<main class="card"><h1>Link not found</h1><p>This link does not exist or has been disabled.</p></main>');
}
