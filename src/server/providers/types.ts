import type { ModelConfig } from '../../core/library.ts';
import type { AssembledMessage } from '../../core/types.ts';

/** 平台统一的输入：最终消息 + 希望复用到的位置。 */
export interface ProviderInput {
  messages: readonly AssembledMessage[];
  cacheBreakpoints: readonly number[];
}

/**
 * 从上游流里解析出的事件。
 * done：上游报告已正常结束（之后可能还有 usage）。流读完却没见到 done，视为中断。
 */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  | { type: 'done'; stopReason?: string }
  | { type: 'error'; message: string };

export interface SseEvent {
  event: string | undefined;
  data: string;
}

export interface HttpTarget {
  url: string;
  headers: Record<string, string>;
}

export interface Adapter {
  /**
   * 生成请求体里由平台固定的部分（模型、消息、流式）。预设的请求参数随后合并进来，见 buildRequestBody。
   * 协议不支持的消息结构直接抛 ProtocolError。
   */
  buildBody(input: ProviderInput, model: ModelConfig): Record<string, unknown>;
  /** 流式生成的地址与请求头（含密钥）。 */
  streamTarget(model: ModelConfig): HttpTarget;
  /** 一个 SSE 事件 → 零到多个平台事件。 */
  parseEvent(e: SseEvent): StreamEvent[];
  modelsTarget(model: ModelConfig): HttpTarget;
  parseModels(json: unknown): string[];
}

export class ProtocolError extends Error {
  readonly entryId: string | undefined;
  constructor(message: string, entryId?: string) {
    super(entryId === undefined ? message : `[${entryId}] ${message}`);
    this.name = 'ProtocolError';
    this.entryId = entryId;
  }
}

/** 某条消息来自哪个词条（用于报错定位）。 */
export const entryOf = (m: AssembledMessage): string | undefined => (m.origin.kind === 'entry' ? m.origin.entryId : undefined);

/** 拼接地址：base 已含版本段时不再重复。 */
export function joinUrl(base: string, versioned: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  return b.endsWith(`/${versioned}`) ? `${b}${path}` : `${b}/${versioned}${path}`;
}

/**
 * 开头连续的 system 消息作为系统提示；之后再出现 system 时，
 * 对不支持的协议直接报错（规格：目标协议不支持时直接报错）。
 */
export function splitLeadingSystem(messages: readonly AssembledMessage[], protocol: string): {
  system: { msg: AssembledMessage; index: number }[];
  rest: { msg: AssembledMessage; index: number }[];
} {
  let cut = 0;
  while (cut < messages.length && messages[cut]!.role === 'system') cut++;
  const system = messages.slice(0, cut).map((msg, index) => ({ msg, index }));
  const rest = messages.slice(cut).map((msg, i) => ({ msg, index: cut + i }));
  const stray = rest.find((r) => r.msg.role === 'system');
  if (stray) {
    throw new ProtocolError(`${protocol} 不支持在对话中间使用 system 消息，请把该词条的角色改为 user 或 assistant`, entryOf(stray.msg));
  }
  return { system, rest };
}
