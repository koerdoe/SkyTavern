// 系统设置（账号级，换设备也一样）：
//   外观：主题、阅读模式、每次加载条数。
//   风格：多套自定义 CSS，一键切换；编辑时实时预览。
//   预估：自动选分词器时模型名优先还是接口类型优先。
//   召回：开关（打开即向量匹配，另有两个备选方式）、嵌入模型、取前几条；一键往当前预设里加放召回结果的词条。

import { useEffect, useState } from 'react';
import type { EntryDraft, RecallSettings, UiPrefs, UiStyle, UserSettings } from '../../../src/core/library.ts';
import { activeCss, applyUserCss, useDirtyGuard, useStore } from '../store.tsx';
import { HelpLink, Icon, Modal, Switch } from '../ui.tsx';

type Tab = 'look' | 'style' | 'tokens' | 'recall';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, saveSettings, confirmLeave } = useStore();
  const [tab, setTab] = useState<Tab>('look');
  if (!settings) return null;
  const ui = settings.ui;
  const setUi = (patch: Partial<UiPrefs>) => saveSettings({ ui: { ...ui, ...patch } });

  return (
    <Modal
      title="系统设置"
      onClose={() => void confirmLeave().then((ok) => ok && onClose())}
      actions={
        <>
          <a className="btn ghost small" href="/docs" target="_blank" rel="noreferrer">
            <Icon name="book" size={13} />
            文档
          </a>
          <a className="btn ghost small" href="/admin">
            <Icon name="wrench" size={13} />
            管理与调试
          </a>
        </>
      }
    >
      <div className="settings-tabs tabs" role="tablist">
        {(
          [
            ['look', '外观'],
            ['style', '风格'],
            ['tokens', 'token 预估'],
            ['recall', '召回'],
          ] as const
        ).map(([v, label]) => (
          <button key={v} className="tab" role="tab" aria-selected={tab === v} onClick={() => void confirmLeave().then((ok) => ok && setTab(v))}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'look' && <LookTab ui={ui} setUi={setUi} />}
      {tab === 'style' && <StyleTab ui={ui} setUi={setUi} />}
      {tab === 'tokens' && <TokensTab settings={settings} save={saveSettings} />}
      {tab === 'recall' && <RecallTab settings={settings} save={saveSettings} />}
    </Modal>
  );
}

function LookTab({ ui, setUi }: { ui: UiPrefs; setUi: (p: Partial<UiPrefs>) => Promise<void> }) {
  return (
    <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
      <div className="grid-2">
        <div className="field">
          <span>主题</span>
          <div className="tabs">
            {(
              [
                ['system', '跟随系统'],
                ['light', '白天'],
                ['dark', '夜晚'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} className="tab" aria-selected={ui.theme === v} onClick={() => void setUi({ theme: v })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>阅读模式</span>
          <div className="tabs">
            <button className="tab" aria-selected={ui.readingMode === 'short'} onClick={() => void setUi({ readingMode: 'short' })}>
              短对话 · 气泡
            </button>
            <button className="tab" aria-selected={ui.readingMode === 'long'} onClick={() => void setUi({ readingMode: 'long' })}>
              长对话 · 紧凑
            </button>
          </div>
        </div>
      </div>
      <label className="field" style={{ maxWidth: 240 }}>
        <span>每次加载的消息条数（0 为全部）</span>
        <input className="input mono" type="number" min={0} defaultValue={ui.loadCount} onBlur={(e) => void setUi({ loadCount: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
      </label>
    </div>
  );
}

const STYLE_EXAMPLE = `/* 例：换强调色、放大长对话的正文 */
:root { --accent: #c0703c; --accent-text: #a85a2a; }
[data-reading="long"] .msg-body { font-size: 17px; }`;

function StyleTab({ ui, setUi }: { ui: UiPrefs; setUi: (p: Partial<UiPrefs>) => Promise<void> }) {
  const [selected, setSelected] = useState<string | null>(ui.activeStyle ?? ui.styles[0]?.id ?? null);
  const current = ui.styles.find((s) => s.id === selected) ?? null;
  const [draft, setDraft] = useState<UiStyle | null>(current);
  useEffect(() => setDraft(current), [current]);
  const dirty = draft !== null && current !== null && (draft.name !== current.name || draft.css !== current.css);

  // 编辑时实时预览；离开这一页（或关掉窗口）时恢复成正在使用的风格
  useEffect(() => {
    if (draft) applyUserCss(draft.css);
  }, [draft]);
  useEffect(() => () => applyUserCss(activeCss(ui)), [ui]);

  const replace = (styles: UiStyle[], activeStyle = ui.activeStyle) => setUi({ styles, activeStyle: styles.some((s) => s.id === activeStyle) ? activeStyle : null });
  const save = async (): Promise<boolean> => {
    if (!draft) return true;
    await replace(ui.styles.map((s) => (s.id === draft.id ? draft : s)));
    return true;
  };
  useDirtyGuard(dirty, save, () => setDraft(current));

  const nextId = () => {
    let n = ui.styles.length + 1;
    while (ui.styles.some((s) => s.id === `style${n}`)) n++;
    return `style${n}`;
  };
  const add = async (from?: UiStyle) => {
    const s: UiStyle = { id: nextId(), name: from ? `${from.name} 副本` : '新风格', css: from ? from.css : STYLE_EXAMPLE };
    await replace([...ui.styles, s]);
    setSelected(s.id);
  };
  const remove = async () => {
    if (!current || !confirm(`删除风格“${current.name}”？`)) return;
    await replace(ui.styles.filter((s) => s.id !== current.id));
    setSelected(null);
  };

  return (
    <div className="split" style={{ minHeight: 380 }}>
      <div className="split-list">
        <button aria-current={ui.activeStyle === null && selected === null} onClick={() => setSelected(null)}>
          <span>
            默认 {ui.activeStyle === null && <span className="chip accent">使用中</span>}
          </span>
        </button>
        {ui.styles.map((s) => (
          <button key={s.id} aria-current={s.id === selected} onClick={() => s.id !== selected && setSelected(s.id)}>
            <span>
              {s.name} {ui.activeStyle === s.id && <span className="chip accent">使用中</span>}
            </span>
          </button>
        ))}
        <button onClick={() => void add()}>
          <span className="row" style={{ gap: 4 }}>
            <Icon name="plus" size={13} />
            添加风格
          </span>
        </button>
      </div>
      <div className="modal-body" style={{ display: "grid", gap: 10, alignContent: "start" }}>
        {!draft ? (
          <>
            <p className="muted" style={{ margin: 0 }}>
              不用自定义风格，界面保持默认样子。
            </p>
            <div className="row">
              <span className="spacer" />
              <button className="btn" disabled={ui.activeStyle === null} onClick={() => void setUi({ activeStyle: null })}>
                {ui.activeStyle === null ? '正在使用' : '使用默认'}
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="field">
              <span>名称</span>
              <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="field">
              <span>CSS（编辑时实时预览；保存后所有设备生效）</span>
              <textarea className="textarea code" rows={14} value={draft.css} onChange={(e) => setDraft({ ...draft, css: e.target.value })} spellCheck={false} />
            </label>
            <span className="faint" style={{ fontSize: 12 }}>
              可以改的颜色变量有 --bg、--surface、--text、--accent、--border 等；夜晚模式用 [data-theme="dark"] 或 @media (prefers-color-scheme: dark) 单独写。
            </span>
            <div className="row">
              <button className="btn ghost danger-text small" onClick={() => void remove()}>
                删除
              </button>
              <button className="btn ghost small" onClick={() => void add(draft)}>
                复制
              </button>
              <span className="spacer" />
              <button className="btn small" disabled={!dirty} onClick={() => setDraft(current)}>
                放弃修改
              </button>
              <button className="btn small primary" disabled={!dirty} onClick={() => void save()}>
                保存
              </button>
              <button
                className="btn small"
                disabled={ui.activeStyle === draft.id && !dirty}
                onClick={async () => {
                  const styles = ui.styles.map((s) => (s.id === draft.id ? draft : s));
                  await setUi({ styles, activeStyle: draft.id });
                }}
              >
                {ui.activeStyle === draft.id ? (dirty ? '保存并使用' : '正在使用') : '使用这个'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TokensTab({ settings, save }: { settings: UserSettings; save: (p: Partial<UserSettings>) => Promise<void> }) {
  const options = [
    ['name', '模型名优先', '先按模型名匹配（例如 anthropic/claude-opus-4.7、deepseek-chat），都没匹配到再按接口类型。适合 OpenRouter 这类一个接口里什么模型都有的渠道。'],
    ['protocol', '接口类型优先', 'Claude 接口一律用 Claude 分词器、Gemini 接口一律用 Gemini 分词器（新旧代仍按模型名里的版本号分），OpenAI Responses 一律用 o200k；只有 OpenAI Chat 这种通用接口才看模型名。适合 Azure 等部署名和模型无关的渠道。'],
  ] as const;
  return (
    <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
      <div className="row" style={{ gap: 6 }}>
        <strong>自动选择分词器时</strong>
        <HelpLink to="request-params#token-预估" />
      </div>
      {options.map(([v, label, desc]) => (
        <label key={v} className={`choice${settings.tokenizerPriority === v ? ' on' : ''}`}>
          <input type="radio" name="tokenizer-priority" checked={settings.tokenizerPriority === v} onChange={() => void save({ tokenizerPriority: v })} />
          <span>
            <strong>{label}</strong>
            <span className="muted">{desc}</span>
          </span>
        </label>
      ))}
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>
        某个模型配置认错了分词器时，可以在“模型配置”里单独指定，那里的指定总是优先。无论怎么选，预估都会按每次回复的实际用量自动校准。
      </p>
    </div>
  );
}

const RECALL_ENTRY: EntryDraft = {
  name: '召回结果',
  enabled: true,
  role: 'user',
  content: '以下是与当前对话相关的过往片段，供参考：\n{{$recall}}',
  priority: 0,
  if: '$recall != ""',
  placement: { kind: 'position', section: 'after' },
};

function RecallTab({ settings, save }: { settings: UserSettings; save: (p: Partial<UserSettings>) => Promise<void> }) {
  const { lists, docs, mutate } = useStore();
  const preset = docs.preset;
  const recall = settings.recall;
  const set = (patch: Partial<RecallSettings>) => save({ recall: { ...recall, ...patch } });
  const embeddingModels = lists.model.filter((m) => m.use === 'embedding');
  const needsModel = recall.mode === 'vector' || recall.mode === 'hybrid';
  // 预设、角色卡、用户角色、世界书里任何一个启用的词条用到都算
  const all = [...(docs.preset?.entries ?? []), ...(docs.character?.entries ?? []), ...(docs.persona?.entries ?? []), ...docs.worldbooks.flatMap((w) => w.entries)];
  const presetUses = all.some((e) => e.enabled && (e.content.includes('$recall') || (e.if ?? '').includes('$recall')));
  const on = recall.mode !== 'off';
  return (
    <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
      <div className="row" style={{ gap: 8 }}>
        <Switch checked={on} label="开启召回" onChange={(v) => void set({ mode: v ? 'vector' : 'off' })} />
        <strong>开启召回</strong>
        <HelpLink to="request-structure#召回" />
        <span className="spacer" />
        {on && (
          <label className="row" style={{ gap: 6, fontSize: 12, whiteSpace: 'nowrap' }}>
            <span className="faint">匹配方式</span>
            <select className="select small" style={{ width: 'auto' }} value={recall.mode} onChange={(e) => void set({ mode: e.target.value as RecallSettings['mode'] })}>
              <option value="vector">向量（推荐）</option>
              <option value="hybrid">向量 + 关键词</option>
              <option value="keyword">只用关键词</option>
            </select>
          </label>
        )}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {!on
          ? '关闭时不召回，{{$recall}} 总是空的，也不会调用嵌入模型。'
          : recall.mode === 'vector'
            ? '用嵌入模型从较早的聊天记录里找出和最新一条用户消息意思相近的片段，换个说法也能找到。新消息在后台建索引。'
            : recall.mode === 'hybrid'
              ? '向量和关键词的分数各占一半。人名、地名这类专有词更容易命中，但也更容易被字面相同、意思无关的片段带偏。'
              : '只按字面上相同的词打分，不需要嵌入模型，但换个说法就找不到。一般不推荐。'}
      </p>
      {on && (
        <div className="grid-2">
          <label className="field">
            <span>嵌入模型{needsModel && !recall.embeddingModelId && <span className="chip warn">未选择</span>}</span>
            <select className="select" value={recall.embeddingModelId ?? ''} disabled={!needsModel} onChange={(e) => void set({ embeddingModelId: e.target.value || null })}>
              <option value="">（未选择）</option>
              {embeddingModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <span className="faint">{embeddingModels.length === 0 ? '还没有嵌入模型：在“模型配置”里新建一个，用途选“嵌入”。' : '只列出用途是“嵌入”的模型配置。'}</span>
          </label>
          <label className="field">
            <span>取前几条（1–20）</span>
            <input
              className="input mono"
              type="number"
              min={1}
              max={20}
              defaultValue={recall.topK}
              key={recall.topK}
              onBlur={(e) => void set({ topK: Math.min(20, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
            />
            <span className="faint">每条命中的片段会带上它前后各一段，所以实际放进去的会多一些。</span>
          </label>
          <label className="field">
            <span className="row" style={{ gap: 6 }}>
              按内容触发的词条最多几条（1–50）
              <HelpLink to="request-structure#按相似度触发-similar" />
            </span>
            <input
              className="input mono"
              type="number"
              min={1}
              max={50}
              defaultValue={recall.similarTopK}
              key={`s${recall.similarTopK}`}
              onBlur={(e) => void set({ similarTopK: Math.min(50, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
            />
            <span className="faint">IF 里用了 similar() 的词条：过了阈值的按相似度取前几条，其余这次不发送。</span>
          </label>
        </div>
      )}
      <div className="callout">
        <div>
          召回结果通过占位符 <code>{'{{$recall}}'}</code> 放进词条，没有词条用到它时不会召回。
          {presetUses ? <> 当前的请求结构里已经有用到它的词条。</> : <> 当前的请求结构里还没有。</>}
        </div>
        {preset && !presetUses && (
          <button className="btn small" onClick={() => void mutate('preset', preset.id, [{ op: 'addEntry', entry: RECALL_ENTRY }])}>
            <Icon name="plus" size={13} />
            往当前预设加一条“召回结果”
          </button>
        )}
      </div>
    </div>
  );
}
