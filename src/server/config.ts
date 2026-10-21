import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  /** SQLite 与附件所在目录。 */
  dataDir: string;
  auth: {
    enabled: boolean;
    /** 暂时明文。 */
    users: { name: string; password: string }[];
  };
  /** 附件连续多少天没被任何会话引用就自动清理。 */
  attachmentRetentionDays: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  host: '127.0.0.1',
  port: 7860,
  dataDir: 'data',
  auth: { enabled: false, users: [] },
  attachmentRetentionDays: 7,
};

/** 不做深度合并：auth 要么整块写，要么用默认值。 */
export function loadConfig(path = resolve('config.json')): AppConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  let raw: Partial<AppConfig>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AppConfig>;
  } catch (e) {
    throw new Error(`config.json 不是合法的 JSON：${(e as Error).message}`);
  }
  const config: AppConfig = { ...DEFAULT_CONFIG, ...raw };
  validateConfig(config);
  return config;
}

export function validateConfig(c: AppConfig): void {
  if (!Number.isInteger(c.port) || c.port <= 0 || c.port > 65535) throw new Error(`config.json: port 不合法：${c.port}`);
  if (typeof c.auth?.enabled !== 'boolean' || !Array.isArray(c.auth.users)) {
    throw new Error('config.json: auth 应为 { enabled: boolean, users: [{ name, password }] }');
  }
  const names = new Set<string>();
  for (const u of c.auth.users) {
    if (!u.name || typeof u.password !== 'string' || u.name.includes(':')) {
      throw new Error('config.json: 每个用户都需要 name（不能含冒号）和 password');
    }
    if (names.has(u.name)) throw new Error(`config.json: 用户名重复：${u.name}`);
    names.add(u.name);
  }
  if (typeof c.attachmentRetentionDays !== 'number' || !(c.attachmentRetentionDays > 0)) {
    throw new Error('config.json: attachmentRetentionDays 应为大于 0 的天数');
  }
  if (c.auth.enabled && c.auth.users.length === 0) throw new Error('config.json: 开启认证时至少要有一个用户');
}
