// /admin：Debug 模式（截取 → 改请求体 → 发送）、最近一次发送的请求、局部变量（第 5 步）。

import { useCallback, useEffect, useState } from 'react';
import type { VarValue } from '../../../src/core/types.ts';
import { formatValue, literal } from '../../../src/core/vars.ts';
import type { RecallStatus, SessionMeta, VarsReport } from '../../../src/core/views.ts';
import { api, errorText, watchGeneration, type AttachmentInfo } from '../api.ts';
import { fileSize } from '../components/Attachments.tsx';
import { PreviewView } from '../components/PreviewView.tsx';
import { opText } from '../components/VarOpsBar.tsx';
import { useStore } from '../store.tsx';
import { formatTime, HelpLink, Icon } from '../ui.tsx';

export function AdminPage() {
  const store = useStore();
  const { session, lists } = store;
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sid, setSid] = useState<string>('');
  const [text, setText] = useState('');
  const [hasSnap, setHasSnap] = useState(false);
  const [out, setOut] = useState<{ text: string; status: string; error?: string } | null>(null);
  const [lastSent, setLastSent] = useState<Awaited<ReturnType<typeof api.snapshot>>>(null);

  useEffect(() => {
    void api.allSessions().then((l) => {
      setSessions(l);
      setSid((cur) => cur || session?.meta.id || l[0]?.id || '');
    }, store.fail);
  }, [session?.meta.id, store.fail]);

  useEffect(() => {
    if (!sid) return;
    setOut(null);
    void api.debug.get(sid).then((d) => {
      setHasSnap(d !== null);
      setText(d ? JSON.stringify(d.body, null, 2) : '');
    }, store.fail);
    void api.snapshot(sid).then(setLastSent, store.fail);
  }, [sid, store.fail]);

  let parsed: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch (e) {
    parseError = (e as Error).message;
  }

  const capture = async () => {
    try {
      const d = await api.debug.create(sid);
      setHasSnap(true);
      setText(JSON.stringify(d.body, null, 2));
    } catch (e) {
      store.fail(e);
    }
  };

  const send = async () => {
    if (!parsed) return;
    try {
      await api.debug.update(sid, parsed);
      const { generationId } = await api.debug.send(sid);
      setOut({ text: '', status: 'running' });
      watchGeneration(generationId, (e) => {
        if (e.type === 'snapshot') setOut({ text: e.text, status: e.status });
        else if (e.type === 'delta') setOut((o) => o && { ...o, text: o.text + e.text });
        else setOut((o) => o && { ...o, status: e.status, ...(e.error ? { error: e.error } : {}) });
      });
    } catch (e) {
      setOut({ text: '', status: 'failed', error: errorText(e) });
    }
  };

  const charName = (id: string) => lists.character.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="admin">
      <header className="topbar" style={{ height: 46 }}>
        <a className="btn ghost small" href="/">
          <Icon name="back" size={14} />
          返回对话
        </a>
        <strong>管理与调试</strong>
        <span className="spacer" />
        {sessions.length === 0 && <span className="faint">还没有会话</span>}
        <select className="select" style={{ width: 'auto', display: sessions.length ? undefined : 'none' }} value={sid} onChange={(e) => setSid(e.target.value)} aria-label="会话">
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {charName(s.characterId)} · {formatTime(s.lastActiveAt)}
            </option>
          ))}
        </select>
      </header>
      <div className="admin-inner">
        <section className="card">
          <div className="row">
            <h2>Debug 请求</h2>
            <HelpLink to="getting-started#管理与调试admin" />
            <span className="spacer" />
            <button className="btn small" onClick={() => void capture()} disabled={!sid}>
              {hasSnap ? '重新截取' : '截取当前请求'}
            </button>
            {hasSnap && (
              <button
                className="btn small ghost"
                onClick={() => void api.debug.drop(sid).then(() => (setHasSnap(false), setText('')), store.fail)}
              >
                丢弃
              </button>
            )}
          </div>
          <p className="muted" style={{ margin: 0 }}>
            截取后，会话和配置的任何变化都不会影响这份请求体。发送的回复写入正式聊天，落在截取时对应的层。服务重启后快照清空。
          </p>
          {hasSnap ? (
            <>
              <textarea className="textarea code" style={{ minHeight: 360 }} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
              <div className="row">
                <span className={parseError ? 'danger-text' : 'faint'} style={{ fontSize: 12 }}>
                  {parseError ? `JSON 语法错误：${parseError}` : '密钥在发送时由服务端加上，不在这里'}
                </span>
                <span className="spacer" />
                <button className="btn primary" disabled={!parsed || out?.status === 'running'} onClick={() => void send()}>
                  <Icon name="send" size={14} />
                  发送
                </button>
              </div>
            </>
          ) : (
            <div className="empty">还没有截取</div>
          )}
          {out && (
            <div className="detail-block">
              <h3>
                回复 <span className="chip plain">{out.status}</span>
              </h3>
              {out.error && <div className="gen-error">{out.error}</div>}
              <pre className="json-view" style={{ whiteSpace: 'pre-wrap' }}>
                {out.text || '…'}
              </pre>
            </div>
          )}
        </section>

        <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 700 }}>
            {lastSent ? <PreviewView data={lastSent} title="最近一次实际发送的请求（只读）" /> : <div className="empty">这个会话还没有发送过请求</div>}
          </div>
        </section>

        {sid && <VarsCard sessionId={sid} />}
        {sid && <RecallCard sessionId={sid} />}
        <AttachmentsCard />
      </div>
    </div>
  );
}

