// 宏转换器：把酒馆的宏换成我们的占位符、函数写法或编辑块。
//
//   <USER> <BOT> <CHAR>、{{user}} {{char}}       → {{user}} {{char}}
//   {{time}} {{date}} {{weekday}}                → {{$time}} {{$date}} {{$weekday}}
//   {{isotime}} {{isodate}}                       → {{$time}} {{$date}}
//   {{lastMessage}} {{lastUserMessage}} {{lastCharMessage}} → {{$lastMessage}} …
//   {{newline}}                                   → 换行
//   {{// 注释}} {{trim}} {{noop}}                  → 删除
//   {{getvar::名}} {{getglobalvar::名}}           → {{get("名")}}（变量不存在时是空文字，和酒馆一样）
//   {{random::a::b}} {{random:a,b}}               → {{random("a", "b")}}（每次请求重新抽）
//   {{pick::a::b}}                                → {{pick("a", "b")}}（同一会话里固定）
//   {{roll:1d20}} {{roll::2d6+1}}                 → {{roll("1d20")}}
//   {{setvar::名::值}} {{addvar::名::值}} {{incvar::名}} {{decvar::名}}（以及 global 版本）
//                                                 → 编辑块 <var>名 = 值</var> 等，只在开场白和返回时正则里；
//                                                   addvar / incvar / decvar 写成“存在就累加，不存在就赋值”的分支（和酒馆一致）；
//                                                   词条里不能改变量（只有聊天记录能改），所在词条停用
//
// 各处能用的不一样（where）：
//   entry    词条：读变量、随机都可以；改变量不行
//   greeting 开场白：都可以（新会话时求值一次，改变量的宏变成开场白那一层的变量操作）
//   request  运行时 · 作用于请求的正则：读变量、随机都可以（发送前对正文求值）；改变量不行
//   receive  返回时正则：只有改变量的宏（变成编辑块）；读变量、随机不行（结果会存进正文，我们不在那时求值）
//   display  运行时 · 只作用于显示的正则：只有简单替换，读变量、随机、改变量都不行（显示时不求值，请用组件）

export type MacroWhere = 'entry' | 'greeting' | 'request' | 'receive' | 'display';

const SIMPLE: Record<string, string> = {
  user: '{{user}}',
  char: '{{char}}',
  time: '{{$time}}',
  date: '{{$date}}',
  weekday: '{{$weekday}}',
  isotime: '{{$time}}',
  isodate: '{{$date}}',
  newline: '\n',
  trim: '',
  noop: '',
};

const LAST: Record<string, string> = {
  lastmessage: '{{$lastMessage}}',
  lastusermessage: '{{$lastUserMessage}}',
  lastcharmessage: '{{$lastCharMessage}}',
};

const READ = new Set(['getvar', 'getglobalvar']);
const WRITE = new Set(['setvar', 'addvar', 'incvar', 'decvar', 'setglobalvar', 'addglobalvar', 'incglobalvar', 'decglobalvar']);
const RANDOM = new Set(['random', 'pick', 'roll']);

const VAR_NAME = /^[\p{L}_][\p{L}\p{N}_.]*$/u;

export interface MacroResult {
  text: string;
  /** 不支持的宏的名字（去重，按出现顺序）。 */
  unsupported: string[];
  /** 这里不能用的改变量的宏（词条、运行时正则里）。 */
  writes: string[];
  /** 这里不能用的读变量 / 随机的宏（返回时、显示用的正则里）。 */
  dynamic: string[];
  /** 用到了酒馆的全局变量（当作会话变量处理）。 */
  globals: boolean;
  /** 转成了编辑块。 */
  editBlocks: number;
}

const q = (s: string) => JSON.stringify(s);

/** 酒馆的宏参数：name::a::b 或旧写法 name:a,b（random、pick），roll 还可以写成 roll 1d20。 */
function argsOf(body: string, name: string): string[] | null {
  const rest = body.slice(name.length);
  if (rest.startsWith('::')) return rest.slice(2).split('::');
  if (rest.startsWith(':')) {
    const r = rest.slice(1);
    return name === 'roll' ? [r] : r.split(',');
  }
  if (name === 'roll' && /^\s+\S/.test(rest)) return [rest.trim()];
  return rest.trim() === '' ? [] : null;
}

/** 编辑块里的值：数字照写；只是捕获组引用（$1）时不加引号，替换后就是数字；其他加引号。 */
function valueLiteral(raw: string, where: MacroWhere): string {
  const v = raw.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return v;
  if (where === 'receive' && /^-?\$\d+$/.test(v)) return v;
  return q(raw);
}

