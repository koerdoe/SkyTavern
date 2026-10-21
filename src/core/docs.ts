// 文档页面与测试共用的小工具：标题锚点和文档间链接。

/** GitHub 风格的标题锚点：小写，去掉标点，空白换成 -。 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

/** 同一篇里重名的标题依次加 -1、-2。 */
export function slugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = headingSlug(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

/** 文档里的相对链接 `x.md#frag` → 页面路径 `/docs/x#frag`；外部链接和纯锚点原样返回。 */
export function docHref(href: string): string {
  const m = /^(?:\.\/)?([A-Za-z0-9-]+)\.md(#.*)?$/.exec(href);
  if (!m) return href;
  return `${m[1] === 'README' ? '/docs' : `/docs/${m[1]}`}${m[2] ?? ''}`;
}

/** 从 Markdown 里取出标题文字（跳过代码块）。 */
export function headingsOf(md: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of md.split('\n')) {
    const f = /^(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1]!;
      else if (line.startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) out.push(h[1]!.replace(/`/g, ''));
  }
  return out;
}
