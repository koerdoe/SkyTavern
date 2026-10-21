// 接口返回给前端的数据形状。前后端共用。

import type { SimilarityInfo } from './similar.ts';
import type { Protocol } from './library.ts';
import type { Bump } from './order.ts';
import type { Usage } from './session.ts';
import type { AssembledMessage, EntryOutcome, Role, Warning } from './types.ts';
import type { LineError, OpWarning, VarOp, VarState } from './vars.ts';
import type { TokenizerProfileId } from './tokens.ts';
import type { AttachmentRef } from './types.ts';

export interface LibrarySummary {
  id: string;
  name: string;
  updatedAt: number;
  /** 仅角色卡。 */
  tags?: string[];
  favorite?: boolean;
  /** 仅角色卡：头像版本号，没有头像时为 null。 */
  avatar?: string | null;
  /** 仅模型配置：用途（对话 / 嵌入）。 */
  use?: 'chat' | 'embedding';
}

export interface SessionMeta {
  id: string;
  user: string;
  characterId: string;
  createdAt: number;
  lastActiveAt: number;
  /** 从哪个会话分支出来的；不是分支时为 null。 */
  parentId: string | null;
  /** 分支点：父会话里的消息 ID。 */
  branchFrom: string | null;
  /** 用户起的名字；空则界面按时间显示。 */
  title: string;
  /** 层数与最后一条消息的开头，列表里显示用。 */
  layerCount: number;
  lastText: string;
}

export interface LayerView {
  layer: number;
  id: string;
  role: Role;
  content: string;
  partial: boolean;
  usage: Usage | null;
  /** 该层全部候选的 ID，用于切换。 */
  candidateIds: string[];
  selectedIndex: number;
  /** 这一层的变量操作。 */
  varOps: VarOp[];
  /** 按当前初始变量重放时，这一层里不生效的操作。 */
  varWarnings: OpWarning[];
  /** 进入会话时编辑块里不合格式的行，或返回时正则失败的原因。 */
  varErrors: LineError[];
  /** 附加消息（例如商店记录）：显示在消息末尾，发送时作为紧跟其后的 user 消息。 */
  notes: string[];
  /** 随消息发送的附件。 */
  attachments: AttachmentRef[];
  /** 生成这条回复时的预估（校准后）和实际输入 token。 */
  estimate: { tokens: number; actual: number | null; tokenizer: string } | null;
}

export interface SessionView {
  meta: SessionMeta;
  /** 总层数。 */
  total: number;
  /** 返回的第一层的层号。 */
  from: number;
  layers: LayerView[];
}

export interface OpResult {
  applied: boolean;
  total?: number;
  layer?: LayerView | null;
  generationId: string | null;
}

export interface PreviewView {
  protocol: Protocol | null;
  presetId: string;
  modelId: string | null;
  createdAt: number;
  messages: AssembledMessage[];
  outcomes: Record<string, EntryOutcome>;
  bumped: Bump[];
  warnings: Warning[];
  cacheBreakpoints: number[];
  /** 校准后的预估。 */
  tokens: number;
  /** 每个词条的 token（校准后）。 */
  entryTokens: Record<string, number>;
  /** 用的分词器和校准情况；没选模型时为 null（粗略估算）。 */
  tokenizer: TokenizerInfo | null;
  windowStartId: string | undefined;
  body: Record<string, unknown> | null;
  /** 用了 similar() 的词条这次的相似度（一个词条有多个调用时取分数最高的那个）。 */
  similarity: Record<string, SimilarityInfo>;
}

export interface TokenizerInfo {
  id: TokenizerProfileId;
  label: string;
  exact: boolean;
  /** 怎么选出来的。 */
  reason: string;
  auto: boolean;
  factor: number;
  /** 参与校准的记录数；0 表示默认系数。 */
  samples: number;
  /** 记录来自哪里：本会话，还是这个账号最近的其他会话。 */
  source: 'session' | 'recent' | 'default';
  /** 分词器包没装或加载失败时的原因（此时用粗略估算）。 */
  error: string | null;
}

export type GenStatus = 'running' | 'completed' | 'stopped' | 'interrupted' | 'failed';

export type GenEvent =
  | { type: 'snapshot'; text: string; status: GenStatus }
  | { type: 'delta'; text: string }
  | { type: 'end'; status: GenStatus; error?: string; messageId?: string; stopReason?: string };

export interface GenerationView {
  id: string;
  sessionId: string;
  debug: boolean;
  status: GenStatus;
  text: string;
  usage: Usage;
  stopReason?: string;
  error?: string;
  messageId?: string;
}

/** 接口错误的统一形状。 */
export interface ApiErrorBody {
  error: string;
  message: string;
  entryId?: string | null;
}

export interface VarLayerView {
  layer: number;
  messageId: string;
  role: Role;
  ops: VarOp[];
  warnings: OpWarning[];
  errors: LineError[];
  /** 这一层执行完之后的状态。 */
  state: VarState;
}

export interface VarsReport {
  initial: VarState;
  layers: VarLayerView[];
  final: VarState;
}

/** 召回索引的状态（/admin 用）。 */
export interface RecallStatus {
  /** 后台建索引：空闲、进行中、上次失败。 */
  state: 'idle' | 'indexing' | 'error';
  error: string | null;
  at: number | null;
  mode: 'off' | 'keyword' | 'vector' | 'hybrid';
  /** 嵌入模型（名称和模型名）；没选或不可用时为 null。 */
  model: string | null;
  /** 当前选用路径上的块数，以及其中已经用当前嵌入模型建好索引的块数。 */
  chunks: number;
  indexed: number;
}
