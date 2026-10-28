import type { App } from './apps.ts';

/** Paths served by Twig itself that must never be captured as Universal Links / App Links. */
const EXCLUDED_PREFIXES = ['/e/*', '/qr/*', '/v1/*', '/api/*', '/dashboard*', '/sdk/*', '/.well-known/*'];

export function appleAppIds(app: App): string[] {
  const teamId = app.config.ios.teamId;
  if (!teamId) return [];
  return app.config.ios.bundleIds.map((bundleId) => `${teamId}.${bundleId}`);
}

/**
 * apple-app-site-association. One detail object carries both formats:
 * appIDs + components for iOS 13+, appID + paths for older systems.
 */
export function appleAppSiteAssociation(app: App): Record<string, unknown> {
  const appIds = appleAppIds(app);
  const components = [
    { '/': '*', '?': { $web_only: 'true' }, exclude: true, comment: 'Links forced to the web' },
    { '/': '*', '?': { '%24web_only': 'true' }, exclude: true, comment: 'Links forced to the web (encoded key)' },
    ...EXCLUDED_PREFIXES.map((path) => ({ '/': path, exclude: true, comment: 'Served by the link server' })),
    { '/': '*', comment: 'Every other link opens the app' },
    { '/': '/', comment: 'Root long links open the app' },
  ];
  const paths = [...EXCLUDED_PREFIXES.map((path) => `NOT ${path}`), '*', '/'];
  return {
    applinks: {
      apps: [],
      details: appIds.length === 0 ? [] : [{ appIDs: appIds, appID: appIds[0], components, paths }],
    },
    webcredentials: { apps: appIds },
  };
}

export function assetLinks(app: App): Array<Record<string, unknown>> {
  const android = app.config.android;
  if (!android.packageName || android.sha256Fingerprints.length === 0) return [];
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: android.packageName,
        sha256_cert_fingerprints: android.sha256Fingerprints,
      },
    },
  ];
}

/** Paths accepted for a website's Apple file: absolute, AASA wildcards allowed, no query or spaces. */
const WEBSITE_PATH_RE = /^\/[A-Za-z0-9._~\-/*?%]{0,200}$/;

export function parseWebsitePaths(input: string | null): string[] {
  const paths = (input ?? '')
    .split(/[\s,]+/)
    .map((path) => path.trim())
    .filter(Boolean)
    .filter((path) => WEBSITE_PATH_RE.test(path));
  return [...new Set(paths)].slice(0, 20);
}

/**
 * apple-app-site-association for a website you upload yourself (for example a customer's own
 * domain): only [paths] open the app, so every other page of the website keeps opening in the
 * browser. An empty list means the whole website.
 */
export function websiteAppleAppSiteAssociation(app: App, paths: string[]): Record<string, unknown> {
  const appIds = appleAppIds(app);
  const included = paths.length ? paths : ['*'];
  return {
    applinks: {
      apps: [],
      details: appIds.length === 0 ? [] : [{
        appIDs: appIds,
        appID: appIds[0],
        components: included.map((path) => ({ '/': path, comment: 'Opens the app' })),
        paths: included,
      }],
    },
  };
}
