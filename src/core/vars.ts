// 局部变量：操作只挂在楼层（消息候选）上，状态由重放得到，从不单独存储。
//
// 值：数字、文字、true/false、列表 [..]、对象 {..}。变量名可以用 . 取到对象的字段或列表的第几项：
//   商品.灵泉水.价格、背包.0
// 操作只有三种：
//   =   赋值（路径上缺的对象自动建立）。已有值时类型要一致。
//   +=  数字相加、文字拼接、列表末尾追加一项、对象合并字段。
//   -=  数字相减、列表删掉第一项相等的、对象删掉某个字段（值写字段名）。
// 编辑块写法（也用于初始变量和手动编辑），列表和对象可以跨行：
//   <var>
//   hp -= 5
//   location = "酒馆"
//   商品.灵泉水 = { 价格: 30, 货币: "金币", 库存: 5 }
//   </var>
//
// 原则上也支持算式和分支，但不推荐（容易出错）。它们按聊天记录重放时才求值，所以只能用在聊天里，
// 初始变量只能写固定的值：
//   hp -= 伤害 * 2              值不是固定的值时按算式求值（和 IF 同一套语法）
//   if hp <= 0                   条件在执行到这里时求值一次，选中的那一支依次执行
//     状态 = "倒下"
//   elif hp < 30
//     状态 = "重伤"
//   else
//     状态 = "正常"
//   end

import { evalCondition, evalExpr, ExprError, parseExpr } from './expr.ts';
import type { VarValue } from './types.ts';

export type VarOpKind = '+=' | '-=' | '=';
export type VarSource = 'block' | 'widget' | 'manual' | 'tool';

/** 赋值类操作。expr 有值时按算式求值（value 不用）。 */
export interface AssignOp {
  name: string;
  op: VarOpKind;
  value: VarValue;
  expr?: string;
  source: VarSource;
}

/** 分支：按顺序找第一个条件成立的分支（cond 为 null 的是 else），执行它里面的操作。 */
export interface BranchOp {
  op: 'if';
  branches: { cond: string | null; ops: VarOp[] }[];
  source: VarSource;
}

export type VarOp = AssignOp | BranchOp;

export const isBranch = (o: VarOp): o is BranchOp => o.op === 'if';

/** 分支最多嵌套几层。 */
const MAX_NESTING = 8;

export type VarState = Record<string, VarValue>;

const SEGMENT = /^(?:[\p{L}_][\p{L}\p{N}_]*|\d+)$/u;
const TOP = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const INDEX = /^\d+$/;
/** 单个值（JSON 形式）的长度上限，防止一次写进巨大的数据。 */
const MAX_VALUE_CHARS = 20000;

/** char、user 和以 $ 开头的是系统保留名，只能读不能写。 */
export function isReservedName(name: string): boolean {
  const top = name.split('.')[0]!;
  return top === 'char' || top === 'user' || top.startsWith('$');
}

/** 变量名（路径）不合法时返回原因。 */
function checkName(name: string): string | null {
  if (isReservedName(name)) return `${name} 是系统保留名，不能修改`;
  const parts = name.split('.');
  if (!TOP.test(parts[0]!) || !parts.every((p) => SEGMENT.test(p))) return `变量名不合法：${name}`;
  return null;
}

// ---------- 值 ----------

export type ValueKind = 'number' | 'string' | 'boolean' | 'list' | 'object';

export function kindOf(v: VarValue): ValueKind {
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'object') return 'object';
  return typeof v as 'number' | 'string' | 'boolean';
}

export const KIND_NAME: Record<ValueKind, string> = { number: '数字', string: '文字', boolean: '真假值', list: '列表', object: '对象' };

