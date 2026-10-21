// token 预估：按模型名选分词器，再用实际用量校准。
//
// 模型名用部分匹配：各家渠道的名字不一定和官方一致（anthropic/claude-opus-4.7、claude-opus-4-7@vertex、
// 某某中转自定义的名字……）。先去掉前缀和 :free 这类后缀，再按下面的规则表从上往下匹配，第一条命中的生效；
// 都没命中时按协议兜底。模型配置里也可以手动指定分词器。
//
// 分词器分“精确”和“近似”两类：OpenAI、各家开源权重模型用官方词表，是精确的；Claude 没有公开分词器，
// Gemini 3 的 gemma4 词表还没有 JS 版本，没有公开分词器的模型统一用 DeepSeek 的词表作参照——这些是近似的。
// 每次回复后上游会报告真实的输入 token 数，和预估一起记在这条回复上；之后按最近几条记录的
// “实际 / 预估”算出校准系数，乘到预估上。

import type { Protocol } from './library.ts';

export type TokenizerProfileId =
  | 'openai-o200k'
  | 'openai-cl100k'
  | 'claude-legacy'
  | 'claude-new'
  | 'gemini-2'
  | 'gemini-3'
  | 'gemma'
  | 'deepseek-v3'
  | 'deepseek-v4'
  | 'qwen'
  | 'llama'
  | 'mistral'
  | 'reference';

export interface TokenizerProfile {
  id: TokenizerProfileId;
  label: string;
  /** npm 包 @lenml/tokenizer-<pkg> 里的词表。 */
  pkg: string;
  /** 词表是否就是这个模型用的。 */
  exact: boolean;
  /** 还没有校准记录时用的系数。 */
  prior: number;
}

const P = (id: TokenizerProfileId, label: string, pkg: string, exact: boolean, prior = 1): TokenizerProfile => ({ id, label, pkg, exact, prior });

export const TOKENIZER_PROFILES: Record<TokenizerProfileId, TokenizerProfile> = {
  'openai-o200k': P('openai-o200k', 'OpenAI o200k（gpt-4o / 4.1 / 5、o 系列）', 'gpt4o', true),
  'openai-cl100k': P('openai-cl100k', 'OpenAI cl100k（gpt-4 / 3.5）', 'gpt4', true),
  'claude-legacy': P('claude-legacy', 'Claude 4.6 及以前（近似）', 'claude', false),
  // 4.7 起换了分词器，同样的文字多出约 1.0–1.35 倍
  'claude-new': P('claude-new', 'Claude 4.7 及以后（近似）', 'claude', false, 1.3),
  'gemini-2': P('gemini-2', 'Gemini 2.x 及以前（Gemma 3 词表）', 'gemma3', false),
  // Gemini 3 用 gemma4 词表，目前没有 JS 版本，先用 Gemma 3 词表加校准
  'gemini-3': P('gemini-3', 'Gemini 3 及以后（近似，Gemma 3 词表）', 'gemma3', false),
  gemma: P('gemma', 'Gemma', 'gemma3', true),
  'deepseek-v3': P('deepseek-v3', 'DeepSeek V3 / R1', 'deepseek_v3', true),
  'deepseek-v4': P('deepseek-v4', 'DeepSeek V4', 'deepseek_v4', true),
  qwen: P('qwen', 'Qwen', 'qwen3', true),
  llama: P('llama', 'Llama 3', 'llama3_1', true),
  mistral: P('mistral', 'Mistral（Tekken）', 'mistral_nemo', true),
  reference: P('reference', '参照 DeepSeek（近似）', 'deepseek_v4', false),
};

export const TOKENIZER_IDS = Object.keys(TOKENIZER_PROFILES) as TokenizerProfileId[];

export function isTokenizerId(v: unknown): v is TokenizerProfileId {
  return typeof v === 'string' && Object.hasOwn(TOKENIZER_PROFILES, v);
}

/** 去掉 anthropic/、models/ 这类前缀和 :free、:beta 这类后缀，转小写。 */
export function normalizeModelName(name: string): string {
  let n = name.trim().toLowerCase();
  n = n.slice(n.lastIndexOf('/') + 1);
  const colon = n.indexOf(':');
  if (colon > 0) n = n.slice(0, colon);
  return n;
}

function claudeGeneration(n: string): TokenizerProfileId {
  const m = /claude[-_. ]?(?:(?:opus|sonnet|haiku|instant)[-_. ]?)?(\d+)(?:[-_.](\d{1,2})(?!\d))?/.exec(n);
  if (!m) return 'claude-new'; // claude-latest 这类不带版本的，按最新的算
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  return major > 4 || (major === 4 && minor >= 7) ? 'claude-new' : 'claude-legacy';
}

function geminiGeneration(n: string): TokenizerProfileId {
  const m = /gemini[-_ ]?(\d+)/.exec(n);
  return !m || Number(m[1]) >= 3 ? 'gemini-3' : 'gemini-2';
}

/** 规则表：从上往下，第一条命中的生效。 */
const RULES: readonly { test: RegExp; pick: (n: string) => TokenizerProfileId; why: string }[] = [
  { test: /mythos|fable/, pick: () => 'claude-new', why: 'Claude Mythos / Fable' },
  { test: /claude/, pick: claudeGeneration, why: '名字里有 claude，按版本号分代' },
  { test: /gpt-oss|gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|chatgpt|codex|(?:^|[^a-z0-9])o[1-9](?:-|$)/, pick: () => 'openai-o200k', why: 'OpenAI 新一代模型' },
  { test: /gpt-4|gpt-3\.5|gpt-35|text-embedding|davinci/, pick: () => 'openai-cl100k', why: 'OpenAI 旧一代模型' },
  { test: /gemini/, pick: geminiGeneration, why: '名字里有 gemini，按版本号分代' },
  { test: /gemma/, pick: () => 'gemma', why: 'Gemma' },
  { test: /deepseek/, pick: (n) => (/v3|r1|v2/.test(n) ? 'deepseek-v3' : 'deepseek-v4'), why: 'DeepSeek' },
  { test: /qwen|qwq/, pick: () => 'qwen', why: 'Qwen' },
  { test: /llama/, pick: () => 'llama', why: 'Llama' },
  { test: /mistral|mixtral|ministral|magistral|codestral|devstral|pixtral/, pick: () => 'mistral', why: 'Mistral' },
];

