// 编排核心的数据类型。纯数据，不依赖运行环境。

export type Role = 'system' | 'user' | 'assistant';

/** 四个分区，按请求中的先后排列。 */
export type Section = 'system' | 'before' | 'chat' | 'after';
export const SECTION_ORDER: readonly Section[] = ['system', 'before', 'chat', 'after'];

/** 词条来源。只有预设可以使用 ±10000 以外的优先级。 */
export type EntrySource = 'preset' | 'character' | 'persona' | 'worldbook';

export const PRIORITY_LIMIT = 10000;

/** 位置法：按分区 + 优先级排列；chat 分区用 depth（Dx）。 */
export interface PositionPlacement {
  kind: 'position';
  section: Section;
  /** 仅 chat 分区使用。0 = 正文末尾之后。 */
  depth?: number;
}

/** 插入法：正则匹配单条消息，用词条内容作替换模板。 */
export interface InsertPlacement {
  kind: 'insert';
  pattern: string;
  /** 只允许 i m s u。 */
  flags?: string;
  /** 可匹配的分区（不含受保护的头尾词条）。 */
  scope: readonly Section[];
  /** 多处匹配时取哪一处。 */
  pick: 'first' | 'last';
  /** 没匹配到时。 */
  onMiss: 'warn' | 'silent';
}

/** 手动缓存标记：本身不产生消息，断点落在它前面那条消息上。 */
export interface CacheMarkPlacement {
  kind: 'cacheMark';
  section: Section;
  depth?: number;
}

export type Placement = PositionPlacement | InsertPlacement | CacheMarkPlacement;

export interface Entry {
  /** `容器ID-词条ID`，词条ID 为容器内单调递增整数。 */
  id: string;
  /** 编辑器里显示的名称，不参与组装。 */
  name?: string;
  source: EntrySource;
  enabled: boolean;
  role: Role;
  /** 位置法：消息正文；插入法：替换模板（$1、$&、$<name>、$$）。 */
  content: string;
  priority: number;
  /** IF 表达式；为空表示总是成立。 */
  if?: string;
  placement: Placement;
}

/** 已选用候选连成的线性正文中的一条。 */
export interface HistoryMessage {
  id: string;
  role: Role;
  content: string;
  /** 挂在这条消息上的附加消息（例如商店记录），发送时作为紧跟其后的一条 user 消息。 */
  notes?: readonly string[];
  /** 随这条消息发送的附件（按原文件发送）。 */
  attachments?: readonly AttachmentRef[];
}

/** 消息里对附件的引用。文件本身存在附件表里。 */
export interface AttachmentRef {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export type MessageOrigin =
  | { kind: 'entry'; entryId: string }
  | { kind: 'history'; messageId: string }
  /** 聊天记录里某条消息的附加消息。 */
  | { kind: 'note'; messageId: string };

export interface AssembledMessage {
  role: Role;
  content: string;
  section: Section;
  origin: MessageOrigin;
  /** 来自 ±10000 以外优先级的词条，插入法不能匹配。 */
  protected: boolean;
  /** 内容或位置每轮都可能变化，自动缓存断点不会越过它。 */
  volatile: boolean;
  /** 修改过这条消息的插入法词条。 */
  insertedBy: string[];
  /** 聊天记录里这条消息带的附件。 */
  attachments?: AttachmentRef[];
}

export type VarValue = number | string | boolean | VarValue[] | { [key: string]: VarValue };
/** 读取变量；不存在返回 undefined。 */
export type VarLookup = (name: string) => VarValue | undefined;

/** 每个词条在本次组装中的结果，供预设预览定位。messageIndex 指最终消息列表的下标。 */
export type EntryOutcome =
  | { status: 'disabled' }
  | { status: 'if-false'; priority: number }
  /** 位置法词条进入了某条消息；内容为空被去掉时 messageIndex 为 null。 */
  | { status: 'placed'; priority: number; messageIndex: number | null }
  /** 手动缓存标记：断点落在的消息。 */
  | { status: 'cache-mark'; priority: number; messageIndex: number | null }
  | { status: 'inserted'; priority: number; messageIndex: number | null }
  | { status: 'insert-miss'; priority: number };

export interface Warning {
  entryId: string;
  code: 'insert-miss' | 'similar-off';
  message: string;
}

export type OrchestrationErrorCode =
  | 'bad-priority'
  | 'bad-depth'
  | 'bad-regex'
  | 'bad-template'
  | 'bad-if'
  | 'if-failed'
  | 'placeholder-failed'
  | 'bad-script'
  | 'over-budget'
  | 'timeout';

/** 会终止本次生成的错误。entryId 指出是哪个词条。 */
export class OrchestrationError extends Error {
  readonly code: OrchestrationErrorCode;
  readonly entryId: string | undefined;
  /** 不带词条前缀的原始说明。 */
  readonly detail: string;
  constructor(code: OrchestrationErrorCode, detail: string, entryId?: string) {
    super(entryId === undefined ? detail : `[${entryId}] ${detail}`);
    this.name = 'OrchestrationError';
    this.code = code;
    this.entryId = entryId;
    this.detail = detail;
  }
}