export function valuesEqual(a: VarValue, b: VarValue): boolean {
  if (a === b) return true;
  const ka = kindOf(a);
  if (ka !== kindOf(b)) return false;
  if (ka === 'list') {
    const x = a as VarValue[];
    const y = b as VarValue[];
    return x.length === y.length && x.every((v, i) => valuesEqual(v, y[i]!));
  }
  if (ka === 'object') {
    const x = a as Record<string, VarValue>;
    const y = b as Record<string, VarValue>;
    const kx = Object.keys(x);
    return kx.length === Object.keys(y).length && kx.every((k) => Object.hasOwn(y, k) && valuesEqual(x[k]!, y[k]!));
  }
  return false;
}

/** 显示和占位符用：文字不加引号，列表和对象用 JSON。 */
export function formatValue(v: VarValue, pretty = false): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v, null, pretty ? 2 : undefined);
}

/** 写回编辑块用：文字加引号。 */
export function literal(v: VarValue): string {
  return typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
}

/** 按路径读取；不存在返回 undefined。 */
export function getPath(state: Readonly<Record<string, VarValue>>, name: string): VarValue | undefined {
  // 整个名字本身就是一个键（例如保留名 $date）时直接取
  if (Object.hasOwn(state, name)) return state[name];
  const parts = name.split('.');
  let cur: VarValue | undefined = Object.hasOwn(state, parts[0]!) ? state[parts[0]!] : undefined;
  for (const part of parts.slice(1)) {
    if (cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = INDEX.test(part) ? cur[Number(part)] : undefined;
    else if (typeof cur === 'object') cur = Object.hasOwn(cur, part) ? cur[part] : undefined;
    else return undefined;
  }
  return cur;
}

/** 客户端传来的值是否是合法的变量值（不允许 null、非有限数字）。 */
function isVarValue(v: unknown, depth = 0): v is VarValue {
  if (depth > 32) return false;
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isVarValue(x, depth + 1));
  if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.entries(v).every(([k, x]) => SEGMENT.test(k) && isVarValue(x, depth + 1));
  }
  return false;
}

// ---------- 解析 ----------

export interface LineError {
  /** 编辑块内的行号（从 1 开始）。 */
  line: number;
  text: string;
  message: string;
}

class ValueError extends Error {}

/**
 * 从 text[at] 开始读一个值：数字、"文字" / '文字'、true/false、[..]、{..}。
 * 列表和对象可以跨行，字段名可以不加引号，允许末尾多一个逗号和 // 注释。
 */
function readValue(text: string, at: number): { value: VarValue; end: number } {
  let i = at;
  const fail = (msg: string): never => {
    throw new ValueError(msg);
  };
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (!text.startsWith('//', i)) return;
      while (i < text.length && text[i] !== '\n') i++;
    }
  };
  const str = (): string => {
    const q = text[i]!;
    i++;
    let out = '';
    for (;;) {
      const c = text[i];
      if (c === undefined || c === '\n') return fail('文字没有结束（引号不配对）');
      i++;
      if (c === q) return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = text[i++];
      if (e === undefined) return fail('文字没有结束（引号不配对）');
      out += e === 'n' ? '\n' : e === 't' ? '\t' : e;
    }
  };
  const value = (depth: number): VarValue => {
    if (depth > 32) fail('嵌套太深');
    skip();
    const c = text[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++;
      const arr: VarValue[] = [];
      for (;;) {
        skip();
        if (text[i] === ']') {
          i++;
          return arr;
        }
        if (i >= text.length) fail('列表缺少右方括号 ]');
        arr.push(value(depth + 1));
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== ']') fail('列表的两项之间缺少逗号 ,');
      }
    }
    if (c === '{') {
      i++;
      const obj: Record<string, VarValue> = {};
      for (;;) {
        skip();
        if (text[i] === '}') {
          i++;
          return obj;
        }
        if (i >= text.length) fail('对象缺少右花括号 }');
        let key: string;
        if (text[i] === '"' || text[i] === "'") {
          key = str();
        } else {
          const m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(text.slice(i));
          if (!m) return fail('这里应该是字段名');
          key = m[0];
          i += key.length;
        }
        if (!SEGMENT.test(key)) fail(`字段名不合法：${key}`);
        if (Object.hasOwn(obj, key)) fail(`字段 ${key} 重复`);
        skip();
        if (text[i] !== ':') fail(`字段 ${key} 后面缺少冒号 :`);
        i++;
        obj[key] = value(depth + 1);
        skip();
        if (text[i] === ',') i++;
        else if (text[i] !== '}') fail('对象的两个字段之间缺少逗号 ,');
      }
    }
    const m = /^(?:-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?|true|false)(?![\p{L}\p{N}_])/u.exec(text.slice(i));
    if (!m) return fail('值不合法（数字直接写，文字要加引号，也可以是 true/false、[列表]、{对象}）');
    i += m[0].length;
    return m[0] === 'true' ? true : m[0] === 'false' ? false : Number(m[0]);
  };
  const v = value(0);
  return { value: v, end: i };
}

