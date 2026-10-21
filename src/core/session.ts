// 会话文档：层级 + 候选，末尾显式记录每层选用哪个候选。纯函数，服务端和前端共用。

import type { AttachmentRef, HistoryMessage, Role } from './types.ts';
import type { TokenEstimate } from './tokens.ts';
import { checkOps, type LineError, type VarOp } from './vars.ts';

export interface StoredMessage {
  /** `生成时间-层级-序号`。创建后不再变化，删除中间层也不重排。 */
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  /** 用户停止或上游中断时保存的未完成回复。 */
  partial?: true;
  /** 生成这条回复时上游报告的用量（含缓存命中），便于确认缓存是否生效。 */
  usage?: Usage;
  /** 挂在这一层（这个候选）上的变量操作。变量状态由重放得到，不单独存储。 */
  varOps?: VarOp[];
  /** 进入会话时编辑块里不合格式的行，或返回时正则执行失败的原因。 */
  varErrors?: LineError[];
  /**
   * 附加消息：不是正文，显示在这条消息末尾（例如组件写下的商店记录）。
   * 发送时合成一条 user 消息，紧跟在这条消息之后。跟着候选走。
   */
  notes?: string[];
  /** 生成这条回复时的 token 预估与实际值，用来校准之后的预估。 */
  estimate?: TokenEstimate;
  /** 随消息发送的附件（按原文件发送）。 */
  attachments?: AttachmentRef[];
}

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 新消息附带的信息。 */
export type MessageExtra = Pick<StoredMessage, 'partial' | 'usage' | 'varOps' | 'varErrors' | 'estimate' | 'attachments'>;

export interface Layer {
  candidates: StoredMessage[];
}

export interface SessionDoc {
  v: 1;
  layers: Layer[];
  /** 已裁剪的正文起点，按预设和模型记住；二者变化时失效。 */
  window?: { startId: string; presetId: string; modelId: string };
  /** 最近处理过的 operationId，用于重试去重。 */
  recentOps: string[];
  /** 每层选用的候选下标，与 layers 等长。放在文档末尾。 */
  selected: number[];
}

export const RECENT_OPS_LIMIT = 200;
/** 单条附加消息的长度上限。 */
export const NOTE_LIMIT = 8000;

export function emptySession(): SessionDoc {
  return { v: 1, layers: [], recentOps: [], selected: [] };
}

/** 客户端提交的变更。append 的 extra 只由服务端填写（执行返回时正则之后）。 */
export type SessionOp =
  | { op: 'append'; role: Role; content: string; extra?: MessageExtra }
  | { op: 'edit'; messageId: string; content: string }
  | { op: 'select'; messageId: string }
  | { op: 'delete'; messageId: string }
  /** 整体替换这一层的变量操作（手动编辑）。 */
  | { op: 'setVarOps'; messageId: string; ops: VarOp[] }
  /** 追加变量操作（组件提交），可以同时附上一条附加消息。 */
  | { op: 'addVarOps'; messageId: string; ops: VarOp[]; note?: string }
  /** 删除一条附加消息。 */
  | { op: 'removeNote'; messageId: string; index: number };

export class SessionOpError extends Error {
  readonly code: 'not-found' | 'invalid';
  constructor(code: 'not-found' | 'invalid', message: string) {
    super(message);
    this.name = 'SessionOpError';
    this.code = code;
  }
}

export function makeMessageId(createdAt: number, layer: number, seq: number): string {
  return `${createdAt}-${layer}-${seq}`;
}

/** 找到消息所在的层和候选下标。 */
export function locate(doc: SessionDoc, messageId: string): { layer: number; index: number } {
  for (let layer = doc.layers.length - 1; layer >= 0; layer--) {
    const index = doc.layers[layer]!.candidates.findIndex((m) => m.id === messageId);
    if (index >= 0) return { layer, index };
  }
  throw new SessionOpError('not-found', `找不到消息 ${messageId}`);
}

/** 已选用候选连成的线性正文。 */
export function linearize(doc: SessionDoc): StoredMessage[] {
  return doc.layers.map((l, i) => l.candidates[doc.selected[i]!]!);
}

export function toHistory(doc: SessionDoc): HistoryMessage[] {
  return linearize(doc).map(toHistoryMessage);
}

export function toHistoryMessage({ id, role, content, notes, attachments }: StoredMessage): HistoryMessage {
  return { id, role, content, ...(notes?.length ? { notes } : {}), ...(attachments?.length ? { attachments } : {}) };
}

/** 会话里所有消息（含全部候选）引用的附件 ID。 */
export function attachmentIds(doc: SessionDoc): string[] {
  const ids = new Set<string>();
  for (const l of doc.layers) for (const m of l.candidates) for (const a of m.attachments ?? []) ids.add(a.id);
  return [...ids];
}

/** 新增一层。 */
export function appendLayer(doc: SessionDoc, role: Role, content: string, now: number, extra: MessageExtra = {}): StoredMessage {
  const layer = doc.layers.length;
  const msg: StoredMessage = { id: makeMessageId(now, layer, 0), role, content, createdAt: now, ...extra };
  doc.layers.push({ candidates: [msg] });
  doc.selected.push(0);
  return msg;
}

