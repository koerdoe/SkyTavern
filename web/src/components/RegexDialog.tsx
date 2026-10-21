// 顶栏“正则”：当前预设与角色卡的全部正则脚本。可以新增、编辑、试运行，以及对当前会话重新执行返回时正则。

import { useEffect, useMemo, useState } from 'react';
import { checkScript, LibraryError, type ScriptDraft } from '../../../src/core/library.ts';
import { orderScripts, receiveMessage, runScripts, ScriptError, validateScript, type RegexScript, type ScriptRole } from '../../../src/core/scripts.ts';
import { formatOps } from '../../../src/core/vars.ts';
import { api } from '../api.ts';
import { useDirtyGuard, useStore } from '../store.tsx';
import { HelpLink, Icon, Modal, Switch } from '../ui.tsx';

type HostKind = 'preset' | 'character';
interface Row {
  script: RegexScript;
  kind: HostKind;
  hostId: string;
  hostName: string;
}

const STAGE_LABEL = (s: RegexScript): string => (s.stage === 'receive' ? '返回时' : { display: '显示', request: '请求', both: '显示+请求' }[s.target]);
const ACTION_LABEL: Record<RegexScript['action'], string> = { replace: '替换', prepend: '插到开头', append: '插到末尾' };

const blankScript = (): ScriptDraft => ({
  name: '新正则',
  enabled: true,
  stage: 'receive',
  target: 'both',
  roles: ['assistant'],
  action: 'replace',
  latestOnly: false,
  pattern: '',
  flags: 'g',
  replacement: '',
  priority: 0,
});