const HEAD = /^([^\s+\-=]+)[ \t]*(\+=|-=|=)[ \t]*/u;
const IF_LINE = /^(if|elif|else\s+if)\s+(.+)$/u;

/** 去掉行尾的 // 注释（引号里的不算）。 */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let k = 0; k < line.length; k++) {
    const c = line[k]!;
    if (quote) {
      if (c === '\\') k++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '/' && line[k + 1] === '/') {
      return line.slice(0, k);
    }
  }
  return line;
}

/** 检查算式写法；错误时返回原因。 */
function exprError(src: string): string | null {
  try {
    parseExpr(src);
    return null;
  } catch (e) {
    if (e instanceof ExprError) return e.message;
    throw e;
  }
}

/**
 * 解析若干行操作。空行和 // 注释忽略；不合格式的行记错误，不生效。lines[i] 是 ops[i]（顶层）所在行号。
 * 列表和对象的值可以跨多行；if / elif / else / end 组成分支，可以嵌套。
 */
export function parseOpLines(text: string, source: VarSource): { ops: VarOp[]; lines: number[]; errors: LineError[] } {
  const ops: VarOp[] = [];
  const lines: number[] = [];
  const errors: LineError[] = [];
  const starts = [0];
  for (let k = 0; k < text.length; k++) if (text[k] === '\n') starts.push(k + 1);
  const lineOf = (at: number) => {
    let n = 0;
    while (n + 1 < starts.length && starts[n + 1]! <= at) n++;
    return n;
  };
  const lineText = (n: number) => text.slice(starts[n], n + 1 < starts.length ? starts[n + 1]! - 1 : text.length).trim();
  const lineEnd = (at: number) => {
    const n = lineOf(at);
    return n + 1 < starts.length ? starts[n + 1]! - 1 : text.length;
  };

  // 打开着的分支：操作写进最内层分支的最后一支
  const open: { op: BranchOp; line: number }[] = [];
  const push = (o: VarOp, line: number) => {
    const top = open.at(-1);
    if (top) top.op.branches.at(-1)!.ops.push(o);
    else {
      ops.push(o);
      lines.push(line);
    }
  };

  let i = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) break;
    const ln = lineOf(i);
    const end = lineEnd(i);
    if (text.startsWith('//', i)) {
      i = end;
      continue;
    }
    const err = (message: string, resume: number) => {
      errors.push({ line: ln + 1, text: lineText(ln), message });
      i = Math.max(resume, end);
    };
    const whole = stripComment(text.slice(i, end)).trim();

    // ---------- 分支 ----------
    const ifm = IF_LINE.exec(whole);
    if (ifm || whole === 'else' || whole === 'end') {
      i = end;
      if (ifm && ifm[1] === 'if') {
        const bad = exprError(ifm[2]!);
        if (bad) {
          err(`条件写错了：${bad}`, end);
          // 照样打开，免得后面的 else / end 对不上；这个分支整体不生效
        }
        if (open.length >= MAX_NESTING) {
          err(`分支最多嵌套 ${MAX_NESTING} 层`, end);
          continue;
        }
        const op: BranchOp = { op: 'if', branches: [{ cond: ifm[2]!.trim(), ops: [] }], source };
        open.push({ op, line: ln + 1 });
        if (bad) (op as BranchOp & { broken?: true }).broken = true;
        continue;
      }
      const top = open.at(-1);
      if (!top) {
        err(`${whole.split(/\s/)[0]} 前面没有对应的 if`, end);
        continue;
      }
      if (ifm) {
        if (top.op.branches.at(-1)!.cond === null) {
          err('else 后面不能再有 elif', end);
          continue;
        }
        const bad = exprError(ifm[2]!);
        if (bad) {
          err(`条件写错了：${bad}`, end);
          (top.op as BranchOp & { broken?: true }).broken = true;
        }
        top.op.branches.push({ cond: ifm[2]!.trim(), ops: [] });
        continue;
      }
      if (whole === 'else') {
        if (top.op.branches.at(-1)!.cond === null) {
          err('一个 if 只能有一个 else', end);
          continue;
        }
        top.op.branches.push({ cond: null, ops: [] });
        continue;
      }
      // end
      open.pop();
      const broken = (top.op as BranchOp & { broken?: true }).broken;
      delete (top.op as BranchOp & { broken?: true }).broken;
      if (!broken) push(top.op, top.line);
      continue;
    }

    // ---------- 赋值 ----------
    const m = HEAD.exec(text.slice(i, end));
    if (!m) {
      err('格式应为 名称 = 值、名称 += 值 或 名称 -= 值（也可以是 if / elif / else / end）', i);
      continue;
    }
    const [head, name, op] = m as unknown as [string, string, VarOpKind];
    let read: { value: VarValue; end: number } | null = null;
    let literalError: string | null = null;
    try {
      read = readValue(text, i + head.length);
      // 值后面只能有空白或注释
      let j = read.end;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r')) j++;
      if (text.startsWith('//', j)) j = lineEnd(j);
      if (j < text.length && text[j] !== '\n') {
        literalError = '值后面有多余的内容';
        read = null;
      } else {
        read = { value: read.value, end: j };
      }
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      literalError = e.message;
    }

    let next: VarOp;
    if (read) {
      i = read.end;
      next = { name, op, value: read.value, source };
    } else {
      // 不是固定的值：按算式（只看这一行）
      const src = stripComment(text.slice(i + head.length, end)).trim();
      const bad = src === '' ? '缺少值' : exprError(src);
      if (bad) {
        err(src === '' ? '缺少值' : `${literalError}；当作算式也不对：${bad}`, end);
        continue;
      }
      i = end;
      next = { name, op, value: '', expr: src, source };
    }
    const bad = checkName(name) ?? (!next.expr && literal(next.value).length > MAX_VALUE_CHARS ? '值太长' : null);
    if (bad) {
      errors.push({ line: ln + 1, text: lineText(ln), message: bad });
      continue;
    }
    push(next, ln + 1);
  }
  for (const o of open) errors.push({ line: o.line, text: lineText(o.line - 1), message: 'if 没有对应的 end，整个分支不生效' });
  return { ops, lines, errors };
}