/** 逐层变量表：每层的操作、不生效的原因、执行后的状态。 */
function VarsCard({ sessionId }: { sessionId: string }) {
  const store = useStore();
  const [report, setReport] = useState<VarsReport | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(true);

  const load = useCallback(() => void api.vars(sessionId).then(setReport, store.fail), [sessionId, store.fail]);
  useEffect(load, [load]);

  if (!report) return null;
  const names = [...new Set([...Object.keys(report.initial), ...report.layers.flatMap((l) => Object.keys(l.state))])].sort();
  const rows = onlyChanged ? report.layers.filter((l) => l.ops.length > 0 || l.errors.length > 0) : report.layers;
  const cell = (v: VarValue | undefined) =>
    v === undefined ? null : typeof v === 'object' ? (
      <span className="var-json" title={formatValue(v, true)}>
        {literal(v)}
      </span>
    ) : (
      literal(v)
    );

  return (
    <section className="card">
      <div className="row">
        <h2>局部变量</h2>
        <HelpLink to="variables#在-admin-查看" />
        <span className="spacer" />
        <label className="row" style={{ gap: 4, fontSize: 12 }}>
          <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
          只看有操作的楼层
        </label>
        <button className="btn small" onClick={load}>
          刷新
        </button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        状态不单独存储：从初始值开始，按当前选用的候选逐层重放。切换候选、修改操作后自动重算。
      </p>
      {names.length === 0 ? (
        <div className="empty">这个会话还没有变量</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="var-table">
            <thead>
              <tr>
                <th>层</th>
                <th>操作</th>
                {names.map((n) => (
                  <th key={n} className="mono">
                    {n}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="initial">
                <td>初始</td>
                <td />
                {names.map((n) => (
                  <td key={n} className="mono">
                    {cell(report.initial[n])}
                  </td>
                ))}
              </tr>
              {rows.map((l) => {
                const warned = new Map(l.warnings.map((w) => [w.index, w.message]));
                return (
                  <tr key={l.messageId}>
                    <td className="mono">
                      #{l.layer + 1} <span className="faint">{l.role === 'user' ? 'U' : 'A'}</span>
                    </td>
                    <td>
                      <div className="var-bar">
                        {l.ops.map((o, i) => (
                          <span key={i} className={`chip ${warned.has(i) ? 'danger' : 'ok'}`} title={warned.get(i)}>
                            {opText(o)}
                          </span>
                        ))}
                        {l.errors.length > 0 && (
                          <span className="chip warn" title={l.errors.map((e) => e.message).join('\n')}>
                            {l.errors.length} 处无效
                          </span>
                        )}
                      </div>
                    </td>
                    {names.map((n) => (
                      <td key={n} className="mono">
                        {cell(l.state[n])}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const RECALL_MODE: Record<RecallStatus['mode'], string> = { off: '关闭', keyword: '关键词', vector: '向量', hybrid: '混合' };

/** 召回索引：当前会话切了多少块、用当前嵌入模型建好了多少，后台出错时的原因；可以手动重试。 */
function RecallCard({ sessionId }: { sessionId: string }) {
  const store = useStore();
  const [st, setSt] = useState<RecallStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => void api.recallStatus(sessionId).then(setSt, store.fail), [sessionId, store.fail]);
  useEffect(load, [load]);
  if (!st) return null;
  const vector = st.mode === 'vector' || st.mode === 'hybrid';
  const retry = async () => {
    setBusy(true);
    try {
      setSt(await api.reindexRecall(sessionId));
      store.notify('索引已补齐');
    } catch (e) {
      store.fail(e);
      load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <div className="row">
        <h2>召回索引</h2>
        <HelpLink to="request-structure#召回" />
        <span className="chip plain">{RECALL_MODE[st.mode]}</span>
        <span className="spacer" />
        <button className="btn small" onClick={load}>
          刷新
        </button>
        {vector && (
          <button className="btn small primary" disabled={busy || !st.model} onClick={() => void retry()}>
            {busy ? '建索引中…' : '补齐索引'}
          </button>
        )}
      </div>
      {!vector ? (
        <p className="muted" style={{ margin: 0 }}>
          {st.mode === 'off' ? '召回已关闭。' : '关键词召回不需要索引，每次直接按聊天记录打分。'}当前会话共 {st.chunks} 块。
        </p>
      ) : (
        <>
          <p className="muted" style={{ margin: 0 }}>
            嵌入模型：{st.model ?? <span className="danger-text">未选择或不可用（系统设置 → 召回）</span>}。 当前选用的这条线上共 {st.chunks} 块，已建索引 {st.indexed} 块
            {st.state === 'indexing' && '，正在建索引…'}。
          </p>
          {st.state === 'error' && st.error && (
            <div className="gen-error">
              后台建索引失败{st.at ? `（${formatTime(st.at)}）` : ''}：{st.error}
            </div>
          )}
          <p className="faint" style={{ margin: 0, fontSize: 12 }}>
            新消息进入会话后会在后台补索引；没补上的部分会在下次需要召回时当场补，补不上则那次生成报错。
          </p>
        </>
      )}
    </section>
  );
}

/** 附件：大小、被几个会话引用；没被引用的显示什么时候会被清理。 */
function AttachmentsCard() {
  const store = useStore();
  const [list, setList] = useState<AttachmentInfo[] | null>(null);
  const load = useCallback(() => void api.attachments().then(setList, store.fail), [store.fail]);
  useEffect(load, [load]);
  if (!list) return null;
  const total = list.reduce((n, a) => n + a.size, 0);
  return (
    <section className="card">
      <div className="row">
        <h2>附件</h2>
        <span className="faint">
          {list.length} 个，共 {fileSize(total)}
        </span>
        <span className="spacer" />
        <button className="btn small" onClick={load}>
          刷新
        </button>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        相同内容的文件只存一份。没被任何会话引用的附件会在一段时间后自动清理（config.json 的 attachmentRetentionDays，默认 7 天）；被引用的不能删除。
      </p>
      {list.length === 0 ? (
        <div className="empty">还没有附件</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="var-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>大小</th>
                <th>引用</th>
                <th>上传时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td>
                    <a href={`/api/attachments/${a.id}?download`}>{a.name}</a>
                  </td>
                  <td className="mono">{a.mime}</td>
                  <td className="mono">{fileSize(a.size)}</td>
                  <td>{a.refs > 0 ? `${a.refs} 个会话` : <span className="faint">无（{formatTime(a.orphanedAt ?? a.createdAt)} 起）</span>}</td>
                  <td>{formatTime(a.createdAt)}</td>
                  <td>
                    <button
                      className="btn ghost small danger-text"
                      disabled={a.refs > 0}
                      title={a.refs > 0 ? '还被引用，不能删除' : '删除'}
                      onClick={async () => {
                        if (!confirm(`删除附件“${a.name}”？`)) return;
                        try {
                          await api.deleteAttachment(a.id);
                          load();
                        } catch (e) {
                          store.fail(e);
                        }
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
