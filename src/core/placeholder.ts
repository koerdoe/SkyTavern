// 占位符：{{名称}}，名称规则与变量名相同（可以用 . 取字段）。
// 另有函数写法 {{random("a", "b")}}、{{roll("1d20")}}、{{get("hp", 0)}} 等：按 IF 的表达式求值，见 expr.ts。
// 与 IF 共用同一个变量查找：char、user、$time 等由调用方放进查找函数里。

import { evalExpr, ExprError, type ExprContext } from './expr.ts';
import type { VarLookup } from './types.ts';
import { formatValue } from './vars.ts';

const PLACEHOLDER = /\{\{\s*([\p{L}_$][\p{L}\p{N}_.$]*)\s*\}\}/gu;
/** 函数写法：{{函数名(…)}}。参数里不能有花括号。 */
const CALL = /\{\{\s*([A-Za-z_]\w*)\s*\(([^{}]*)\)\s*\}\}/g;

export class PlaceholderError extends Error {
  readonly placeholder: string;
  constructor(placeholder: string, message?: string) {
    super(message ?? `占位符 {{${placeholder}}} 对应的变量不存在`);
    this.name = 'PlaceholderError';
    this.placeholder = placeholder;
  }
}

/**
 * strict：变量不存在时报错（用于词条）。
 * 非 strict：原样保留（用于正文消息，避免用户随手打的 {{…}} 让生成失败）。
 */
export function renderPlaceholders(text: string, lookup: VarLookup, strict: boolean, calls?: ExprContext): string {
  if (!text.includes('{{')) return text;
  // 函数写法：给了求值环境才处理；非 strict 时求值失败原样保留
  const withCalls = !calls
    ? text
    : text.replace(CALL, (whole, fn: string, args: string) => {
        try {
          return formatValue(evalExpr(`${fn}(${args})`, lookup, calls));
        } catch (err) {
          if (!(err instanceof ExprError)) throw err;
          if (strict) throw new PlaceholderError(`${fn}(…)`, `占位符 ${whole} 求值失败：${err.message}`);
          return whole;
        }
      });
  return withCalls.replace(PLACEHOLDER, (whole, name: string) => {
    const v = lookup(name);
    // 列表和对象展开成紧凑的 JSON
    if (v !== undefined) return formatValue(v);
    if (strict) throw new PlaceholderError(name);
    return whole;
  });
}

export function hasPlaceholders(text: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(text);
}

/** 文字里用到的占位符名称。 */
export function placeholderNames(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** 文字里用到的函数写法占位符的函数名。 */
export function placeholderCalls(text: string): string[] {
  return [...text.matchAll(CALL)].map((m) => m[1]!);
}
