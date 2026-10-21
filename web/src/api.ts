// 接口客户端。类型全部来自 src/core，前后端共用。

import type { LibraryDocs, LibraryKind, LibraryOp, UserSettings } from '../../src/core/library.ts';
import type { Role } from '../../src/core/types.ts';
import type { VarOp } from '../../src/core/vars.ts';
import type { ImportReport } from '../../src/core/import/report.ts';
import type { AttachmentRef } from '../../src/core/types.ts';
import type { RecallStatus } from '../../src/core/views.ts';

/** 附件列表里的一项（见 server/attachments/store.ts）。 */
export interface AttachmentInfo extends AttachmentRef {
  createdAt: number;
  refs: number;
  orphanedAt: number | null;
}
import type {
  ApiErrorBody,
  GenerationView,
  GenEvent,
  LibrarySummary,
  OpResult,
  PreviewView,
  SessionMeta,
  SessionView,
  VarsReport,
} from '../../src/core/views.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** 上传原始字节（头像）。 */
async function upload<T>(method: string, path: string, file: Blob): Promise<T> {
  const res = await fetch(`/api${path}`, { method, headers: { 'content-type': file.type }, body: file });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const b = (data ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(res.status, { error: b.error ?? 'http', message: b.message ?? `请求失败（${res.status}）`, entryId: b.entryId ?? null });
  }
  return data as T;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const b = (data ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(res.status, { error: b.error ?? 'http', message: b.message ?? `请求失败（${res.status}）`, entryId: b.entryId ?? null });
  }
  return data as T;
}

/** 不依赖安全上下文（局域网 http 访问时 crypto.randomUUID 不可用）。 */
export function newOpId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** 模型配置下发时不带密钥，只告诉有没有。 */
export type ModelView = Omit<LibraryDocs['model'], 'apiKey'> & { hasKey: boolean };
export type DocView<K extends LibraryKind> = K extends 'model' ? ModelView : LibraryDocs[K];

/** 导入结果（见 server/library/import-routes.ts）。 */
export interface ImportedItem {
  kind: 'character' | 'worldbook';
  id: string;
  name: string;
  report: ImportReport;
}

export type SessionOpInput =
  | { op: 'append'; role: Exclude<Role, 'system'>; content: string; generate?: boolean; attachments?: string[] }
  | { op: 'edit'; messageId: string; content: string }
  | { op: 'select'; messageId: string }
  | { op: 'delete'; messageId: string }
  | { op: 'continue' }
  | { op: 'reroll'; messageId: string }
  | { op: 'setVarOps'; messageId: string; ops: VarOp[] }
  | { op: 'addVarOps'; messageId: string; ops: Omit<VarOp, 'source'>[]; note?: string }
  | { op: 'removeNote'; messageId: string; index: number };

