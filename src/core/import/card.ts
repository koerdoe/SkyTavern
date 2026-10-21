// 导入酒馆角色卡（V1 / V2 / V3，JSON 或 PNG 里的 JSON）和世界书 JSON。
// 只负责“转换”：产出角色卡、世界书的草稿和导入报告；写库、存头像由服务端做。
// 格式按 SillyTavern 的导出文件核对，不复制它的代码。

import { BASE_PRIORITY, type EntryDraft, type ScriptDraft } from '../library.ts';
import { convertMacros, macroReasons, noteMacros } from './macros.ts';
import { convertRegexScripts } from './regex.ts';
import { newReport, type ImportReport } from './report.ts';
import { convertWiEntries, wiEntriesOf } from './worldinfo.ts';

export class ImportError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.replace(/\r\n/g, '\n') : '');

/** 对话示例的优先级：在世界书后（1000 起）之后。 */
const EXAMPLE_PRIORITY = 500;

export interface CharacterDraft {
  name: string;
  tags: string[];
  favorite: boolean;
  worldbookIds: string[];
  greeting: string;
  alternateGreetings: string[];
  creatorNotes: string;
  initialVars: string;
  entries: (EntryDraft & { source: 'character' })[];
  scripts: ScriptDraft[];
}

export interface WorldbookDraft {
  name: string;
  entries: (EntryDraft & { source: 'worldbook' })[];
}

export interface CardImport {
  character: CharacterDraft;
  /** 卡里内嵌的世界书（导入成独立的一本并关联到角色卡）。 */
  worldbook: WorldbookDraft | null;
  reports: ImportReport[];
}

/** 文件内容是角色卡还是世界书。 */
export function detectKind(json: unknown): 'card' | 'worldbook' {
  if (!isObj(json)) throw new ImportError('文件内容不是 JSON 对象');
  if (typeof json.spec === 'string' && json.spec.startsWith('chara_card')) return 'card';
  if (isObj(json.data) && typeof json.data.name === 'string') return 'card';
  if (typeof json.name === 'string' && (json.first_mes !== undefined || json.description !== undefined || json.char_name !== undefined)) return 'card';
  if (json.entries !== undefined) return 'worldbook';
  throw new ImportError('认不出这是角色卡还是世界书');
}

/** V1 的字段在顶层，V2 / V3 在 data 里。 */
function cardData(json: Record<string, unknown>): Record<string, unknown> {
  if (isObj(json.data) && typeof json.data.name === 'string') return json.data;
  return json;
}

