// 分词器池：在沙箱 worker 里按需加载 @lenml/tokenizer-* 包里的 tokenizer.json，数 token。
//
// 只读取包里的 models/tokenizer.json 和 tokenizer_config.json，不引入包里打包好的 dist（体积很大）。
// 每个分词器加载要零点几秒到两秒、占几十 MB 内存，所以常驻缓存，最多同时保留 MAX_LOADED 个。
// 包没装或加载失败时退回到粗略估算（中日韩字符按 1 个，其余约 4 个字符 1 个）。

import { TokenizerLoader } from '@lenml/tokenizers';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { estimateTokens } from '../../core/build.ts';

const require = createRequire(import.meta.url);

const MAX_LOADED = 3;
/** 每个分词器缓存的文本条数（同一段文字反复出现：词条、聊天记录）。 */
const MAX_CACHED = 20000;
/** 每条消息在协议里的格式开销，按经验取值，差多少由校准补上。 */
export const MESSAGE_OVERHEAD = 4;

interface Loaded {
  encode: (text: string) => number;
  cache: Map<string, number>;
}

const loaded = new Map<string, Loaded>();
const failed = new Map<string, string>();

export type LoadResult = { ok: true } | { ok: false; error: string };

function readJson(pkg: string, file: string): unknown {
  return JSON.parse(readFileSync(require.resolve(`@lenml/tokenizer-${pkg}/models/${file}`), 'utf8'));
}

/** 加载分词器（已加载时直接返回）。失败会记住原因，不反复重试。 */
export function loadTokenizer(pkg: string): LoadResult {
  if (loaded.has(pkg)) {
    // 调整为最近使用
    const t = loaded.get(pkg)!;
    loaded.delete(pkg);
    loaded.set(pkg, t);
    return { ok: true };
  }
  const known = failed.get(pkg);
  if (known) return { ok: false, error: known };
  try {
    const tokenizer = TokenizerLoader.fromPreTrained({
      tokenizerJSON: readJson(pkg, 'tokenizer.json') as never,
      tokenizerConfig: readJson(pkg, 'tokenizer_config.json') as never,
    });
    loaded.set(pkg, { encode: (text) => tokenizer.encode(text, { add_special_tokens: false }).length, cache: new Map() });
    while (loaded.size > MAX_LOADED) loaded.delete(loaded.keys().next().value!);
    return { ok: true };
  } catch (e) {
    const error = `分词器 @lenml/tokenizer-${pkg} 加载失败：${(e as Error).message}`;
    failed.set(pkg, error);
    return { ok: false, error };
  }
}

/** 一段文字的 token 数（不含消息格式开销）。分词器不可用时用粗略估算。 */
export function countText(pkg: string | undefined, text: string): number {
  const t = pkg === undefined ? undefined : loaded.get(pkg);
  if (!t) return Math.max(0, estimateTokens({ role: 'user', content: text }) - MESSAGE_OVERHEAD);
  const hit = t.cache.get(text);
  if (hit !== undefined) return hit;
  const n = t.encode(text);
  if (t.cache.size >= MAX_CACHED) t.cache.clear();
  t.cache.set(text, n);
  return n;
}

/** 给 buildRequest 用的计数函数：文字 + 每条消息的格式开销。 */
export function messageCounter(pkg: string | undefined): (m: { role: string; content: string }) => number {
  return (m) => countText(pkg, m.content) + MESSAGE_OVERHEAD;
}

export function isLoaded(pkg: string): boolean {
  return loaded.has(pkg);
}