export const api = {
  me: () => request<{ user: string }>('GET', '/me'),
  settings: () => request<UserSettings>('GET', '/settings'),
  saveSettings: (s: UserSettings) => request<UserSettings>('PUT', '/settings', s),

  list: (kind: LibraryKind) => request<LibrarySummary[]>('GET', `/library/${kind}`),
  get: <K extends LibraryKind>(kind: K, id: string) => request<DocView<K>>('GET', `/library/${kind}/${encodeURIComponent(id)}`),
  create: <K extends LibraryKind>(kind: K, doc: Record<string, unknown>) => request<DocView<K>>('POST', `/library/${kind}`, doc),
  replace: <K extends LibraryKind>(kind: K, id: string, doc: Record<string, unknown>) =>
    request<DocView<K>>('PUT', `/library/${kind}/${encodeURIComponent(id)}`, doc),
  patch: <K extends LibraryKind>(kind: K, id: string, ops: LibraryOp[]) =>
    request<DocView<K>>('PATCH', `/library/${kind}/${encodeURIComponent(id)}`, { ops }),
  remove: (kind: LibraryKind, id: string) => request<void>('DELETE', `/library/${kind}/${encodeURIComponent(id)}`),
  /** 用表单当前值拉取模型列表；apiKey 留空时服务端用 modelId 对应的已保存密钥。 */
  listModels: (draft: { protocol: string; baseUrl: string; apiKey?: string; modelId?: string }) =>
    request<{ models: string[] }>('POST', '/models/list', draft),

  allSessions: () => request<SessionMeta[]>('GET', '/sessions'),
  sessions: (characterId: string) => request<SessionMeta[]>('GET', `/sessions?characterId=${encodeURIComponent(characterId)}`),
  createSession: (characterId: string) => request<SessionView>('POST', '/sessions', { characterId }),
  latestSession: async (characterId: string, limit: number): Promise<SessionView | null> => {
    try {
      return await request<SessionView>('GET', `/sessions/latest?characterId=${encodeURIComponent(characterId)}&limit=${limit}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  session: (id: string, limit: number) => request<SessionView>('GET', `/sessions/${id}?limit=${limit}`),
  deleteSession: (id: string) => request<void>('DELETE', `/sessions/${id}`),
  uploadAttachment: async (file: File): Promise<AttachmentRef> => {
    const res = await fetch('/api/attachments', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), 'x-mime': file.type || 'application/octet-stream' },
      body: file,
    });
    const data = (await res.json().catch(() => ({}))) as Partial<ApiErrorBody> & AttachmentRef;
    if (!res.ok) throw new ApiError(res.status, { error: data.error ?? 'http', message: data.message ?? `上传失败（${res.status}）`, entryId: null });
    return data;
  },
  attachments: () => request<AttachmentInfo[]>('GET', '/attachments'),
  recallStatus: (sessionId: string) => request<RecallStatus>('GET', `/sessions/${sessionId}/recall`),
  reindexRecall: (sessionId: string) => request<RecallStatus>('POST', `/sessions/${sessionId}/recall/reindex`),
  deleteAttachment: (id: string) => request<void>('DELETE', `/attachments/${encodeURIComponent(id)}`),
  importFile: (filename: string, data: string) => request<{ items: ImportedItem[] }>('POST', '/import', { filename, data }),
  setAvatar: (characterId: string, file: Blob) => upload<{ avatar: string }>('PUT', `/library/character/${encodeURIComponent(characterId)}/avatar`, file),
  removeAvatar: (characterId: string) => request<void>('DELETE', `/library/character/${encodeURIComponent(characterId)}/avatar`),
  branchSession: (id: string, messageId: string) => request<SessionView>('POST', `/sessions/${id}/branch`, { messageId }),
  renameSession: (id: string, title: string) => request<SessionMeta>('PATCH', `/sessions/${id}`, { title }),
  op: (sessionId: string, op: SessionOpInput) => request<OpResult>('POST', `/sessions/${sessionId}/ops`, { opId: newOpId(), ...op }),
  /** 逐层变量表。 */
  vars: (sessionId: string) => request<VarsReport>('GET', `/sessions/${sessionId}/vars`),
  /** 对若干层重新执行返回时正则。 */
  receive: (sessionId: string, messageIds: string[]) => request<{ layers: number[] }>('POST', `/sessions/${sessionId}/receive`, { messageIds }),

  preview: (target: { sessionId: string } | { characterId: string }) => request<PreviewView>('POST', '/preview', target),
  snapshot: async (sessionId: string): Promise<PreviewView | null> => {
    try {
      return await request<PreviewView>('GET', `/sessions/${sessionId}/snapshot`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  generation: async (sessionId: string): Promise<GenerationView | null> => {
    try {
      return await request<GenerationView>('GET', `/sessions/${sessionId}/generation`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  stop: (generationId: string) => request<{ stopped: boolean }>('POST', `/generations/${generationId}/stop`),

  debug: {
    create: (sessionId: string) => request<PreviewView>('POST', `/sessions/${sessionId}/debug`, {}),
    get: async (sessionId: string): Promise<PreviewView | null> => {
      try {
        return await request<PreviewView>('GET', `/sessions/${sessionId}/debug`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    update: (sessionId: string, body: Record<string, unknown>) => request<PreviewView>('PUT', `/sessions/${sessionId}/debug`, { body }),
    drop: (sessionId: string) => request<void>('DELETE', `/sessions/${sessionId}/debug`),
    send: (sessionId: string) => request<{ generationId: string }>('POST', `/sessions/${sessionId}/debug/send`),
  },
};

/** 订阅生成事件。返回取消函数。浏览器会带上已缓存的 Basic 认证。 */
export function watchGeneration(generationId: string, onEvent: (e: GenEvent) => void): () => void {
  const es = new EventSource(`/api/generations/${generationId}/events`);
  for (const type of ['snapshot', 'delta', 'end'] as const) {
    es.addEventListener(type, (ev) => {
      const e = JSON.parse((ev as MessageEvent<string>).data) as GenEvent;
      onEvent(e);
      if (e.type === 'end') es.close();
    });
  }
  return () => es.close();
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.body.message;
  return e instanceof Error ? e.message : String(e);
}
