// 扁平紧凑的词条列表：从上往下就是请求里的顺序。点击展开编辑，拖拽改位置（按落点 ±1 设优先级）。

import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { PRIORITY_LIMIT, type EntryOutcome } from '../../../src/core/types.ts';
import type { SimilarityInfo } from '../../../src/core/similar.ts';
import { effectivePriority, entryTitle, GROUP_LABEL, groupOf, KIND_LABEL, outcomeBadge, placementChip, sortItems, type EntryItem, type Group } from '../entries.ts';
import { useStore, type ListScope } from '../store.tsx';
import { Switch } from '../ui.tsx';
import { EntryEditor } from './EntryEditor.tsx';

interface Props {
  items: EntryItem[];
  outcomes?: Record<string, EntryOutcome> | undefined;
  /** 每个词条的 token 预估（来自预览）。 */
  tokens?: Record<string, number> | undefined;
  /** 合并视图：显示来源和“聊天记录”标记。 */
  merged?: boolean;
  historyCount?: number | undefined;
  emptyText?: string;
  /** 用于接收“新增后展开”的请求。 */
  scope: ListScope;
}

type DropAt = { id: string; where: 'before' | 'after' } | null;

export function EntryList({ items, outcomes, tokens, merged = false, historyCount, emptyText = '还没有词条', scope }: Props) {
  const { mutate, focusEntry, confirmLeave, pendingOpen, clearPendingOpen, preview } = useStore();
  const similarity = preview?.similarity;
  const similarOff = useMemo(() => new Map((preview?.warnings ?? []).filter((w) => w.code === 'similar-off').map((w) => [w.entryId, w.message])), [preview]);
  const [openId, setOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 新增的词条出现在列表里时自动展开，滚动过去并聚焦名称，方便马上调整。
  useEffect(() => {
    if (!pendingOpen || pendingOpen.scope !== scope || !items.some((i) => i.entry.id === pendingOpen.entryId)) return;
    const id = pendingOpen.entryId;
    clearPendingOpen();
    setOpenId(id);
    requestAnimationFrame(() => {
      const row = rootRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`);
      row?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      row?.nextElementSibling?.querySelector<HTMLInputElement>('input')?.select();
    });
  }, [pendingOpen, scope, items, clearPendingOpen]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DropAt>(null);
  const groups = useMemo(() => sortItems(items, outcomes), [items, outcomes]);
  const byId = useMemo(() => new Map(items.map((i) => [i.entry.id, i])), [items]);

  const toggleOpen = async (id: string) => {
    if (openId !== null && openId !== id && !(await confirmLeave())) return;
    setOpenId((cur) => (cur === id ? null : id));
  };

  const draggable = (it: EntryItem) => it.entry.placement.kind !== 'insert';

  const onDragOver = (e: DragEvent, target: EntryItem) => {
    if (!dragId || dragId === target.entry.id || !draggable(target)) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropAt({ id: target.entry.id, where: e.clientY < r.top + r.height / 2 ? 'before' : 'after' });
  };

  /** 放到目标上方 → 目标优先级 +1；下方 → −1。跨分区时一并改分区（正文沿用目标深度）。 */
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    const drag = dragId ? byId.get(dragId) : undefined;
    const target = dropAt ? byId.get(dropAt.id) : undefined;
    setDragId(null);
    setDropAt(null);
    if (!drag || !target || !dropAt || target.entry.placement.kind === 'insert' || drag.entry.placement.kind === 'insert') return;
    const tp = effectivePriority(target.entry, outcomes);
    let priority = dropAt.where === 'before' ? tp + 1 : tp - 1;
    if (drag.kind !== 'preset') priority = Math.max(-PRIORITY_LIMIT, Math.min(PRIORITY_LIMIT, priority));
    const t = target.entry.placement;
    const placement = { kind: drag.entry.placement.kind, section: t.section, ...(t.section === 'chat' ? { depth: t.depth ?? 0 } : {}) };
    await mutate(drag.kind, drag.containerId, [{ op: 'updateEntry', entryId: drag.entry.id, patch: { priority, placement } }]);
  };

  if (items.length === 0 && !merged) return <div className="empty">{emptyText}</div>;

  return (
    <div ref={rootRef} onDragEnd={() => (setDragId(null), setDropAt(null))}>
      {[...groups].map(([group, list]) => {
        if (list.length === 0 && !(merged && group === 'chat')) return null;
        return (
          <Fragment key={group}>
            <div className="section-head">
              <span className="dot" style={{ background: `var(--sec-${group})` }} />
              {GROUP_LABEL[group as Group]}
              <span className="spacer" />
              <span>{list.length || ''}</span>
            </div>
            {merged && group === 'chat' && (
              <div className="chat-marker">
                ≋ 聊天记录{historyCount !== undefined ? ` · ${historyCount} 条` : ''}
                <span className="faint" style={{ fontWeight: 400 }}>
                  D 词条从末尾往前数插入
                </span>
              </div>
            )}
            {list.map((it) => {
              const e = it.entry;
              const chip = placementChip(e);
              const o = outcomes?.[e.id];
              const badge = outcomeBadge(o);
              const eff = effectivePriority(e, outcomes);
              const cls = [
                'entry-row',
                openId === e.id && 'selected',
                !e.enabled && 'disabled',
                o?.status === 'if-false' && 'skipped',
                dropAt?.id === e.id && `drop-${dropAt.where}`,
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <Fragment key={e.id}>
                  <div
                    className={cls}
                    data-entry-id={e.id}
                    draggable={draggable(it)}
                    onDragStart={(ev) => {
                      setDragId(e.id);
                      ev.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(ev) => onDragOver(ev, it)}
                    onDrop={(ev) => void onDrop(ev)}
                    onClick={() => void toggleOpen(e.id)}
                    title={groupOf(e) === 'insert' ? `插入规则 /${e.placement.kind === 'insert' ? e.placement.pattern : ''}/` : undefined}
                  >
                    <span className={`drag-handle${draggable(it) ? '' : ' none'}`} aria-hidden="true">
                      ⋮⋮
                    </span>
                    <Switch
                      checked={e.enabled}
                      label={e.enabled ? '已启用' : '已禁用'}
                      onChange={(v) => void mutate(it.kind, it.containerId, [{ op: 'updateEntry', entryId: e.id, patch: { enabled: v } }])}
                    />
                    <span className={`chip ${chip.cls}`}>{chip.text}</span>
                    <span className="prio" title={eff !== e.priority ? `与同位置的词条撞车，自动延后为 ${eff}` : '优先级'}>
                      {e.priority}
                      {eff !== e.priority && <span className="bump">(+{eff - e.priority})</span>}
                    </span>
                    <span className="entry-name">
                      <span>{entryTitle(e)}</span>
                      {merged && it.kind !== 'preset' && (
                        <span className="src">
                          {KIND_LABEL[it.kind]}
                          {it.kind === 'worldbook' ? `·${it.containerName}` : ''}
                        </span>
                      )}
                    </span>
                    <span className="entry-flags">
                      {!!tokens?.[e.id] && e.placement.kind !== 'cacheMark' && (
                        <span className="entry-tokens" title={`约 ${tokens[e.id]!.toLocaleString()} token${o?.status === 'placed' ? '（按它这次形成的消息算）' : '（按词条内容算）'}`}>
                          {compactTokens(tokens[e.id]!)}
                        </span>
                      )}
                      {e.if?.trim() && <span className="chip plain" title={`IF ${e.if}`}>IF</span>}
                      {similarity?.[e.id] ? (
                        <span className={`chip ${similarity[e.id]!.passed ? 'ok' : 'plain'}`} title={similarTitle(similarity[e.id]!)}>
                          ≈{similarity[e.id]!.score.toFixed(2)}
                        </span>
                      ) : (
                        similarOff.has(e.id) && (
                          <span className="chip warn" title={similarOff.get(e.id)}>
                            ≈ 未算
                          </span>
                        )
                      )}
                      {badge && (
                        <button
                          type="button"
                          className={`chip ${badge.cls}`}
                          title={badge.title}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            if (badge.jump) focusEntry(e.id);
                          }}
                        >
                          {badge.text}
                        </button>
                      )}
                    </span>
                  </div>
                  {openId === e.id && <EntryEditor item={it} onClose={() => setOpenId(null)} />}
                </Fragment>
              );
            })}
          </Fragment>
        );
      })}
    </div>
  );
}

function similarTitle(s: SimilarityInfo): string {
  const head = `similar() 相似度 ${s.score.toFixed(3)}，阈值 ${s.threshold}`;
  if (s.passed) return `${head}：成立`;
  return s.cut ? `${head}：过了阈值，但超出“最多几条”，按不成立处理` : `${head}：没过阈值，不成立`;
}

/** 1234 → 1.2k，列表里省地方。 */
function compactTokens(n: number): string {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
