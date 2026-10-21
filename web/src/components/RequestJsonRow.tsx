// 预设最上方的“请求参数”：宽松 JSON，按协议原生字段写，合并进请求体。
// 实时校验（语法、缺逗号、固定字段）；当前协议必需但没写的字段，打开时自动补进草稿。

import { useMemo, useState } from 'react';
import type { Preset, Protocol } from '../../../src/core/library.ts';
import { addMissingFields, checkRequestJson, parseRequestJson } from '../../../src/core/request-json.ts';
import { useDirtyGuard, useStore } from '../store.tsx';
import { HelpLink } from '../ui.tsx';

const PROTOCOL_NAME: Record<Protocol, string> = {
  'openai-chat': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  claude: 'Claude',
  gemini: 'Gemini',
};

const PLACEHOLDER = `// 按当前协议的原生字段书写，最外层花括号可省，键可不加引号，例如：
thinking: { "type": "disabled" },
max_tokens: 4096,
temperature: 1`;

export function RequestJsonRow({ preset, protocol }: { preset: Preset; protocol: Protocol | null }) {
  const { mutate } = useStore();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(preset.requestJson);
  const [autoAdded, setAutoAdded] = useState<string[]>([]);
  const dirty = open && draft !== preset.requestJson;

  const check = useMemo(() => checkRequestJson(draft, protocol), [draft, protocol]);
  const saved = useMemo(() => checkRequestJson(preset.requestJson, protocol), [preset.requestJson, protocol]);
  const keys = useMemo(() => {
    try {
      return Object.keys(parseRequestJson(preset.requestJson));
    } catch {
      return null;
    }
  }, [preset.requestJson]);

  const expand = () => {
    // 打开时把当前协议必需但没写的字段补进草稿，保存后生效
    const filled = protocol ? addMissingFields(preset.requestJson, protocol) : { text: preset.requestJson, added: [] };
    setDraft(filled.text);
    setAutoAdded(filled.added);
    setOpen(true);
  };

  const save = async (): Promise<boolean> => {
    if (check.errors.length > 0) return false;
    const text = protocol ? addMissingFields(draft, protocol).text : draft;
    const ok = await mutate('preset', preset.id, [{ op: 'set', field: 'requestJson', value: text }]);
    if (ok) {
      setOpen(false);
      setAutoAdded([]);
    }
    return ok;
  };
  const discard = () => {
    setDraft(preset.requestJson);
    setAutoAdded([]);
    setOpen(false);
  };
  useDirtyGuard(dirty, save, discard);

  return (
    <>
      <div className="section-head">
        <span className="dot" style={{ background: 'var(--text-3)' }} />
        请求参数
        <HelpLink to="request-params#请求参数" title="请求参数写法" />
      </div>
      <div className={`entry-row request-row${open ? ' selected' : ''}`} onClick={() => (open ? dirty || setOpen(false) : expand())}>
        <span />
        <span />
        <span className="chip plain">JSON</span>
        <span />
        <span className="entry-name">
          {keys === null ? <span className="danger-text">有错误</span> : keys.length === 0 ? <span className="snippet">（未设置，使用协议默认）</span> : <span className="mono">{keys.join(', ')}</span>}
        </span>
        <span className="entry-flags">
          {saved.errors.length > 0 && <span className="chip danger">错误</span>}
          {saved.errors.length === 0 && saved.missing.length > 0 && (
            <span className="chip warn" title={`${protocol ? PROTOCOL_NAME[protocol] : ''} 必需，发送时自动使用默认值`}>
              缺 {saved.missing.join(', ')}
            </span>
          )}
        </span>
      </div>
      {open && (
        <div className="entry-editor" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 's' && (e.preventDefault(), void save())}>
          <textarea
            className="textarea code"
            style={{ minHeight: 140 }}
            value={draft}
            placeholder={PLACEHOLDER}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
          />
          {check.errors.map((err) => (
            <div key={err} className="gen-error">
              {err}
            </div>
          ))}
          {autoAdded.length > 0 && check.errors.length === 0 && (
            <div className="chip warn" style={{ height: 'auto', padding: '5px 8px', whiteSpace: 'normal' }}>
              已按 {protocol && PROTOCOL_NAME[protocol]} 补上必需字段 {autoAdded.join(', ')}，可以直接改数值，保存后生效。
            </div>
          )}
          <div className="row">
            <span className="faint" style={{ fontSize: 11.5 }}>
              {protocol ? `当前协议：${PROTOCOL_NAME[protocol]}` : '未选择模型'} · 模型、消息、stream 等由平台固定
            </span>
            <span className="spacer" />
            <button className="btn small" onClick={discard}>
              {dirty ? '放弃' : '收起'}
            </button>
            <button className="btn primary small" disabled={!dirty || check.errors.length > 0} onClick={() => void save()}>
              保存
            </button>
          </div>
        </div>
      )}
    </>
  );
}
