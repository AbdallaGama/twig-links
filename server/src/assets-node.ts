import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { AssetLoader } from './server.ts';

export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

/** Node: dashboard from server/public, Web SDK from sdk/web (the Worker bundles the same files). */
export function nodeAssets(root = resolve(import.meta.dirname, '..')): AssetLoader {
  const files: Record<string, string> = { 'sdk/twig.js': resolve(root, '..', 'sdk', 'web', 'twig.js') };
  return async (path) => {
    const file = files[path] ?? (path.startsWith('dashboard/') ? resolve(root, 'public', path.slice('dashboard/'.length)) : null);
    if (!file || !file.startsWith(root.replace(/server$/, ''))) return null;
    try {
      return { body: new Uint8Array(await readFile(file)), contentType: CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' };
    } catch {
      return null;
    }
  };
}
