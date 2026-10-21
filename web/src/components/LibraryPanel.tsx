// 右栏：角色 / 自机 / 世界书。列表（搜索、标签、重点关注）→ 详情（可返回）。

import { useEffect, useMemo, useState } from 'react';
import { BASE_PRIORITY, type Character, type ContainerKind, type EntryContainer } from '../../../src/core/library.ts';
import type { SessionMeta } from '../../../src/core/views.ts';
import { api } from '../api.ts';
import { newEntryDraft, type EntryItem } from '../entries.ts';
import { useStore } from '../store.tsx';
import { Avatar, avatarUrl, formatTime, Icon } from '../ui.tsx';
import { AvatarEditor, CreatorNotes } from './CharacterExtras.tsx';
import { ImportButton } from './ImportDialog.tsx';
import { EntryList } from './EntryList.tsx';
import { Greeting } from './Greeting.tsx';
import { InitialVars } from './InitialVars.tsx';

type Tab = 'character' | 'persona' | 'worldbook';
const TAB_LABEL: Record<Tab, string> = { character: '角色', persona: '自机', worldbook: '世界书' };

export function LibraryPanel() {
  const store = useStore();
  const [tab, setTab] = useState<Tab>('character');
  const [detail, setDetail] = useState<string | null>(null);

  const go = async (next: string | null) => {
    if (!(await store.confirmLeave())) return;
    setDetail(next);
  };

  return (
    <>
      <div className="panel-head">
        <div className="tabs" role="tablist">
          {(['character', 'persona', 'worldbook'] as const).map((t) => (
            <button
              key={t}
              className="tab"
              role="tab"
              aria-selected={tab === t}
              onClick={async () => {
                if (!(await store.confirmLeave())) return;
                setTab(t);
                setDetail(null);
              }}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="btn ghost small icon panel-close" onClick={() => store.setMobilePanel('none')} aria-label="关闭">
          <Icon name="close" size={14} />
        </button>
      </div>
      {detail ? <Detail kind={tab} id={detail} onBack={() => void go(null)} /> : <List kind={tab} onOpen={(id) => void go(id)} />}
    </>
  );
}

function List({ kind, onOpen }: { kind: Tab; onOpen: (id: string) => void }) {
  const store = useStore();
  const { lists, settings, characterId } = store;
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [favOnly, setFavOnly] = useState(false);
  const items = lists[kind];

  const tags = useMemo(() => [...new Set(items.flatMap((i) => i.tags ?? []))].sort(), [items]);
  const shown = items
    .filter((i) => !q || i.name.toLowerCase().includes(q.toLowerCase()) || i.tags?.some((t) => t.includes(q)))
    .filter((i) => !tag || i.tags?.includes(tag))
    .filter((i) => !favOnly || i.favorite)
    .sort((a, b) => Number(b.favorite ?? false) - Number(a.favorite ?? false));

  const isCurrent = (id: string) =>
    kind === 'character' ? id === characterId : kind === 'persona' ? id === settings?.personaId : (settings?.worldbookIds.includes(id) ?? false);

  const create = async () => {
    const name = prompt(`新${TAB_LABEL[kind]}的名称`);
    if (!name?.trim()) return;
    const priority = kind === 'persona' ? BASE_PRIORITY.persona : kind === 'character' ? BASE_PRIORITY.characterDescription : BASE_PRIORITY.worldbookBefore;
    const first = { ...newEntryDraft('before'), name: kind === 'persona' ? '用户设定' : kind === 'character' ? '角色设定' : '词条', priority };
    try {
      const doc = await api.create(kind, { name: name.trim(), entries: [first] });
      await store.reloadList(kind);
      onOpen(doc.id);
    } catch (e) {
      store.fail(e);
    }
  };

  const toggleFav = async (id: string, fav: boolean) => {
    await store.mutate('character', id, [{ op: 'set', field: 'favorite', value: fav }]);
  };

  const primary = (id: string) => {
    if (kind === 'character') return void store.selectCharacter(id).then(() => store.setMobilePanel('none'));
    onOpen(id);
  };

  return (
    <>
      <div className="list-tools">
        <div className="row">
          <input className="input" placeholder={`搜索${TAB_LABEL[kind]}…`} value={q} onChange={(e) => setQ(e.target.value)} />
          {kind === 'character' && (
            <button className={`btn icon${favOnly ? ' active' : ''}`} title="只看重点关注" onClick={() => setFavOnly((v) => !v)}>
              ★
            </button>
          )}
          {kind !== 'persona' && <ImportButton />}
          <button className="btn icon" title={`新建${TAB_LABEL[kind]}`} onClick={() => void create()}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        {tags.length > 0 && (
          <div className="tag-filter">
            {tags.map((t) => (
              <button key={t} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                {t}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="panel-body">
        {shown.length === 0 && <div className="empty">没有符合条件的{TAB_LABEL[kind]}</div>}
        {shown.map((i) => (
          <div key={i.id} className={`lib-item${isCurrent(i.id) ? ' current' : ''}`} onClick={() => primary(i.id)}>
            <Avatar name={i.name} src={kind === 'character' ? avatarUrl(i.id, i.avatar) : null} />
            <div className="meta">
              <div className="name">{i.name}</div>
              <div className="sub">
                {kind === 'character' && (i.tags?.length ? i.tags.join(' · ') : '无标签')}
                {kind === 'persona' && (isCurrent(i.id) ? '正在使用' : '点击查看')}
                {kind === 'worldbook' && (isCurrent(i.id) ? '已打开' : '未打开')}
              </div>
            </div>
            {kind === 'character' && (
              <button
                className={`star${i.favorite ? ' on' : ''}`}
                title={i.favorite ? '取消重点关注' : '重点关注'}
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleFav(i.id, !i.favorite);
                }}
              >
                {i.favorite ? '★' : '☆'}
              </button>
            )}
            {kind === 'character' && (
              <button
                className="btn ghost small"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(i.id);
                }}
              >
                详情
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function Detail({ kind, id, onBack }: { kind: ContainerKind & Tab; id: string; onBack: () => void }) {
  const store = useStore();
  const { settings, lists } = store;
  const [doc, setDoc] = useState<EntryContainer | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const summary = lists[kind].find((i) => i.id === id);

  // 资料有变化（列表时间戳变了）就重新读取。
  useEffect(() => {
    void api.get(kind, id).then(setDoc, store.fail);
    if (kind === 'character') void api.sessions(id).then(setSessions, store.fail);
  }, [kind, id, summary?.updatedAt, store.session?.meta.id, store.fail]);

  if (!doc) return <div className="empty">正在加载…</div>;

  const items: EntryItem[] = doc.entries.map((entry) => ({ entry, kind, containerId: doc.id, containerName: doc.name }));
  const set = (field: string, value: unknown) => void store.mutate(kind, id, [{ op: 'set', field, value }]);
  const character = kind === 'character' ? (doc as Character) : null;

  const remove = async () => {
    if (!confirm(`删除${TAB_LABEL[kind]}“${doc.name}”？`)) return;
    try {
      await api.remove(kind, id);
      await store.reloadList(kind);
      onBack();
    } catch (e) {
      store.fail(e);
    }
  };

  const addEntry = () =>
    void store.addEntry(
      kind,
      id,
      { ...newEntryDraft('before'), priority: kind === 'worldbook' ? BASE_PRIORITY.worldbookBefore : kind === 'persona' ? BASE_PRIORITY.persona : BASE_PRIORITY.characterDescription },
      'detail',
    );

  return (
    <>
      <div className="list-tools">
        <div className="row">
          <button className="btn ghost small" onClick={onBack}>
            <Icon name="back" size={14} />
            返回
          </button>
          <span className="spacer" />
          {kind === 'character' && (
            <button className="btn small primary" onClick={() => void store.selectCharacter(id).then(() => store.setMobilePanel('none'))}>
              <Icon name="chat" size={14} />
              对话
            </button>
          )}
          {kind === 'persona' && (
            <button className="btn small" disabled={settings?.personaId === id} onClick={() => void store.saveSettings({ personaId: id })}>
              {settings?.personaId === id ? '正在使用' : '使用'}
            </button>
          )}
          {kind === 'worldbook' && settings && (
            <button
              className={`btn small${settings.worldbookIds.includes(id) ? ' active' : ''}`}
              onClick={() =>
                void store.saveSettings({
                  worldbookIds: settings.worldbookIds.includes(id) ? settings.worldbookIds.filter((w) => w !== id) : [...settings.worldbookIds, id],
                })
              }
            >
              {settings.worldbookIds.includes(id) ? '已打开' : '打开'}
            </button>
          )}
        </div>
      </div>
      <div className="panel-body">
        <div className="detail">
          <div className="row" style={{ gap: 10 }}>
            {character ? <AvatarEditor id={character.id} name={doc.name} version={character.avatar} /> : <Avatar name={doc.name} size={44} />}
            <div style={{ flex: 1, display: 'grid', gap: 4 }}>
              <NameInput value={doc.name} onSave={(v) => set('name', v)} />
              <span className="faint mono">{doc.id}</span>
            </div>
            {character && (
              <button className={`star${character.favorite ? ' on' : ''}`} style={{ fontSize: 20 }} onClick={() => set('favorite', !character.favorite)}>
                {character.favorite ? '★' : '☆'}
              </button>
            )}
          </div>

          {character && (
            <label className="field">
              <span>标签（逗号分隔）</span>
              <TagInput value={character.tags} onSave={(tags) => set('tags', tags)} />
            </label>
          )}

          {character && <Greeting id={character.id} value={character.greeting} alternates={character.alternateGreetings} />}

          {character && <CreatorNotes id={character.id} value={character.creatorNotes} />}

          <div className="detail-block">
            <h3>
              词条
              <span className="spacer" />
              <button className="btn ghost small" onClick={addEntry}>
                <Icon name="plus" size={13} />
                添加
              </button>
            </h3>
            <div className="entry-box">
              <EntryList items={items} outcomes={store.preview?.outcomes} tokens={store.preview?.entryTokens} emptyText="还没有词条" scope="detail" />
            </div>
          </div>

          {character && <InitialVars kind="character" id={character.id} value={character.initialVars} />}

          {character && (
            <div className="detail-block">
              <h3>关联的世界书</h3>
              {lists.worldbook.length === 0 && <span className="faint">还没有世界书</span>}
              <div className="check-list">
                {lists.worldbook.map((w) => (
                  <label key={w.id}>
                    <input
                      type="checkbox"
                      checked={character.worldbookIds.includes(w.id)}
                      onChange={(e) =>
                        set('worldbookIds', e.target.checked ? [...character.worldbookIds, w.id] : character.worldbookIds.filter((x) => x !== w.id))
                      }
                    />
                    {w.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          {character && (
            <div className="detail-block">
              <h3>
                会话
                <span className="spacer" />
                <button
                  className="btn ghost small"
                  onClick={async () => {
                    if (store.characterId !== id) await store.selectCharacter(id);
                    await store.newSession();
                    store.setMobilePanel('none');
                  }}
                >
                  <Icon name="plus" size={13} />
                  新会话
                </button>
              </h3>
              {sessions.length === 0 && <span className="faint">还没有会话</span>}
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className={`session-item${store.session?.meta.id === s.id ? ' current' : ''}`}
                  onClick={async () => {
                    if (store.characterId !== id) await store.selectCharacter(id);
                    await store.openSession(s.id);
                    store.setMobilePanel('none');
                  }}
                >
                  <Icon name="chat" size={14} />
                  <span>{formatTime(s.lastActiveAt)}</span>
                  <span className="faint mono" style={{ fontSize: 11 }}>
                    {s.id.slice(0, 6)}
                  </span>
                  <span className="spacer" />
                  <button
                    className="btn ghost small icon"
                    title="删除会话"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (!confirm('删除这个会话？此操作不能撤销。')) return;
                      try {
                        await api.deleteSession(s.id);
                        setSessions((l) => l.filter((x) => x.id !== s.id));
                        if (store.session?.meta.id === s.id) await store.selectCharacter(id);
                      } catch (err) {
                        store.fail(err);
                      }
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="row-end">
            <button className="btn small ghost danger-text" onClick={() => void remove()}>
              删除{TAB_LABEL[kind]}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function NameInput({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v.trim() && v !== value && onSave(v.trim());
  return <input className="input" style={{ fontWeight: 650, fontSize: 14 }} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}

function TagInput({ value, onSave }: { value: string[]; onSave: (tags: string[]) => void }) {
  const [v, setV] = useState(value.join('，'));
  useEffect(() => setV(value.join('，')), [value]);
  const commit = () => {
    const tags = [...new Set(v.split(/[,，]/).map((t) => t.trim()).filter(Boolean))];
    if (tags.join() !== value.join()) onSave(tags);
  };
  return <input className="input" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}
