import { createServer } from 'node:http';
import { bootstrapOwner } from './auth.ts';
import { loadConfig } from './config.ts';
import { Db } from './db.ts';
import { deliverDueWebhooks } from './events.ts';
import { purgeOldClicks } from './matching.ts';
import { createTwig } from './server.ts';

const log = (message: string) => console.log(`[twig] ${new Date().toISOString()} ${message}`);
const config = loadConfig();
const db = new Db(config.databasePath);
bootstrapOwner(db, config, log);
const twig = createTwig(config, db, log);

const server = createServer((req, res) => { void twig.handle(req, res); });
server.listen(config.port, config.host, () => log(`listening on http://${config.host}:${config.port} (public URL ${config.publicUrl})`));

let delivering = false;
const webhookTimer = setInterval(() => {
  if (delivering) return;
  delivering = true;
  deliverDueWebhooks(db).catch((error) => log(`webhook delivery failed: ${String(error)}`)).finally(() => { delivering = false; });
}, 5000);

const purge = () => {
  const removed = purgeOldClicks(db, config.clickRetentionDays);
  if (removed > 0) log(`purged ${removed} click fingerprints older than ${config.clickRetentionDays} days`);
};
purge();
const purgeTimer = setInterval(purge, 6 * 3600 * 1000);

function shutdown(signal: string): void {
  log(`${signal} received, shutting down`);
  clearInterval(webhookTimer);
  clearInterval(purgeTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