export function convertMacros(text: string, where: MacroWhere = 'entry'): MacroResult {
  const r: MacroResult = { text: '', unsupported: [], writes: [], dynamic: [], globals: false, editBlocks: 0 };
  const note = (list: string[], name: string) => {
    if (!list.includes(name)) list.push(name);
  };
  let out = text.replace(/<(USER|BOT|CHAR)>/gi, (_m, w: string) => (w.toLowerCase() === 'user' ? '{{user}}' : '{{char}}'));
  out = out.replace(/\{\{([\s\S]*?)\}\}/g, (whole, inner: string) => {
    const body = inner.trim();
    if (body.startsWith('//')) return '';
    // 我们自己的写法（保留名、函数写法）不动
    if (/^\$[A-Za-z]+$/.test(body) || /^[A-Za-z_]\w*\s*\(/.test(body)) return whole;
    const lower = body.toLowerCase();
    if (Object.hasOwn(SIMPLE, lower)) return SIMPLE[lower]!;
    const name = (/^[^:\s(]+/.exec(body)?.[0] ?? body).toLowerCase();
    const unsupported = () => {
      note(r.unsupported, name);
      return whole;
    };
    if (body.includes('{{')) return unsupported(); // 嵌套的宏
    const live = where === 'entry' || where === 'greeting' || where === 'request';

    if (Object.hasOwn(LAST, lower)) {
      if (!live) return note(r.dynamic, name), whole;
      return LAST[lower]!;
    }

    if (READ.has(name)) {
      const args = argsOf(body, name);
      if (!args || args.length !== 1 || !args[0]!.trim()) return unsupported();
      if (!live) return note(r.dynamic, name), whole;
      if (name.includes('global')) r.globals = true;
      return `{{get(${q(args[0]!.trim())})}}`;
    }

    if (RANDOM.has(name)) {
      const args = argsOf(body, name);
      if (!args || args.length === 0) return unsupported();
      if (!live) return note(r.dynamic, name), whole;
      if (name === 'roll') return args.length === 1 ? `{{roll(${q(args[0]!.trim())})}}` : unsupported();
      return `{{${name}(${args.map(q).join(', ')})}}`;
    }

    if (WRITE.has(name)) {
      const args = argsOf(body, name);
      if (!args || args.length === 0) return unsupported();
      const [rawName, ...rest] = args;
      const varName = rawName!.trim();
      if (!VAR_NAME.test(varName)) return unsupported();
      const value = rest.join('::');
      const base = name.replace('global', '');
      let line: string;
      // 酒馆对不存在的变量 addvar / incvar / decvar 时从空值算起；我们对不存在的变量 += 不生效，
      // 所以写成分支：存在时累加，不存在时直接赋值
      const orInit = (op: string, init: string) => `if has(${q(varName)})\n${varName} ${op}\nelse\n${varName} = ${init}\nend`;
      if (base === 'setvar') {
        if (rest.length === 0) return unsupported();
        line = `${varName} = ${valueLiteral(value, where)}`;
      } else if (base === 'addvar') {
        if (rest.length === 0) return unsupported();
        const v = valueLiteral(value, where);
        line = orInit(`+= ${v}`, v);
      } else {
        if (rest.length !== 0) return unsupported();
        line = orInit(base === 'incvar' ? '+= 1' : '-= 1', base === 'incvar' ? '1' : '-1');
      }
      if (where !== 'greeting' && where !== 'receive') return note(r.writes, name), whole;
      if (name.includes('global')) r.globals = true;
      r.editBlocks++;
      return `<var>\n${line}\n</var>`;
    }

    return unsupported();
  });
  r.text = out;
  return r;
}

/** 词条停用的原因（没有问题时为空）。 */
export function macroReasons(m: MacroResult, where: MacroWhere): string[] {
  const list = (names: readonly string[]) => names.map((n) => `{{${n}}}`).join('、');
  const out: string[] = [];
  if (m.unsupported.length) out.push(`用了酒馆的宏 ${list(m.unsupported)}，我们没有对应的写法，修改后再启用`);
  if (m.writes.length) {
    out.push(
      where === 'entry'
        ? `用了改变量的宏 ${list(m.writes)}：我们这里只有聊天记录能改变量，词条只能读。如果是用来设初始值，请写进角色卡的初始变量`
        : `用了改变量的宏 ${list(m.writes)}：只有返回时正则能改变量`,
    );
  }
  if (m.dynamic.length) {
    out.push(
      where === 'display'
        ? `显示用的正则里用了 ${list(m.dynamic)}：显示时不读变量、不抽随机数，请改用 HTML 组件`
        : `返回时正则里用了 ${list(m.dynamic)}：结果会存进正文，我们不在那时读变量或抽随机数`,
    );
  }
  return out;
}

/** 宏转换的说明写进导入报告（同样的说明只写一次）。 */
export function noteMacros(notes: string[], m: MacroResult, where: MacroWhere): void {
  const add = (t: string) => {
    if (!notes.includes(t)) notes.push(t);
  };
  if (m.globals) add('酒馆的全局变量（getglobalvar、setglobalvar 等）当作会话变量处理，不再跨聊天共享');
  if (m.editBlocks && where === 'greeting') add('开场白里改变量的宏（setvar 等）转成了编辑块：新会话开始时，成为第一条消息上的变量操作');
  if (m.editBlocks && where === 'receive') add('返回时正则里改变量的宏（setvar 等）转成了编辑块：回复收下时变成那一层的变量操作');
  if (/\{\{(?:random|roll)\(/.test(m.text) && where !== 'greeting') add('random、roll 每次请求重新抽（和酒馆一样）；放在正文前会让缓存失效');
}

/** 兼容旧调用：只有不支持的宏。 */
export const macroReason = (names: readonly string[]): string => macroReasons({ text: '', unsupported: [...names], writes: [], dynamic: [], globals: false, editBlocks: 0 }, 'entry')[0]!;
