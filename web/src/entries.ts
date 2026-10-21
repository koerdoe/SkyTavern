// 词条列表的排序、标签和默认值。

import type { ContainerKind, EntryDraft } from '../../src/core/library.ts';
import type { Entry, EntryOutcome, Section } from '../../src/core/types.ts';

export interface EntryItem {
  entry: Entry;
  kind: ContainerKind;
  containerId: string;
  containerName: string;
}

export type Group = Section | 'insert';
export const GROUP_ORDER: readonly Group[] = ['system', 'before', 'chat', 'after', 'insert'];
export const GROUP_LABEL: Record<Group, string> = {
  system: '系统提示',
  before: '正文前',
  chat: '正文',
  after: '正文后',
  insert: '插入规则',
};

export const groupOf = (e: Entry): Group => (e.placement.kind === 'insert' ? 'insert' : e.placement.section);

export const KIND_LABEL: Record<ContainerKind, string> = { preset: '预设', character: '角色', persona: '自机', worldbook: '世界书' };

/** 行首的位置标签：系统 / 前 / D3 / 后 / 插入 / 断点。 */
export function placementChip(e: Entry): { text: string; cls: string } {
  const p = e.placement;
  if (p.kind === 'insert') return { text: '插入', cls: 'sec-insert' };
  const base = p.section === 'chat' ? `D${p.depth ?? 0}` : { system: '系统', before: '前', after: '后', chat: '' }[p.section];
  return { text: p.kind === 'cacheMark' ? `断点·${base}` : base, cls: `sec-${p.section}` };
}

/** 生效的优先级（避让之后），没有预览数据时用原值。 */
export function effectivePriority(e: Entry, outcomes: Record<string, EntryOutcome> | undefined): number {
  const o = outcomes?.[e.id];
  return o && 'priority' in o ? o.priority : e.priority;
}

/** 与请求中的实际顺序一致：分区 → （正文按深度从深到浅）→ 优先级降序 → ID。 */
export function sortItems(items: readonly EntryItem[], outcomes?: Record<string, EntryOutcome>): Map<Group, EntryItem[]> {
  const groups = new Map<Group, EntryItem[]>(GROUP_ORDER.map((g) => [g, []]));
  for (const it of items) groups.get(groupOf(it.entry))!.push(it);
  const depth = (e: Entry) => (e.placement.kind !== 'insert' ? (e.placement.depth ?? 0) : 0);
  for (const [g, list] of groups) {
    list.sort(
      (a, b) =>
        (g === 'chat' ? depth(b.entry) - depth(a.entry) : 0) ||
        effectivePriority(b.entry, outcomes) - effectivePriority(a.entry, outcomes) ||
        a.entry.id.localeCompare(b.entry.id, 'en', { numeric: true }),
    );
  }
  return groups;
}

export function entryTitle(e: Entry): string {
  if (e.name?.trim()) return e.name.trim();
  const first = e.content.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  if (e.placement.kind === 'insert') return `/${e.placement.pattern}/`;
  if (e.placement.kind === 'cacheMark') return '缓存断点';
  return first || '（空）';
}

export function newEntryDraft(group: Group = 'before'): EntryDraft {
  if (group === 'insert') {
    return {
      name: '新插入规则',
      enabled: true,
      role: 'system',
      content: '$&',
      priority: 0,
      placement: { kind: 'insert', pattern: '', scope: ['before', 'chat', 'after'], pick: 'first', onMiss: 'warn' },
    };
  }
  return { name: '新词条', enabled: true, role: 'system', content: '', priority: 0, placement: { kind: 'position', section: group } };
}

/** 结果徽标的文字与样式。 */
export function outcomeBadge(o: EntryOutcome | undefined): { text: string; cls: string; title: string; jump: boolean } | null {
  if (!o) return null;
  switch (o.status) {
    case 'disabled':
      return null;
    case 'if-false':
      return { text: 'IF 否', cls: 'plain', title: 'IF 不成立，本次不发送', jump: true };
    case 'placed':
      return o.messageIndex === null
        ? { text: '空', cls: 'plain', title: '内容为空，已被去掉', jump: true }
        : { text: `#${o.messageIndex + 1}`, cls: 'accent', title: `在第 ${o.messageIndex + 1} 条消息，点击查看实际发送内容`, jump: true };
    case 'inserted':
      return o.messageIndex === null
        ? { text: '空', cls: 'plain', title: '插入后消息为空', jump: true }
        : { text: `→#${o.messageIndex + 1}`, cls: 'ok', title: `插入到第 ${o.messageIndex + 1} 条消息`, jump: true };
    case 'insert-miss':
      return { text: '未命中', cls: 'warn', title: '插入规则没有匹配到任何消息', jump: true };
    case 'cache-mark':
      return o.messageIndex === null
        ? { text: '无效', cls: 'plain', title: '前面没有消息，断点无效', jump: false }
        : { text: `⟂#${o.messageIndex + 1}`, cls: 'ok', title: `缓存断点落在第 ${o.messageIndex + 1} 条消息`, jump: true };
  }
}