/** 把操作写回文本（编辑用）。 */
export function formatOps(ops: readonly VarOp[], indent = ''): string {
  const out: string[] = [];
  for (const o of ops) {
    if (isBranch(o)) {
      o.branches.forEach((b, k) => {
        out.push(`${indent}${k === 0 ? 'if' : b.cond === null ? 'else' : 'elif'}${b.cond === null ? '' : ` ${b.cond}`}`);
        if (b.ops.length) out.push(formatOps(b.ops, `${indent}  `));
      });
      out.push(`${indent}end`);
    } else {
      out.push(`${indent}${o.name} ${o.op} ${o.expr ?? literal(o.value)}`);
    }
  }
  return out.join('\n');
}

const BLOCK = /<var>([\s\S]*?)<\/var>/g;
const MARK = '\u0000';

/**
 * 从正文里取出所有完整的编辑块：合法操作返回，编辑块从正文中删除。
 * 编辑块单独占的行整行删掉，嵌在句中的只删编辑块本身，段落不会被并到一起。
 * 没闭合的编辑块（例如回复被截断）留在正文里，不生效。
 */
export function extractVarBlocks(text: string): { text: string; ops: VarOp[]; errors: LineError[] } {
  const ops: VarOp[] = [];
  const errors: LineError[] = [];
  const marked = text.replace(BLOCK, (_all, body: string) => {
    const r = parseOpLines(body, 'block');
    ops.push(...r.ops);
    errors.push(...r.errors);
    return MARK;
  });
  if (ops.length === 0 && errors.length === 0 && !marked.includes(MARK)) return { text, ops, errors };
  // 删掉只有编辑块的行；它两侧都是空行时再删掉一个空行，段落间距保持原样。
  const kept: string[] = [];
  const lines = marked.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const onlyBlock = line.includes(MARK) && line.replaceAll(MARK, '').trim() === '';
    if (!onlyBlock) {
      kept.push(line);
      continue;
    }
    if (kept.length > 0 && kept.at(-1)!.trim() === '' && (lines[i + 1] ?? '').trim() === '') i++;
  }
  const stripped = kept.join('\n').replaceAll(MARK, '');
  return { text: stripped.trimEnd(), ops, errors };
}

