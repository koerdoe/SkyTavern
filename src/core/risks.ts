// 保存或首次读取时的粗略风险检查。只提示，不阻止。

import { compileInsert } from './insert.ts';
import { compareEntries } from './order.ts';
import { placeholderCalls, placeholderNames } from './placeholder.ts';

/** 会话内基本不变的占位符，放在正文前不算破坏缓存。 */
const STABLE_PLACEHOLDERS = new Set(['char', 'user']);
import type { Entry, InsertPlacement } from './types.ts';

export interface Risk {
  kind: 'cache-break' | 'recursive-insert';
  entryIds: string[];
  message: string;
}

export function checkRisks(entries: readonly Entry[]): Risk[] {
  const risks: Risk[] = [];
  const active = entries.filter((e) => e.enabled);

  for (const e of active) {
    const p = e.placement;
    if (p.kind === 'position' && (p.section === 'system' || p.section === 'before') && e.if?.trim()) {
      risks.push({
        kind: 'cache-break',
        entryIds: [e.id],
        message: '正文前的词条带 IF，条件变化时会使缓存失效',
      });
    }
    if (p.kind === 'position' && (p.section === 'system' || p.section === 'before')) {
      // 函数写法里只有 pick() 在同一会话里固定，其他（random、roll、get…）都可能变
      const dynamic = [
        ...placeholderNames(e.content).filter((n) => !STABLE_PLACEHOLDERS.has(n)),
        ...placeholderCalls(e.content)
          .filter((f) => f !== 'pick')
          .map((f) => `${f}(…)`),
      ];
      if (dynamic.length > 0) {
        risks.push({
          kind: 'cache-break',
          entryIds: [e.id],
          message: `正文前的词条使用了会变化的占位符 ${dynamic.map((n) => `{{${n}}}`).join(' ')}，值变化时缓存失效`,
        });
      }
    }
    if (p.kind === 'insert' && p.scope.includes('chat')) {
      risks.push({
        kind: 'cache-break',
        entryIds: [e.id],
        message: '插入规则会修改正文消息，被修改的消息之后无法复用缓存',
      });
    }
  }

  // 后执行的插入规则能匹配到先执行者写入的文字（去掉 $ 引用后的字面部分）。
  const inserts = active.filter((e) => e.placement.kind === 'insert').sort(compareEntries);
  const literal = (t: string): string => t.replace(/\$(?:\$|&|<[^>]*>|[0-9]{1,2})/g, '');
  for (let i = 0; i < inserts.length; i++) {
    const text = literal(inserts[i]!.content);
    if (text.trim() === '') continue;
    // 每条规则每次请求只执行一次，也不写回正文，所以只需看后执行的规则。
    for (let j = i + 1; j < inserts.length; j++) {
      const later = inserts[j]!;
      const p = later.placement as InsertPlacement;
      let hit: boolean;
      try {
        hit = compileInsert(p.pattern, p.flags ?? '', later.content).regex.test(text);
      } catch {
        continue; // 配置错误由 validateEntry 报告
      }
      if (hit) {
        risks.push({
          kind: 'recursive-insert',
          entryIds: [inserts[i]!.id, later.id],
          message: `${later.id} 的正则能匹配到 ${inserts[i]!.id} 插入的内容`,
        });
      }
    }
  }
  return risks;
}
