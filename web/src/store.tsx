// 全局状态：设置、资料列表、当前角色与会话、当前请求结构、预览、未保存编辑的守卫。

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Character, ContainerKind, EntryDraft, LibraryKind, LibraryOp, Persona, Preset, UiPrefs, UserSettings, Worldbook } from '../../src/core/library.ts';
import type { LibrarySummary, PreviewView, SessionView } from '../../src/core/views.ts';
import { api, ApiError, errorText } from './api.ts';

export interface ContextDocs {
  preset: Preset | null;
  character: Character | null;
  persona: Persona | null;
  worldbooks: Worldbook[];
}

export type Notice = { id: number; kind: 'error' | 'info'; text: string };

/** 词条列表所在的位置：左栏请求结构，或右栏资料详情。 */
export type ListScope = 'structure' | 'detail';

interface Guard {
  save: () => Promise<boolean>;
  discard: () => void;
}

interface Store {
  settings: UserSettings | null;
  saveSettings: (patch: Partial<UserSettings>) => Promise<void>;
  lists: Record<LibraryKind, LibrarySummary[]>;
  reloadList: (kind: LibraryKind) => Promise<void>;

  characterId: string | null;
  selectCharacter: (id: string) => Promise<void>;
  docs: ContextDocs;
  reloadDocs: () => Promise<void>;
  /** 修改资料：发送变更 → 刷新列表、当前请求结构、预览。 */
  mutate: (kind: LibraryKind, id: string, ops: LibraryOp[]) => Promise<boolean>;
  /** 新增词条，并让发起新增的那个列表把它展开。 */
  addEntry: (kind: ContainerKind, id: string, draft: EntryDraft, scope: ListScope) => Promise<void>;
  /** 等待展开的新词条；由对应 scope 的列表取走。 */
  pendingOpen: { entryId: string; scope: ListScope } | null;
  clearPendingOpen: () => void;

  session: SessionView | null;
  openSession: (id: string) => Promise<void>;
  newSession: () => Promise<void>;
  reloadSession: (limit?: number) => Promise<void>;

  preview: PreviewView | null;
  previewError: ApiError | null;
  refreshPreview: () => void;
  /** 中间栏显示对话还是请求预览。 */
  view: 'chat' | 'preview';
  setView: (v: 'chat' | 'preview') => void;
  /** 预览中要定位的消息下标。 */
  focusMessage: number | null;
  focusEntry: (entryId: string) => void;

  mobilePanel: 'none' | 'left' | 'right';
  setMobilePanel: (p: 'none' | 'left' | 'right') => void;

  notices: Notice[];
  notify: (text: string, kind?: Notice['kind']) => void;
  fail: (e: unknown) => void;

  /** 有未保存编辑时，离开前询问；返回 true 表示可以继续。 */
  confirmLeave: () => Promise<boolean>;
  registerGuard: (key: symbol, g: Guard | null) => void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore 必须在 AppProvider 内使用');
  return s;
}