export function RegexDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const { docs, session } = store;
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const [kind, host] of [
      ['preset', docs.preset],
      ['character', docs.character],
    ] as const) {
      if (host) for (const script of host.scripts) out.push({ script, kind, hostId: host.id, hostName: host.name });
    }
    return out;
  }, [docs]);

  // 执行顺序：优先级降序，同优先级预设在前
  const ordered = useMemo(() => {
    const byScript = new Map(rows.map((r) => [r.script, r]));
    return orderScripts(rows.map((r) => r.script)).map((s) => byScript.get(s)!);
  }, [rows]);

  // 新增后自动展开
  useEffect(() => {
    if (pending && rows.some((r) => r.script.id === pending)) {
      setOpenId(pending);
      setPending(null);
    }
  }, [pending, rows]);

  const add = async (kind: HostKind) => {
    const host = kind === 'preset' ? docs.preset : docs.character;
    if (!host || !(await store.confirmLeave())) return;
    const id = `${host.id}-s${host.nextScriptId}`;
    if (await store.mutate(kind, host.id, [{ op: 'addScript', script: blankScript() }])) setPending(id);
  };

  const reapplyAll = async () => {
    if (!session) return;
    if (!confirm('对当前会话已加载的全部楼层重新执行返回时正则？\n正文会被改写，取出的变量操作会追加到对应楼层。')) return;
    try {
      const r = await api.receive(session.meta.id, session.layers.map((l) => l.id));
      await store.reloadSession();
      store.notify(`已处理 ${r.layers.length} 层`);
    } catch (e) {
      store.fail(e);
    }
  };

  return (
    <Modal
      title="正则"
      onClose={() => void store.confirmLeave().then((ok) => ok && onClose())}
      actions={
        <>
          <HelpLink to="variables#正则脚本" title="正则脚本说明" />
          <button className="btn small" onClick={() => void add('preset')} disabled={!docs.preset}>
            <Icon name="plus" size={13} />
            预设正则
          </button>
          <button className="btn small" onClick={() => void add('character')} disabled={!docs.character}>
            <Icon name="plus" size={13} />
            角色正则
          </button>
        </>
      }
      footer={
        <div className="row">
          <span className="faint" style={{ fontSize: 12 }}>
            按执行顺序排列：优先级大的先执行，同优先级预设在前。返回时正则只在消息进入会话时执行一次，改的是存下来的正文。
          </span>
          <span className="spacer" />
          <button className="btn small" onClick={() => void reapplyAll()} disabled={!session || session.layers.length === 0} title="改过正则后，补处理已有的消息">
            <Icon name="redo" size={13} />
            对当前会话重新执行
          </button>
        </div>
      }
    >
      <div className="modal-body" style={{ padding: 0 }}>
        {ordered.length === 0 && <div className="empty">还没有正则。预设和角色卡都可以挂正则。</div>}
        {ordered.map((r) => (
          <div key={r.script.id}>
            <div className={`entry-row script-row${openId === r.script.id ? ' selected' : ''}${r.script.enabled ? '' : ' disabled'}`} onClick={async () => (openId === r.script.id ? setOpenId(null) : (await store.confirmLeave()) && setOpenId(r.script.id))}>
              <span />
              <Switch
                checked={r.script.enabled}
                label={r.script.enabled ? '已启用' : '已禁用'}
                onChange={(v) => void store.mutate(r.kind, r.hostId, [{ op: 'updateScript', scriptId: r.script.id, patch: { enabled: v } }])}
              />
              <span className={`chip ${r.script.stage === 'receive' ? 'sec-insert' : 'sec-after'}`}>{STAGE_LABEL(r.script)}</span>
              <span className="prio">{r.script.priority}</span>
              <span className="entry-name">
                <span>{r.script.name || `/${r.script.pattern}/`}</span>
                <span className="src">
                  {r.kind === 'preset' ? '预设' : '角色'}·{r.hostName}
                </span>
              </span>
              <span className="entry-flags">
                {r.script.action !== 'replace' && <span className="chip plain">{ACTION_LABEL[r.script.action]}</span>}
                {r.script.stage === 'runtime' && r.script.latestOnly && (
                  <span className="chip plain" title="只作用于最新一条">
                    最新
                  </span>
                )}
                {r.script.roles.map((role) => (
                  <span key={role} className="chip plain" title={role === 'user' ? '作用于用户消息' : '作用于 AI 回复'}>
                    {role === 'user' ? 'U' : 'A'}
                  </span>
                ))}
              </span>
            </div>
            {openId === r.script.id && <ScriptEditor row={r} onClose={() => setOpenId(null)} />}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function ScriptEditor({ row, onClose }: { row: Row; onClose: () => void }) {
  const store = useStore();
  const [draft, setDraft] = useState<RegexScript>(row.script);
  const [sample, setSample] = useState('');
  const [sampleRole, setSampleRole] = useState<ScriptRole>(row.script.roles[0] ?? 'assistant');
  const dirty = JSON.stringify(draft) !== JSON.stringify(row.script);

  // 停用的正则可以先保存（例如导入时转不了的），启用时才必须是好的
  const error = useMemo(() => {
    try {
      checkScript(draft);
      validateScript(draft);
      return null;
    } catch (e) {
      return e instanceof LibraryError ? e.message : e instanceof ScriptError ? e.message : String(e);
    }
  }, [draft]);
  const canSave = error === null || !draft.enabled;

  // 试一试：只用这一条正则，在浏览器里直接跑
  const trial = useMemo(() => {
    if (error || !sample) return null;
    try {
      if (draft.stage === 'receive') {
        const r = receiveMessage(sample, sampleRole, [{ ...draft, enabled: true }]);
        return { text: r.text, ops: formatOps(r.ops), errors: r.errors.map((e) => `${e.text}：${e.message}`) };
      }
      const target = draft.target === 'request' ? 'request' : 'display';
      return { text: runScripts(sample, sampleRole, [{ ...draft, enabled: true }], { stage: 'runtime', target }), ops: '', errors: [] };
    } catch (e) {
      return { text: '', ops: '', errors: [e instanceof ScriptError ? e.detail : String(e)] };
    }
  }, [draft, sample, sampleRole, error]);

  const set = <K extends keyof RegexScript>(k: K, v: RegexScript[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async (): Promise<boolean> => {
    if (!canSave) return false;
    const { id: _id, ...patch } = draft;
    const ok = await store.mutate(row.kind, row.hostId, [{ op: 'updateScript', scriptId: row.script.id, patch }]);
    if (ok) onClose();
    return ok;
  };
  useDirtyGuard(dirty, save, () => setDraft(row.script));

  const remove = async () => {
    if (!confirm(`删除正则“${draft.name || draft.id}”？`)) return;
    if (await store.mutate(row.kind, row.hostId, [{ op: 'removeScript', scriptId: row.script.id }])) onClose();
  };

  return (
    <div className="entry-editor">
      <div className="grid-3">
        <label className="field">
          <span>名称</span>
          <input className="input" value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="field">
          <span>何时执行</span>
          <select className="select" value={draft.stage === 'receive' ? 'receive' : draft.target} onChange={(e) => {
            const v = e.target.value;
            setDraft((d) => (v === 'receive' ? { ...d, stage: 'receive' } : { ...d, stage: 'runtime', target: v as RegexScript['target'] }));
          }}>
            <option value="receive">返回时（改正文，可产生变量）</option>
            <option value="display">运行时 · 只作用于显示</option>
            <option value="request">运行时 · 只作用于请求</option>
            <option value="both">运行时 · 显示和请求</option>
          </select>
        </label>
        <label className="field">
          <span>优先级（大的先执行）</span>
          <input className="input mono" type="number" step={1} value={draft.priority} onChange={(e) => set('priority', Math.round(Number(e.target.value)))} />
        </label>
      </div>
      <div className="grid-3">
        <label className="field">
          <span>动作</span>
          <select className="select" value={draft.action} onChange={(e) => set('action', e.target.value as RegexScript['action'])}>
            <option value="replace">替换匹配到的文字</option>
            <option value="prepend">插到消息开头</option>
            <option value="append">插到消息末尾</option>
          </select>
        </label>
        <label className="field">
          <span>{draft.action === 'replace' ? '正则' : '条件正则（可留空：总是插入）'}</span>
          <input className="input mono" value={draft.pattern} onChange={(e) => set('pattern', e.target.value)} placeholder={draft.action === 'replace' ? '【伤害(\d+)】' : '留空'} />
        </label>
        <label className="field">
          <span>标志（g 为替换全部）</span>
          <input className="input mono" value={draft.flags} onChange={(e) => set('flags', e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span>
          {draft.action === 'replace'
            ? '替换为（$1 $& $<名> $$；返回时正则可以写 <var>hp -= $1</var>）'
            : '插入的内容（原样插入，和正文之间隔一个空行；```html 代码块会显示为组件）'}
        </span>
        <textarea className="textarea code" style={{ minHeight: draft.action === 'replace' ? 60 : 160 }} value={draft.replacement} onChange={(e) => set('replacement', e.target.value)} spellCheck={false} />
      </label>
      <div className="row">
        <span className="faint" style={{ fontSize: 12 }}>作用于</span>
        {(['user', 'assistant'] as const).map((role) => (
          <label key={role} className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={draft.roles.includes(role)} onChange={(e) => set('roles', e.target.checked ? [...draft.roles, role] : draft.roles.filter((r) => r !== role))} />
            {role === 'user' ? '用户消息' : 'AI 回复'}
          </label>
        ))}
        {draft.stage === 'runtime' && (
          <label className="row" style={{ gap: 4 }} title="只处理所选角色里最后一条消息，例如只在最新的 AI 回复下面挂商店">
            <input type="checkbox" checked={draft.latestOnly} onChange={(e) => set('latestOnly', e.target.checked)} />
            只作用于最新一条
          </label>
        )}
      </div>

      <div className="detail-block" style={{ padding: 8, borderRadius: 8, background: 'var(--surface)', border: '1px dashed var(--border-strong)' }}>
        <h3>
          试一试
          <span className="spacer" />
          <select className="select" style={{ width: 'auto', height: 24, minHeight: 24, padding: '0 6px', fontSize: 12 }} value={sampleRole} onChange={(e) => setSampleRole(e.target.value as ScriptRole)}>
            <option value="assistant">当作 AI 回复</option>
            <option value="user">当作用户消息</option>
          </select>
        </h3>
        <textarea className="textarea" style={{ minHeight: 50 }} placeholder="粘贴一段文字，看看这条正则会把它变成什么" value={sample} onChange={(e) => setSample(e.target.value)} />
        {trial && (
          <>
            {!draft.roles.includes(sampleRole) && <span className="chip warn">这条正则不作用于{sampleRole === 'user' ? '用户消息' : 'AI 回复'}，实际不会执行</span>}
            <pre className="json-view" style={{ whiteSpace: 'pre-wrap', padding: 8 }}>{trial.text || '（空）'}</pre>
            {trial.ops && <pre className="json-view" style={{ whiteSpace: 'pre-wrap', padding: 8, color: 'var(--ok)' }}>{trial.ops}</pre>}
            {trial.errors.map((e) => (
              <div key={e} className="gen-error">
                {e}
              </div>
            ))}
          </>
        )}
      </div>

      {error && <div className="gen-error">{error}{!draft.enabled && '（停用状态下可以先保存，修好后再启用）'}</div>}
      <div className="row">
        <span className="faint mono">{row.script.id}</span>
        <span className="spacer" />
        <button className="btn ghost danger-text small" onClick={() => void remove()}>
          删除
        </button>
        <button className="btn small" onClick={() => (setDraft(row.script), onClose())}>
          {dirty ? '放弃' : '收起'}
        </button>
        <button className="btn primary small" disabled={!dirty || !canSave} onClick={() => void save()}>
          保存
        </button>
      </div>
    </div>
  );
}
