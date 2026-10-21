// 正则脚本：挂在预设或角色卡上，由作者自己写。
//
//   返回时（receive）：消息进入会话时执行一次，结果就是存下来的正文；
//                       执行完再取出 <var> 编辑块，变成这一层的变量操作。
//   运行时（runtime）：每次显示或组装请求时执行，不改存储的正文。
//
// 作用于哪些消息（user / assistant）由每条脚本自己决定。
//
// 动作：
//   替换（replace）：正则查找，按模板替换。
//   插到开头 / 插到末尾（prepend / append）：把内容原样插进消息（和正文之间隔一个空行），
//       不做 $1 之类的替换，适合固定挂一段 HTML 组件。正则可以留空；写了就只在匹配到时插入。
// 运行时脚本可以设为“只作用于最新一条”：只处理它所作用的角色里最后一条消息。

import { compileInsert, InsertConfigError, renderTemplate, type CompiledInsert } from './insert.ts';
import type { Role } from './types.ts';
import { extractVarBlocks, type LineError, type VarOp } from './vars.ts';

export type ScriptStage = 'receive' | 'runtime';
export type RuntimeTarget = 'display' | 'request' | 'both';
export type ScriptRole = Exclude<Role, 'system'>;
export type ScriptAction = 'replace' | 'prepend' | 'append';

export interface RegexScript {
  /** `容器ID-s序号`。 */
  id: string;
  name: string;
  enabled: boolean;
  stage: ScriptStage;
  /** 仅运行时：作用于显示、请求或两者。 */
  target: RuntimeTarget;
  roles: ScriptRole[];
  action: ScriptAction;
  /** 仅运行时：只作用于所选角色里最新的一条消息。 */
  latestOnly: boolean;
  /** 替换时必填；插入时可以留空，写了就作为条件。 */
  pattern: string;
  /** g i m s u；带 g 时替换全部匹配，否则只替换第一处。 */
  flags: string;
  /** 替换时是模板：$1…$99、$&、$<名>、$$；插入时是原样插入的内容。 */
  replacement: string;
  /** 数字大的先执行。 */
  priority: number;
}

export class ScriptError extends Error {
  readonly scriptId: string;
  /** 不带脚本前缀的原始说明。 */
  readonly detail: string;
  constructor(scriptId: string, detail: string) {
    super(`[正则 ${scriptId}] ${detail}`);
    this.name = 'ScriptError';
    this.scriptId = scriptId;
    this.detail = detail;
  }
}

export function compileScript(s: RegexScript): CompiledInsert {
  try {
    // 插入的内容原样使用，模板只在替换时检查
    return compileInsert(s.pattern, s.flags, s.action === 'replace' ? s.replacement : '', { global: true });
  } catch (e) {
    if (e instanceof InsertConfigError) throw new ScriptError(s.id, e.message);
    throw e;
  }
}

/** 执行顺序：优先级降序，同优先级保持给定顺序（预设在前、角色卡在后）。 */
export function orderScripts(scripts: readonly RegexScript[]): RegexScript[] {
  return scripts
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.priority - a.s.priority || a.i - b.i)
    .map(({ s }) => s);
}

function replaceWith(c: CompiledInsert, text: string): string {
  let out = '';
  let last = 0;
  const re = c.regex;
  if (!re.global) {
    const m = re.exec(text);
    return m ? text.slice(0, m.index) + renderTemplate(c.parts, m) + text.slice(m.index + m[0].length) : text;
  }
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out += text.slice(last, m.index) + renderTemplate(c.parts, m);
    last = m.index + m[0].length;
    if (m[0] === '') re.lastIndex++;
  }
  return out + text.slice(last);
}

/**
 * isLatest：这条消息是否是给定角色里最新的一条，用于“只作用于最新一条”。
 * 不提供时（例如试运行）当作是最新的。
 */
export type ScriptFilter =
  | { stage: 'receive' }
  | { stage: 'runtime'; target: 'display' | 'request'; isLatest?: (roles: readonly ScriptRole[]) => boolean };

function matches(s: RegexScript, role: Role, f: ScriptFilter): boolean {
  if (!s.enabled || s.stage !== f.stage || role === 'system' || !s.roles.includes(role)) return false;
  if (f.stage === 'receive') return true;
  if (s.target !== 'both' && s.target !== f.target) return false;
  return !s.latestOnly || !f.isLatest || f.isLatest(s.roles);
}

function apply(s: RegexScript, text: string): string {
  const c = compileScript(s);
  if (s.action === 'replace') return replaceWith(c, text);
  if (s.pattern !== '') {
    c.regex.lastIndex = 0;
    if (!c.regex.test(text)) return text;
  }
  if (s.replacement === '') return text;
  if (text === '') return s.replacement;
  return s.action === 'append' ? `${text}\n\n${s.replacement}` : `${s.replacement}\n\n${text}`;
}

/** 依次执行符合条件的脚本。 */
export function runScripts(text: string, role: Role, scripts: readonly RegexScript[], f: ScriptFilter): string {
  let out = text;
  for (const s of orderScripts(scripts)) if (matches(s, role, f)) out = apply(s, out);
  return out;
}

/** 给一串消息算“是否是某些角色里最新的一条”。 */
export function latestChecker(roles: readonly Role[]): (index: number) => (scriptRoles: readonly ScriptRole[]) => boolean {
  return (index) => (scriptRoles) => {
    for (let j = roles.length - 1; j >= 0; j--) if ((scriptRoles as readonly Role[]).includes(roles[j]!)) return j === index;
    return false;
  };
}

export interface Received {
  text: string;
  ops: VarOp[];
  /** 编辑块里不合格式的行。 */
  errors: LineError[];
}

/** 消息进入会话：返回时正则 → 取出编辑块。 */
export function receiveMessage(text: string, role: Role, scripts: readonly RegexScript[]): Received {
  return extractVarBlocks(runScripts(text, role, scripts, { stage: 'receive' }));
}

/** 静态检查：正则能否编译、模板引用的组是否存在。 */
export function validateScript(s: RegexScript): void {
  if (s.action === 'replace' && s.pattern === '') throw new ScriptError(s.id, '替换需要填写正则');
  compileScript(s);
  if (s.roles.length === 0) throw new ScriptError(s.id, '至少要作用于 user 或 assistant 之一');
}
