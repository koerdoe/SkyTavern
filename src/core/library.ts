// 资料：预设、角色卡、用户自机、世界书、模型配置。类型、校验、变更操作都是纯函数，前端 JSON 模式保存前也用它校验。

import { validateEntry } from './assemble.ts';
import { parseEntryId } from './order.ts';
import { checkRequestJson } from './request-json.ts';
import { ScriptError, validateScript, type RegexScript, type ScriptRole } from './scripts.ts';
import { OrchestrationError, SECTION_ORDER, type Entry, type EntrySource, type Placement, type Role } from './types.ts';
import { parseInitialVars } from './vars.ts';
import { shopExample } from './examples/shop.ts';
import { TOKENIZER_IDS, type TokenizerPriority, type TokenizerProfileId } from './tokens.ts';
import type { RecallMode } from './recall.ts';

export type ContainerKind = 'preset' | 'character' | 'persona' | 'worldbook';
export type LibraryKind = ContainerKind | 'model';
export const LIBRARY_KINDS: readonly LibraryKind[] = ['preset', 'character', 'persona', 'worldbook', 'model'];

export type Protocol = 'openai-chat' | 'openai-responses' | 'claude' | 'gemini';
export const PROTOCOLS: readonly Protocol[] = ['openai-chat', 'openai-responses', 'claude', 'gemini'];

/** 容器ID 前缀。词条ID = `${容器ID}-${序号}`。 */
export const ID_PREFIX: Record<LibraryKind, string> = {
  preset: 'preset',
  character: 'char',
  persona: 'persona',
  worldbook: 'wb',
  model: 'model',
};

export interface EntryContainer {
  id: string;
  name: string;
  entries: Entry[];
  /** 下一个词条序号；只增不减，删除后不复用。 */
  nextEntryId: number;
}

/** 可以挂正则脚本和初始变量的资料：预设、角色卡。 */
export interface ScriptHost {
  scripts: RegexScript[];
  /** 下一个脚本序号；只增不减。脚本 ID = `${容器ID}-s${序号}`。 */
  nextScriptId: number;
  /** 初始变量，每行 `名称 = 值`；角色卡的覆盖预设的。 */
  initialVars: string;
}

export interface Preset extends EntryContainer, ScriptHost {
  cacheMode: 'auto' | 'manual';
  /**
   * 请求参数：宽松 JSON，按协议原生字段名书写，合并进请求体。
   * 例如 `thinking: {"type":"disabled"}, max_tokens: 4096`。见 request-json.ts。
   */
  requestJson: string;
  /** 输入上限（token，用于裁剪正文）；不设则不裁剪。这是平台预算，不发给模型。 */
  inputLimit?: number;
  /** 超出上限时一次腾出大约多少轮对话（1 轮 = 一问一答）。 */
  trimRounds: number;
}

export const DEFAULT_TRIM_ROUNDS = 5;
export const MAX_TRIM_ROUNDS = 50;

export interface Character extends EntryContainer, ScriptHost {
  tags: string[];
  favorite: boolean;
  /** 关联的世界书（例如导入时内嵌的那本）。 */
  worldbookIds: string[];
  /** 开场白：新会话以它作为第一条 AI 消息。空则不加。 */
  greeting: string;
  /** 其他开场白：新会话第一层的其他候选，可以左右切换。 */
  alternateGreetings: string[];
  /** 作者备注：给使用者看的说明，不发给模型。 */
  creatorNotes: string;
  /** 头像的版本号（图片存在头像表里）；null 表示没有头像。只由头像接口修改。 */
  avatar: string | null;
}

export type Persona = EntryContainer;
export type Worldbook = EntryContainer;

export interface ModelConfig {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  /** 只保存在服务端。 */
  apiKey: string;
  model: string;
  /** 预估 token 用的分词器：auto 按模型名匹配，或者指定一个（见 tokens.ts）。 */
  tokenizer: 'auto' | TokenizerProfileId;
  /** 用途：对话，或者嵌入（召回用，OpenAI 兼容的 /embeddings 或 Gemini）。 */
  use: 'chat' | 'embedding';
}

export interface LibraryDocs {
  preset: Preset;
  character: Character;
  persona: Persona;
  worldbook: Worldbook;
  model: ModelConfig;
}
export type LibraryDoc = LibraryDocs[LibraryKind];

