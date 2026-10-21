import type { FastifyInstance } from 'fastify';
import { LIBRARY_KINDS, type LibraryDoc, type LibraryKind, type LibraryOp } from '../../core/library.ts';
import type { LibraryStore } from './store.ts';

/** 密钥不下发：只告诉前端有没有配置。 */
export function toClient(kind: LibraryKind, doc: LibraryDoc): unknown {
  if (kind !== 'model') return doc;
  const { apiKey, ...rest } = doc as LibraryDoc & { apiKey: string };
  return { ...rest, hasKey: apiKey !== '' };
}

const kindParam = {
  type: 'object',
  required: ['kind'],
  properties: { kind: { enum: LIBRARY_KINDS }, id: { type: 'string' } },
} as const;

const opsBody = {
  type: 'object',
  required: ['ops'],
  properties: {
    ops: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['op'],
        properties: { op: { enum: ['set', 'addEntry', 'updateEntry', 'removeEntry', 'addScript', 'updateScript', 'removeScript'] } },
      },
    },
  },
} as const;

type P = { kind: LibraryKind; id: string };

export function registerLibraryRoutes(app: FastifyInstance, store: LibraryStore): void {
  // 头像上传：图片按原始字节接收
  app.addContentTypeParser(AVATAR_TYPES, { parseAs: 'buffer', bodyLimit: AVATAR_LIMIT }, (_req, body, done) => done(null, body));

  app.get<{ Params: P }>('/api/library/:kind', { schema: { params: kindParam } }, (req) => store.list(req.user, req.params.kind));

  app.get<{ Params: P }>('/api/library/:kind/:id', { schema: { params: kindParam } }, (req) =>
    toClient(req.params.kind, store.get(req.user, req.params.kind, req.params.id)),
  );

  app.post<{ Params: P; Body: Record<string, unknown> }>(
    '/api/library/:kind',
    { schema: { params: kindParam, body: { type: 'object' } } },
    async (req, reply) => reply.code(201).send(toClient(req.params.kind, store.create(req.user, req.params.kind, req.body))),
  );

  app.put<{ Params: P; Body: Record<string, unknown> }>(
    '/api/library/:kind/:id',
    { schema: { params: kindParam, body: { type: 'object' } } },
    (req) => toClient(req.params.kind, store.replace(req.user, req.params.kind, req.params.id, req.body)),
  );

  app.patch<{ Params: P; Body: { ops: LibraryOp[] } }>(
    '/api/library/:kind/:id',
    { schema: { params: kindParam, body: opsBody } },
    (req) => toClient(req.params.kind, store.patch(req.user, req.params.kind, req.params.id, req.body.ops)),
  );

  app.delete<{ Params: P }>('/api/library/:kind/:id', { schema: { params: kindParam } }, async (req, reply) => {
    store.delete(req.user, req.params.kind, req.params.id);
    return reply.code(204).send();
  });

  app.get('/api/settings', (req) => store.settings(req.user));
  app.put<{ Body: unknown }>('/api/settings', { schema: { body: { type: 'object' } } }, (req) => store.saveSettings(req.user, req.body));

  // ---------- 角色卡头像 ----------

  app.get<{ Params: { id: string } }>('/api/library/character/:id/avatar', (req, reply) => {
    const a = store.avatar(req.user, req.params.id);
    if (!a) return reply.code(404).send({ error: 'not-found', message: '没有头像' });
    // 地址里带版本号，内容不会变，可以长期缓存
    return reply.type(a.mime).header('cache-control', 'private, max-age=31536000, immutable').send(Buffer.from(a.data));
  });

  app.put<{ Params: { id: string }; Body: Buffer }>('/api/library/character/:id/avatar', (req, reply) => {
    const mime = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (!AVATAR_TYPES.includes(mime)) return reply.code(415).send({ error: 'invalid', message: '头像只支持 PNG、JPEG、WebP、GIF' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return reply.code(400).send({ error: 'invalid', message: '图片是空的' });
    return { avatar: store.setAvatar(req.user, req.params.id, mime, req.body) };
  });

  app.delete<{ Params: { id: string } }>('/api/library/character/:id/avatar', (req, reply) => {
    store.removeAvatar(req.user, req.params.id);
    return reply.code(204).send();
  });
}

export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** 头像大小上限。 */
export const AVATAR_LIMIT = 10 * 1024 * 1024;