export interface TokenizerChoice {
  profile: TokenizerProfile;
  /** 怎么选出来的，界面上显示。 */
  reason: string;
  /** 是否是自动匹配（否则是模型配置里手动指定的）。 */
  auto: boolean;
}

/** 按模型名部分匹配；都没命中时按协议兜底。 */
export function matchTokenizer(modelName: string, protocol: Protocol): TokenizerChoice {
  const n = normalizeModelName(modelName);
  for (const r of RULES) {
    if (r.test.test(n)) return { profile: TOKENIZER_PROFILES[r.pick(n)], reason: `按模型名匹配：${r.why}`, auto: true };
  }
  const byProtocol: Record<Protocol, TokenizerProfileId> = {
    claude: 'claude-new',
    gemini: 'gemini-3',
    'openai-responses': 'openai-o200k',
    'openai-chat': 'reference',
  };
  return { profile: TOKENIZER_PROFILES[byProtocol[protocol]], reason: '模型名没有匹配到，按协议兜底', auto: true };
}

/**
 * 自动选择时哪个优先（系统设置）：
 *   name：模型名优先，都没匹配到再按接口类型兜底（适合 OpenRouter 这类一个接口里什么模型都有的渠道）。
 *   protocol：接口类型优先。Claude 接口一律用 Claude 分词器、Gemini 接口一律用 Gemini 分词器（代数仍按模型名判断），
 *             OpenAI Responses 一律用 o200k；只有 OpenAI Chat 这种通用接口才看模型名。
 *             适合 Azure 等部署名和模型无关的渠道。
 */
export type TokenizerPriority = 'name' | 'protocol';

/** 按接口类型直接决定时用哪个分词器；OpenAI Chat 是通用接口，返回 null 交给模型名。 */
function byProtocolFirst(n: string, protocol: Protocol): TokenizerChoice | null {
  const pick = (id: TokenizerProfileId, why: string): TokenizerChoice => ({ profile: TOKENIZER_PROFILES[id], reason: `按接口类型：${why}`, auto: true });
  if (protocol === 'claude') return pick(claudeGeneration(n), 'Claude 接口，代数按模型名里的版本号');
  if (protocol === 'gemini') return pick(geminiGeneration(n), 'Gemini 接口，代数按模型名里的版本号');
  if (protocol === 'openai-responses') return pick('openai-o200k', 'OpenAI Responses 接口');
  return null;
}

/** 模型配置里的选择：auto 或指定的分词器。 */
export function chooseTokenizer(model: { model: string; protocol: Protocol; tokenizer?: string }, priority: TokenizerPriority = 'name'): TokenizerChoice {
  if (model.tokenizer && model.tokenizer !== 'auto' && isTokenizerId(model.tokenizer)) {
    return { profile: TOKENIZER_PROFILES[model.tokenizer], reason: '模型配置里手动指定', auto: false };
  }
  if (priority === 'protocol') {
    const hit = byProtocolFirst(normalizeModelName(model.model), model.protocol);
    if (hit) return hit;
  }
  return matchTokenizer(model.model, model.protocol);
}

// ---------- 校准 ----------

/** 记在每条回复上的预估记录。raw 是没乘系数的预估；actual 是上游报告的实际输入 token。 */
export interface TokenEstimate {
  /** 发送时的模型名（模型配置里的 model 字段）。 */
  model: string;
  tokenizer: TokenizerProfileId;
  raw: number;
  /** 当时用的校准系数。 */
  factor: number;
  actual?: number;
}

export interface Calibration {
  factor: number;
  /** 参与计算的记录数；0 表示用的是默认系数。 */
  samples: number;
}

export const CALIBRATION_SAMPLES = 5;
const FACTOR_MIN = 0.5;
const FACTOR_MAX = 2.5;

/**
 * 从记录里算校准系数：取同一模型、同一分词器、带实际值的最近几条，系数 = 实际总和 / 预估总和。
 * records 按从新到旧排列。没有可用记录时返回默认系数。
 */
export function calibrate(records: Iterable<TokenEstimate | undefined>, model: string, tokenizer: TokenizerProfileId): Calibration {
  let raw = 0;
  let actual = 0;
  let samples = 0;
  for (const r of records) {
    if (!r || r.model !== model || r.tokenizer !== tokenizer || !r.actual || r.raw <= 0) continue;
    raw += r.raw;
    actual += r.actual;
    if (++samples >= CALIBRATION_SAMPLES) break;
  }
  if (samples === 0) return { factor: TOKENIZER_PROFILES[tokenizer].prior, samples: 0 };
  return { factor: Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, actual / raw)), samples };
}

/** 上游报告的用量 → 实际输入 token 总数。Claude 的 input_tokens 不含缓存部分，要加回来。 */
export function promptTotal(usage: { input?: number; cacheRead?: number; cacheWrite?: number }, protocol: Protocol): number | undefined {
  if (usage.input === undefined) return undefined;
  return protocol === 'claude' ? usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : usage.input;
}
