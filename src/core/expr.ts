// IF 表达式：只读、JS 风格、不使用 eval。
//
// 支持：数字、字符串、true/false、变量名（可含中文，用 . 取字段或第几项）、has("名称")、len(值)、
//       get("名称"[, 默认值])、mentioned([条数,] "关键词", …)（见 mention.ts）、
//       similar([条数,] ["描述",] [阈值])（向量相似度，生成前算好，见 similar.ts）、
//       random(a, b, …)（每次请求重新抽）、pick(a, b, …)（同一会话里固定）、roll("2d6+1")（掷骰）
//       ! - * / % + - < <= > >= == != === !== && || 和括号。
// 语义比 JS 严格：不做隐式类型转换，== 与 === 等价（列表和对象按内容比较）；
//       算术只用于数字（+ 也可拼接两个字符串），大小比较要求两侧同类型。
// 读取不存在的变量会报错，需要先用 has() 判断。

import type { VarLookup, VarValue } from './types.ts';
import { DEFAULT_MENTION_DEPTH, keyMatcher, type Mentioned } from './mention.ts';
import { KIND_NAME, kindOf, valuesEqual } from './vars.ts';
import { parseSimilarArgs, type SimilarCall } from './similar.ts';

type Value = VarValue;

type Node =
  | { t: 'lit'; v: Value }
  | { t: 'var'; name: string; pos: number }
  | { t: 'call'; fn: string; args: Node[]; pos: number }
  | { t: 'un'; op: '!' | '-'; x: Node; pos: number }
  | { t: 'bin'; op: string; l: Node; r: Node; pos: number };

export class ExprError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(`${message}（位置 ${pos}）`);
    this.name = 'ExprError';
    this.pos = pos;
  }
}

// ---------- 词法 ----------

type Tok =
  | { k: 'num'; v: number; pos: number }
  | { k: 'str'; v: string; pos: number }
  | { k: 'id'; v: string; pos: number }
  | { k: 'op'; v: string; pos: number }
  | { k: 'end'; pos: number };

const OPS = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '+', '-', '*', '/', '%', '(', ')', ','];
const ID_START = /[\p{L}_$]/u;
const ID_PART = /[\p{L}\p{N}_$.]/u;

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    const pos = i;
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ k: 'num', v: Number(m[0]), pos });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let s = '';
      i++;
      for (;;) {
        const d = src[i];
        if (d === undefined) throw new ExprError('字符串没有结束', pos);
        i++;
        if (d === c) break;
        if (d === '\\') {
          const e = src[i++];
          if (e === undefined) throw new ExprError('字符串没有结束', pos);
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
        } else {
          s += d;
        }
      }
      out.push({ k: 'str', v: s, pos });
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j]!)) j++;
      out.push({ k: 'id', v: src.slice(i, j), pos });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op === undefined) throw new ExprError(`无法识别的字符 “${c}”`, pos);
    out.push({ k: 'op', v: op, pos });
    i += op.length;
  }
  out.push({ k: 'end', pos: src.length });
  return out;
}

// ---------- 语法 ----------

const BINARY_LEVELS: readonly (readonly string[])[] = [
  ['||'],
  ['&&'],
  ['==', '!=', '===', '!=='],
  ['<', '<=', '>', '>='],
  ['+', '-'],
  ['*', '/', '%'],
];

const FUNCTIONS = new Set(['has', 'len', 'get', 'mentioned', 'similar', 'random', 'pick', 'roll']);

/** 求值时可用的外部信息。没有聊天记录时（例如单独测试表达式）mentioned 总是不成立。 */
export interface ExprContext {
  mentioned?: Mentioned;
  /** 这个词条的 similar() 是否成立（生成前算好）；没有时总是不成立。 */
  similar?: (call: SimilarCall) => boolean;
  /** random() 和 roll() 用的随机数，默认 Math.random（测试时可以固定）。 */
  rand?: () => number;
  /** pick() 的种子：同一会话里相同的 pick 总是选同一项。 */
  seed?: string;
}

/** 字符串 → 0..1 之间的稳定伪随机数。 */
function hashUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const DICE = /^\s*(\d*)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i;

/** 掷骰：roll(20) 即 1d20；roll("2d6+1")。 */
function roll(spec: Value, rand: () => number, pos: number): number {
  let count = 1;
  let sides: number;
  let bonus = 0;
  if (typeof spec === 'number') sides = spec;
  else if (typeof spec === 'string') {
    const m = DICE.exec(spec) ?? (/^\s*\d+\s*$/.test(spec) ? [spec, '1', spec.trim()] : null);
    if (!m) throw new ExprError(`roll() 看不懂 “${spec}”，应该写成 "2d6" 或 "1d20+3"`, pos);
    count = m[1] ? Number(m[1]) : 1;
    sides = Number(m[2]);
    if (m[3]) bonus = (m[3] === '-' ? -1 : 1) * Number(m[4]);
  } else throw new ExprError('roll() 的参数应该是数字或 "2d6" 这样的文字', pos);
  if (!Number.isInteger(sides) || sides < 1 || sides > 100000 || !Number.isInteger(count) || count < 1 || count > 100) {
    throw new ExprError('roll() 的骰子数应在 1–100，面数应在 1–100000', pos);
  }
  let sum = bonus;
  for (let i = 0; i < count; i++) sum += 1 + Math.floor(rand() * sides);
  return sum;
}

