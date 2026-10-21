// 附件接口。上传时正文是文件的原始字节（Content-Type: application/octet-stream），
// 文件名和类型放在请求头 X-Filename（URL 编码）和 X-Mime 里。

import type { FastifyInstance } from 'fastify';
import { ATTACHMENT_LIMIT, type AttachmentStore } from './store.ts';

export function registerAttachmentRoutes(app: FastifyInstance, store: AttachmentStore): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: ATTACHMENT_LIMIT + 1024 }, (_req, body, done) => done(null, body));

    scope.post<{ Body: Buffer }>('/api/attachments', async (req, reply) => {
      const name = decodeURIComponent(String(req.headers['x-filename'] ?? '')) || '未命名';
      const mime = String(req.headers['x-mime'] ?? '').split(';')[0]!.trim().toLowerCase() || 'application/octet-stream';
      if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'invalid', message: '请用 application/octet-stream 上传文件内容' });
      return reply.code(201).send(store.put(req.user, name, mime, req.body));
    });
  });

  app.get('/api/attachments', (req) => store.list(req.user));

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>('/api/attachments/:id', (req, reply) => {
    const f = store.data(req.user, req.params.id);
    if (!f) return reply.code(404).send({ error: 'not-found', message: '附件不存在' });
    const disposition = req.query.download !== undefined ? 'attachment' : 'inline';
    return reply
      .type(f.mime)
      .header('content-disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .header('cache-control', 'private, max-age=31536000, immutable')
      // 用户上传的 HTML、SVG 等不能在本站来源下执行
      .header('content-security-policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox")
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(f.data));
  });

  app.delete<{ Params: { id: string } }>('/api/attachments/:id', (req, reply) => {
    store.delete(req.user, req.params.id);
    return reply.code(204).send();
  });
}