/** 每个账号当前选用的资料。 */
export interface UserSettings {
  presetId: string | null;
  modelId: string | null;
  personaId: string | null;
  /** 除角色卡关联之外、额外打开的世界书。 */
  worldbookIds: string[];
  /** 选分词器时，模型名和接口类型哪个优先（见 tokens.ts）。 */
  tokenizerPriority: TokenizerPriority;
  /** 召回（见 recall.ts）：方式、嵌入模型、命中中心数量。 */
  recall: RecallSettings;
  ui: UiPrefs;
}

export interface RecallSettings {
  mode: RecallMode;
  /** 向量 / 混合模式用的嵌入模型配置。 */
  embeddingModelId: string | null;
  /** 最多几个命中中心（每个还会带上前后各一块）。 */
  topK: number;
  /** IF 里的 similar()：同一次请求最多几个成立（过了阈值的按相似度取前几个）。 */
  similarTopK: number;
}

export const DEFAULT_RECALL: RecallSettings = { mode: 'off', embeddingModelId: null, topK: 3, similarTopK: 5 };

/** 账号级界面偏好，换设备也保持一致。 */
export interface UiPrefs {
  theme: 'system' | 'light' | 'dark';
  /** short：字大、有气泡；long：紧凑，适合长文。 */
  readingMode: 'short' | 'long';
  /** 每次加载的层数；0 表示全部。 */
  loadCount: number;
  /** 自定义风格：每套一段 CSS，可以切换。 */
  styles: UiStyle[];
  /** 正在使用的风格；null 表示不用自定义风格。 */
  activeStyle: string | null;
  /** 已确认过的风险（签名），相关配置不变就不再提示。 */
  ackedRisks: string[];
}

export interface UiStyle {
  id: string;
  name: string;
  css: string;
}

export const DEFAULT_UI: UiPrefs = { theme: 'system', readingMode: 'long', loadCount: 50, styles: [], activeStyle: null, ackedRisks: [] };
const MAX_STYLES = 50;

export class LibraryError extends Error {
  readonly code: 'invalid' | 'not-found' | 'in-use';
  constructor(code: 'invalid' | 'not-found' | 'in-use', message: string) {
    super(message);
    this.name = 'LibraryError';
    this.code = code;
  }
}

// ---------- 校验 ----------

const fail = (msg: string): never => {
  throw new LibraryError('invalid', msg);
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, what: string): string => (typeof v === 'string' ? v : fail(`${what} 应为字符串`));
const bool = (v: unknown, what: string): boolean => (typeof v === 'boolean' ? v : fail(`${what} 应为 true/false`));
const int = (v: unknown, what: string): number => (Number.isInteger(v) ? (v as number) : fail(`${what} 应为整数`));
const strList = (v: unknown, what: string): string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...v] : fail(`${what} 应为字符串数组`);
const oneOf = <T extends string>(v: unknown, options: readonly T[], what: string): T =>
  options.includes(v as T) ? (v as T) : fail(`${what} 只能是 ${options.join(' / ')}`);

const ROLES: readonly Role[] = ['system', 'user', 'assistant'];

function checkPlacement(v: unknown, where: string): Placement {
  if (!isObj(v)) return fail(`${where}.placement 缺失`);
  const kind = oneOf(v.kind, ['position', 'insert', 'cacheMark'] as const, `${where}.placement.kind`);
  if (kind === 'insert') {
    const scope = strList(v.scope, `${where}.placement.scope`).map((s) => oneOf(s, SECTION_ORDER, `${where}.placement.scope`));
    return {
      kind,
      pattern: str(v.pattern, `${where}.placement.pattern`),
      ...(v.flags === undefined ? {} : { flags: str(v.flags, `${where}.placement.flags`) }),
      scope,
      pick: oneOf(v.pick, ['first', 'last'] as const, `${where}.placement.pick`),
      onMiss: oneOf(v.onMiss, ['warn', 'silent'] as const, `${where}.placement.onMiss`),
    };
  }
  const section = oneOf(v.section, SECTION_ORDER, `${where}.placement.section`);
  return v.depth === undefined ? { kind, section } : { kind, section, depth: int(v.depth, `${where}.placement.depth`) };
}

