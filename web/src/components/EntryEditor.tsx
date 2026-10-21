// 行内词条编辑器。保存前用 core 的校验，不合规则不能保存。

import { useMemo, useState } from 'react';
import { checkEntry, LibraryError } from '../../../src/core/library.ts';
import { SECTION_ORDER, type Entry, type Placement, type Role, type Section } from '../../../src/core/types.ts';
import type { EntryItem } from '../entries.ts';
import { useDirtyGuard, useStore } from '../store.tsx';

const SECTION_LABEL: Record<Section, string> = { system: '系统提示', before: '正文前', chat: '正文（Dx）', after: '正文后' };

export function EntryEditor({ item, onClose }: { item: EntryItem; onClose: () => void }) {
  const { mutate } = useStore();
  const original = item.entry;
  const [draft, setDraft] = useState<Entry>(original);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);

  const error = useMemo(() => {
    try {
      checkEntry(draft, item.kind);
      return null;
    } catch (e) {
      return e instanceof LibraryError ? e.message : String(e);
    }
  }, [draft, item.kind]);

  const set = <K extends keyof Entry>(k: K, v: Entry[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setPlacement = (p: Placement) => setDraft((d) => ({ ...d, placement: p }));

  const save = async (): Promise<boolean> => {
    if (error) return false;
    const { id: _id, source: _src, ...patch } = draft;
    const ok = await mutate(item.kind, item.containerId, [{ op: 'updateEntry', entryId: original.id, patch }]);
    if (ok) onClose();
    return ok;
  };
  const discard = () => setDraft(original);
  useDirtyGuard(dirty, save, discard);

  const remove = async () => {
    if (!confirm(`删除词条“${draft.name || draft.id}”？`)) return;
    if (await mutate(item.kind, item.containerId, [{ op: 'removeEntry', entryId: original.id }])) onClose();
  };

  const p = draft.placement;
  const mode = p.kind;
  const changeMode = (kind: Placement['kind']) => {
    if (kind === mode) return;
    if (kind === 'insert') setPlacement({ kind, pattern: '', scope: ['before', 'chat', 'after'], pick: 'first', onMiss: 'warn' });
    else setPlacement({ kind, section: p.kind === 'insert' ? 'before' : p.section });
  };

  return (
    <div className="entry-editor" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 's' && (e.preventDefault(), void save())}>
      <div className="grid-3">
        <label className="field">
          <span>名称</span>
          <input className="input" value={draft.name ?? ''} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="field">
          <span>角色</span>
          <select className="select" value={draft.role} onChange={(e) => set('role', e.target.value as Role)}>
            <option value="system">system</option>
            <option value="user">user</option>
            <option value="assistant">assistant</option>
          </select>
        </label>
        <label className="field">
          <span>优先级{item.kind !== 'preset' && '（±10000）'}</span>
          <input className="input mono" type="number" step={1} value={draft.priority} onChange={(e) => set('priority', Number(e.target.value))} />
        </label>
      </div>

      <div className="grid-3">
        <label className="field">
          <span>放置方式</span>
          <select className="select" value={mode} onChange={(e) => changeMode(e.target.value as Placement['kind'])}>
            <option value="position">位置</option>
            <option value="insert">插入（正则）</option>
            {item.kind === 'preset' && <option value="cacheMark">缓存断点（手动）</option>}
          </select>
        </label>
        {p.kind !== 'insert' && (
          <label className="field">
            <span>分区</span>
            <select className="select" value={p.section} onChange={(e) => setPlacement({ kind: p.kind, section: e.target.value as Section })}>
              {SECTION_ORDER.map((s) => (
                <option key={s} value={s}>
                  {SECTION_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
        )}
        {p.kind !== 'insert' && p.section === 'chat' && (
          <label className="field">
            <span>深度 D（从末尾往前）</span>
            <input className="input mono" type="number" min={0} step={1} value={p.depth ?? 0} onChange={(e) => setPlacement({ ...p, depth: Number(e.target.value) })} />
          </label>
        )}
      </div>

      {p.kind === 'insert' && (
        <>
          <div className="grid-3">
            <label className="field" style={{ gridColumn: 'span 2' }}>
              <span>正则（单条消息内匹配）</span>
              <input className="input mono" value={p.pattern} onChange={(e) => setPlacement({ ...p, pattern: e.target.value })} placeholder="(【场景】)" />
            </label>
            <label className="field">
              <span>标志（i m s u）</span>
              <input className="input mono" value={p.flags ?? ''} onChange={(e) => setPlacement({ ...p, flags: e.target.value })} />
            </label>
          </div>
          <div className="grid-3">
            <div className="field">
              <span>匹配范围</span>
              <div className="row">
                {(['before', 'chat', 'after'] as const).map((s) => (
                  <label key={s} className="row" style={{ gap: 3 }}>
                    <input
                      type="checkbox"
                      checked={p.scope.includes(s)}
                      onChange={(e) => setPlacement({ ...p, scope: e.target.checked ? [...p.scope, s] : p.scope.filter((x) => x !== s) })}
                    />
                    {SECTION_LABEL[s].replace('（Dx）', '')}
                  </label>
                ))}
              </div>
            </div>
            <label className="field">
              <span>多处匹配时</span>
              <select className="select" value={p.pick} onChange={(e) => setPlacement({ ...p, pick: e.target.value as 'first' | 'last' })}>
                <option value="first">取第一处</option>
                <option value="last">取最后一处</option>
              </select>
            </label>
            <label className="field">
              <span>没匹配到时</span>
              <select className="select" value={p.onMiss} onChange={(e) => setPlacement({ ...p, onMiss: e.target.value as 'warn' | 'silent' })}>
                <option value="warn">警告</option>
                <option value="silent">静默</option>
              </select>
            </label>
          </div>
        </>
      )}

      <label className="field">
        <span>IF（留空表示总是发送，例如 has("hp") &amp;&amp; hp &lt; 30）</span>
        <input className="input mono" value={draft.if ?? ''} onChange={(e) => set('if', e.target.value)} placeholder="总是" />
      </label>

      {p.kind !== 'cacheMark' && (
        <label className="field">
          <span>{p.kind === 'insert' ? '替换模板（$1 $& $<名> $$，可用 {{占位符}}）' : '内容（可用 {{char}} {{user}} {{变量}}）'}</span>
          <textarea className="textarea" value={draft.content} onChange={(e) => set('content', e.target.value)} spellCheck={false} />
        </label>
      )}

      {error && <div className="gen-error">{error}</div>}

      <div className="row">
        <span className="faint mono">{original.id}</span>
        <span className="spacer" />
        <button className="btn ghost danger-text small" onClick={() => void remove()}>
          删除
        </button>
        <button className="btn small" onClick={() => (discard(), onClose())}>
          {dirty ? '放弃' : '收起'}
        </button>
        <button className="btn primary small" disabled={!dirty || error !== null} onClick={() => void save()}>
          保存
        </button>
      </div>
    </div>
  );
}