/** 在已有层新增一个候选（重 roll），并选用它。 */
export function addCandidate(doc: SessionDoc, layer: number, content: string, now: number, extra: MessageExtra = {}): StoredMessage {
  const l = doc.layers[layer];
  if (!l) throw new SessionOpError('not-found', `没有第 ${layer} 层`);
  const seq = Math.max(...l.candidates.map((m) => Number(m.id.split('-')[2]))) + 1;
  const msg: StoredMessage = { id: makeMessageId(now, layer, seq), role: l.candidates[0]!.role, content, createdAt: now, ...extra };
  l.candidates.push(msg);
  doc.selected[layer] = l.candidates.length - 1;
  return msg;
}

export type OpResult =
  | { applied: false }
  /** layer：受影响的层；整层被删除时为 null。 */
  | { applied: true; layer: number | null };

/**
 * 应用一次变更。重复的 opId 直接忽略。
 * 删除一层的最后一个候选时，整层移除，后面的层前移。
 */
export function applyOp(doc: SessionDoc, opId: string, op: SessionOp, now: number): OpResult {
  if (doc.recentOps.includes(opId)) return { applied: false };
  const layer = mutate(doc, op, now);
  recordOp(doc, opId);
  return { applied: true, layer };
}

/** 记下已处理的 opId（有上限）。重复时返回 false。 */
export function recordOp(doc: SessionDoc, opId: string): boolean {
  if (doc.recentOps.includes(opId)) return false;
  doc.recentOps.push(opId);
  if (doc.recentOps.length > RECENT_OPS_LIMIT) doc.recentOps.splice(0, doc.recentOps.length - RECENT_OPS_LIMIT);
  return true;
}

function mutate(doc: SessionDoc, op: SessionOp, now: number): number | null {
  if (op.op === 'append') {
    if (op.role === 'system') throw new SessionOpError('invalid', '正文只能追加 user 或 assistant 消息');
    appendLayer(doc, op.role, op.content, now, op.extra);
    return doc.layers.length - 1;
  }
  const { layer, index } = locate(doc, op.messageId);
  const l = doc.layers[layer]!;
  switch (op.op) {
    case 'edit': {
      const msg = l.candidates[index]!;
      msg.content = op.content;
      delete msg.partial;
      return layer;
    }
    case 'select':
      doc.selected[layer] = index;
      return layer;
    case 'setVarOps':
    case 'addVarOps': {
      const msg = l.candidates[index]!;
      let ops: VarOp[];
      try {
        ops = op.op === 'setVarOps' ? checkOps(op.ops, 'manual', { keepSource: true }) : checkOps(op.ops, 'widget');
      } catch (e) {
        throw new SessionOpError('invalid', (e as Error).message);
      }
      const note = op.op === 'addVarOps' ? op.note?.trim() : undefined;
      if (note !== undefined && note.length > NOTE_LIMIT) throw new SessionOpError('invalid', `附加消息太长（上限 ${NOTE_LIMIT} 字）`);
      msg.varOps = op.op === 'setVarOps' ? ops : [...(msg.varOps ?? []), ...ops];
      if (msg.varOps.length === 0) delete msg.varOps;
      if (note) msg.notes = [...(msg.notes ?? []), note];
      return layer;
    }
    case 'removeNote': {
      const msg = l.candidates[index]!;
      if (!msg.notes || !Number.isInteger(op.index) || op.index < 0 || op.index >= msg.notes.length) {
        throw new SessionOpError('not-found', '找不到这条附加消息');
      }
      msg.notes = msg.notes.filter((_n, k) => k !== op.index);
      if (msg.notes.length === 0) delete msg.notes;
      return layer;
    }
    case 'delete': {
      if (doc.window?.startId === op.messageId) delete doc.window;
      if (l.candidates.length === 1) {
        doc.layers.splice(layer, 1);
        doc.selected.splice(layer, 1);
        return null;
      }
      l.candidates.splice(index, 1);
      const sel = doc.selected[layer]!;
      doc.selected[layer] = sel > index ? sel - 1 : Math.min(sel, l.candidates.length - 1);
      return layer;
    }
  }
}

/** 手动重新执行返回时正则后：替换正文，追加取出的操作，记下编辑块错误。 */
export function applyReceived(doc: SessionDoc, messageId: string, r: { text: string; ops: VarOp[]; errors: LineError[] }): number {
  const { layer, index } = locate(doc, messageId);
  const msg = doc.layers[layer]!.candidates[index]!;
  msg.content = r.text;
  if (r.ops.length > 0) msg.varOps = [...(msg.varOps ?? []), ...r.ops];
  if (r.errors.length > 0) msg.varErrors = r.errors;
  else delete msg.varErrors;
  return layer;
}

/** 从数据库读出的 JSON 转回文档，并检查基本一致性。 */
export function parseSessionDoc(json: string): SessionDoc {
  const doc = JSON.parse(json) as SessionDoc;
  if (doc.v !== 1 || !Array.isArray(doc.layers) || doc.selected?.length !== doc.layers.length) {
    throw new Error('会话文档格式不正确');
  }
  return doc;
}

/** 序列化时保证 selected 在末尾。 */
export function serializeSessionDoc(doc: SessionDoc): string {
  const { selected, ...rest } = doc;
  return JSON.stringify({ ...rest, selected });
}