/** 校验一个词条的结构和静态配置；source 由容器决定，不信任输入。 */
export function checkEntry(v: unknown, source: EntrySource, where = '词条'): Entry {
  if (!isObj(v)) return fail(`${where} 应为对象`);
  const entry: Entry = {
    id: str(v.id, `${where}.id`),
    source,
    enabled: bool(v.enabled, `${where}.enabled`),
    role: oneOf(v.role, ROLES, `${where}.role`),
    content: str(v.content, `${where}.content`),
    priority: int(v.priority, `${where}.priority`),
    placement: checkPlacement(v.placement, where),
  };
  if (v.if !== undefined && v.if !== '') entry.if = str(v.if, `${where}.if`);
  if (v.name !== undefined) entry.name = str(v.name, `${where}.name`);
  try {
    validateEntry(entry);
  } catch (e) {
    if (e instanceof OrchestrationError) fail(e.message);
    throw e;
  }
  return entry;
}

function tryParseEntryId(id: string): ReturnType<typeof parseEntryId> | undefined {
  try {
    return parseEntryId(id);
  } catch {
    return undefined;
  }
}

function checkContainer(v: Record<string, unknown>, kind: ContainerKind): EntryContainer {
  const id = str(v.id, 'id');
  const name = str(v.name, 'name').trim() || fail('名称不能为空');
  if (!Array.isArray(v.entries)) fail('entries 应为数组');
  const entries = (v.entries as unknown[]).map((e, i) => checkEntry(e, kind, `词条[${i}]`));
  const seen = new Set<string>();
  let maxLocal = 0;
  for (const e of entries) {
    const { container, local } = tryParseEntryId(e.id) ?? fail(`词条 ID 格式应为 ${id}-序号：${e.id}`);
    if (container !== id) fail(`词条 ${e.id} 不属于 ${id}`);
    if (seen.has(e.id)) fail(`词条 ID 重复：${e.id}`);
    seen.add(e.id);
    maxLocal = Math.max(maxLocal, local);
  }
  const nextEntryId = Math.max(v.nextEntryId === undefined ? 1 : int(v.nextEntryId, 'nextEntryId'), maxLocal + 1);
  return { id, name, entries, nextEntryId };
}

function checkTrimRounds(v: Record<string, unknown>): number {
  if (v.trimRounds === undefined) return DEFAULT_TRIM_ROUNDS;
  const n = int(v.trimRounds, 'trimRounds');
  if (n < 1 || n > MAX_TRIM_ROUNDS) fail(`trimRounds 应在 1 到 ${MAX_TRIM_ROUNDS} 之间`);
  return n;
}

function checkPresetRequest(v: Record<string, unknown>): Pick<Preset, 'requestJson' | 'inputLimit'> {
  const requestJson = v.requestJson === undefined ? '' : str(v.requestJson, 'requestJson');
  const { errors } = checkRequestJson(requestJson, null);
  if (errors.length > 0) fail(`请求参数：${errors[0]}`);
  // 旧版把输入上限放在 params 里（temperature 等旧字段直接丢弃，改写进请求参数）
  const legacy = isObj(v.params) ? v.params.inputLimit : undefined;
  const limit = v.inputLimit ?? legacy;
  if (limit === undefined || limit === null) return { requestJson };
  const inputLimit = int(limit, 'inputLimit');
  if (inputLimit <= 0) fail('inputLimit 应大于 0');
  return { requestJson, inputLimit };
}

const SCRIPT_ROLES: readonly ScriptRole[] = ['user', 'assistant'];

export function checkScript(v: unknown, where = '正则'): RegexScript {
  if (!isObj(v)) return fail(`${where} 应为对象`);
  const s: RegexScript = {
    id: str(v.id, `${where}.id`),
    name: v.name === undefined ? '' : str(v.name, `${where}.name`),
    enabled: bool(v.enabled, `${where}.enabled`),
    stage: oneOf(v.stage, ['receive', 'runtime'] as const, `${where}.stage`),
    target: v.target === undefined ? 'both' : oneOf(v.target, ['display', 'request', 'both'] as const, `${where}.target`),
    roles: strList(v.roles, `${where}.roles`).map((r) => oneOf(r, SCRIPT_ROLES, `${where}.roles`)),
    action: v.action === undefined ? 'replace' : oneOf(v.action, ['replace', 'prepend', 'append'] as const, `${where}.action`),
    latestOnly: v.latestOnly === undefined ? false : bool(v.latestOnly, `${where}.latestOnly`),
    pattern: str(v.pattern, `${where}.pattern`),
    flags: v.flags === undefined ? '' : str(v.flags, `${where}.flags`),
    replacement: v.replacement === undefined ? '' : str(v.replacement, `${where}.replacement`),
    priority: v.priority === undefined ? 0 : int(v.priority, `${where}.priority`),
  };
  // 停用的正则可以暂时是坏的（例如导入时转不了的），启用时才检查
  if (s.enabled) {
    try {
      validateScript(s);
    } catch (e) {
      if (e instanceof ScriptError) fail(e.message);
      throw e;
    }
  }
  return s;
}

