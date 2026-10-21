// 组装：避让 → IF → 位置法 → 插入法 → 去空。输入是已裁剪好的正文窗口。

import { ExprError, evalCondition, parseExpr } from './expr.ts';
import { mentionedIn } from './mention.ts';
import { similarKey } from './similar.ts';
import type { ExprContext } from './expr.ts';
import { compileInsert, findMatch, InsertConfigError, renderTemplate, type CompiledInsert } from './insert.ts';
import { compareEntries, resolveCollisions, type Bump } from './order.ts';
import { PlaceholderError, renderPlaceholders } from './placeholder.ts';
import { latestChecker, runScripts, ScriptError, type RegexScript } from './scripts.ts';
import {
  OrchestrationError,
  PRIORITY_LIMIT,
  SECTION_ORDER,
  type AssembledMessage,
  type Entry,
  type EntryOutcome,
  type HistoryMessage,
  type InsertPlacement,
  type Section,
  type VarLookup,
  type Warning,
} from './types.ts';

export interface AssembleInput {
  entries: readonly Entry[];
  /** 已选用候选连成的正文（已按预算裁剪）。 */
  history: readonly HistoryMessage[];
  /** 变量查找，同时供 IF 和占位符使用（含 char、user 等保留名）。 */
  vars: VarLookup;
  /** 正则脚本；这里只执行“运行时 · 作用于请求”的那些，改的是本次请求里的正文，不改存储。 */
  scripts?: readonly RegexScript[];
  /** similar() 的结果（键见 similarKey），由服务端生成前算好；没有的一律不成立。 */
  similar?: Readonly<Record<string, boolean>>;
  /** pick() 的种子（会话 ID）：同一会话里相同的 pick 总是选同一项。 */
  seed?: string;
}

export interface Assembly {
  messages: AssembledMessage[];
  /** 手动缓存标记对应的消息下标（标记前一条消息）。 */
  manualBreakpoints: number[];
  warnings: Warning[];
  /** 因撞车而调整了优先级的词条。 */
  bumped: Bump[];
  /** 每个词条的结果，供预设预览定位到实际发送的内容。 */
  outcomes: Record<string, EntryOutcome>;
}

/** 检查单个词条的静态配置。编辑器保存时也用它。返回编译好的插入规则（如有）。 */
export function validateEntry(e: Entry): CompiledInsert | undefined {
  const limit = e.source === 'preset' ? Infinity : PRIORITY_LIMIT;
  if (!Number.isFinite(e.priority) || !Number.isInteger(e.priority) || Math.abs(e.priority) > limit) {
    throw new OrchestrationError(
      'bad-priority',
      e.source === 'preset' ? '优先级必须是整数' : `优先级必须是 ±${PRIORITY_LIMIT} 以内的整数`,
      e.id,
    );
  }
  const p = e.placement;
  if (p.kind !== 'insert' && p.depth !== undefined && (p.section !== 'chat' || !Number.isInteger(p.depth) || p.depth < 0)) {
    throw new OrchestrationError('bad-depth', '深度只用于正文分区，且必须是非负整数', e.id);
  }
  if (e.if !== undefined && e.if.trim() !== '') {
    try {
      parseExpr(e.if);
    } catch (err) {
      if (err instanceof ExprError) throw new OrchestrationError('bad-if', `IF 语法错误：${err.message}`, e.id);
      throw err;
    }
  }
  if (p.kind !== 'insert') return undefined;
  try {
    return compileInsert(p.pattern, p.flags ?? '', e.content);
  } catch (err) {
    if (err instanceof InsertConfigError) {
      throw new OrchestrationError(err.kind === 'regex' ? 'bad-regex' : 'bad-template', err.message, e.id);
    }
    throw err;
  }
}

/** 同一条消息的多条附加消息合成一条发送。 */
export const joinNotes = (notes: readonly string[]): string => notes.join('\n\n');

export const isProtectedPriority = (priority: number): boolean => Math.abs(priority) > PRIORITY_LIMIT;

const sectionRank = (s: Section): number => SECTION_ORDER.indexOf(s);

