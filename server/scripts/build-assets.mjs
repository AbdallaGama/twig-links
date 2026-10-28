// Copies the dashboard and Web SDK into dist-assets/ for the Worker's static assets binding.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist-assets');
rmSync(out, { recursive: true, force: true });
mkdirSync(resolve(out, 'sdk'), { recursive: true });
cpSync(resolve(root, 'public'), resolve(out, 'dashboard'), { recursive: true });
cpSync(resolve(root, '..', 'sdk', 'web', 'twig.js'), resolve(out, 'sdk', 'twig.js'));
console.log('assets ready in dist-assets/');
