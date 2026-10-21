// 插入法：正则 + 替换模板。
// 不用 String.prototype.replace：它对不存在的捕获组静默当作字面量，这里要报错。

const INSERT_FLAGS = /^[imsu]*$/;
const SCRIPT_FLAGS = /^[gimsu]*$/;

export type TemplatePart = string | { group: number } | { name: string } | { whole: true };

export interface CompiledInsert {
  regex: RegExp;
  parts: TemplatePart[];
}

export class InsertConfigError extends Error {
  readonly kind: 'regex' | 'template';
  constructor(message: string, kind: 'regex' | 'template') {
    super(message);
    this.name = 'InsertConfigError';
    this.kind = kind;
  }
}

/**
 * 编译正则并检查模板。配置有问题直接抛错。
 * 插入法每次只替换一处，不允许 g；正则脚本（global）允许 g。
 */
export function compileInsert(pattern: string, flags: string, template: string, opts: { global?: boolean } = {}): CompiledInsert {
  const allowed = opts.global ? SCRIPT_FLAGS : INSERT_FLAGS;
  if (!allowed.test(flags) || new Set(flags).size !== flags.length) {
    throw new InsertConfigError(`正则标志只能是 ${opts.global ? 'g i m s u' : 'i m s u'} 且不重复：${flags}`, 'regex');
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (e) {
    throw new InsertConfigError(`正则无法编译：${(e as Error).message}`, 'regex');
  }
  // 用必然成功的空分支拿到捕获组数量和组名。
  const probe = new RegExp(`${pattern}|`, flags).exec('')!;
  const groupCount = probe.length - 1;
  const names = new Set(Object.keys(probe.groups ?? {}));
  return { regex, parts: parseTemplate(template, groupCount, names) };
}

/** 模板语法：$1…$99、$&、$<name>、$$。其他 `$` 按字面量。 */
function parseTemplate(template: string, groupCount: number, names: ReadonlySet<string>): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let lit = '';
  const flush = (): void => {
    if (lit) parts.push(lit);
    lit = '';
  };
  let i = 0;
  while (i < template.length) {
    const c = template[i]!;
    if (c !== '$') {
      lit += c;
      i++;
      continue;
    }
    const next = template[i + 1] ?? '';
    if (next === '$') {
      lit += '$';
      i += 2;
    } else if (next === '&') {
      flush();
      parts.push({ whole: true });
      i += 2;
    } else if (next === '<') {
      const end = template.indexOf('>', i + 2);
      if (end < 0) throw new InsertConfigError(`模板中的 $< 没有闭合`, 'template');
      const name = template.slice(i + 2, end);
      if (!names.has(name)) throw new InsertConfigError(`模板引用了不存在的命名组 $<${name}>`, 'template');
      flush();
      parts.push({ name });
      i = end + 1;
    } else if (/[0-9]/.test(next)) {
      // 两位数优先（该组存在时），否则一位数。
      const two = /^[0-9]{2}/.exec(template.slice(i + 1))?.[0];
      const digits = two !== undefined && Number(two) >= 1 && Number(two) <= groupCount ? two : next;
      const group = Number(digits);
      if (group < 1 || group > groupCount) {
        throw new InsertConfigError(`模板引用了不存在的捕获组 $${digits}（正则只有 ${groupCount} 组）`, 'template');
      }
      flush();
      parts.push({ group });
      i += 1 + digits.length;
    } else {
      lit += '$';
      i++;
    }
  }
  flush();
  return parts;
}

export function renderTemplate(parts: readonly TemplatePart[], m: RegExpExecArray): string {
  let out = '';
  for (const p of parts) {
    if (typeof p === 'string') out += p;
    else if ('whole' in p) out += m[0];
    else if ('group' in p) out += m[p.group] ?? '';
    else out += m.groups?.[p.name] ?? '';
  }
  return out;
}

/** 在一段文本中找第一处或最后一处匹配。 */
export function findMatch(regex: RegExp, text: string, pick: 'first' | 'last'): RegExpExecArray | null {
  const g = new RegExp(regex.source, `${regex.flags}g`);
  let found: RegExpExecArray | null = null;
  for (let m = g.exec(text); m !== null; m = g.exec(text)) {
    found = m;
    if (pick === 'first') break;
    if (m[0] === '') g.lastIndex++;
  }
  return found;
}
