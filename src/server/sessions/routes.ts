import type { FastifyInstance } from 'fastify';
import { SessionOpError, applyOp, type Layer, type SessionDoc, type SessionOp } from '../../core/session.ts';
import type { OpWarning } from '../../core/vars.ts';
import type { LayerView, SessionView } from '../../core/views.ts';
import { GenerationBusy, type Generation, type GenerationManager } from '../generation/manager.ts';
import type { LibraryStore } from '../library/store.ts';
import type { SessionMeta, SessionStore } from './store.ts';
import type { AttachmentStore } from '../attachments/store.ts';

export type { LayerView, SessionView };

/** 每条消息的重放警告；由调用方按当前初始变量算好。 */
type Warnings = ReadonlyMap<string, OpWarning[]>;

function layerView(doc: SessionDoc, i: number, warnings: Warnings): LayerView {
  const l: Layer = doc.layers[i]!;
  const sel = doc.selected[i]!;
  const m = l.candidates[sel]!;
  return {
    layer: i,
    id: m.id,
    role: m.role,
    content: m.content,
    partial: m.partial === true,
    usage: m.usage ?? null,
    candidateIds: l.candidates.map((c) => c.id),
    selectedIndex: sel,
    varOps: m.varOps ?? [],
    varWarnings: warnings.get(m.id) ?? [],
    varErrors: m.varErrors ?? [],
    notes: m.notes ?? [],
    attachments: m.attachments ?? [],
    estimate: m.estimate
      ? { tokens: Math.round(m.estimate.raw * m.estimate.factor), actual: m.estimate.actual ?? null, tokenizer: m.estimate.tokenizer }
      : null,
  };
}

/** limit 缺省或 0 表示全部。 */
export function sessionView(meta: SessionMeta, doc: SessionDoc, limit: number | undefined, warnings: Warnings): SessionView {
  const total = doc.layers.length;
  const from = limit ? Math.max(0, total - limit) : 0;
  const layers: LayerView[] = [];
  for (let i = from; i < total; i++) layers.push(layerView(doc, i, warnings));
  return { meta, total, from, layers };
}

const limitQuery = {
  type: 'object',
  properties: { limit: { type: 'integer', minimum: 0 } },
} as const;

const messageId = { type: 'string', minLength: 1, maxLength: 100 } as const;
/** 具体字段由 core 校验（checkOps），这里只限定形状。 */
const varOps = { type: 'array', maxItems: 500, items: { type: 'object' } } as const;

const opBody = {
  type: 'object',
  required: ['opId', 'op'],
  properties: { opId: { type: 'string', minLength: 1, maxLength: 100 } },
  oneOf: [
    {
      properties: {
        op: { const: 'append' },
        role: { enum: ['user', 'assistant'] },
        content: { type: 'string' },
        /** 追加后立即生成下一层回复。 */
        generate: { type: 'boolean' },
        /** 附件 ID（先上传到 /api/attachments）。 */
        attachments: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 64 } },
      },
      required: ['role', 'content'],
    },
    { properties: { op: { const: 'continue' } } },
    { properties: { op: { const: 'reroll' }, messageId }, required: ['messageId'] },
    { properties: { op: { const: 'edit' }, messageId, content: { type: 'string' } }, required: ['messageId', 'content'] },
    { properties: { op: { const: 'select' }, messageId }, required: ['messageId'] },
    { properties: { op: { const: 'delete' }, messageId }, required: ['messageId'] },
    { properties: { op: { const: 'setVarOps' }, messageId, ops: varOps }, required: ['messageId', 'ops'] },
    { properties: { op: { const: 'addVarOps' }, messageId, ops: varOps, note: { type: 'string', maxLength: 8000 } }, required: ['messageId', 'ops'] },
    { properties: { op: { const: 'removeNote' }, messageId, index: { type: 'integer', minimum: 0 } }, required: ['messageId', 'index'] },
  ],
} as const;

type OpRequest = { opId: string } & (
  | (SessionOp & { generate?: boolean })
  | { op: 'continue' }
  | { op: 'reroll'; messageId: string }
);

