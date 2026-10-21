// 预设的“请求参数”：一段写法宽松的 JSON，合并进发给模型的请求体。
//
// 写法：最外层花括号可省；键可以不加引号；允许末尾多一个逗号和 // 注释。
//   thinking: { "type": "disabled" },
//   max_tokens: 4096
// 成员之间必须有逗号，缺了会指出第几行第几列。

import type { Protocol } from './library.ts';

export class RequestJsonError extends Error {
  readonly line: number;
  readonly col: number;
  constructor(message: string, line: number, col: number) {
    super(`第 ${line} 行第 ${col} 列：${message}`);
    this.name = 'RequestJsonError';
    this.line = line;
    this.col = col;
  }
}

/** 请求参数不能用（语法错误或写了固定字段）。 */
export class RequestJsonInvalid extends Error {
  constructor(message: string) {
    super(`请求参数有误：${message}`);
    this.name = 'RequestJsonInvalid';
  }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

interface Parsed {
  value: JsonObject;
  /** 顶层是否写了外层花括号；是的话 closeAt 是最后那个 } 的位置。 */
  closeAt: number | null;
  /** 顶层最后一个成员的值结束的位置，以及它后面是否已经有逗号。 */
  lastValueEnd: number | null;
  trailingComma: boolean;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$\-.]/;

/** 解析宽松 JSON 对象。空文本得到空对象。 */
export function parseRequestJson(text: string): JsonObject {
  return parseDetailed(text).value;
}

function parseDetailed(text: string): Parsed {
  let i = 0;
  let depth = 0;
  let lastValueEnd: number | null = null;
  let trailingComma = false;
  const pos = (at = i) => {
    const before = text.slice(0, at);
    const line = before.split('\n').length;
    return { line, col: at - before.lastIndexOf('\n') };
  };
  const fail = (msg: string, at = i): never => {
    const p = pos(at);
    throw new RequestJsonError(msg, p.line, p.col);
  };

  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text.startsWith('//', i)) {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      return;
    }
  };

  const parseString = (): string => {
    const quote = text[i]!;
    const start = i;
    i++;
    let out = '';
    for (;;) {
      const c = text[i];
      if (c === undefined || c === '\n') return fail('字符串没有结束', start);
      i++;
      if (c === quote) return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = text[i++];
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"', "'": "'" };
      if (e === 'u') {
        const hex = text.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('\\u 后面应是 4 位十六进制');
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else if (e !== undefined && e in map) {
        out += map[e];
      } else {
        fail('无效的转义');
      }
    }
  };

  const parseKey = (): string => {
    const c = text[i];
    if (c === '"' || c === "'") return parseString();
    if (c === undefined || !IDENT_START.test(c)) return fail('这里应该是字段名');
    const start = i;
    while (i < text.length && IDENT_PART.test(text[i]!)) i++;
    return text.slice(start, i);
  };

  /** 解析成员直到遇到 close（顶层省略花括号时 close 为 undefined，读到结尾为止）。 */
  const parseMembers = (close: '}' | undefined): JsonObject => {
    const obj: JsonObject = {};
    const top = depth === 0;
    depth++;
    for (;;) {
      skip();
      if (close ? text[i] === close : i >= text.length) {
        i++;
        depth--;
        return obj;
      }
      if (i >= text.length) return fail('缺少右花括号 }');
      const keyAt = i;
      const key = parseKey();
      if (Object.hasOwn(obj, key)) fail(`字段 ${key} 重复`, keyAt);
      skip();
      if (text[i] !== ':') fail(`字段 ${key} 后面缺少冒号 :`);
      i++;
      skip();
      obj[key] = parseValue();
      if (top) {
        lastValueEnd = i;
        trailingComma = false;
      }
      skip();
      if (text[i] === ',') {
        if (top) trailingComma = true;
        i++;
        continue;
      }
      if (close ? text[i] === close : i >= text.length) continue;
      fail('这里缺少逗号 ,');
    }
  };

  const parseArray = (): Json[] => {
    i++;
    const arr: Json[] = [];
    for (;;) {
      skip();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      if (i >= text.length) return fail('缺少右方括号 ]');
      arr.push(parseValue());
      skip();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] !== ']') fail('这里缺少逗号 ,');
    }
  };

  const parseValue = (): Json => {
    skip();
    const c = text[i];
    if (c === '{') {
      i++;
      return parseMembers('}');
    }
    if (c === '[') return parseArray();
    if (c === '"' || c === "'") return parseString();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) return fail('这里应该是一个值（数字、字符串、true/false/null、对象或数组）');
    i += m[0].length;
    return m[0] === 'true' ? true : m[0] === 'false' ? false : m[0] === 'null' ? null : Number(m[0]);
  };

  skip();
  if (i >= text.length) return { value: {}, closeAt: null, lastValueEnd: null, trailingComma: false };
  // 整段被一对花括号包住时按标准写法解析，否则视为省略了外层花括号。
  let wrappedError: unknown = null;
  if (text[i] === '{') {
    const save = i;
    i++;
    try {
      const value = parseMembers('}');
      const closeAt = i - 1;
      skip();
      if (i >= text.length) return { value, closeAt, lastValueEnd, trailingComma };
    } catch (e) {
      wrappedError = e; // 也可能是省略了外层花括号、以对象开头的写法，下面重试
    }
    i = save;
    depth = 0;
    lastValueEnd = null;
    trailingComma = false;
  }
  try {
    return { value: parseMembers(undefined), closeAt: null, lastValueEnd, trailingComma };
  } catch (e) {
    // 两种读法都失败时，按花括号读法的错误更贴近作者的意图
    throw wrappedError ?? e;
  }
}