function checkScriptHost(v: Record<string, unknown>, id: string): ScriptHost {
  const raw = v.scripts === undefined ? [] : v.scripts;
  if (!Array.isArray(raw)) fail('scripts 应为数组');
  const scripts = (raw as unknown[]).map((x, i) => checkScript(x, `正则[${i}]`));
  const seen = new Set<string>();
  let maxLocal = 0;
  for (const sc of scripts) {
    const m = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-s(\\d+)$`).exec(sc.id);
    if (!m) fail(`正则 ID 格式应为 ${id}-s序号：${sc.id}`);
    if (seen.has(sc.id)) fail(`正则 ID 重复：${sc.id}`);
    seen.add(sc.id);
    maxLocal = Math.max(maxLocal, Number(m![1]));
  }
  const initialVars = v.initialVars === undefined ? '' : str(v.initialVars, 'initialVars');
  const { errors } = parseInitialVars(initialVars);
  if (errors.length > 0) fail(`初始变量第 ${errors[0]!.line} 行：${errors[0]!.message}`);
  const nextScriptId = Math.max(v.nextScriptId === undefined ? 1 : int(v.nextScriptId, 'nextScriptId'), maxLocal + 1);
  return { scripts, nextScriptId, initialVars };
}

/** 校验整份资料，返回规范化后的副本（丢弃未知字段）。 */
export function checkDoc<K extends LibraryKind>(kind: K, v: unknown): LibraryDocs[K] {
  if (!isObj(v)) return fail('资料应为对象');
  switch (kind) {
    case 'model': {
      const baseUrl = str(v.baseUrl, 'baseUrl').trim().replace(/\/+$/, '');
      if (!/^https?:\/\/\S+$/.test(baseUrl)) fail('baseUrl 应以 http:// 或 https:// 开头');
      const doc: ModelConfig = {
        id: str(v.id, 'id'),
        name: str(v.name, 'name').trim() || fail('名称不能为空'),
        protocol: oneOf(v.protocol, PROTOCOLS, 'protocol'),
        baseUrl,
        apiKey: v.apiKey === undefined ? '' : str(v.apiKey, 'apiKey'),
        model: str(v.model, 'model'),
        tokenizer: v.tokenizer === undefined ? 'auto' : oneOf(v.tokenizer, ['auto', ...TOKENIZER_IDS] as const, 'tokenizer'),
        use: v.use === undefined ? 'chat' : oneOf(v.use, ['chat', 'embedding'] as const, 'use'),
      };
      return doc as LibraryDocs[K];
    }
    case 'preset': {
      const base = checkContainer(v, 'preset');
      return {
        ...base,
        cacheMode: oneOf(v.cacheMode, ['auto', 'manual'] as const, 'cacheMode'),
        ...checkPresetRequest(v),
        trimRounds: checkTrimRounds(v),
        ...checkScriptHost(v, base.id),
      } as LibraryDocs[K];
    }
    case 'character': {
      const base = checkContainer(v, 'character');
      return {
        ...base,
        ...checkScriptHost(v, base.id),
        tags: v.tags === undefined ? [] : strList(v.tags, 'tags'),
        favorite: v.favorite === undefined ? false : bool(v.favorite, 'favorite'),
        worldbookIds: v.worldbookIds === undefined ? [] : strList(v.worldbookIds, 'worldbookIds'),
        greeting: v.greeting === undefined ? '' : str(v.greeting, 'greeting'),
        alternateGreetings: v.alternateGreetings === undefined ? [] : strList(v.alternateGreetings, 'alternateGreetings'),
        creatorNotes: v.creatorNotes === undefined ? '' : str(v.creatorNotes, 'creatorNotes'),
        avatar: v.avatar === undefined || v.avatar === null ? null : str(v.avatar, 'avatar'),
      } as LibraryDocs[K];
    }
    default:
      return checkContainer(v, kind as ContainerKind) as LibraryDocs[K];
  }
}

export function checkSettings(v: unknown): UserSettings {
  if (!isObj(v)) return fail('设置应为对象');
  const idOrNull = (x: unknown, what: string): string | null => (x === null || x === undefined ? null : str(x, what));
  return {
    presetId: idOrNull(v.presetId, 'presetId'),
    modelId: idOrNull(v.modelId, 'modelId'),
    personaId: idOrNull(v.personaId, 'personaId'),
    worldbookIds: v.worldbookIds === undefined ? [] : strList(v.worldbookIds, 'worldbookIds'),
    tokenizerPriority: v.tokenizerPriority === undefined ? 'name' : oneOf(v.tokenizerPriority, ['name', 'protocol'] as const, 'tokenizerPriority'),
    recall: checkRecall(v.recall),
    ui: checkUi(v.ui),
  };
}

function checkRecall(v: unknown): RecallSettings {
  if (v === undefined) return { ...DEFAULT_RECALL };
  if (!isObj(v)) return fail('recall 应为对象');
  const topK = v.topK === undefined ? DEFAULT_RECALL.topK : int(v.topK, 'recall.topK');
  if (topK < 1 || topK > 20) fail('recall.topK 应在 1 到 20 之间');
  const similarTopK = v.similarTopK === undefined ? DEFAULT_RECALL.similarTopK : int(v.similarTopK, 'recall.similarTopK');
  if (similarTopK < 1 || similarTopK > 50) fail('recall.similarTopK 应在 1 到 50 之间');
  return {
    mode: v.mode === undefined ? 'off' : oneOf(v.mode, ['off', 'keyword', 'vector', 'hybrid'] as const, 'recall.mode'),
    embeddingModelId: v.embeddingModelId === undefined || v.embeddingModelId === null ? null : str(v.embeddingModelId, 'recall.embeddingModelId'),
    topK,
    similarTopK,
  };
}

function checkUi(v: unknown): UiPrefs {
  if (v === undefined) return { ...DEFAULT_UI };
  if (!isObj(v)) return fail('ui 应为对象');
  const loadCount = v.loadCount === undefined ? DEFAULT_UI.loadCount : int(v.loadCount, 'ui.loadCount');
  if (loadCount < 0) fail('ui.loadCount 不能为负数');
  return {
    theme: v.theme === undefined ? DEFAULT_UI.theme : oneOf(v.theme, ['system', 'light', 'dark'] as const, 'ui.theme'),
    readingMode: v.readingMode === undefined ? DEFAULT_UI.readingMode : oneOf(v.readingMode, ['short', 'long'] as const, 'ui.readingMode'),
    loadCount,
    ...checkStyles(v),
    // 只保留最近的，避免无限增长
    ackedRisks: v.ackedRisks === undefined ? [] : strList(v.ackedRisks, 'ui.ackedRisks').slice(-500),
  };
}

/** 自定义风格。旧版只有一段 customCss：转成一套名为“我的风格”的风格并启用。 */
function checkStyles(v: Record<string, unknown>): Pick<UiPrefs, 'styles' | 'activeStyle'> {
  if (v.styles === undefined) {
    const legacy = typeof v.customCss === 'string' ? v.customCss : '';
    return legacy.trim() ? { styles: [{ id: 'style1', name: '我的风格', css: legacy }], activeStyle: 'style1' } : { styles: [], activeStyle: null };
  }
  if (!Array.isArray(v.styles)) fail('ui.styles 应为数组');
  const raw = v.styles as unknown[];
  if (raw.length > MAX_STYLES) fail(`风格最多 ${MAX_STYLES} 套`);
  const seen = new Set<string>();
  const styles = raw.map((x, i): UiStyle => {
    if (!isObj(x)) return fail(`ui.styles[${i}] 应为对象`);
    const id = str(x.id, `ui.styles[${i}].id`);
    if (seen.has(id)) fail(`风格 ID 重复：${id}`);
    seen.add(id);
    return { id, name: str(x.name, `ui.styles[${i}].name`).trim() || '未命名风格', css: str(x.css, `ui.styles[${i}].css`) };
  });
  const active = v.activeStyle === undefined || v.activeStyle === null ? null : str(v.activeStyle, 'ui.activeStyle');
  return { styles, activeStyle: active !== null && seen.has(active) ? active : null };
}

/**
 * 读出旧版数据时补齐到当前结构（不做完整校验，保证旧数据总能读出来再修）。
 * - 预设：params → requestJson（空）+ inputLimit。
 * - 预设、角色卡：补上 scripts、nextScriptId、initialVars；正则补上 action、latestOnly。
 */
export function upgradeDoc<K extends LibraryKind>(kind: K, raw: Record<string, unknown>): LibraryDocs[K] {
  let doc = raw;
  if (kind === 'preset' && doc.requestJson === undefined) {
    const { params, ...rest } = doc;
    const inputLimit = isObj(params) && Number.isInteger(params.inputLimit) ? (params.inputLimit as number) : undefined;
    doc = { ...rest, requestJson: '', ...(inputLimit === undefined ? {} : { inputLimit }) };
  }
  if ((kind === 'preset' || kind === 'character') && doc.scripts === undefined) {
    doc = { ...doc, scripts: [], nextScriptId: 1, initialVars: doc.initialVars ?? '' };
  }
  if (kind === 'character' && doc.greeting === undefined) doc = { ...doc, greeting: '' };
  if (kind === 'character' && doc.alternateGreetings === undefined) doc = { ...doc, alternateGreetings: [], creatorNotes: '', avatar: null };
  if (kind === 'model' && doc.tokenizer === undefined) doc = { ...doc, tokenizer: 'auto' };
  if (kind === 'model' && doc.use === undefined) doc = { ...doc, use: 'chat' };
  if (kind === 'preset' && doc.trimRounds === undefined) doc = { ...doc, trimRounds: DEFAULT_TRIM_ROUNDS };
  if ((kind === 'preset' || kind === 'character') && Array.isArray(doc.scripts)) {
    doc = { ...doc, scripts: (doc.scripts as Record<string, unknown>[]).map((sc) => ({ action: 'replace', latestOnly: false, ...sc })) };
  }
  return doc as unknown as LibraryDocs[K];
}

// ---------- 变更操作：对象ID + 词条ID + 变更项 ----------

/** 新词条不带 id 和 source，由容器分配。 */
export type EntryDraft = Omit<Entry, 'id' | 'source'>;
/** 新脚本不带 id，由容器分配。 */
export type ScriptDraft = Omit<RegexScript, 'id'>;

export type LibraryOp =
  | { op: 'set'; field: string; value: unknown }
  | { op: 'addEntry'; entry: EntryDraft }
  | { op: 'updateEntry'; entryId: string; patch: Partial<EntryDraft> }
  | { op: 'removeEntry'; entryId: string }
  | { op: 'addScript'; script: ScriptDraft }
  | { op: 'updateScript'; scriptId: string; patch: Partial<ScriptDraft> }
  | { op: 'removeScript'; scriptId: string };

const FIXED_FIELDS = new Set(['id', 'entries', 'nextEntryId', 'scripts', 'nextScriptId', 'avatar']);

/** 依次应用变更，最后整体校验；任一步不合法则整批不生效。 */
export function applyLibraryOps<K extends LibraryKind>(kind: K, doc: LibraryDocs[K], ops: readonly LibraryOp[]): LibraryDocs[K] {
  const draft = structuredClone(upgradeDoc(kind, doc as unknown as Record<string, unknown>)) as unknown as Record<string, unknown> &
    Partial<EntryContainer>;
  for (const op of ops) {
    if (op.op === 'set') {
      if (FIXED_FIELDS.has(op.field)) fail(`字段 ${op.field} 不能直接修改`);
      draft[op.field] = op.value;
      continue;
    }
    if (op.op === 'addScript' || op.op === 'updateScript' || op.op === 'removeScript') {
      if (kind !== 'preset' && kind !== 'character') fail('只有预设和角色卡可以挂正则');
      const host = draft as unknown as ScriptHost & { id: string };
      const scripts = host.scripts;
      if (op.op === 'addScript') {
        scripts.push({ ...op.script, id: `${host.id}-s${host.nextScriptId}` });
        host.nextScriptId += 1;
        continue;
      }
      const i = scripts.findIndex((sc) => sc.id === op.scriptId);
      if (i < 0) throw new LibraryError('not-found', `找不到正则 ${op.scriptId}`);
      if (op.op === 'removeScript') scripts.splice(i, 1);
      else {
        const { id: _id, ...patch } = op.patch as Partial<RegexScript>;
        scripts[i] = { ...scripts[i]!, ...patch };
      }
      continue;
    }
    if (kind === 'model' || !draft.entries) fail('模型配置没有词条');
    const entries = draft.entries!;
    switch (op.op) {
      case 'addEntry': {
        const id = `${draft.id}-${draft.nextEntryId}`;
        draft.nextEntryId = draft.nextEntryId! + 1;
        entries.push({ ...(op.entry as Entry), id, source: kind as EntrySource });
        break;
      }
      case 'updateEntry': {
        const i = entries.findIndex((e) => e.id === op.entryId);
        if (i < 0) throw new LibraryError('not-found', `找不到词条 ${op.entryId}`);
        const { id: _id, source: _src, ...patch } = op.patch as Partial<Entry>;
        entries[i] = { ...entries[i]!, ...patch };
        break;
      }
      case 'removeEntry': {
        const i = entries.findIndex((e) => e.id === op.entryId);
        if (i < 0) throw new LibraryError('not-found', `找不到词条 ${op.entryId}`);
        entries.splice(i, 1);
        break;
      }
    }
  }
  return checkDoc(kind, draft);
}

// ---------- 默认资料 ----------

/** 导入和默认资料使用的基础优先级（都在正文前分区）。预设中要排在世界书前面的词条设为 6000 以上。 */
export const BASE_PRIORITY = {
  worldbookBefore: 5000,
  persona: 4000,
  characterDescription: 3000,
  characterScenario: 2000,
  worldbookAfter: 1000,
} as const;

const entry = (id: string, source: EntrySource, name: string, content: string, priority: number, placement: Placement): Entry => ({
  id,
  name,
  source,
  enabled: true,
  role: 'system',
  content,
  priority,
  placement,
});

export interface DefaultLibrary {
  presets: Preset[];
  characters: Character[];
  personas: Persona[];
  worldbooks: Worldbook[];
  settings: UserSettings;
}

/** 新账号的默认资料：默认预设、一个空白角色、示例角色卡「万界商铺」及其账本世界书。 */
export function defaultLibrary(): DefaultLibrary {
  const before = { kind: 'position', section: 'before' } as const;
  const preset: Preset = {
    id: 'preset1',
    name: '默认预设',
    cacheMode: 'auto',
    requestJson: '',
    inputLimit: 32000,
    trimRounds: DEFAULT_TRIM_ROUNDS,
    scripts: [],
    nextScriptId: 1,
    initialVars: '',
    nextEntryId: 2,
    entries: [
      entry('preset1-1', 'preset', '主提示', '你是{{char}}。请以{{char}}的身份与{{user}}进行角色扮演，保持人设一致，自然地推动情节。', 0, {
        kind: 'position',
        section: 'system',
      }),
    ],
  };
  const character: Character = {
    id: 'char1',
    name: '占位角色',
    tags: [],
    favorite: false,
    worldbookIds: [],
    greeting: '',
    alternateGreetings: [],
    creatorNotes: '',
    avatar: null,
    scripts: [],
    nextScriptId: 1,
    initialVars: '',
    nextEntryId: 2,
    entries: [entry('char1-1', 'character', '角色设定', '一位友善的酒馆老板，乐于和来客聊天。', BASE_PRIORITY.characterDescription, before)],
  };
  const persona: Persona = {
    id: 'persona1',
    name: '用户',
    nextEntryId: 2,
    entries: [entry('persona1-1', 'persona', '用户设定', '', BASE_PRIORITY.persona, before)],
  };
  const shop = shopExample('char2', 'worldbook1');
  return {
    presets: [preset],
    characters: [character, shop.character],
    personas: [persona],
    worldbooks: [shop.worldbook],
    settings: { presetId: preset.id, modelId: null, personaId: persona.id, worldbookIds: [], tokenizerPriority: 'name', recall: { ...DEFAULT_RECALL }, ui: { ...DEFAULT_UI } },
  };
}