/** 初始变量只允许 =；可以用路径给对象的字段赋值。 */
export function parseInitialVars(text: string): { state: VarState; errors: LineError[] } {
  const { ops, lines, errors } = parseOpLines(text, 'manual');
  const state: VarState = {};
  ops.forEach((o, i) => {
    const bad = isBranch(o) || o.expr !== undefined
      ? '初始变量只能写固定的值（算式和 if 要等聊天记录载入后才能求值，只能用在聊天里）'
      : o.op === '=' ? applyVarOp(state, o) : '初始变量只能用 = 赋值';
    if (bad) errors.push({ line: lines[i]!, text: formatOps([o]).split('\n')[0]!, message: bad });
  });
  errors.sort((a, b) => a.line - b.line);
  return { state, errors };
}

// ---------- 执行与重放 ----------

export interface OpWarning {
  messageId: string;
  /** 该楼层操作列表中的下标。 */
  index: number;
  message: string;
}

/**
 * 执行一条操作；不合法时返回原因且不修改状态（分支里已经执行的操作保留）。
 * 只替换顶层的键，嵌套的值沿路径复制后修改，旧状态（包括逐层快照）不受影响。
 * 算式和分支条件读的是执行到这里时的状态。
 */
export function applyVarOp(state: VarState, o: VarOp, depth = 0): string | null {
  const lookup = (n: string) => getPath(state, n);
  if (isBranch(o)) {
    if (depth >= MAX_NESTING) return `分支最多嵌套 ${MAX_NESTING} 层`;
    let chosen: VarOp[] | null = null;
    for (const b of o.branches) {
      if (b.cond === null) {
        chosen = b.ops;
        break;
      }
      try {
        if (evalCondition(b.cond, lookup)) {
          chosen = b.ops;
          break;
        }
      } catch (e) {
        if (e instanceof ExprError) return `分支条件 ${b.cond} 求值失败：${missingHint(e.message)}`;
        throw e;
      }
    }
    const problems = (chosen ?? []).map((x) => applyVarOp(state, x, depth + 1)).filter((x): x is string => x !== null);
    return problems.length ? problems.join('；') : null;
  }
  let target: AssignOp = o;
  if (o.expr !== undefined) {
    let value: VarValue;
    try {
      value = evalExpr(o.expr, lookup);
    } catch (e) {
      if (e instanceof ExprError) return `${o.name} ${o.op} ${o.expr}：${missingHint(e.message)}`;
      throw e;
    }
    target = { ...o, value };
  }
  const parts = target.name.split('.');
  const top = parts[0]!;
  const r = update(Object.hasOwn(state, top) ? state[top] : undefined, parts, 1, target);
  if (typeof r === 'string') return r;
  state[top] = r.value;
  return null;
}