export function parseExpr(src: string): Node {
  const toks = lex(src);
  let p = 0;
  const peek = (): Tok => toks[p]!;
  const isOp = (v: string): boolean => {
    const t = peek();
    return t.k === 'op' && t.v === v;
  };
  const expect = (v: string): void => {
    if (!isOp(v)) throw new ExprError(`这里应该是 “${v}”`, peek().pos);
    p++;
  };

  const binary = (level: number): Node => {
    if (level === BINARY_LEVELS.length) return unary();
    const ops = BINARY_LEVELS[level]!;
    let l = binary(level + 1);
    for (;;) {
      const t = peek();
      if (t.k !== 'op' || !ops.includes(t.v)) return l;
      p++;
      l = { t: 'bin', op: t.v, l, r: binary(level + 1), pos: t.pos };
    }
  };

  const unary = (): Node => {
    const t = peek();
    if (t.k === 'op' && (t.v === '!' || t.v === '-')) {
      p++;
      return { t: 'un', op: t.v, x: unary(), pos: t.pos };
    }
    return primary();
  };

  const primary = (): Node => {
    const t = toks[p++]!;
    switch (t.k) {
      case 'num':
      case 'str':
        return { t: 'lit', v: t.v };
      case 'id': {
        if (t.v === 'true' || t.v === 'false') return { t: 'lit', v: t.v === 'true' };
        if (!isOp('(')) return { t: 'var', name: t.v, pos: t.pos };
        if (!FUNCTIONS.has(t.v)) throw new ExprError(`没有函数 ${t.v}()`, t.pos);
        p++;
        const args: Node[] = [];
        while (!isOp(')')) {
          args.push(binary(0));
          if (!isOp(',')) break;
          p++;
        }
        expect(')');
        return { t: 'call', fn: t.v, args, pos: t.pos };
      }
      case 'op':
        if (t.v === '(') {
          const x = binary(0);
          expect(')');
          return x;
        }
        throw new ExprError(`这里不能是 “${t.v}”`, t.pos);
      case 'end':
        throw new ExprError('表达式不完整', t.pos);
    }
  };

  const root = binary(0);
  if (peek().k !== 'end') throw new ExprError('表达式后面有多余内容', peek().pos);
  return root;
}

// ---------- 求值 ----------

function truthy(v: Value): boolean {
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'boolean') return v;
  return Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0;
}

const typeName = (v: Value): string => KIND_NAME[kindOf(v)];

