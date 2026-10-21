import type { FastifyInstance, FastifyReply } from 'fastify';
import { checkDoc } from '../../core/library.ts';
import type { GenEvent as CoreGenEvent, PreviewView } from '../../core/views.ts';
import type { LibraryStore } from '../library/store.ts';
import { listModels } from '../providers/index.ts';
import type { SessionStore } from '../sessions/store.ts';
import { ContextError } from './context.ts';
import type { GenMode, Generation, GenerationManager, GenEvent, Prepared } from './manager.ts';

/** 预览数据：最终消息、每个词条的结果、断点、用量估算，以及协议请求体。 */
export function previewView(p: Prepared): PreviewView {
  const { built } = p;
  return {
    protocol: p.protocol,
    presetId: p.presetId,
    modelId: p.modelId,
    createdAt: p.createdAt,
    messages: built.messages,
    outcomes: built.outcomes,
    bumped: built.bumped,
    warnings: built.warnings,
    cacheBreakpoints: built.cacheBreakpoints,
    tokens: built.tokens,
    entryTokens: built.entryTokens,
    tokenizer: p.tokenizer,
    windowStartId: built.windowStartId,
    body: p.body,
    similarity: p.similarity,
  };
}

const modeBody = {
  type: 'object',
  properties: { mode: { enum: ['new', 'reroll'] }, messageId: { type: 'string' } },
} as const;

type ModeBody = { mode?: 'new' | 'reroll'; messageId?: string };

function toMode(b: ModeBody | undefined): GenMode {
  if (b?.mode !== 'reroll') return { kind: 'new' };
  if (!b.messageId) throw new ContextError('reroll 需要 messageId');
  return { kind: 'reroll', messageId: b.messageId };
}

/** 客户端流：先发当前全文，再发增量；断开重连不影响生成。 */
function streamTo(reply: FastifyReply, g: Generation): void {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (e: GenEvent | CoreGenEvent): void => {
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  send({ type: 'snapshot', text: g.text, status: g.status });
  if (g.status !== 'running') {
    send(g.endEvent());
    res.end();
    return;
  }
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  const off = g.subscribe((e) => {
    send(e);
    if (e.type === 'end') close();
  });
  const close = (): void => {
    clearInterval(heartbeat);
    off();
    res.end();
  };
  res.on('close', () => {
    clearInterval(heartbeat);
    off();
  });
}

export function registerGenerationRoutes(
  app: FastifyInstance,
  deps: { manager: GenerationManager; sessions: SessionStore; library: LibraryStore },
): void {
  const { manager, sessions, library } = deps;

  // 预设预览：按当前资料解析成实际发送的内容。不修改任何东西。
  app.post<{ Body: { sessionId?: string; characterId?: string } & ModeBody }>(
    '/api/preview',
    {
      schema: {
        body: { type: 'object', properties: { sessionId: { type: 'string' }, characterId: { type: 'string' }, ...modeBody.properties } },
      },
    },
    async (req) => {
      const { sessionId, characterId } = req.body;
      if (sessionId) return previewView(await manager.prepare(req.user, sessionId, toMode(req.body)));
      if (!characterId) throw new ContextError('需要 sessionId 或 characterId');
      return previewView(await manager.prepareBlank(req.user, characterId));
    },
  );

  app.get<{ Params: { id: string } }>('/api/sessions/:id/snapshot', async (req, reply) => {
    const p = manager.lastSentSnapshot(req.user, req.params.id);
    if (!p) return reply.code(404).send({ error: 'not-found', message: '这个会话还没有发送过请求' });
    return previewView(p);
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/generation', async (req, reply) => {
    sessions.get(req.user, req.params.id);
    const g = manager.latest(req.user, req.params.id);
    if (!g) return reply.code(404).send({ error: 'not-found', message: '没有生成记录' });
    return g;
  });

  app.get<{ Params: { gid: string } }>('/api/generations/:gid/events', async (req, reply) => {
    const g = manager.get(req.user, req.params.gid);
    if (!g) return reply.code(404).send({ error: 'not-found', message: '生成不存在或已过期' });
    streamTo(reply, g);
  });

  app.post<{ Params: { gid: string } }>('/api/generations/:gid/stop', async (req) => ({ stopped: manager.stop(req.user, req.params.gid) }));

  // ---------- Debug ----------
  app.post<{ Params: { id: string }; Body: ModeBody }>('/api/sessions/:id/debug', { schema: { body: modeBody } }, async (req) =>
    previewView(await manager.createDebug(req.user, req.params.id, toMode(req.body))),
  );

  app.get<{ Params: { id: string } }>('/api/sessions/:id/debug', async (req, reply) => {
    const snap = manager.getDebug(req.user, req.params.id);
    if (!snap) return reply.code(404).send({ error: 'not-found', message: '还没有 Debug 快照' });
    return previewView(snap);
  });

  app.put<{ Params: { id: string }; Body: { body: Record<string, unknown> } }>(
    '/api/sessions/:id/debug',
    { schema: { body: { type: 'object', required: ['body'], properties: { body: { type: 'object' } } } } },
    async (req) => previewView(manager.updateDebugBody(req.user, req.params.id, req.body.body)),
  );

  app.delete<{ Params: { id: string } }>('/api/sessions/:id/debug', async (req, reply) => {
    manager.dropDebug(req.user, req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/debug/send', async (req) => ({
    generationId: manager.sendDebug(req.user, req.params.id).id,
  }));

  // ---------- 模型列表 ----------
  // 用表单里的当前值（不必先保存）。密钥留空时，用 modelId 对应的已保存密钥。
  app.post<{ Body: { protocol: string; baseUrl: string; apiKey?: string; modelId?: string } }>(
    '/api/models/list',
    {
      schema: {
        body: {
          type: 'object',
          required: ['protocol', 'baseUrl'],
          properties: { protocol: { type: 'string' }, baseUrl: { type: 'string' }, apiKey: { type: 'string' }, modelId: { type: 'string' } },
        },
      },
    },
    async (req) => {
      const { protocol, baseUrl, apiKey, modelId } = req.body;
      const savedKey = !apiKey && modelId ? library.get(req.user, 'model', modelId).apiKey : '';
      const draft = checkDoc('model', { id: modelId ?? 'draft', name: 'draft', protocol, baseUrl, apiKey: apiKey || savedKey, model: '' });
      return { models: await listModels(draft, AbortSignal.timeout(20_000)) };
    },
  );
}
