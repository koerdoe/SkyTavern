// 召回索引的状态与手动重试（/admin 用）。

import type { FastifyInstance } from 'fastify';
import type { SessionStore } from '../sessions/store.ts';
import type { RecallService } from './service.ts';

export function registerRecallRoutes(app: FastifyInstance, deps: { recall: RecallService; sessions: SessionStore }): void {
  const { recall, sessions } = deps;

  app.get<{ Params: { id: string } }>('/api/sessions/:id/recall', (req) => {
    const s = sessions.get(req.user, req.params.id);
    return recall.statusOf(req.user, req.params.id, s.doc);
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/recall/reindex', async (req) => {
    const s = sessions.get(req.user, req.params.id);
    await recall.reindex(req.user, req.params.id, s.doc);
    return recall.statusOf(req.user, req.params.id, s.doc);
  });
}
