// 浏览器原生 Basic 认证。未认证时所有路径（页面、静态资源、接口）都只返回 401。

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user: string;
  }
}

export const ROOT_USER = 'root';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function parseBasic(header: string | undefined): { name: string; password: string } | undefined {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '');
  if (!m) return undefined;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const cut = decoded.indexOf(':');
  return cut < 0 ? undefined : { name: decoded.slice(0, cut), password: decoded.slice(cut + 1) };
}

export function registerAuth(app: FastifyInstance, auth: AppConfig['auth']): void {
  app.decorateRequest('user', '');
  app.addHook('onRequest', async (req, reply) => {
    if (!auth.enabled) {
      req.user = ROOT_USER;
      return;
    }
    const cred = parseBasic(req.headers.authorization);
    const user = cred && auth.users.find((u) => u.name === cred.name);
    // 用户不存在时也做一次比较，避免按耗时区分用户名是否存在。
    const ok = safeEqual(cred?.password ?? '', user?.password ?? '\0') && user !== undefined;
    if (!ok) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Basic realm="SkyTavern", charset="UTF-8"')
        .type('text/plain; charset=utf-8')
        .send('需要登录');
    }
    req.user = user.name;
  });
}