export function registerSessionRoutes(
  app: FastifyInstance,
  deps: { store: SessionStore; library: LibraryStore; manager: GenerationManager; attachments?: AttachmentStore; now: () => number },
): void {
  const { store, library, manager, attachments, now } = deps;
  const view = (user: string, meta: SessionMeta, doc: SessionDoc, limit?: number) =>
    sessionView(meta, doc, limit, manager.varWarnings(user, meta.characterId, doc));

  app.get<{ Querystring: { characterId?: string } }>(
    '/api/sessions',
    { schema: { querystring: { type: 'object', properties: { characterId: { type: 'string' } } } } },
    (req) => store.list(req.user, req.query.characterId),
  );

  app.post<{ Body: { characterId: string } }>(
    '/api/sessions',
    {
      schema: {
        body: { type: 'object', required: ['characterId'], properties: { characterId: { type: 'string', minLength: 1 } } },
      },
    },
    async (req, reply) => {
      library.get(req.user, 'character', req.body.characterId); // 角色不存在时 404
      const created = store.create(req.user, req.body.characterId);
      await manager.greet(req.user, created.meta.id);
      const s = store.get(req.user, created.meta.id);
      return reply.code(201).send(view(req.user, s.meta, s.doc));
    },
  );

  // 选择角色后打开最近活跃的会话；没有则返回 404，由前端决定是否新建。
  app.get<{ Querystring: { characterId: string; limit?: number } }>(
    '/api/sessions/latest',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['characterId'],
          properties: { characterId: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 0 } },
        },
      },
    },
    async (req, reply) => {
      const s = store.latest(req.user, req.query.characterId);
      if (!s) return reply.code(404).send({ error: 'not-found', message: '该角色还没有会话' });
      return view(req.user, s.meta, s.doc, req.query.limit);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: number } }>(
    '/api/sessions/:id',
    { schema: { querystring: limitQuery } },
    (req) => {
      const s = store.get(req.user, req.params.id);
      return view(req.user, s.meta, s.doc, req.query.limit);
    },
  );

  // 变更与生成共用一个入口。生成中不能再追加（生成的回复总是落在末尾），但可以编辑、切换、删除。
  app.post<{ Params: { id: string }; Body: OpRequest }>('/api/sessions/:id/ops', { schema: { body: opBody } }, async (req) => {
    const { user } = req;
    const sessionId = req.params.id;
    const body = req.body;
    const generation = (g: Generation | null) => ({ applied: g !== null, generationId: g?.id ?? null });

    if (body.op === 'continue') return generation(await manager.generate(user, sessionId, { kind: 'new' }, body.opId));
    if (body.op === 'reroll') {
      return generation(await manager.generate(user, sessionId, { kind: 'reroll', messageId: body.messageId }, body.opId));
    }

    const { opId, generate, attachments: attachmentIds, ...clientOp } = body as SessionOp & { opId: string; generate?: boolean; attachments?: string[] };
    let op: SessionOp = clientOp;
    if (op.op === 'append') {
      if (manager.isBusy(sessionId)) throw new GenerationBusy();
      const refs = (attachmentIds ?? []).map((id) => {
        const ref = attachments?.ref(user, id);
        if (!ref) throw new SessionOpError('invalid', `附件不存在：${id}`);
        return ref;
      });
      // 新消息进入会话：先执行返回时正则、取出编辑块（extra 只由服务端填写）
      const { text, ...extra } = await manager.receiveIncoming(user, sessionId, op.content, op.role);
      op = { op: 'append', role: op.role, content: text, extra: { ...extra, ...(refs.length ? { attachments: refs } : {}) } };
    }
    const { characterId } = store.get(user, sessionId).meta;
    const { doc, r } = store.mutate(user, sessionId, (d) => ({ doc: d, r: applyOp(d, opId, op, now()) }));
    const warnings = manager.varWarnings(user, characterId, doc);
    const out = {
      applied: r.applied,
      total: doc.layers.length,
      layer: r.applied && r.layer !== null ? layerView(doc, r.layer, warnings) : null,
      generationId: null as string | null,
    };
    if (generate && out.applied) {
      out.generationId = (await manager.generate(user, sessionId, { kind: 'new' }, `${opId}:generate`))?.id ?? null;
    }
    return out;
  });

  // 手动对若干层重新执行返回时正则（改过正则后补处理旧消息）。
  app.post<{ Params: { id: string }; Body: { messageIds: string[] } }>(
    '/api/sessions/:id/receive',
    { schema: { body: { type: 'object', required: ['messageIds'], properties: { messageIds: { type: 'array', minItems: 1, maxItems: 1000, items: messageId } } } } },
    async (req) => ({ layers: await manager.reapplyReceive(req.user, req.params.id, req.body.messageIds) }),
  );

  // 逐层变量表：每层的操作、警告、执行后的状态。
  app.get<{ Params: { id: string } }>('/api/sessions/:id/vars', (req) => manager.varsReport(req.user, req.params.id));

  // 从某条消息分支出一个新会话（挂在当前会话下面）
  app.post<{ Params: { id: string }; Body: { messageId: string } }>(
    '/api/sessions/:id/branch',
    { schema: { body: { type: 'object', required: ['messageId'], properties: { messageId } } } },
    async (req, reply) => {
      const s = store.branch(req.user, req.params.id, req.body.messageId);
      return reply.code(201).send(view(req.user, s.meta, s.doc));
    },
  );

  // 改名
  app.patch<{ Params: { id: string }; Body: { title: string } }>(
    '/api/sessions/:id',
    { schema: { body: { type: 'object', required: ['title'], properties: { title: { type: 'string', maxLength: 200 } } } } },
    (req) => store.rename(req.user, req.params.id, req.body.title),
  );

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    if (manager.isBusy(req.params.id)) throw new GenerationBusy();
    store.delete(req.user, req.params.id);
    return reply.code(204).send();
  });
}
