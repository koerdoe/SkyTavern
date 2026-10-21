// 模型配置：协议、Base URL、API 密钥、模型名（可拉取列表）。与预设分开。

import { useEffect, useState } from 'react';
import { PROTOCOLS, type ModelConfig, type Protocol } from '../../../src/core/library.ts';
import { chooseTokenizer, TOKENIZER_IDS, TOKENIZER_PROFILES } from '../../../src/core/tokens.ts';
import { api, errorText, type ModelView } from '../api.ts';
import { useDirtyGuard, useStore } from '../store.tsx';
import { HelpLink, Icon, Modal } from '../ui.tsx';

const PROTOCOL_LABEL: Record<Protocol, string> = {
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  claude: 'Claude Messages',
  gemini: 'Gemini generateContent',
};
const BASE_HINT: Record<Protocol, string> = {
  'openai-chat': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

type Form = { name: string; protocol: Protocol; baseUrl: string; apiKey: string; model: string; tokenizer: ModelConfig['tokenizer']; use: ModelConfig['use'] };
const blank = (): Form => ({ name: '新模型', protocol: 'claude', baseUrl: BASE_HINT.claude, apiKey: '', model: '', tokenizer: 'auto', use: 'chat' });

export function ModelDialog({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const { lists, settings } = store;
  const [selected, setSelected] = useState<string | null>(settings?.modelId ?? lists.model[0]?.id ?? null);
  const [current, setCurrent] = useState<ModelView | null>(null);
  const [form, setForm] = useState<Form>(blank);
  /** 最近一次载入或保存时的表单，用来判断有没有未保存的修改。 */
  const [baseline, setBaseline] = useState<Form>(blank);
  const [models, setModels] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);

  useEffect(() => {
    setModels([]);
    if (!selected) {
      setCurrent(null);
      setForm(blank());
      setBaseline(blank());
      return;
    }
    void api.get('model', selected).then((m) => {
      const loaded: Form = { name: m.name, protocol: m.protocol, baseUrl: m.baseUrl, apiKey: '', model: m.model, tokenizer: m.tokenizer ?? 'auto', use: m.use ?? 'chat' };
      setCurrent(m);
      setForm(loaded);
      setBaseline(loaded);
    }, store.fail);
  }, [selected, store.fail]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (): Promise<boolean> => {
    try {
      // 密钥留空表示不修改
      const { apiKey, ...rest } = form;
      const body = apiKey ? form : rest;
      const doc = selected ? await api.replace('model', selected, body) : await api.create('model', body);
      await store.reloadList('model');
      const saved: Form = { ...form, apiKey: '' };
      setForm(saved);
      setBaseline(saved);
      setCurrent(doc);
      setSelected(doc.id);
      store.notify('已保存');
      return true;
    } catch (e) {
      store.fail(e);
      return false;
    }
  };
  useDirtyGuard(dirty, save, () => setForm(baseline));

  /** 离开当前配置（关闭、切换）前，有未保存修改就先询问。 */
  const leave = async (then: () => void) => {
    if (await store.confirmLeave()) then();
  };

  // 用表单里的当前值拉取，不必先保存；密钥留空时服务端沿用已保存的密钥。
  const fetchModels = async () => {
    setFetching(true);
    try {
      const draft = {
        protocol: form.protocol,
        baseUrl: form.baseUrl,
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
        ...(selected ? { modelId: selected } : {}),
      };
      setModels((await api.listModels(draft)).models);
    } catch (e) {
      store.notify(`拉取失败：${errorText(e)}`, 'error');
    } finally {
      setFetching(false);
    }
  };

  const remove = async () => {
    if (!selected || !confirm(`删除模型配置“${form.name}”？`)) return;
    try {
      await api.remove('model', selected);
      await store.reloadList('model');
      setSelected(null);
    } catch (e) {
      store.fail(e);
    }
  };

  const embedding = form.use === 'embedding';
  const inUse = selected !== null && (embedding ? settings?.recall.embeddingModelId === selected : settings?.modelId === selected);
  const autoChoice = chooseTokenizer({ model: form.model, protocol: form.protocol }, settings?.tokenizerPriority ?? 'name');

  return (
    <Modal title="模型配置" onClose={() => void leave(onClose)}>
      <div className="split">
        <div className="split-list">
          {lists.model.map((m) => (
            <button key={m.id} aria-current={m.id === selected} onClick={() => m.id !== selected && void leave(() => setSelected(m.id))}>
              <span>
                {m.name} {m.use === 'embedding' && <span className="chip">嵌入</span>}
                {settings?.modelId === m.id && <span className="chip accent">使用中</span>}
                {settings?.recall.embeddingModelId === m.id && <span className="chip accent">召回用</span>}
              </span>
            </button>
          ))}
          <button aria-current={selected === null} onClick={() => selected !== null && void leave(() => setSelected(null))}>
            <span className="row">
              <Icon name="plus" size={13} />
              新建
            </span>
          </button>
        </div>
        <div className="modal-body" style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
          <label className="field">
            <span>名称</span>
            <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </label>
          <label className="field">
            <span className="row" style={{ gap: 6 }}>
              用途
              <HelpLink to="request-structure#召回" />
            </span>
            <select className="select" value={form.use} onChange={(e) => set('use', e.target.value as Form['use'])}>
              <option value="chat">对话</option>
              <option value="embedding">嵌入（只用于召回）</option>
            </select>
            {embedding && (
              <span className={form.protocol === 'claude' ? 'faint danger-text' : 'faint'}>
                {form.protocol === 'claude'
                  ? 'Claude 没有嵌入接口，请选 OpenAI 兼容（发到 Base URL 下的 /embeddings）或 Gemini。'
                  : form.protocol === 'gemini'
                    ? '发到 Gemini 的 batchEmbedContents，例如 gemini-embedding-001。'
                    : '发到 Base URL 下的 /embeddings，例如 text-embedding-3-small，或其他兼容渠道的嵌入模型。'}
              </span>
            )}
          </label>
          <label className="field">
            <span>协议</span>
            <select
              className="select"
              value={form.protocol}
              onChange={(e) => {
                const p = e.target.value as Protocol;
                setForm((f) => ({ ...f, protocol: p, baseUrl: Object.values(BASE_HINT).includes(f.baseUrl) || !f.baseUrl ? BASE_HINT[p] : f.baseUrl }));
              }}
            >
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {PROTOCOL_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Base URL</span>
            <input className="input mono" value={form.baseUrl} placeholder={BASE_HINT[form.protocol]} onChange={(e) => set('baseUrl', e.target.value)} />
          </label>
          <label className="field">
            <span>API 密钥 {current?.hasKey && <span className="chip ok">已设置</span>}</span>
            <input
              className="input mono"
              type="password"
              autoComplete="off"
              value={form.apiKey}
              placeholder={current?.hasKey ? '留空则不修改' : 'sk-…'}
              onChange={(e) => set('apiKey', e.target.value)}
            />
          </label>
          <label className="field">
            <span>模型</span>
            <div className="row">
              <input className="input mono" list="model-options" value={form.model} onChange={(e) => set('model', e.target.value)} placeholder="模型名" />
              <button className="btn" onClick={() => void fetchModels()} disabled={fetching}>
                {fetching ? '拉取中…' : '拉取列表'}
              </button>
            </div>
            <datalist id="model-options">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {models.length > 0 && <span className="faint">共 {models.length} 个，点输入框选择</span>}
          </label>
          {!embedding && <label className="field">
            <span className="row" style={{ gap: 6 }}>
              分词器（预估 token 用）
              <HelpLink to="request-params#token-预估" />
            </span>
            <select className="select" value={form.tokenizer} onChange={(e) => set('tokenizer', e.target.value as Form['tokenizer'])}>
              <option value="auto">自动：{autoChoice.profile.label}</option>
              {TOKENIZER_IDS.map((id) => (
                <option key={id} value={id}>
                  {TOKENIZER_PROFILES[id].label}
                </option>
              ))}
            </select>
            <span className="faint">
              {form.tokenizer === 'auto' ? autoChoice.reason : '手动指定'}。预估会按每次回复的实际用量自动校准。
            </span>
          </label>}
          <div className="row" style={{ marginTop: 6 }}>
            {selected && (
              <button className="btn ghost danger-text" onClick={() => void remove()}>
                删除
              </button>
            )}
            <span className="spacer" />
            {selected && (
              <button
                className="btn"
                disabled={inUse}
                onClick={async () => {
                  // 有未保存的修改时先保存，确保用的是眼前这份配置
                  if (dirty && !(await save())) return;
                  await (embedding
                    ? store.saveSettings({ recall: { ...settings!.recall, embeddingModelId: selected } })
                    : store.saveSettings({ modelId: selected }));
                }}
              >
                {inUse ? (embedding ? '正在用于召回' : '正在使用') : embedding ? '用于召回' : '使用这个'}
              </button>
            )}
            {dirty && <span className="chip warn">未保存</span>}
            <button className="btn primary" disabled={!dirty && selected !== null} onClick={() => void save()}>
              保存
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