// ---------- 协议相关 ----------

/** 平台固定、每次请求都一样的字段，不能在请求参数里写。按所有协议合并，预设换协议也不会漏。 */
export const FIXED_FIELDS: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'input',
  'contents',
  'system',
  'systemInstruction',
  'stream',
  'stream_options',
]);

/** 协议必需、但可以调整的字段；缺了就补上这个默认值。 */
export const REQUIRED_FIELDS: Record<Protocol, JsonObject> = {
  'openai-chat': {},
  'openai-responses': {},
  claude: { max_tokens: 4096 },
  gemini: {},
};

export interface RequestJsonCheck {
  value: JsonObject | null;
  /** 语法错误或写了固定字段；有错误时不能保存。 */
  errors: string[];
  /** 当前协议必需但没写的字段。 */
  missing: string[];
}

export function checkRequestJson(text: string, protocol: Protocol | null): RequestJsonCheck {
  let value: JsonObject;
  try {
    value = parseDetailed(text).value;
  } catch (e) {
    if (e instanceof RequestJsonError) return { value: null, errors: [e.message], missing: [] };
    throw e;
  }
  const errors = Object.keys(value)
    .filter((k) => FIXED_FIELDS.has(k))
    .map((k) => `${k} 由平台固定填写，不能在请求参数里修改`);
  const missing = protocol ? Object.keys(REQUIRED_FIELDS[protocol]).filter((k) => !Object.hasOwn(value, k)) : [];
  return { value, errors, missing };
}

/**
 * 把缺少的必需字段追加到最后一个成员之后（保留原有写法和注释），返回新文本。
 * 文本本身有错误时原样返回。
 */
export function addMissingFields(text: string, protocol: Protocol): { text: string; added: string[] } {
  const { value, errors, missing } = checkRequestJson(text, protocol);
  if (!value || errors.length > 0 || missing.length === 0) return { text, added: [] };
  const p = parseDetailed(text);
  const lines = missing.map((k) => `${k}: ${JSON.stringify(REQUIRED_FIELDS[protocol][k])}`);
  const indent = p.closeAt === null ? '' : '  ';
  const addition = lines.map((l) => `${indent}${l}`).join(',\n');

  // 在最后一个值后面补逗号（不会落进注释里），新字段放在末尾或右花括号之前。
  let head = text;
  let tail = '';
  if (p.closeAt !== null) {
    head = text.slice(0, p.closeAt).trimEnd();
    tail = `\n${text.slice(p.closeAt)}`;
  }
  if (p.lastValueEnd !== null && !p.trailingComma) head = `${head.slice(0, p.lastValueEnd)},${head.slice(p.lastValueEnd)}`;
  head = head.trimEnd();
  return { text: `${head}${head === '' ? '' : '\n'}${addition}${tail}`, added: missing };
}

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 深合并：对象逐层合并，其余（含数组）整体替换。不改动参数。 */
export function deepMerge(base: Record<string, unknown>, over: JsonObject): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out;
}

/** 请求体 = 协议固定部分 + 用户请求参数 + 缺失的必需字段默认值。 */
export function applyRequestJson(fixedBody: Record<string, unknown>, text: string, protocol: Protocol): Record<string, unknown> {
  const { value, errors } = checkRequestJson(text, protocol);
  if (!value || errors.length > 0) throw new RequestJsonInvalid(errors[0]!);
  const merged = deepMerge(fixedBody, value);
  for (const [k, v] of Object.entries(REQUIRED_FIELDS[protocol])) if (!Object.hasOwn(merged, k)) merged[k] = v;
  return merged;
}