const EMPTY_LISTS: Record<LibraryKind, LibrarySummary[]> = { preset: [], character: [], persona: [], worldbook: [], model: [] };
const LAST_CHARACTER = 'skytavern.lastCharacter';

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 无痕模式等情况下忽略 */
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [lists, setLists] = useState(EMPTY_LISTS);
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [docs, setDocs] = useState<ContextDocs>({ preset: null, character: null, persona: null, worldbooks: [] });
  const [session, setSession] = useState<SessionView | null>(null);
  const [preview, setPreview] = useState<PreviewView | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [view, setView] = useState<'chat' | 'preview'>('chat');
  const [focusMessage, setFocusMessage] = useState<number | null>(null);
  const [mobilePanel, setMobilePanel] = useState<'none' | 'left' | 'right'>('none');
  const [notices, setNotices] = useState<Notice[]>([]);
  const [leavePrompt, setLeavePrompt] = useState<((ok: boolean) => void) | null>(null);
  const [pendingOpen, setPendingOpen] = useState<{ entryId: string; scope: ListScope } | null>(null);
  const guards = useRef(new Map<symbol, Guard>());
  const noticeSeq = useRef(0);

  const notify = useCallback((text: string, kind: Notice['kind'] = 'info') => {
    const id = ++noticeSeq.current;
    setNotices((n) => [...n.slice(-3), { id, kind, text }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 3000);
  }, []);
  const fail = useCallback((e: unknown) => notify(errorText(e), 'error'), [notify]);

  const loadCount = settings?.ui.loadCount ?? 50;

  // ---------- 资料 ----------
  const reloadList = useCallback(async (kind: LibraryKind) => {
    const l = await api.list(kind);
    setLists((prev) => ({ ...prev, [kind]: l }));
  }, []);

  const loadDocs = useCallback(async (s: UserSettings, charId: string | null): Promise<void> => {
    const character = charId ? await api.get('character', charId).catch(() => null) : null;
    const [preset, persona] = await Promise.all([
      s.presetId ? api.get('preset', s.presetId).catch(() => null) : null,
      s.personaId ? api.get('persona', s.personaId).catch(() => null) : null,
    ]);
    const wbIds = [...new Set([...(character?.worldbookIds ?? []), ...s.worldbookIds])];
    const worldbooks = (await Promise.all(wbIds.map((id) => api.get('worldbook', id).catch(() => null)))).filter((w) => w !== null);
    setDocs({ preset, character, persona, worldbooks });
  }, []);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const characterRef = useRef(characterId);
  characterRef.current = characterId;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const reloadDocs = useCallback(async () => {
    if (settingsRef.current) await loadDocs(settingsRef.current, characterRef.current);
  }, [loadDocs]);

  // ---------- 预览（防抖） ----------
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshPreview = useCallback(() => {
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(async () => {
      const sid = sessionRef.current?.meta.id;
      const cid = characterRef.current;
      if (!sid && !cid) return;
      try {
        setPreview(await api.preview(sid ? { sessionId: sid } : { characterId: cid! }));
        setPreviewError(null);
      } catch (e) {
        if (e instanceof ApiError) setPreviewError(e);
        else fail(e);
      }
    }, 250);
  }, [fail]);

  const mutate = useCallback(
    async (kind: LibraryKind, id: string, ops: LibraryOp[]): Promise<boolean> => {
      try {
        await api.patch(kind, id, ops);
        await Promise.all([reloadList(kind), reloadDocs()]);
        refreshPreview();
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    [reloadList, reloadDocs, refreshPreview, fail],
  );

  const saveSettings = useCallback(
    async (patch: Partial<UserSettings>) => {
      const cur = settingsRef.current;
      if (!cur) return;
      try {
        const next = await api.saveSettings({ ...cur, ...patch });
        setSettings(next);
        await loadDocs(next, characterRef.current);
        refreshPreview();
      } catch (e) {
        fail(e);
      }
    },
    [loadDocs, refreshPreview, fail],
  );

  // ---------- 未保存编辑 ----------
  const registerGuard = useCallback((key: symbol, g: Guard | null) => {
    if (g) guards.current.set(key, g);
    else guards.current.delete(key);
  }, []);

  const confirmLeave = useCallback(async (): Promise<boolean> => {
    if (guards.current.size === 0) return true;
    return new Promise<boolean>((resolve) => setLeavePrompt(() => resolve));
  }, []);

  const addEntry = useCallback(
    async (kind: ContainerKind, id: string, draft: EntryDraft, scope: ListScope) => {
      // 新词条会占用展开位置，先处理正在编辑的词条
      if (!(await confirmLeave())) return;
      try {
        const doc = await api.patch(kind, id, [{ op: 'addEntry', entry: draft }]);
        setPendingOpen({ entryId: `${id}-${(doc as { nextEntryId: number }).nextEntryId - 1}`, scope });
        await Promise.all([reloadList(kind), reloadDocs()]);
        refreshPreview();
      } catch (e) {
        fail(e);
      }
    },
    [confirmLeave, reloadList, reloadDocs, refreshPreview, fail],
  );
  const clearPendingOpen = useCallback(() => setPendingOpen(null), []);

  const answerLeave = async (choice: 'save' | 'discard' | 'stay') => {
    const resolve = leavePrompt;
    setLeavePrompt(null);
    if (!resolve) return;
    if (choice === 'stay') return resolve(false);
    const all = [...guards.current.values()];
    if (choice === 'discard') {
      all.forEach((g) => g.discard());
      return resolve(true);
    }
    const results = await Promise.all(all.map((g) => g.save()));
    resolve(results.every(Boolean));
  };

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (guards.current.size > 0) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // ---------- 角色与会话 ----------
  const selectCharacter = useCallback(
    async (id: string) => {
      if (!(await confirmLeave())) return;
      setCharacterId(id);
      writeLocal(LAST_CHARACTER, id);
      setView('chat');
      try {
        const s = await api.latestSession(id, settingsRef.current?.ui.loadCount ?? 50);
        setSession(s);
        if (settingsRef.current) await loadDocs(settingsRef.current, id);
      } catch (e) {
        fail(e);
      }
    },
    [confirmLeave, loadDocs, fail],
  );

  const openSession = useCallback(
    async (id: string) => {
      try {
        setSession(await api.session(id, loadCount));
        setView('chat');
      } catch (e) {
        fail(e);
      }
    },
    [loadCount, fail],
  );

  const newSession = useCallback(async () => {
    const cid = characterRef.current;
    if (!cid) return;
    try {
      setSession(await api.createSession(cid));
      setView('chat');
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  const reloadSession = useCallback(
    async (limit?: number) => {
      const s = sessionRef.current;
      if (!s) return;
      const shown = s.total - s.from;
      try {
        setSession(await api.session(s.meta.id, limit ?? Math.max(shown, loadCount)));
      } catch (e) {
        fail(e);
      }
    },
    [loadCount, fail],
  );

  const focusEntry = useCallback(
    (entryId: string) => {
      const o = preview?.outcomes[entryId];
      const idx = o && 'messageIndex' in o ? o.messageIndex : null;
      setView('preview');
      setFocusMessage(idx);
      setMobilePanel('none');
      if (idx === null) {
        const why = !o
          ? '这个词条不在当前请求里'
          : o.status === 'if-false'
            ? 'IF 不成立，本次不发送'
            : o.status === 'disabled'
              ? '已禁用'
              : o.status === 'insert-miss'
                ? '插入规则没有匹配到任何消息'
                : '内容为空，已被去掉';
        notify(why);
      }
    },
    [preview, notify],
  );

  // ---------- 启动 ----------
  useEffect(() => {
    void (async () => {
      try {
        const s = await api.settings();
        setSettings(s);
        const kinds: LibraryKind[] = ['preset', 'character', 'persona', 'worldbook', 'model'];
        const all = await Promise.all(kinds.map((k) => api.list(k)));
        setLists(Object.fromEntries(kinds.map((k, i) => [k, all[i]!])) as Record<LibraryKind, LibrarySummary[]>);
        const chars = all[1]!;
        const last = readLocal(LAST_CHARACTER);
        const cid = chars.find((c) => c.id === last)?.id ?? chars[0]?.id ?? null;
        setCharacterId(cid);
        if (cid) setSession(await api.latestSession(cid, s.ui.loadCount));
        await loadDocs(s, cid);
      } catch (e) {
        fail(e);
      }
    })();
  }, [loadDocs, fail]);

  // 当前请求相关的东西变化时刷新预览（会话每次重新载入都算：变量操作不改变层数，但会改变 IF 和占位符的结果）。
  useEffect(() => {
    refreshPreview();
  }, [session, characterId, docs, refreshPreview]);

  // 主题、阅读模式、自定义风格
  useEffect(() => {
    const root = document.documentElement;
    const ui = settings?.ui;
    if (!ui) return;
    if (ui.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = ui.theme;
    root.dataset.reading = ui.readingMode;
    applyUserCss(activeCss(ui));
  }, [settings?.ui]);

  const value = useMemo<Store>(
    () => ({
      settings,
      saveSettings,
      lists,
      reloadList,
      characterId,
      selectCharacter,
      docs,
      reloadDocs,
      mutate,
      addEntry,
      pendingOpen,
      clearPendingOpen,
      session,
      openSession,
      newSession,
      reloadSession,
      preview,
      previewError,
      refreshPreview,
      view,
      setView,
      focusMessage,
      focusEntry,
      mobilePanel,
      setMobilePanel,
      notices,
      notify,
      fail,
      confirmLeave,
      registerGuard,
    }),
    [settings, saveSettings, lists, reloadList, characterId, selectCharacter, docs, reloadDocs, mutate, addEntry, pendingOpen, clearPendingOpen, session, openSession, newSession, reloadSession, preview, previewError, refreshPreview, view, focusMessage, focusEntry, mobilePanel, notices, notify, fail, confirmLeave, registerGuard],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {leavePrompt && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal modal-small" role="alertdialog" aria-labelledby="leave-title">
            <h2 id="leave-title">有未保存的修改</h2>
            <p className="muted">离开前要保存这些修改吗？</p>
            <div className="row-end">
              <button className="btn" onClick={() => void answerLeave('stay')}>留下</button>
              <button className="btn danger-text" onClick={() => void answerLeave('discard')}>放弃修改</button>
              <button className="btn primary" onClick={() => void answerLeave('save')}>保存</button>
            </div>
          </div>
        </div>
      )}
      <div className="notices" aria-live="polite">
        {notices.map((n) => (
          <div key={n.id} className={`notice ${n.kind}`}>{n.text}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** 编辑器用：有未保存修改时注册守卫。 */
export function useDirtyGuard(dirty: boolean, save: () => Promise<boolean>, discard: () => void): void {
  const { registerGuard } = useStore();
  const key = useRef(Symbol('guard'));
  const saveRef = useRef(save);
  const discardRef = useRef(discard);
  saveRef.current = save;
  discardRef.current = discard;
  useEffect(() => {
    const k = key.current;
    registerGuard(k, dirty ? { save: () => saveRef.current(), discard: () => discardRef.current() } : null);
    return () => registerGuard(k, null);
  }, [dirty, registerGuard]);
}

/** 正在使用的自定义风格的 CSS。 */
export function activeCss(ui: UiPrefs): string {
  return ui.styles.find((st) => st.id === ui.activeStyle)?.css ?? '';
}

/** 把 CSS 写进页面（系统设置里编辑风格时也用它实时预览）。 */
export function applyUserCss(css: string): void {
  let style = document.getElementById('user-css') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'user-css';
    document.head.appendChild(style);
  }
  style.textContent = css;
}
