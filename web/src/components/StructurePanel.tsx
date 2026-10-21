// 左栏：请求结构。预设、角色卡、自机、世界书的词条合并成一个扁平列表，从上往下就是最终请求。

import { useEffect, useMemo, useState } from 'react';
import { checkDoc, DEFAULT_TRIM_ROUNDS, LibraryError, MAX_TRIM_ROUNDS, type Preset } from '../../../src/core/library.ts';
import { checkRisks, type Risk } from '../../../src/core/risks.ts';
import { api } from '../api.ts';
import { newEntryDraft, type EntryItem, type Group } from '../entries.ts';
import { useStore } from '../store.tsx';
import { HelpLink, Icon, Modal } from '../ui.tsx';
import { EntryList } from './EntryList.tsx';
import { InitialVars } from './InitialVars.tsx';
import { RequestJsonRow } from './RequestJsonRow.tsx';
import { tokenizerTitle } from '../tokens.ts';

const riskKey = (r: Risk) => `${r.kind}|${r.entryIds.join(',')}|${r.message}`;

export function StructurePanel() {
  const store = useStore();
  const { docs, preview, previewError, settings, lists, mutate, saveSettings, session } = store;
  const preset = docs.preset;
  const [showParams, setShowParams] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [addGroup, setAddGroup] = useState<Group>('before');

  const items: EntryItem[] = useMemo(() => {
    const out: EntryItem[] = [];
    const push = (kind: EntryItem['kind'], c: { id: string; name: string; entries: EntryItem['entry'][] } | null) => {
      if (c) for (const entry of c.entries) out.push({ entry, kind, containerId: c.id, containerName: c.name });
    };
    push('preset', docs.preset);
    push('character', docs.character);
    push('persona', docs.persona);
    for (const w of docs.worldbooks) push('worldbook', w);
    return out;
  }, [docs]);

  // 风险检查：相关配置不变就只提示一次。
  const unacked = useMemo(() => {
    if (!settings) return [];
    const acked = new Set(settings.ui.ackedRisks);
    return checkRisks(items.map((i) => i.entry)).filter((r) => !acked.has(riskKey(r)));
  }, [items, settings]);
  const [riskDismissed, setRiskDismissed] = useState<string>('');
  const riskSig = unacked.map(riskKey).join('\n');
  const showRisks = unacked.length > 0 && riskDismissed !== riskSig;

  const ackRisks = async () => {
    if (!settings) return;
    await saveSettings({ ui: { ...settings.ui, ackedRisks: [...settings.ui.ackedRisks, ...unacked.map(riskKey)] } });
  };

  const addEntry = async () => {
    if (!preset) return;
    await store.addEntry('preset', preset.id, newEntryDraft(addGroup), 'structure');
  };

  const duplicatePreset = async () => {
    if (!preset) return;
    try {
      const copy = await api.create('preset', { ...preset, name: `${preset.name} 副本` });
      await store.reloadList('preset');
      await saveSettings({ presetId: copy.id });
    } catch (e) {
      store.fail(e);
    }
  };

  const deletePreset = async () => {
    if (!preset || !confirm(`删除预设“${preset.name}”？`)) return;
    try {
      await api.remove('preset', preset.id);
      await store.reloadList('preset');
      const next = lists.preset.find((p) => p.id !== preset.id);
      await saveSettings({ presetId: next?.id ?? null });
    } catch (e) {
      store.fail(e);
    }
  };

  const setParam = (field: 'inputLimit' | 'cacheMode' | 'name' | 'trimRounds', value: unknown) => preset && void mutate('preset', preset.id, [{ op: 'set', field, value }]);

  return (
    <>
      <div className="panel-head">
        <h2>请求结构</h2>
        <HelpLink to="request-structure" title="请求结构说明" />
        <span className="spacer" />
        <button className={`btn small${store.view === 'preview' ? ' active' : ''}`} onClick={() => store.setView(store.view === 'preview' ? 'chat' : 'preview')} title="查看实际发送的内容">
          <Icon name="eye" size={14} />
          预览
        </button>
        <button className="btn ghost small icon panel-close" onClick={() => store.setMobilePanel('none')} aria-label="关闭">
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="structure-toolbar">
        <div className="row">
          <select
            className="select"
            value={settings?.presetId ?? ''}
            onChange={async (e) => (await store.confirmLeave()) && void saveSettings({ presetId: e.target.value })}
            aria-label="当前预设"
          >
            {lists.preset.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn small icon" title="复制为新预设" onClick={() => void duplicatePreset()}>
            <Icon name="plus" size={14} />
          </button>
          <button className="btn small icon" title="JSON 模式" onClick={() => setJsonOpen(true)} disabled={!preset}>
            <Icon name="code" size={14} />
          </button>
          <button className={`btn small icon${showParams ? ' active' : ''}`} title="预设设置与参数" onClick={() => setShowParams((v) => !v)}>
            <Icon name="gear" size={14} />
          </button>
        </div>

        {showParams && preset && <PresetParams preset={preset} onSet={setParam} onDelete={() => void deletePreset()} canDelete={lists.preset.length > 1} />}

        <div className="row">
          <select className="select" value={addGroup} onChange={(e) => setAddGroup(e.target.value as Group)} aria-label="新词条的位置" style={{ width: 'auto' }}>
            <option value="system">系统提示</option>
            <option value="before">正文前</option>
            <option value="chat">正文 D0</option>
            <option value="after">正文后</option>
            <option value="insert">插入规则</option>
          </select>
          <button className="btn small" onClick={() => void addEntry()} disabled={!preset}>
            <Icon name="plus" size={14} />
            预设词条
          </button>
          <span className="spacer" />
          {preview && (
            <span className="faint" title={tokenizerTitle(preview.tokenizer)}>
              约 {preview.tokens.toLocaleString()} token
            </span>
          )}
        </div>
        {previewError && (
          <div className="gen-error">
            {previewError.body.message}
          </div>
        )}
        {preview && preview.warnings.length > 0 && (
          <div className="chip warn" style={{ height: 'auto', padding: '4px 8px', whiteSpace: 'normal' }}>
            {preview.warnings.length} 条警告：{preview.warnings.map((w) => w.message).join('；')}
          </div>
        )}
      </div>

      <div className="panel-body">
        {preset && <RequestJsonRow preset={preset} protocol={preview?.protocol ?? null} />}
        <EntryList items={items} outcomes={preview?.outcomes} tokens={preview?.entryTokens} merged historyCount={session?.total} scope="structure" />
      </div>

      {jsonOpen && preset && <PresetJson preset={preset} onClose={() => setJsonOpen(false)} />}

      {showRisks && (
        <div className="modal-backdrop">
          <div className="modal modal-small" role="alertdialog" aria-labelledby="risk-title">
            <h2 id="risk-title" className="row" style={{ gap: 6 }}>
              发现可能的风险
              <HelpLink to="request-structure#风险提示" />
            </h2>
            <ul className="risk-list">
              {unacked.map((r) => (
                <li key={riskKey(r)}>
                  <strong>{r.kind === 'cache-break' ? '缓存破坏' : '递归插入'}</strong>
                  <span>{r.message}</span>
                  <span className="faint mono">{r.entryIds.join('、')}</span>
                </li>
              ))}
            </ul>
            <p className="muted" style={{ margin: 0 }}>
              确认后，相关配置不变就不再提示。
            </p>
            <div className="row-end">
              <button className="btn" onClick={() => setRiskDismissed(riskSig)}>
                稍后
              </button>
              <button className="btn primary" onClick={() => void ackRisks()}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PresetParams({ preset, onSet, onDelete, canDelete }: { preset: Preset; onSet: (f: 'inputLimit' | 'cacheMode' | 'name' | 'trimRounds', v: unknown) => void; onDelete: () => void; canDelete: boolean }) {
  const [name, setName] = useState(preset.name);
  useEffect(() => setName(preset.name), [preset.name]);
  return (
    <div className="detail-block" style={{ padding: 10, background: 'var(--surface-2)', borderRadius: 8 }}>
      <label className="field">
        <span>预设名称</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== preset.name && onSet('name', name.trim())} />
      </label>
      <div className="grid-2">
        <label className="field">
          <span className="row" style={{ gap: 6 }}>
            缓存断点
            <HelpLink to="request-params#断点" />
          </span>
          <select className="select" value={preset.cacheMode} onChange={(e) => onSet('cacheMode', e.target.value)}>
            <option value="auto">自动</option>
            <option value="manual">手动（缓存断点词条）</option>
          </select>
        </label>
        <label className="field">
          <span className="row" style={{ gap: 6 }}>
            输入上限（token，空为不裁剪）
            <HelpLink to="request-params#正文裁剪" />
          </span>
          <input
            className="input mono"
            type="number"
            min={1}
            defaultValue={preset.inputLimit ?? ''}
            onBlur={(e) => {
              const raw = e.target.value.trim();
              const v = raw === '' ? undefined : Math.round(Number(raw));
              if (v !== preset.inputLimit) onSet('inputLimit', v);
            }}
          />
        </label>
      </div>
      <label className="field" style={{ maxWidth: 260 }}>
        <span className="row" style={{ gap: 6 }}>
          超出上限时一次腾出约几轮
          <HelpLink to="request-params#正文裁剪" />
        </span>
        <input
          className="input mono"
          type="number"
          min={1}
          max={MAX_TRIM_ROUNDS}
          defaultValue={preset.trimRounds}
          disabled={preset.inputLimit === undefined}
          title={preset.inputLimit === undefined ? '没设输入上限时不裁剪' : '一轮 = 一问一答。越多，裁一次之后能撑越久不再裁，缓存越稳；但一次丢掉的内容也越多'}
          onBlur={(e) => {
            const v = Math.min(MAX_TRIM_ROUNDS, Math.max(1, Math.round(Number(e.target.value) || DEFAULT_TRIM_ROUNDS)));
            e.target.value = String(v);
            if (v !== preset.trimRounds) onSet('trimRounds', v);
          }}
        />
      </label>
      <p className="faint" style={{ margin: 0 }}>
        max_tokens、temperature、thinking 等发给模型的参数，写在列表最上方的“请求参数”里。
      </p>
      <InitialVars kind="preset" id={preset.id} value={preset.initialVars} />
      {canDelete && (
        <div className="row-end">
          <button className="btn small ghost danger-text" onClick={onDelete}>
            删除这个预设
          </button>
        </div>
      )}
    </div>
  );
}

/** JSON 模式：保存前用 core 校验，不合规则不能保存。 */
function PresetJson({ preset, onClose }: { preset: Preset; onClose: () => void }) {
  const store = useStore();
  const [text, setText] = useState(() => JSON.stringify(preset, null, 2));
  const error = useMemo(() => {
    try {
      checkDoc('preset', { ...(JSON.parse(text) as object), id: preset.id });
      return null;
    } catch (e) {
      return e instanceof SyntaxError ? `JSON 语法错误：${e.message}` : e instanceof LibraryError ? e.message : String(e);
    }
  }, [text, preset.id]);

  const save = async () => {
    try {
      await api.replace('preset', preset.id, JSON.parse(text) as Record<string, unknown>);
      await Promise.all([store.reloadList('preset'), store.reloadDocs()]);
      store.refreshPreview();
      onClose();
    } catch (e) {
      store.fail(e);
    }
  };

  return (
    <Modal
      title={`JSON · ${preset.name}`}
      onClose={onClose}
      footer={
        <div className="row">
          <span className={error ? 'danger-text' : 'muted'} style={{ fontSize: 12 }}>
            {error ?? '格式正确'}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={error !== null} onClick={() => void save()}>
            保存
          </button>
        </div>
      }
    >
      <div className="modal-body" style={{ padding: 0, display: 'flex' }}>
        <textarea className="textarea code" style={{ border: 0, borderRadius: 0, minHeight: '60vh', flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      </div>
    </Modal>
  );
}