/** 算式里读到不存在的变量时，多半是想写文字却忘了引号。 */
const missingHint = (message: string): string => (/变量 .+ 不存在/.test(message) ? `${message}（如果想写文字，要加引号）` : message);

type Updated = { value: VarValue } | string;

function update(cur: VarValue | undefined, parts: readonly string[], k: number, o: AssignOp): Updated {
  if (k === parts.length) return leaf(cur, o);
  const path = parts.slice(0, k).join('.');
  const key = parts[k]!;
  if (cur === undefined) {
    // 路径上缺的对象只有赋值时自动建立
    if (o.op !== '=') return `${o.name} 还不存在，不能 ${o.op}`;
    if (INDEX.test(key)) return `${path} 还不存在，不能按序号赋值`;
    const r = update(undefined, parts, k + 1, o);
    return typeof r === 'string' ? r : { value: { [key]: r.value } };
  }
  if (Array.isArray(cur)) {
    if (!INDEX.test(key)) return `${path} 是列表，要用序号取第几项（从 0 开始）`;
    const idx = Number(key);
    if (idx >= cur.length) return `${path} 只有 ${cur.length} 项，没有第 ${idx} 项`;
    const r = update(cur[idx], parts, k + 1, o);
    if (typeof r === 'string') return r;
    const next = cur.slice();
    next[idx] = r.value;
    return { value: next };
  }
  if (typeof cur === 'object') {
    const r = update(Object.hasOwn(cur, key) ? cur[key] : undefined, parts, k + 1, o);
    if (typeof r === 'string') return r;
    return { value: { ...cur, [key]: r.value } };
  }
  return `${path} 是${KIND_NAME[kindOf(cur)]}，没有字段 ${key}`;
}

function leaf(cur: VarValue | undefined, o: AssignOp): Updated {
  const v = o.value;
  if (o.op === '=') {
    if (cur !== undefined && kindOf(cur) !== kindOf(v)) return `${o.name} 是${KIND_NAME[kindOf(cur)]}，不能赋值为${KIND_NAME[kindOf(v)]}`;
    return { value: v };
  }
  if (cur === undefined) return `${o.name} 还不存在，不能 ${o.op}`;
  const kc = kindOf(cur);
  const kv = kindOf(v);
  if (o.op === '+=') {
    if (kc === 'number' && kv === 'number') return { value: (cur as number) + (v as number) };
    if (kc === 'string' && kv === 'string') return { value: (cur as string) + (v as string) };
    if (kc === 'list') return { value: [...(cur as VarValue[]), v] };
    if (kc === 'object' && kv === 'object') {
      const base = cur as Record<string, VarValue>;
      for (const [key, x] of Object.entries(v as Record<string, VarValue>)) {
        const old = base[key];
        if (old !== undefined && kindOf(old) !== kindOf(x)) return `${o.name}.${key} 是${KIND_NAME[kindOf(old)]}，不能合并为${KIND_NAME[kindOf(x)]}`;
      }
      return { value: { ...base, ...(v as Record<string, VarValue>) } };
    }
    return `${o.name} 是${KIND_NAME[kc]}，不能 += ${KIND_NAME[kv]}`;
  }
  // -=
  if (kc === 'number' && kv === 'number') return { value: (cur as number) - (v as number) };
  if (kc === 'list') {
    const list = cur as VarValue[];
    const idx = list.findIndex((x) => valuesEqual(x, v));
    if (idx < 0) return `${o.name} 里没有 ${literal(v)}`;
    return { value: [...list.slice(0, idx), ...list.slice(idx + 1)] };
  }
  if (kc === 'object' && kv === 'string') {
    const obj = cur as Record<string, VarValue>;
    const key = v as string;
    if (!Object.hasOwn(obj, key)) return `${o.name} 没有字段 ${key}`;
    const rest = { ...obj };
    delete rest[key];
    return { value: rest };
  }
  return `${o.name} 是${KIND_NAME[kc]}，不能 -= ${KIND_NAME[kv]}`;
}

