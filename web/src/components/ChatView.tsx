// 中间栏：对话。发送、续写、重新生成、停止；流式显示；切换候选、编辑、删除。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GenStatus, LayerView } from '../../../src/core/views.ts';
import { api, watchGeneration, type SessionOpInput } from '../api.ts';
import { useStore } from '../store.tsx';
import type { RegexScript } from '../../../src/core/scripts.ts';
import { displayText, splitSegments } from '../display.ts';
import { avatarUrl, FormattedText, Icon } from '../ui.tsx';
import { VarOpsBar } from './VarOpsBar.tsx';
import { AttachmentList, useComposerAttachments } from './Attachments.tsx';
import { SessionTree } from './SessionTree.tsx';
import { Widget } from './Widget.tsx';

interface LiveGen {
  id: string;
  text: string;
  status: GenStatus;
  /** reroll 时显示在该层，否则显示在末尾。 */
  layer: number | null;
  error?: string;
  /** 结束后重新载入会话完成，正式消息已显示，临时气泡可以撤下。 */
  settled: boolean;
}

export function ChatView() {
  const { session, docs, settings, reloadSession, newSession, openSession, notify, fail, characterId } = useStore();
  const [live, setLive] = useState<LiveGen | null>(null);
  const [input, setInput] = useState('');
  const files = useComposerAttachments();
  const [editing, setEditing] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const unwatch = useRef<(() => void) | null>(null);

  const charName = docs.character?.name ?? '角色';
  const scripts = useMemo(() => [...(docs.preset?.scripts ?? []), ...(docs.character?.scripts ?? [])], [docs.preset, docs.character]);
  const userName = docs.persona?.name ?? '用户';
  const charAvatar = docs.character ? avatarUrl(docs.character.id, docs.character.avatar) : null;
  const running = live?.status === 'running';

  const attach = useCallback(
    (generationId: string, layer: number | null) => {
      unwatch.current?.();
      setLive({ id: generationId, text: '', status: 'running', layer, settled: false });
      stickToBottom.current = layer === null;
      unwatch.current = watchGeneration(generationId, (e) => {
        if (e.type === 'snapshot') setLive((g) => g && { ...g, text: e.text, status: e.status });
        else if (e.type === 'delta') setLive((g) => g && { ...g, text: g.text + e.text });
        else {
          setLive((g) => g && { ...g, status: e.status, ...(e.error ? { error: e.error } : {}) });
          // 先载入正式消息再撤下临时气泡，避免闪烁；有错误时留下错误提示。
          void reloadSession().then(() => setLive((g) => (g?.id !== generationId ? g : g.error ? { ...g, settled: true } : null)));
        }
      });
    },
    [reloadSession],
  );

  // 打开会话时，如果有进行中的生成就接上（刷新页面后也能找回）。
  useEffect(() => {
    setLive(null);
    setEditing(null);
    unwatch.current?.();
    stickToBottom.current = true;
    const sid = session?.meta.id;
    if (!sid) return;
    void api.generation(sid).then((g) => g?.status === 'running' && attach(g.id, null));
    return () => unwatch.current?.();
  }, [session?.meta.id, attach]);

  // 新内容时保持在底部（用户往上翻时不打扰）。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [session, live?.text]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const run = async (op: SessionOpInput, layer: number | null = null): Promise<boolean> => {
    if (!session) return false;
    try {
      const r = await api.op(session.meta.id, op);
      if (op.op === 'append') setInput('');
      await reloadSession();
      if (r.generationId) attach(r.generationId, layer);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  const send = () => {
    const text = input.trim();
    if ((!text && files.items.length === 0) || running || files.uploading) return;
    stickToBottom.current = true;
    const ids = files.items.map((a) => a.id);
    void run({ op: 'append', role: 'user', content: text, generate: true, ...(ids.length ? { attachments: ids } : {}) }).then((ok) => ok && files.clear());
  };

  if (!characterId) return <div className="chat-empty">正在加载…</div>;

  if (!session) {
    return (
      <div className="chat-scroll">
        <div className="chat-empty">
          <h3>{charName}</h3>
          <p>还没有和 {charName} 的对话。</p>
          <button className="btn primary" onClick={() => void newSession()}>
            开始对话
          </button>
        </div>
      </div>
    );
  }

  const layers = session.layers;
  const hasEarlier = session.from > 0;
  const loadCount = settings?.ui.loadCount || 50;

  return (
    <>
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-inner">
          {hasEarlier && (
            <button className="btn small load-earlier" onClick={() => void reloadSession(session.total - session.from + loadCount)}>
              加载更早的 {Math.min(loadCount, session.from)} 条（共 {session.total} 条）
            </button>
          )}
          {layers.length === 0 && !live && <div className="chat-empty faint">说点什么开始吧。</div>}
          {layers.map((l, idx) =>
            live && !live.settled && live.layer === l.layer ? (
              <LiveMessage key={l.id} live={live} name={charName} avatar={charAvatar} />
            ) : (
              <Message
                key={l.id}
                layer={l}
                sessionId={session.meta.id}
                scripts={scripts}
                latest={latestFlags(layers, idx)}
                onReceive={async () => {
                  try {
                    await api.receive(session.meta.id, [l.id]);
                    await reloadSession();
                  } catch (e) {
                    fail(e);
                  }
                }}
                name={l.role === 'user' ? userName : charName}
                avatar={l.role === 'assistant' ? charAvatar : null}
                editing={editing === l.id}
                busy={running}
                onEdit={() => setEditing(l.id)}
                onCancelEdit={() => setEditing(null)}
                onSaveEdit={async (content) => {
                  await run({ op: 'edit', messageId: l.id, content });
                  setEditing(null);
                }}
                onSelect={(messageId) => void run({ op: 'select', messageId })}
                onDelete={() => confirm(l.candidateIds.length > 1 ? '删除当前这个候选？' : '删除这条消息？') && void run({ op: 'delete', messageId: l.id })}
                onReroll={() => void run({ op: 'reroll', messageId: l.id }, l.layer)}
                onRemoveNote={async (index) => {
                  await run({ op: 'removeNote', messageId: l.id, index });
                }}
                onBranch={async () => {
                  if (!confirm('从这条消息分支出一个新会话？\n到这条为止的内容会复制过去，原会话不变。')) return;
                  try {
                    const b = await api.branchSession(session.meta.id, l.id);
                    await openSession(b.meta.id);
                    notify('已切到新分支');
                  } catch (e) {
                    fail(e);
                  }
                }}
              />
            ),
          )}
          {live && !live.settled && live.layer === null && <LiveMessage live={live} name={charName} avatar={charAvatar} />}
          {live?.settled && live.error && (
            <div className="gen-error">
              {live.status === 'failed' ? '生成失败：' : '回复未完成：'}
              {live.error}
            </div>
          )}
        </div>
      </div>

      <div className="composer">
        {files.pending && <div className="composer-inner">{files.pending}</div>}
        <div className="composer-inner">
          <SessionTree />
          {files.button}
          <textarea
            className="textarea"
            rows={1}
            value={input}
            placeholder={`对 ${charName} 说…`}
            title="Enter 发送，Shift+Enter 换行"
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          {running ? (
            <button className="btn" onClick={() => live && void api.stop(live.id)} title="停止，已收到的内容会保存">
              <Icon name="stop" size={14} />
              停止
            </button>
          ) : (
            <>
              <button className="btn" onClick={() => void run({ op: 'continue' })} title="让角色接着说（新增一层）" disabled={layers.length === 0}>
                <Icon name="forward" size={14} />
                <span className="desktop-only">续写</span>
              </button>
              <button className="btn primary" onClick={send} disabled={(!input.trim() && files.items.length === 0) || files.uploading}>
                <Icon name="send" size={14} />
                发送
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function LiveMessage({ live, name, avatar }: { live: LiveGen; name: string; avatar: string | null }) {
  return (
    <div className="msg assistant">
      <div className="msg-head">
        {avatar && <img className="msg-avatar" src={avatar} alt="" />}
        <span className="who">{name}</span>
        <span className="chip accent">{live.status === 'running' ? '生成中' : '保存中'}</span>
      </div>
      <div className={`msg-body${live.status === 'running' ? ' cursor' : ''}`}>{live.text ? <FormattedText text={live.text} /> : <p className="faint">…</p>}</div>
    </div>
  );
}

interface LatestFlags {
  user: boolean;
  assistant: boolean;
  any: boolean;
}

function latestFlags(layers: readonly LayerView[], idx: number): LatestFlags {
  const last = (role?: 'user' | 'assistant') => {
    for (let j = layers.length - 1; j >= 0; j--) if (!role || layers[j]!.role === role) return j === idx;
    return false;
  };
  return { user: last('user'), assistant: last('assistant'), any: last() };
}

interface MessageProps {
  layer: LayerView;
  /** 角色头像（只给 AI 回复）。 */
  avatar: string | null;
  sessionId: string;
  name: string;
  /** 显示用的运行时正则（预设 + 角色卡）。 */
  scripts: readonly RegexScript[];
  /** 这条是否是已加载消息里最新的 user / assistant / 任意一条。 */
  latest: LatestFlags;
  editing: boolean;
  busy: boolean;
  onReceive: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (content: string) => Promise<void>;
  onSelect: (messageId: string) => void;
  onDelete: () => void;
  onReroll: () => void;
  onRemoveNote: (index: number) => Promise<void>;
  onBranch: () => void;
}

function Message({ layer: l, sessionId, name, avatar, scripts, latest, editing, busy, onReceive, onEdit, onCancelEdit, onSaveEdit, onSelect, onDelete, onReroll, onRemoveNote, onBranch }: MessageProps) {
  const [draft, setDraft] = useState(l.content);
  const [editingVars, setEditingVars] = useState(false);
  useEffect(() => setDraft(l.content), [l.content, editing]);
  const n = l.candidateIds.length;
  const i = l.selectedIndex;
  const u = l.usage;
  const { user: lastUser, assistant: lastAssistant, any: lastAny } = latest;
  const shown = useMemo(
    () =>
      displayText(l.content, l.role, scripts, (roles) =>
        roles.length > 1 ? lastAny : roles[0] === 'user' ? lastUser : lastAssistant,
      ),
    [l.content, l.role, scripts, lastUser, lastAssistant, lastAny],
  );
  const segments = useMemo(() => splitSegments(shown.text), [shown.text]);

  return (
    <div className={`msg ${l.role}`}>
      <div className="msg-head">
        {avatar && <img className="msg-avatar" src={avatar} alt="" />}
        <span className="who">{name}</span>
        {n > 1 && (
          <span className="candidates">
            <button className="btn ghost small icon" disabled={i === 0 || busy} onClick={() => onSelect(l.candidateIds[i - 1]!)} aria-label="上一个候选">
              <Icon name="left" size={13} />
            </button>
            {i + 1}/{n}
            <button className="btn ghost small icon" disabled={i === n - 1 || busy} onClick={() => onSelect(l.candidateIds[i + 1]!)} aria-label="下一个候选">
              <Icon name="right" size={13} />
            </button>
          </span>
        )}
        {l.partial && <span className="chip warn" title="停止或中断时保存的回复，会参与后续上下文">未完成</span>}
        <span className="msg-tools">
          <button className="btn ghost small icon" onClick={onEdit} title="编辑" disabled={editing}>
            <Icon name="edit" size={13} />
          </button>
          <button className={`btn ghost small icon${editingVars ? ' active' : ''}`} onClick={() => setEditingVars((v) => !v)} title="这一层的变量操作">
            <Icon name="sliders" size={13} />
          </button>
          <button className="btn ghost small icon" onClick={onReceive} title="重新执行返回时正则">
            <Icon name="regex" size={13} />
          </button>
          {l.role === 'assistant' && (
            <button className="btn ghost small icon" onClick={onReroll} title="重新生成" disabled={busy}>
              <Icon name="redo" size={13} />
            </button>
          )}
          <button className="btn ghost small icon" onClick={onBranch} title="从这条消息分支出一个新会话">
            <Icon name="branch" size={13} />
          </button>
          <button className="btn ghost small icon" onClick={onDelete} title="删除">
            <Icon name="trash" size={13} />
          </button>
        </span>
      </div>
      {editing ? (
        <div className="msg-edit">
          <textarea className="textarea" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
          <div className="row-end">
            <button className="btn small" onClick={onCancelEdit}>
              取消
            </button>
            <button className="btn small primary" disabled={draft === l.content} onClick={() => void onSaveEdit(draft)}>
              保存
            </button>
          </div>
        </div>
      ) : (
        <div className="msg-body">
          {segments.map((seg, k) =>
            seg.kind === 'html' ? (
              <Widget key={k} html={seg.html} sessionId={sessionId} messageId={l.id} />
            ) : (
              <FormattedText key={k} text={seg.text} />
            ),
          )}
        </div>
      )}
      <AttachmentList items={l.attachments} />
      {shown.error && <div className="chip warn" title={shown.error}>显示用正则出错，显示原文</div>}
      {l.notes.map((note, k) => (
        <div key={k} className="msg-note" title="附加消息：下一轮会作为一条 user 消息，紧跟在这条消息之后发给模型">
          <div className="msg-note-head">
            <span>附加消息</span>
            <span className="spacer" />
            <button
              className="btn ghost small icon"
              aria-label="删除附加消息"
              onClick={() => {
                if (confirm('删除这条附加消息？变量不会跟着撤销。')) void onRemoveNote(k);
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          <div className="msg-note-body">{note}</div>
        </div>
      ))}
      <VarOpsBar layer={l} sessionId={sessionId} editing={editingVars} onClose={() => setEditingVars(false)} />
      {u && (u.input !== undefined || u.output !== undefined) && (
        <div className="msg-foot" title="上游报告的用量">
          {u.input !== undefined && <span>输入 {u.input.toLocaleString()}</span>}
          {u.cacheRead ? <span style={{ color: 'var(--ok)' }}>缓存命中 {u.cacheRead.toLocaleString()}</span> : null}
          {u.cacheWrite ? <span>缓存写入 {u.cacheWrite.toLocaleString()}</span> : null}
          {u.output !== undefined && <span>输出 {u.output.toLocaleString()}</span>}
          {l.estimate && (
            <span title={`发送前的预估（校准后）${l.estimate.actual ? `；实际输入共 ${l.estimate.actual.toLocaleString()}，偏差 ${Math.round(((l.estimate.tokens - l.estimate.actual) / l.estimate.actual) * 100)}%` : ''}`}>
              预估 {l.estimate.tokens.toLocaleString()}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
