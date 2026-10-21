// 消息显示前的处理：执行“作用于显示”的运行时正则，再切出 ```html 组件块。

import { runScripts, type RegexScript, type ScriptRole } from '../../src/core/scripts.ts';
import type { Role } from '../../src/core/types.ts';

export type Segment = { kind: 'text'; text: string } | { kind: 'html'; html: string };

/**
 * 显示用正文。正则出错时显示原文并给出原因，不影响阅读。
 * isLatest：这条消息是否是某些角色里最新的一条（“只作用于最新一条”的正则用）。
 */
export function displayText(
  content: string,
  role: Role,
  scripts: readonly RegexScript[],
  isLatest: (roles: readonly ScriptRole[]) => boolean,
): { text: string; error: string | null } {
  try {
    return { text: runScripts(content, role, scripts, { stage: 'runtime', target: 'display', isLatest }), error: null };
  } catch (e) {
    return { text: content, error: (e as Error).message };
  }
}

const FENCE = /```html[ \t]*\n([\s\S]*?)\n?```/g;

/** 切出 ```html … ``` 代码块，作为组件渲染。 */
export function splitSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    const before = text.slice(last, m.index).trim();
    if (before) out.push({ kind: 'text', text: before });
    out.push({ kind: 'html', html: m[1]! });
    last = m.index + m[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest || out.length === 0) out.push({ kind: 'text', text: rest });
  return out;
}