export interface ReplayLayer {
  messageId: string;
  ops: readonly VarOp[];
}

export interface ReplayResult {
  final: VarState;
  /** 每层执行完之后的状态（按需计算，见 withStates）。 */
  states?: VarState[];
  warnings: OpWarning[];
}

/** 从初始值开始依次执行每一层的操作。不合法的操作跳过并记警告。 */
export function replay(initial: VarState, layers: readonly ReplayLayer[], withStates = false): ReplayResult {
  const state: VarState = { ...initial };
  const warnings: OpWarning[] = [];
  const states: VarState[] = [];
  for (const l of layers) {
    l.ops.forEach((o, index) => {
      const why = applyVarOp(state, o);
      if (why) warnings.push({ messageId: l.messageId, index, message: why });
    });
    if (withStates) states.push({ ...state });
  }
  return withStates ? { final: state, states, warnings } : { final: state, warnings };
}

const SOURCES: readonly VarSource[] = ['block', 'widget', 'manual', 'tool'];

/**
 * 校验来自客户端的操作（组件提交、手动编辑）。
 * keepSource：手动编辑整层操作时保留原有来源，没有或不合法时用 source。
 */
export function checkOps(v: unknown, source: VarSource, opts: { keepSource?: boolean } = {}): VarOp[] {
  if (!Array.isArray(v)) throw new Error('ops 应为数组');
  const one = (raw: unknown, where: string, depth: number): VarOp => {
    const o = (raw ?? {}) as { op?: unknown; name?: unknown; value?: unknown; expr?: unknown; branches?: unknown; source?: unknown };
    const keep = opts.keepSource && SOURCES.includes(o.source as VarSource) ? (o.source as VarSource) : source;
    if (o.op === 'if') {
      if (depth >= MAX_NESTING) throw new Error(`${where}：分支最多嵌套 ${MAX_NESTING} 层`);
      if (!Array.isArray(o.branches) || o.branches.length === 0 || o.branches.length > 50) throw new Error(`${where}：分支格式不对`);
      const all = o.branches as unknown[];
      const branches = all.map((b: unknown, k: number) => {
        const br = b as { cond?: unknown; ops?: unknown };
        const last = k === all.length - 1;
        if (br.cond !== null && typeof br.cond !== 'string') throw new Error(`${where}：分支条件应为文字或 null`);
        if (br.cond === null && !last) throw new Error(`${where}：else 只能是最后一支`);
        if (typeof br.cond === 'string') {
          const bad = exprError(br.cond);
          if (bad) throw new Error(`${where}：条件写错了：${bad}`);
        }
        if (!Array.isArray(br.ops)) throw new Error(`${where}：分支里的 ops 应为数组`);
        return { cond: br.cond as string | null, ops: br.ops.map((x: unknown, n: number) => one(x, `${where} 的第 ${n + 1} 条`, depth + 1)) };
      });
      return { op: 'if', branches, source: keep };
    }
    if (typeof o.name !== 'string') throw new Error(`${where}：缺少变量名`);
    const bad = checkName(o.name);
    if (bad) throw new Error(`${where}：${bad}`);
    if (o.op !== '+=' && o.op !== '-=' && o.op !== '=') throw new Error(`${where}：只能是 += -= = 或 if`);
    if (o.expr !== undefined) {
      if (typeof o.expr !== 'string' || o.expr.length > 2000) throw new Error(`${where}：算式应为文字`);
      const e = exprError(o.expr);
      if (e) throw new Error(`${where}：算式写错了：${e}`);
      return { name: o.name, op: o.op, value: '', expr: o.expr, source: keep };
    }
    const value: unknown = o.value;
    if (!isVarValue(value)) throw new Error(`${where}：值应为数字、文字、真假值、列表或对象`);
    if (JSON.stringify(value).length > MAX_VALUE_CHARS) throw new Error(`${where}：值太长`);
    return { name: o.name, op: o.op, value, source: keep };
  };
  return v.map((raw, i) => one(raw, `第 ${i + 1} 条操作`, 0));
}