export function importCard(json: unknown): CardImport {
  if (!isObj(json)) throw new ImportError('角色卡不是 JSON 对象');
  const d = cardData(json);
  const name = text(d.name).trim() || text(json.char_name).trim();
  if (!name) throw new ImportError('角色卡没有名字');
  const spec = typeof json.spec === 'string' ? json.spec : 'V1';
  const report = newReport('character', name);
  report.notes.push(`格式：${spec === 'chara_card_v3' ? 'V3' : spec === 'chara_card_v2' ? 'V2' : 'V1'}`);
  const ext = isObj(d.extensions) ? d.extensions : {};

  const entries: CharacterDraft['entries'] = [];
  const entry = (n: string, content: string, priority: number, placement: EntryDraft['placement'], opts: { role?: EntryDraft['role']; enabled?: boolean; why?: string } = {}) => {
    if (!content.trim()) return;
    const macro = convertMacros(content, 'entry');
    noteMacros(report.notes, macro, 'entry');
    const reasons = [...(opts.why ? [opts.why] : []), ...macroReasons(macro, 'entry')];
    const enabled = (opts.enabled ?? true) && reasons.length === 0;
    if (reasons.length) report.disabled.push({ name: n, reason: reasons.join('；') });
    entries.push({ name: n, source: 'character', enabled, role: opts.role ?? 'system', content: macro.text, priority, placement });
  };
  const before = { kind: 'position', section: 'before' } as const;

  // 角色设定 = description + personality
  const description = [text(d.description), text(d.personality)].filter((t) => t.trim()).join('\n\n');
  if (text(d.personality).trim()) report.notes.push('personality（性格）并入了角色设定');
  entry('角色设定', description, BASE_PRIORITY.characterDescription, before);
  entry('场景', text(d.scenario), BASE_PRIORITY.characterScenario, before);
  entry('对话示例', text(d.mes_example), EXAMPLE_PRIORITY, before);
  entry('卡片系统提示', text(d.system_prompt), 0, { kind: 'position', section: 'system' }, {
    enabled: false,
    why: '卡片自带的系统提示（会替换预设的主提示），提示词应由预设管理；需要时手动启用',
  });
  entry('卡片历史后指令', text(d.post_history_instructions), 0, { kind: 'position', section: 'after' }, {
    role: 'user',
    enabled: false,
    why: '卡片自带的历史后指令，提示词应由预设管理；需要时手动启用',
  });
  const dp = isObj(ext.depth_prompt) ? ext.depth_prompt : null;
  if (dp && text(dp.prompt).trim()) {
    const role = dp.role === 'user' || dp.role === 'assistant' ? dp.role : 'user';
    if (dp.role === 'system' || dp.role === undefined) report.notes.push('角色备注（depth_prompt）原本是 system 角色，改为 user（Claude、Gemini 不允许对话中间出现 system）');
    const depth = typeof dp.depth === 'number' && dp.depth >= 0 ? Math.round(dp.depth) : 4;
    entry('角色备注', text(dp.prompt), 0, { kind: 'position', section: 'chat', depth }, { role });
  }

  // 开场白：宏换成占位符；不支持的宏原样留在文字里（聊天记录里的占位符找不到时原样保留，不会报错）
  const greet = (t: string) => {
    const m = convertMacros(t, 'greeting');
    noteMacros(report.notes, m, 'greeting');
    if (m.unsupported.length) report.notes.push(`开场白里有酒馆的宏 ${m.unsupported.map((n) => `{{${n}}}`).join('、')}，我们没有对应的写法，原样保留`);
    return m.text;
  };
  const greeting = greet(text(d.first_mes));
  const alternateGreetings = (Array.isArray(d.alternate_greetings) ? d.alternate_greetings : []).map(text).filter((g) => g.trim()).map(greet);
  if (alternateGreetings.length) report.notes.push(`${alternateGreetings.length} 个其他开场白成为新会话第一条消息的候选`);
  if (Array.isArray(d.group_only_greetings) && d.group_only_greetings.length) report.notes.push('群聊专用开场白没有导入（不支持群聊）');

  const scripts = convertRegexScripts(ext.regex_scripts, report);

  // 内嵌世界书
  let worldbook: WorldbookDraft | null = null;
  const reports: ImportReport[] = [report];
  if (isObj(d.character_book)) {
    const wiEntries = wiEntriesOf(d.character_book);
    if (wiEntries.length) {
      const bookName = text(d.character_book.name).trim() || `${name} 的世界书`;
      const bookReport = newReport('worldbook', bookName);
      bookReport.notes.push(`来自角色卡“${name}”内嵌的世界书，已关联到这张角色卡`);
      worldbook = { name: bookName, entries: convertWiEntries(wiEntries, bookReport).map((e) => ({ ...e, source: 'worldbook' as const })) };
      reports.push(bookReport);
    }
  }
  if (typeof ext.world === 'string' && ext.world.trim() && !worldbook) {
    report.notes.push(`卡片关联了外部世界书“${ext.world}”，它不在卡里，需要单独导入后在角色卡里勾选`);
  }

  const creatorNotes = text(d.creator_notes);
  const tags = (Array.isArray(d.tags) ? d.tags : []).map(text).map((t) => t.trim()).filter(Boolean);
  if (isObj(ext) && Object.keys(ext).some((k) => !['depth_prompt', 'regex_scripts', 'world', 'talkativeness', 'fav', 'chub'].includes(k))) {
    report.notes.push('卡片里还有其他扩展数据（例如脚本插件），没有导入');
  }

  return {
    character: {
      name,
      tags,
      favorite: false,
      worldbookIds: [],
      greeting,
      alternateGreetings,
      creatorNotes,
      initialVars: '',
      entries,
      scripts,
    },
    worldbook,
    reports,
  };
}

/** 独立的世界书 JSON。 */
export function importWorldbook(json: unknown, fallbackName: string): { worldbook: WorldbookDraft; report: ImportReport } {
  if (!isObj(json)) throw new ImportError('世界书不是 JSON 对象');
  const name = text(json.name).trim() || fallbackName;
  const report = newReport('worldbook', name);
  const wi = wiEntriesOf(json);
  if (wi.length === 0) throw new ImportError('世界书里没有条目');
  return { worldbook: { name, entries: convertWiEntries(wi, report).map((e) => ({ ...e, source: 'worldbook' as const })) }, report };
}
