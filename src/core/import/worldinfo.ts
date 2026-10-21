// 酒馆世界书 → 我们的词条。
//
// 两种来源格式都支持：独立导出的世界书 JSON（entries 是以序号为键的对象，字段 key / keysecondary / order …），
// 以及角色卡内嵌的 character_book（entries 是数组，字段 keys / secondary_keys / insertion_order …，
// 酒馆自己的字段放在 extensions 里）。先统一成 WiEntry，再转换。
//
// 位置（酒馆的 position 编号）：
//   0 角色定义前 → 正文前，基础优先级 5000      1 角色定义后 → 正文前，基础优先级 1000
//   2/3 作者注释上/下 → 正文 D4（酒馆作者注释默认深度）
//   4 @深度 → 正文 Dx，保留角色                5/6 对话示例上/下 → 正文前 600 / 400（对话示例词条是 500）
//   7 outlet → 不支持，停用
// 顺序：酒馆里 order 越大越靠近末尾；我们优先级越大越靠前，所以在 0–999 的范围里倒过来：
//   优先级 = 基础 + 999 − order（order 限制在 0–999）。
// 关键词触发 → IF 里的 mentioned()（见 mention.ts）；常驻词条没有条件。

import { BASE_PRIORITY } from '../library.ts';
import type { EntryDraft } from '../library.ts';
import type { Role } from '../types.ts';
import { convertMacros, macroReasons, noteMacros } from './macros.ts';
import type { ImportReport } from './report.ts';
import { Tally } from './report.ts';

/** 酒馆的扫描深度默认值（世界书设置里的 Scan Depth）。 */
export const ST_DEFAULT_SCAN_DEPTH = 2;
/** 酒馆作者注释的默认深度。 */
const AN_DEPTH = 4;

