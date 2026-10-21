// 托管构建好的前端（web/dist）。/、/admin、/docs 都返回 index.html，由前端按路径切换页面。
// 认证钩子是全局的，所以页面和静态资源同样需要登录。

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';

export async function registerWeb(app: FastifyInstance, distDir: string): Promise<void> {
  if (!existsSync(distDir)) {
    app.get('/', async (_req, reply) =>
      reply.type('text/plain; charset=utf-8').send('前端尚未构建：运行 npm run build 后刷新，或用 npm run dev 启动开发服务器。'),
    );
    return;
  }
  await app.register(fastifyStatic, { root: distDir, wildcard: false, index: false });
  const page = (_req: unknown, reply: { sendFile: (f: string) => unknown }) => reply.sendFile('index.html');
  app.get('/', page);
  app.get('/admin', page);
  app.get('/docs', page);
  app.get('/docs/:page', page);
}
