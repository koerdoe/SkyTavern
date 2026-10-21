// 中间栏左下角的会话切换：这个角色的全部会话，按分支关系排成树。
// 小窗口里默认只展开当前会话所在的那一支；“展开全部”放大成整棵树。点一个节点就切过去。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionMeta } from '../../../src/core/views.ts';
import { api } from '../api.ts';
import { useStore } from '../store.tsx';
import { formatTime, Icon } from '../ui.tsx';

interface TreeNode {
  meta: SessionMeta;
  children: TreeNode[];
}

/** 按 parentId 连成树；父会话已不存在的当作顶层。顶层按最近活跃排，分支按创建时间排。 */
function buildTree(list: readonly SessionMeta[]): TreeNode[] {
  const nodes = new Map(list.map((m) => [m.id, { meta: m, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.meta.parentId ? nodes.get(n.meta.parentId) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  for (const n of nodes.values()) n.children.sort((a, b) => a.meta.createdAt - b.meta.createdAt);
  // 顶层按整支里最近的活跃时间排，正在玩的那支在最上面
  const latest = (n: TreeNode): number => Math.max(n.meta.lastActiveAt, ...n.children.map(latest));
  return roots.sort((a, b) => latest(b) - latest(a));
}

/** 消息 ID 形如 `时间-层-序号`，取出层号用来显示“从第几条分支”。 */
const layerOf = (messageId: string | null): number | null => {
  const m = messageId ? /^\d+-(\d+)-\d+$/.exec(messageId) : null;
  return m ? Number(m[1]) : null;
};

export const sessionLabel = (m: SessionMeta): string => m.title || `会话 · ${formatTime(m.createdAt)}`;

export function SessionTree() {
  const store = useStore();
  const { session, characterId } = store;
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [list, setList] = useState<SessionMeta[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const box = useRef<HTMLDivElement>(null);
  const currentId = session?.meta.id ?? null;

  const load = useCallback(async () => {
    if (!characterId) return;
    try {
      setList(await api.sessions(characterId));
    } catch (e) {
      store.fail(e);
    }
  }, [characterId, store]);

  // 打开时、当前会话变化时刷新（新消息会改变摘要）
  useEffect(() => {
    if (open) void load();
  }, [open, load, session?.total, currentId]);
  useEffect(() => void load(), [load]);

  const tree = useMemo(() => buildTree(list), [list]);
  const byId = useMemo(() => new Map(list.map((m) => [m.id, m])), [list]);

  // 默认展开当前会话的祖先链
  useEffect(() => {
    if (!currentId) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let m = byId.get(currentId); m?.parentId; m = byId.get(m.parentId)) next.add(m.parentId);
      return next;
    });
  }, [currentId, byId]);

  // 点外面收起
  useEffect(() => {
    if (!open || full) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, full]);

  const go = async (id: string) => {
    if (id === currentId || !(await store.confirmLeave())) return;
    await store.openSession(id);
    if (!full) setOpen(false);
  };

  const rename = async (m: SessionMeta) => {
    const title = prompt('会话名称（留空则按时间显示）', m.title);
    if (title === null) return;
    try {
      await api.renameSession(m.id, title);
      await load();
    } catch (e) {
      store.fail(e);
    }
  };

  const remove = async (m: SessionMeta) => {
    const kids = list.filter((x) => x.parentId === m.id).length;
    if (!confirm(`删除“${sessionLabel(m)}”？${kids ? `\n它的 ${kids} 个分支会改挂到上一级。` : ''}`)) return;
    try {
      await api.deleteSession(m.id);
      if (m.id === currentId) {
        const other = list.find((x) => x.id !== m.id);
        if (other) await store.openSession(other.id);
        else await store.newSession();
      }
      await load();
    } catch (e) {
      store.fail(e);
    }
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allIds = useMemo(() => list.filter((m) => list.some((x) => x.parentId === m.id)).map((m) => m.id), [list]);
  const allOpen = allIds.length > 0 && allIds.every((id) => expanded.has(id));

  const renderNode = (n: TreeNode, depth: number) => {
    const m = n.meta;
    const isOpen = expanded.has(m.id);
    const from = layerOf(m.branchFrom);
    return (
      <div key={m.id}>
        <div className={`tree-row${m.id === currentId ? ' current' : ''}`} style={{ paddingLeft: 6 + depth * 16 }} onClick={() => void go(m.id)}>
          <button
            className="tree-toggle"
            style={{ visibility: n.children.length ? 'visible' : 'hidden' }}
            onClick={(e) => {
              e.stopPropagation();
              toggle(m.id);
            }}
            aria-label={isOpen ? '收起' : '展开'}
          >
            {isOpen ? '▾' : '▸'}
          </button>
          <div className="tree-main">
            <div className="tree-title">
              <span>{sessionLabel(m)}</span>
              {from !== null && <span className="chip plain">从第 {from + 1} 条分支</span>}
              {!isOpen && n.children.length > 0 && <span className="faint">+{n.children.length}</span>}
            </div>
            <div className="tree-sub">
              {m.layerCount} 条 · {formatTime(m.lastActiveAt)}
              {m.lastText && <> · {m.lastText}</>}
            </div>
          </div>
          <span className="tree-actions">
            <button className="btn ghost small icon" title="改名" onClick={(e) => (e.stopPropagation(), void rename(m))}>
              <Icon name="edit" size={12} />
            </button>
            <button className="btn ghost small icon" title="删除" onClick={(e) => (e.stopPropagation(), void remove(m))}>
              <Icon name="trash" size={12} />
            </button>
          </span>
        </div>
        {isOpen && n.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  const current = currentId ? byId.get(currentId) : undefined;

  return (
    <div className="session-tree-anchor" ref={box}>
      <button className={`btn ghost small${open ? ' active' : ''}`} onClick={() => setOpen((v) => !v)} title="切换这个角色的会话">
        <Icon name="tree" size={14} />
        <span className="desktop-only session-tree-label">{current ? sessionLabel(current) : '会话'}</span>
        {list.length > 1 && <span className="faint">{list.length}</span>}
      </button>
      {open && (
        <>
          {full && <div className="modal-backdrop" onClick={() => setFull(false)} />}
          <div className={`session-tree${full ? ' full' : ''}`} role="dialog" aria-label="会话">
            <div className="session-tree-head">
              <strong>会话</strong>
              <span className="faint">{list.length} 个</span>
              <span className="spacer" />
              {allIds.length > 0 && (
                <button className="btn ghost small" onClick={() => setExpanded(allOpen ? new Set() : new Set(allIds))}>
                  {allOpen ? '全部收起' : '全部展开'}
                </button>
              )}
              <button className="btn ghost small icon" title={full ? '缩小' : '放大成整棵树'} onClick={() => setFull((v) => !v)}>
                <Icon name="expand" size={13} />
              </button>
              <button
                className="btn small"
                onClick={async () => {
                  if (!(await store.confirmLeave())) return;
                  await store.newSession();
                  await load();
                }}
              >
                <Icon name="plus" size={13} />
                新会话
              </button>
            </div>
            <div className="session-tree-body">
              {tree.length === 0 ? <div className="empty">还没有会话</div> : tree.map((n) => renderNode(n, 0))}
            </div>
            <div className="session-tree-foot faint">在消息的工具按钮里点“分支”，可以从那条消息分出一个新会话。</div>
          </div>
        </>
      )}
    </div>
  );
}
