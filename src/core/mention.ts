// 关键词触发：IF 里的 mentioned(...)，检查最近几条聊天记录里有没有提到某些词。
//
//   mentioned("艾琳")                 最近 2 条消息里出现“艾琳”
//   mentioned("艾琳", "Eileen")       任意一个出现即可
//   mentioned(6, "艾琳")              第一个参数是数字时，表示检查最近 6 条
//   mentioned("/艾琳|伊琳/i")          以 / 开头、/标志 结尾的按正则匹配
//
// 普通关键词不区分大小写；纯英文数字的关键词按整词匹配（“cat” 不会匹配 “category”），
// 其他（中文等）按子串匹配。

export const DEFAULT_MENTION_DEPTH = 2;

export type Mentioned = (depth: number, keys: readonly string[]) => boolean;

const REGEX_KEY = /^\/(.+)\/([gimsuy]*)$/s;
const WORD_KEY = /^[A-Za-z0-9_]+(?: [A-Za-z0-9_]+)*$/;

const cache = new Map<string, (text: string) => boolean>();

/** 关键词 → 判断函数。正则写错时抛错，由 IF 报出来。 */
export function keyMatcher(key: string): (text: string) => boolean {
  const hit = cache.get(key);
  if (hit) return hit;
  let fn: (text: string) => boolean;
  const re = REGEX_KEY.exec(key);
  if (re) {
    const regex = new RegExp(re[1]!, re[2]!.replace(/[gy]/g, ''));
    fn = (t) => regex.test(t);
  } else if (WORD_KEY.test(key)) {
    const regex = new RegExp(`(?<![A-Za-z0-9_])${key.replace(/ /g, '\\s+')}(?![A-Za-z0-9_])`, 'i');
    fn = (t) => regex.test(t);
  } else {
    const lower = key.toLowerCase();
    fn = (t) => lower !== '' && t.toLowerCase().includes(lower);
  }
  if (cache.size > 5000) cache.clear();
  cache.set(key, fn);
  return fn;
}

/** 由聊天记录（从旧到新）构造 mentioned 的实现。 */
export function mentionedIn(texts: readonly string[]): Mentioned {
  return (depth, keys) => {
    const recent = texts.slice(Math.max(0, texts.length - Math.max(0, Math.floor(depth))));
    if (recent.length === 0) return false;
    const matchers = keys.map(keyMatcher);
    return recent.some((t) => matchers.some((m) => m(t)));
  };
}
