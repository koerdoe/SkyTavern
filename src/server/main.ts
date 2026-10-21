import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db.ts';

const config = loadConfig();
const db = openDatabase(join(resolve(config.dataDir), 'skytavern.db'));
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const { app, sessions, attachments, recall } = buildApp({ config, db, logger: true, webDir: join(root, 'web/dist'), docsDir: join(root, 'docs') });

const retention = config.attachmentRetentionDays * 24 * 3600_000;
const sweepAll = () => {
  sessions.sweep();
  // 连续若干天没被任何会话引用的附件
  const n = attachments.sweep(retention);
  if (n > 0) app.log.info(`清理了 ${n} 个不再被引用的附件`);
};
sweepAll();
const sweep = setInterval(sweepAll, 5 * 60_000);
sweep.unref();

const shutdown = async (): Promise<void> => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });

// 上次关闭时可能没建完的召回索引，在后台补上
void recall
  .resume((user, id) => {
    try {
      return sessions.get(user, id).doc;
    } catch {
      return null;
    }
  })
  .then((n) => n > 0 && app.log.info(`检查了 ${n} 个会话的召回索引`));
app.log.info(config.auth.enabled ? `认证已开启，共 ${config.auth.users.length} 个账号` : '认证未开启，以 root 身份访问');
