// 用户文档：直接读取仓库里的 docs/*.md，由前端 /docs 页面渲染。文档只有这一份。

import type { FastifyInstance } from 'fastify';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DocSummary {
  /** 文件名去掉 .md；README 是目录页。 */
  name: string;
  title: string;
}

const NAME = /^[A-Za-z0-9-]+$/;

const titleOf = (md: string, name: string): string => /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? name;

export function registerDocs(app: FastifyInstance, dir: string): void {
  const read = (name: string): string | null => {
    if (!NAME.test(name)) return null;
    const file = join(dir, `${name}.md`);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  };

  app.get('/api/docs', async (): Promise<{ docs: DocSummary[] }> => {
    const names = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => f.slice(0, -3))
          .filter((n) => NAME.test(n))
      : [];
    // 目录页在最前，其余按目录页里出现的先后排，没出现的放最后
    const index = read('README') ?? '';
    const pos = (n: string): number => {
      if (n === 'README') return -1;
      const i = index.indexOf(`(${n}.md`);
      return i < 0 ? Infinity : i;
    };
    names.sort((a, b) => pos(a) - pos(b) || a.localeCompare(b));
    return { docs: names.map((name) => ({ name, title: titleOf(read(name) ?? '', name) })) };
  });

  app.get<{ Params: { name: string } }>('/api/docs/:name', async (req, reply) => {
    const markdown = read(req.params.name);
    if (markdown === null) return reply.code(404).send({ error: 'not-found', message: `没有这篇文档：${req.params.name}` });
    return { name: req.params.name, markdown };
  });
}