export function assemble(input: AssembleInput): Assembly {
  const scripts = input.scripts ?? [];
  const latest = latestChecker(input.history.map((h) => h.role));
  const requestText = (h: HistoryMessage, index: number): string => {
    if (scripts.length === 0) return h.content;
    try {
      return runScripts(h.content, h.role, scripts, { stage: 'runtime', target: 'request', isLatest: latest(index) });
    } catch (err) {
      if (err instanceof ScriptError) throw new OrchestrationError('bad-script', err.detail, err.scriptId);
      throw err;
    }
  };
  // mentioned() 检查的是本次请求用到的聊天记录（裁剪之后的窗口）
  const baseCtx: ExprContext = { mentioned: mentionedIn(input.history.map((h) => h.content)), ...(input.seed === undefined ? {} : { seed: input.seed }) };
  const similar = input.similar ?? {};
  const ctxFor = (e: Entry): ExprContext => ({ ...baseCtx, similar: (c) => similar[similarKey(e.id, c)] === true });
  const outcomes: Record<string, EntryOutcome> = {};
  const compiled = new Map<string, CompiledInsert>();
  const enabled: Entry[] = [];
  for (const e of input.entries) {
    if (!e.enabled) {
      outcomes[e.id] = { status: 'disabled' };
      continue;
    }
    const c = validateEntry(e);
    if (c) compiled.set(e.id, c);
    enabled.push(e);
  }

  // 撞车避让在 IF 之前做：条件是否成立不影响各词条占的位置，结果每轮稳定。
  const { effective, bumped } = resolveCollisions(enabled);
  const active = enabled.map((e) => {
    const p = effective.get(e.id)!;
    return p === e.priority ? e : { ...e, priority: p };
  });

  // IF：位置法（按分区）在前，插入法在后，各自按优先级。
  const ifOrder = [...active].sort((a, b) => {
    const ka = a.placement.kind === 'insert' ? SECTION_ORDER.length : sectionRank(a.placement.section);
    const kb = b.placement.kind === 'insert' ? SECTION_ORDER.length : sectionRank(b.placement.section);
    return ka - kb || compareEntries(a, b);
  });
  const passed: Entry[] = [];
  for (const e of ifOrder) {
    let ok = true;
    if (e.if !== undefined && e.if.trim() !== '') {
      try {
        ok = evalCondition(e.if, input.vars, ctxFor(e));
      } catch (err) {
        if (err instanceof ExprError) throw new OrchestrationError('if-failed', `IF 求值失败：${err.message}`, e.id);
        throw err;
      }
    }
    if (ok) passed.push(e);
    else outcomes[e.id] = { status: 'if-false', priority: e.priority };
  }

  const fill = (e: Entry, text: string): string => {
    try {
      return renderPlaceholders(text, input.vars, true, ctxFor(e));
    } catch (err) {
      if (err instanceof PlaceholderError) throw new OrchestrationError('placeholder-failed', err.message, e.id);
      throw err;
    }
  };

  // ---------- 位置法 ----------
  const messages: AssembledMessage[] = [];
  const marks: number[] = [];
  /** 词条 → 位置法阶段的消息下标（去空前）。 */
  const rawIndex = new Map<string, number>();
  const bySection = (s: Section): Entry[] =>
    passed.filter((e) => e.placement.kind !== 'insert' && e.placement.section === s).sort(compareEntries);

  const place = (e: Entry, section: Section): void => {
    if (e.placement.kind === 'cacheMark') {
      if (messages.length > 0) marks.push(messages.length - 1);
      rawIndex.set(e.id, messages.length - 1);
      return;
    }
    rawIndex.set(e.id, messages.length);
    messages.push({
      role: e.role,
      content: fill(e, e.content),
      section,
      origin: { kind: 'entry', entryId: e.id },
      protected: isProtectedPriority(e.priority),
      volatile: section === 'chat' || section === 'after',
      insertedBy: [],
    });
  };

  for (const s of ['system', 'before'] as const) for (const e of bySection(s)) place(e, s);

  // 正文：Dx 从末尾往前数，只计正文消息；超出则落到最上方。
  const len = input.history.length;
  const slots = new Map<number, Entry[]>();
  for (const e of bySection('chat')) {
    const depth = e.placement.kind === 'insert' ? 0 : (e.placement.depth ?? 0);
    const slot = len - Math.min(depth, len);
    const list = slots.get(slot);
    if (list) list.push(e);
    else slots.set(slot, [e]);
  }
  for (let i = 0; i <= len; i++) {
    for (const e of slots.get(i) ?? []) place(e, 'chat');
    const h = input.history[i];
    if (h) {
      messages.push({
        role: h.role,
        // 先执行作用于请求的运行时正则；正文里的占位符只替换存在的，不存在的原样保留。
        content: renderPlaceholders(requestText(h, i), input.vars, false, baseCtx),
        section: 'chat',
        origin: { kind: 'history', messageId: h.id },
        protected: false,
        volatile: false,
        insertedBy: [],
        ...(h.attachments?.length ? { attachments: [...h.attachments] } : {}),
      });
      // 附加消息紧跟在它所属的消息之后，作为一条 user 消息；不参与 Dx 计数。
      if (h.notes?.length) {
        messages.push({
          role: 'user',
          content: joinNotes(h.notes),
          section: 'chat',
          origin: { kind: 'note', messageId: h.id },
          protected: false,
          volatile: false,
          insertedBy: [],
        });
      }
    }
  }

  for (const e of bySection('after')) place(e, 'after');

  // ---------- 插入法 ----------
  const warnings: Warning[] = [];
  const inserts = passed.filter((e) => e.placement.kind === 'insert').sort(compareEntries);
  for (const e of inserts) {
    const p = e.placement as InsertPlacement;
    const c = compiled.get(e.id)!;
    // 占位符只替换模板的字面部分，变量值里的 $ 不会被当成捕获组引用。
    const parts = c.parts.map((part) => (typeof part === 'string' ? fill(e, part) : part));
    const indices = messages.flatMap((m, i) => (!m.protected && p.scope.includes(m.section) ? [i] : []));
    if (p.pick === 'last') indices.reverse();
    let hitAt = -1;
    for (const i of indices) {
      const msg = messages[i]!;
      const m = findMatch(c.regex, msg.content, p.pick);
      if (m === null) continue;
      msg.content = msg.content.slice(0, m.index) + renderTemplate(parts, m) + msg.content.slice(m.index + m[0].length);
      msg.insertedBy.push(e.id);
      if (msg.section === 'chat') msg.volatile = true;
      hitAt = i;
      break;
    }
    if (hitAt >= 0) {
      rawIndex.set(e.id, hitAt);
    } else {
      outcomes[e.id] = { status: 'insert-miss', priority: e.priority };
      if (p.onMiss === 'warn') {
        warnings.push({ entryId: e.id, code: 'insert-miss', message: `插入规则没有匹配到任何消息：/${p.pattern}/` });
      }
    }
  }

  // ---------- 去掉空消息（例如空的用户设定），下标随之重排 ----------
  const kept: AssembledMessage[] = [];
  /** 去空前下标 → 去空后下标；被去掉的消息指向它前面保留的那条。 */
  const remap: number[] = [];
  const removed = new Set<number>();
  messages.forEach((m, i) => {
    if (m.content.trim() !== '') kept.push(m);
    else removed.add(i);
    remap.push(kept.length - 1);
  });
  const manualBreakpoints = [...new Set(marks.map((i) => remap[i]!).filter((i) => i >= 0))];

  for (const e of passed) {
    const raw = rawIndex.get(e.id);
    if (raw === undefined) continue; // insert-miss 已记录
    const kind = e.placement.kind;
    if (kind === 'cacheMark') {
      const at = raw >= 0 ? remap[raw]! : -1;
      outcomes[e.id] = { status: 'cache-mark', priority: e.priority, messageIndex: at >= 0 ? at : null };
    } else {
      outcomes[e.id] = {
        status: kind === 'insert' ? 'inserted' : 'placed',
        priority: e.priority,
        messageIndex: removed.has(raw) ? null : remap[raw]!,
      };
    }
  }

  return { messages: kept, manualBreakpoints, warnings, bumped, outcomes };
}