function evalNode(n: Node, lookup: VarLookup, ctx: ExprContext = {}): Value {
  const ev = (x: Node): Value => evalNode(x, lookup, ctx);
  switch (n.t) {
    case 'lit':
      return n.v;
    case 'var': {
      const v = lookup(n.name);
      if (v === undefined) throw new ExprError(`变量 ${n.name} 不存在`, n.pos);
      return v;
    }
    case 'call': {
      if (n.fn === 'mentioned') {
        const vals = n.args.map(ev);
        let depth = DEFAULT_MENTION_DEPTH;
        if (typeof vals[0] === 'number') depth = vals.shift() as number;
        if (vals.length === 0) throw new ExprError('mentioned() 至少需要一个关键词', n.pos);
        if (!vals.every((v) => typeof v === 'string')) throw new ExprError('mentioned() 的关键词应该是字符串', n.pos);
        try {
          for (const k of vals as string[]) keyMatcher(k);
        } catch (e) {
          throw new ExprError(`mentioned() 的正则写错了：${(e as Error).message}`, n.pos);
        }
        return ctx.mentioned ? ctx.mentioned(depth, vals as string[]) : false;
      }
      if (n.fn === 'similar') {
        // 参数只能直接写数字和文字：生成前要先把它们找出来算好相似度
        if (!n.args.every((a) => a.t === 'lit')) throw new ExprError('similar() 的参数只能直接写数字和文字，不能用变量或算式', n.pos);
        let call: SimilarCall;
        try {
          call = parseSimilarArgs(n.args.map((a) => (a as { v: Value }).v));
        } catch (e) {
          throw new ExprError((e as Error).message, n.pos);
        }
        return ctx.similar ? ctx.similar(call) : false;
      }
      if (n.fn === 'random' || n.fn === 'pick') {
        const vals = n.args.map(ev);
        if (vals.length === 0) throw new ExprError(`${n.fn}() 至少需要一个选项`, n.pos);
        const u = n.fn === 'random' ? (ctx.rand ?? Math.random)() : hashUnit(`${ctx.seed ?? ''}\n${JSON.stringify(vals)}`);
        return vals[Math.min(vals.length - 1, Math.floor(u * vals.length))]!;
      }
      if (n.fn === 'roll') {
        if (n.args.length !== 1) throw new ExprError('roll() 需要一个参数', n.pos);
        return roll(ev(n.args[0]!), ctx.rand ?? Math.random, n.pos);
      }
      if (n.fn === 'get') {
        if (n.args.length < 1 || n.args.length > 2) throw new ExprError('get() 需要一到两个参数：名称和默认值', n.pos);
        const name = ev(n.args[0]!);
        if (typeof name !== 'string') throw new ExprError('get() 的第一个参数应该是字符串', n.pos);
        const v = lookup(name);
        return v !== undefined ? v : n.args[1] ? ev(n.args[1]) : '';
      }
      const [arg, extra] = n.args;
      if (arg === undefined || extra !== undefined) throw new ExprError(`${n.fn}() 需要一个参数`, n.pos);
      if (n.fn === 'has') {
        const name = ev(arg);
        if (typeof name !== 'string') throw new ExprError('has() 的参数应该是字符串', n.pos);
        return lookup(name) !== undefined;
      }
      // len(值)：文字的字数、列表的项数、对象的字段数
      const v = ev(arg);
      if (typeof v === 'string') return [...v].length;
      if (Array.isArray(v)) return v.length;
      if (typeof v === 'object') return Object.keys(v).length;
      throw new ExprError(`len() 不能用于${typeName(v)}`, n.pos);
    }
    case 'un': {
      const x = ev(n.x);
      if (n.op === '!') return !truthy(x);
      if (typeof x !== 'number') throw new ExprError(`不能对${typeName(x)}取负`, n.pos);
      return -x;
    }
    case 'bin': {
      if (n.op === '&&') return truthy(ev(n.l)) && truthy(ev(n.r));
      if (n.op === '||') return truthy(ev(n.l)) || truthy(ev(n.r));
      const l = ev(n.l);
      const r = ev(n.r);
      switch (n.op) {
        case '==':
        case '===':
          return valuesEqual(l, r);
        case '!=':
        case '!==':
          return !valuesEqual(l, r);
        case '+':
          if (typeof l === 'string' && typeof r === 'string') return l + r;
          break;
        case '<':
        case '<=':
        case '>':
        case '>=':
          if (typeof l !== typeof r || (typeof l !== 'number' && typeof l !== 'string')) {
            throw new ExprError(`不能比较${typeName(l)}和${typeName(r)}`, n.pos);
          }
          return n.op === '<' ? l < r : n.op === '<=' ? l <= r : n.op === '>' ? l > r : l >= r;
      }
      if (typeof l !== 'number' || typeof r !== 'number') {
        throw new ExprError(`${typeName(l)} ${n.op} ${typeName(r)} 无法计算`, n.pos);
      }
      switch (n.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return l / r;
        case '%': return l % r;
      }
      throw new ExprError(`未知运算符 ${n.op}`, n.pos);
    }
  }
}

const cache = new Map<string, Node>();

function parsed(src: string): Node {
  let ast = cache.get(src);
  if (ast === undefined) {
    ast = parseExpr(src);
    if (cache.size > 2000) cache.clear();
    cache.set(src, ast);
  }
  return ast;
}

/** 解析并求值，结果按真值判断。语法错误和运行错误都抛 ExprError。 */
export function evalCondition(src: string, lookup: VarLookup, ctx: ExprContext = {}): boolean {
  return truthy(evalNode(parsed(src), lookup, ctx));
}

/** 解析并求值，返回值本身（变量的算式赋值用）。 */
export function evalExpr(src: string, lookup: VarLookup, ctx: ExprContext = {}): Value {
  const v = evalNode(parsed(src), lookup, ctx);
  if (typeof v === 'number' && !Number.isFinite(v)) throw new ExprError('结果不是有限的数字（例如除以 0）', 0);
  return v;
}

/** 表达式里的 similar() 调用（参数都是直接写的值时）。语法错误时返回空，由组装时报出来。 */
export function similarCalls(src: string): SimilarCall[] {
  let root: Node;
  try {
    root = parsed(src);
  } catch {
    return [];
  }
  const out: SimilarCall[] = [];
  const walk = (n: Node): void => {
    if (n.t === 'call') {
      if (n.fn === 'similar' && n.args.every((a) => a.t === 'lit')) {
        try {
          out.push(parseSimilarArgs(n.args.map((a) => (a as { v: Value }).v)));
        } catch {
          // 参数写错：组装时报
        }
      }
      n.args.forEach(walk);
    } else if (n.t === 'un') walk(n.x);
    else if (n.t === 'bin') {
      walk(n.l);
      walk(n.r);
    }
  };
  walk(root);
  return out;
}
