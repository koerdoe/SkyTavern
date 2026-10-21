import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { LibraryError } from '../core/library.ts';
import { RequestJsonInvalid } from '../core/request-json.ts';
import { ScriptError } from '../core/scripts.ts';
import { attachmentIds, SessionOpError } from '../core/session.ts';
import { AttachmentError, AttachmentStore } from './attachments/store.ts';
import { registerAttachmentRoutes } from './attachments/routes.ts';
import { OrchestrationError } from '../core/types.ts';
import { registerAuth } from './auth.ts';
import type { AppConfig } from './config.ts';
import { Sandbox } from './generation/sandbox.ts';
import { ContextError } from './generation/context.ts';
import { GenerationBusy, GenerationManager } from './generation/manager.ts';
import { registerGenerationRoutes } from './generation/routes.ts';
import { registerImportRoutes } from './library/import-routes.ts';
import { registerLibraryRoutes } from './library/routes.ts';
import { LibraryStore } from './library/store.ts';
import { ProtocolError, UpstreamError } from './providers/index.ts';
import { registerSessionRoutes } from './sessions/routes.ts';
import { RecallError, RecallService } from './recall/service.ts';
import { registerRecallRoutes } from './recall/routes.ts';
import { EmbedError } from './providers/embed.ts';
import { registerWeb } from './web.ts';
import { registerDocs } from './docs.ts';
import { SessionNotFound, SessionStore } from './sessions/store.ts';

export interface AppDeps {
  config: AppConfig;
  db: DatabaseSync;
  now?: () => number;
  logger?: boolean;
  /** 组装超时（毫秒）。 */
  assembleTimeoutMs?: number;
  /** 构建好的前端目录；不给则不托管页面。 */
  webDir?: string;
  /** 用户文档目录（docs/）；不给则没有 /api/docs。 */
  docsDir?: string;
}

export interface App {
  app: FastifyInstance;
  sessions: SessionStore;
  library: LibraryStore;
  manager: GenerationManager;
  attachments: AttachmentStore;
  recall: RecallService;
}

/** 业务错误 → HTTP 状态。未列出的一律 500。 */
function sendError(reply: FastifyReply, err: unknown): FastifyReply | undefined {
  const send = (status: number, error: string, message: string, extra: object = {}) =>
    reply.code(status).send({ error, message, ...extra });
  if (err instanceof SessionNotFound) return send(404, 'not-found', err.message);
  if (err instanceof SessionOpError) return send(err.code === 'not-found' ? 404 : 400, err.code, err.message);
  if (err instanceof AttachmentError) return send({ 'not-found': 404, 'in-use': 409, invalid: 400 }[err.code], err.code, err.message);
  if (err instanceof LibraryError) return send({ 'not-found': 404, 'in-use': 409, invalid: 400 }[err.code], err.code, err.message);
  if (err instanceof GenerationBusy) return send(409, 'busy', err.message);
  if (err instanceof ContextError) return send(400, 'context', err.message);
  if (err instanceof OrchestrationError) return send(422, err.code, err.message, { entryId: err.entryId ?? null });
  if (err instanceof ProtocolError) return send(422, 'protocol', err.message, { entryId: err.entryId ?? null });
  if (err instanceof RequestJsonInvalid) return send(422, 'request-json', err.message);
  if (err instanceof ScriptError) return send(422, 'bad-script', err.message, { scriptId: err.scriptId });
  if (err instanceof UpstreamError) return send(502, 'upstream', err.message);
  if (err instanceof RecallError) return send(422, 'recall', err.message);
  if (err instanceof EmbedError) return send(502, 'embedding', err.message);
  const e = err as { validation?: unknown; statusCode?: number; message?: string };
  if (e.validation) return send(400, 'invalid', e.message ?? '请求格式不正确');
  if (e.statusCode !== undefined && e.statusCode < 500) return send(e.statusCode, 'request', e.message ?? '');
  return undefined;
}

export function buildApp({ config, db, now = Date.now, logger = false, assembleTimeoutMs, webDir, docsDir }: AppDeps): App {
  const app = Fastify({ logger, bodyLimit: 32 * 1024 * 1024 });
  const attachments = new AttachmentStore(db, now);
  const library = new LibraryStore(db, now);
  const recall = new RecallService(db, library, now);
  const sessions = new SessionStore(db, {
    now,
    onWritten: (user, id, doc) => {
      // 会话写回后重算它引用的附件（删除时清空），附件的清理计时由此决定
      attachments.setSessionRefs(user, id, doc ? attachmentIds(doc) : []);
      // 召回索引：删掉已不存在的消息的向量，再在后台补上新消息的
      recall.prune(user, id, doc);
      if (doc) recall.background(user, id, doc);
    },
  });
  const sandbox = new Sandbox(assembleTimeoutMs);
  const manager = new GenerationManager({ sessions, library, sandbox, attachments, recall, now });

  registerAuth(app, config.auth);

  app.setErrorHandler((err, req, reply) => {
    if (sendError(reply, err)) return;
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: '服务器内部错误' });
  });

  app.addHook('onClose', async () => {
    await manager.drain(true);
    await recall.drain();
    await sandbox.close();
  });

  app.get('/api/me', (req) => ({ user: req.user }));
  registerSessionRoutes(app, { store: sessions, library, manager, attachments, now });
  registerLibraryRoutes(app, library);
  registerImportRoutes(app, library);
  registerAttachmentRoutes(app, attachments);
  registerRecallRoutes(app, { recall, sessions });
  registerGenerationRoutes(app, { manager, sessions, library });
  if (docsDir) registerDocs(app, docsDir);
  if (webDir) void app.register((scope) => registerWeb(scope, webDir));

  return { app, sessions, library, manager, attachments, recall };
}