export interface WiEntry {
  name: string;
  keys: string[];
  secondary: string[];
  content: string;
  constant: boolean;
  selective: boolean;
  /** 0 AND_ANY，1 NOT_ALL，2 NOT_ANY，3 AND_ALL */
  logic: number;
  order: number;
  position: number;
  depth: number;
  /** 0 system，1 user，2 assistant（只用于 @深度） */
  role: number;
  enabled: boolean;
  scanDepth: number | null;
  caseSensitive: boolean | null;
  matchWholeWords: boolean | null;
  useProbability: boolean;
  probability: number;
  vectorized: boolean;
  timed: boolean;
  group: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

const POSITION_NAMES: Record<string, number> = { before_char: 0, after_char: 1 };
const ROLE_NAMES: Record<string, number> = { system: 0, user: 1, assistant: 2 };

/** 统一两种格式的条目。 */
export function normalizeWiEntry(raw: unknown, index: number): WiEntry | null {
  if (!isObj(raw)) return null;
  const ext = isObj(raw.extensions) ? raw.extensions : {};
  const pick = (...vals: unknown[]) => vals.find((v) => v !== undefined && v !== null);
  const positionRaw = pick(ext.position, raw.position);
  const position = typeof positionRaw === 'string' ? (POSITION_NAMES[positionRaw] ?? 0) : num(positionRaw, 0);
  const roleRaw = pick(ext.role, raw.role);
  const role = typeof roleRaw === 'string' ? (ROLE_NAMES[roleRaw] ?? 0) : num(roleRaw, 0);
  const name = String(pick(raw.comment, raw.name, '') ?? '').trim() || `条目 ${index + 1}`;
  return {
    name,
    keys: strs(pick(raw.key, raw.keys)),
    secondary: strs(pick(raw.keysecondary, raw.secondary_keys)),
    content: typeof raw.content === 'string' ? raw.content : '',
    constant: raw.constant === true,
    selective: raw.selective !== false,
    logic: num(pick(ext.selectiveLogic, raw.selectiveLogic), 0),
    order: num(pick(raw.order, raw.insertion_order), 100),
    position,
    depth: num(pick(ext.depth, raw.depth), 4),
    role,
    enabled: raw.disable === true ? false : raw.enabled !== false,
    scanDepth: (() => {
      const v = pick(ext.scan_depth, raw.scanDepth);
      return v === undefined ? null : num(v, ST_DEFAULT_SCAN_DEPTH);
    })(),
    caseSensitive: boolOrNull(pick(ext.case_sensitive, raw.caseSensitive, raw.case_sensitive)),
    matchWholeWords: boolOrNull(pick(ext.match_whole_words, raw.matchWholeWords)),
    useProbability: pick(ext.useProbability, raw.useProbability) === true,
    probability: num(pick(ext.probability, raw.probability), 100),
    vectorized: pick(ext.vectorized, raw.vectorized) === true,
    timed: [raw.sticky, raw.cooldown, raw.delay, ext.sticky, ext.cooldown, ext.delay].some((v) => typeof v === 'number' && v > 0),
    group: String(pick(ext.group, raw.group, '') ?? ''),
  };
}

/** 世界书 JSON 里的条目（对象或数组都行）。 */
export function wiEntriesOf(book: unknown): WiEntry[] {
  if (!isObj(book)) return [];
  const raw = book.entries;
  const list = Array.isArray(raw) ? raw : isObj(raw) ? Object.values(raw) : [];
  return list.map((e, i) => normalizeWiEntry(e, i)).filter((e): e is WiEntry => e !== null);
}

const q = (s: string) => JSON.stringify(s);

/** 关键词 → IF。常驻词条返回 null。 */
export function triggerIf(e: WiEntry): string | null {
  if (e.constant) return null;
  const depth = e.scanDepth ?? ST_DEFAULT_SCAN_DEPTH;
  const any = (keys: string[]) => `mentioned(${depth}, ${keys.map(q).join(', ')})`;
  const primary = any(e.keys);
  if (!e.selective || e.secondary.length === 0) return primary;
  const each = e.secondary.map((k) => any([k]));
  switch (e.logic) {
    case 1: // NOT_ALL：次要关键词不能全部出现
      return `${primary} && !(${each.join(' && ')})`;
    case 2: // NOT_ANY
      return `${primary} && !${any(e.secondary)}`;
    case 3: // AND_ALL
      return `${primary} && ${each.join(' && ')}`;
    default: // AND_ANY
      return `${primary} && ${any(e.secondary)}`;
  }
}

const orderOffset = (order: number) => 999 - Math.min(999, Math.max(0, Math.round(order)));
const ROLES: Role[] = ['system', 'user', 'assistant'];

/** 转换一批条目，差异和停用原因写进报告。 */
export function convertWiEntries(entries: readonly WiEntry[], report: ImportReport): EntryDraft[] {
  const tally = new Tally();
  const out: EntryDraft[] = [];
  for (const e of entries) {
    const reasons: string[] = [];
    const macro = convertMacros(e.content, 'entry');
    reasons.push(...macroReasons(macro, 'entry'));
    noteMacros(report.notes, macro, 'entry');

    let section: 'before' | 'chat' = 'before';
    let priority = BASE_PRIORITY.worldbookBefore + orderOffset(e.order);
    let depth: number | undefined;
    let role: Role = 'system';
    switch (e.position) {
      case 0:
        break;
      case 1:
        priority = BASE_PRIORITY.worldbookAfter + orderOffset(e.order);
        break;
      case 2:
      case 3:
        section = 'chat';
        depth = AN_DEPTH;
        priority = orderOffset(e.order);
        tally.add(`{n} 个词条原本放在作者注释上下，我们没有作者注释，改放在正文 D${AN_DEPTH}`);
        break;
      case 4:
        section = 'chat';
        depth = Math.max(0, Math.round(e.depth));
        priority = orderOffset(e.order);
        role = ROLES[e.role] ?? 'system';
        if (role === 'system') {
          role = 'user';
          tally.add('{n} 个 @深度 词条原本是 system 角色，改为 user（Claude、Gemini 不允许对话中间出现 system）');
        }
        break;
      case 5:
        priority = 600;
        tally.add('{n} 个词条原本放在对话示例上方，改放在正文前优先级 600（对话示例是 500）');
        break;
      case 6:
        priority = 400;
        tally.add('{n} 个词条原本放在对话示例下方，改放在正文前优先级 400');
        break;
      default:
        reasons.push('位置是 outlet（由其他宏引用），我们不支持');
    }

    if (!e.constant && e.keys.length === 0 && !e.vectorized) reasons.push('不是常驻词条，也没有关键词，在酒馆里永远不会触发');
    if (e.useProbability && e.probability < 100) tally.add('{n} 个词条设了触发概率，已忽略（条件满足就触发）');
    if (e.caseSensitive === true) tally.add('{n} 个词条要求区分大小写，我们的 mentioned() 不区分');
    if (e.matchWholeWords === false) tally.add('{n} 个词条关闭了整词匹配，我们的 mentioned() 对英文关键词总是按整词匹配');
    if (e.timed) tally.add('{n} 个词条设了黏性 / 冷却 / 延迟，已忽略');
    if (e.group) tally.add('{n} 个词条属于包含组（只选其一），已忽略分组');

    // 向量触发：用词条自己的内容和最近几条消息比相似度；有关键词时两者满足其一即可（和酒馆一样）
    const keyCond = e.keys.length > 0 ? triggerIf(e) : null;
    const vecCond = e.vectorized && !e.constant ? `similar(${e.scanDepth ?? ST_DEFAULT_SCAN_DEPTH})` : null;
    const cond = keyCond && vecCond ? `${vecCond} || (${keyCond})` : (vecCond ?? keyCond);
    const placement = depth === undefined ? ({ kind: 'position', section } as const) : ({ kind: 'position', section, depth } as const);
    const draft: EntryDraft = {
      name: e.name,
      enabled: e.enabled && reasons.length === 0,
      role,
      content: macro.text,
      priority,
      placement,
      ...(cond ? { if: cond } : {}),
    };
    if (e.enabled && reasons.length > 0) report.disabled.push({ name: e.name, reason: reasons.join('；') });
    out.push(draft);
  }
  const vectorized = entries.filter((e) => e.vectorized && !e.constant).length;
  if (vectorized > 0) {
    report.notes.push(
      `${vectorized} 个向量触发的词条转成了 IF 里的 similar()：用词条内容和最近几条消息比相似度。需要在系统设置里打开召回并选好嵌入模型，否则按不成立处理`,
    );
  }
  const keyed = entries.filter((e) => !e.constant && e.keys.length > 0).length;
  if (keyed > 0) {
    report.notes.push(
      `${keyed} 个关键词触发的词条转成了 IF 里的 mentioned()，检查最近几条消息（酒馆的扫描深度，没写的按 ${ST_DEFAULT_SCAN_DEPTH} 条）。它们若在正文前，会破坏缓存，风险检查会提示`,
    );
  }
  tally.flush(report.notes);
  return out;
}
