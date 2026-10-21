// 生成一次请求：预算裁剪 → 组装 → 缓存断点。

import { assemble, joinNotes, type Assembly } from './assemble.ts';
import type { Bump } from './order.ts';
import type { RegexScript } from './scripts.ts';
import {
  OrchestrationError,
  type AssembledMessage,
  type Entry,
  type EntryOutcome,
  type HistoryMessage,
  type VarLookup,
  type Warning,
} from './types.ts';

export type TokenCounter = (m: { role: string; content: string }) => number;

/**
 * 粗略估算：中日韩字符按 1 token，其余约 4 字符 1 token，每条消息另加 4。
 * 协议适配器能给出准确计数时应替换它。
 */
export const estimateTokens: TokenCounter = ({ content }) => {
  let wide = 0;
  for (const ch of content) if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}＀-￯　-〿]/u.test(ch)) wide++;
  const narrow = [...content].length - wide;
  return wide + Math.ceil(narrow / 4) + 4;
};

export interface BuildInput {
  entries: readonly Entry[];
  /** 已选用候选连成的完整正文。 */
  history: readonly HistoryMessage[];
  vars: VarLookup;
  /** 输入 token 上限；不设则不裁剪。 */
  inputLimit?: number;
  /** 超出上限时一次腾出大约多少轮；默认 5。 */
  trimRounds?: number;
  /** 上次保存的正文起点（消息 ID）。切换预设或模型后应传 undefined。 */
  windowStartId?: string;
  cacheMode: 'auto' | 'manual';
  /** 数一条消息的 token（不含校准）。 */
  countTokens?: TokenCounter;
  /** 校准系数：预估乘上它再和上限比较、显示。 */
  tokenFactor?: number;
  /** 正则脚本（只执行作用于请求的运行时脚本）。 */
  scripts?: readonly RegexScript[];
  /** similar() 的结果，见 assemble。 */
  similar?: Readonly<Record<string, boolean>>;
  /** pick() 的种子。 */
  seed?: string;
}

export interface BuiltRequest {
  messages: AssembledMessage[];
  /** 希望复用到的位置（消息下标，含该条），按从前到后排列。 */
  cacheBreakpoints: number[];
  /** 需要保存下来的正文起点。 */
  windowStartId: string | undefined;
  /** 校准后的预估。 */
  tokens: number;
  /** 校准前的预估（记到回复上，之后和实际值比较来校准）。 */
  rawTokens: number;
  /** 每个词条的 token（校准后）：进入了请求的按它形成的那条消息算，其余按词条内容算。 */
  entryTokens: Record<string, number>;
  warnings: Warning[];
  bumped: Bump[];
  outcomes: Record<string, EntryOutcome>;
}

const DEFAULT_TRIM_ROUNDS = 5;
const MESSAGES_PER_ROUND = 2;

export function buildRequest(input: BuildInput): BuiltRequest {
  const rawCount = input.countTokens ?? estimateTokens;
  const factor = input.tokenFactor ?? 1;
  const count: TokenCounter = (m) => rawCount(m) * factor;
  const { history } = input;
  // 附加消息跟着它所属的消息一起计入、一起裁掉
  const cost = history.map((h) => count(h) + (h.notes?.length ? count({ role: 'user', content: joinNotes(h.notes) }) : 0));

  let start = input.windowStartId === undefined ? 0 : Math.max(0, history.findIndex((h) => h.id === input.windowStartId));
  // 保存的起点不能把最后一条也裁掉。
  if (history.length > 0) start = Math.min(start, history.length - 1);

  const run = (): { asm: Assembly; tokens: number } => {
    const asm = assemble({
      entries: input.entries,
      history: history.slice(start),
      vars: input.vars,
      ...(input.scripts ? { scripts: input.scripts } : {}),
      ...(input.similar ? { similar: input.similar } : {}),
      ...(input.seed === undefined ? {} : { seed: input.seed }),
    });
    return { asm, tokens: asm.messages.reduce((n, m) => n + count(m), 0) };
  };

  let { asm, tokens } = run();
  const limit = input.inputLimit;
  if (limit !== undefined && tokens > limit) {
    // 一次腾出约 N 轮（预设里设置，默认 5）：目标 = 上限 − N × 最近平均每轮新增。
    const rounds = input.trimRounds ?? DEFAULT_TRIM_ROUNDS;
    const recent = cost.slice(-rounds * MESSAGES_PER_ROUND);
    const perRound = recent.length === 0 ? 0 : (recent.reduce((a, b) => a + b, 0) / recent.length) * MESSAGES_PER_ROUND;
    const target = limit - rounds * perRound;
    const last = history.length - 1;

    while (tokens > limit) {
      if (start >= last) {
        throw new OrchestrationError('over-budget', `最新一条消息加上必需的提示词共约 ${Math.round(tokens)} token，超过上限 ${limit}`);
      }
      // 正文外的开销（含插入带来的增量）视为固定，先算出要裁到哪里，再重新组装验证。
      const windowCost = cost.slice(start).reduce((a, b) => a + b, 0);
      const overhead = tokens - windowCost;
      let remaining = windowCost;
      do {
        remaining -= cost[start]!;
        start++;
      } while (start < last && remaining + overhead > target);
      ({ asm, tokens } = run());
    }
  }

  const cacheBreakpoints = input.cacheMode === 'manual' ? asm.manualBreakpoints : autoBreakpoints(asm.messages);

  const rawTokens = asm.messages.reduce((n, m) => n + rawCount(m), 0);
  const entryTokens: Record<string, number> = {};
  for (const e of input.entries) {
    const o = asm.outcomes[e.id];
    const msg = o && o.status === 'placed' && o.messageIndex !== null ? asm.messages[o.messageIndex] : undefined;
    entryTokens[e.id] = msg ? Math.round(count(msg)) : e.content.trim() === '' ? 0 : Math.round(count({ role: e.role, content: e.content }));
  }

  return {
    messages: asm.messages,
    cacheBreakpoints,
    windowStartId: history[start]?.id,
    tokens: Math.round(tokens),
    rawTokens,
    entryTokens,
    warnings: asm.warnings,
    bumped: asm.bumped,
    outcomes: asm.outcomes,
  };
}

/**
 * 自动断点：正文前末尾一处；再往后到第一条易变消息之前一处。
 * 易变 = Dx 词条、被插入修改过的正文消息、正文后。
 */
export function autoBreakpoints(messages: readonly AssembledMessage[]): number[] {
  const firstVolatile = messages.findIndex((m) => m.volatile);
  const stableEnd = (firstVolatile < 0 ? messages.length : firstVolatile) - 1;
  if (stableEnd < 0) return [];
  let beforeEnd = -1;
  for (let i = 0; i <= stableEnd; i++) if (messages[i]!.section !== 'chat') beforeEnd = i;
  return beforeEnd >= 0 && beforeEnd < stableEnd ? [beforeEnd, stableEnd] : [stableEnd];
}
