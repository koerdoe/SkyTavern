// 主页面：顶栏 + 三栏（请求结构 / 对话或预览 / 角色）。手机上两侧面板全屏覆盖。

import { useMemo, useState } from 'react';
import { ChatView } from '../components/ChatView.tsx';
import { LibraryPanel } from '../components/LibraryPanel.tsx';
import { ModelDialog } from '../components/ModelDialog.tsx';
import { PreviewView } from '../components/PreviewView.tsx';
import { RegexDialog } from '../components/RegexDialog.tsx';
import { SettingsDialog } from '../components/SettingsDialog.tsx';
import { StructurePanel } from '../components/StructurePanel.tsx';
import type { EntryItem } from '../entries.ts';
import { useStore } from '../store.tsx';
import { Avatar, avatarUrl, Icon } from '../ui.tsx';

export function ChatPage() {
  const store = useStore();
  const { docs, settings, lists, mobilePanel, setMobilePanel, view, setView, preview } = store;
  const [dialog, setDialog] = useState<'model' | 'settings' | 'regex' | null>(null);
  const modelName = lists.model.find((m) => m.id === settings?.modelId)?.name;

  const entryIndex = useMemo(() => {
    const m = new Map<string, EntryItem>();
    const add = (kind: EntryItem['kind'], c: { id: string; name: string; entries: EntryItem['entry'][] } | null) =>
      c?.entries.forEach((entry) => m.set(entry.id, { entry, kind, containerId: c.id, containerName: c.name }));
    add('preset', docs.preset);
    add('character', docs.character);
    add('persona', docs.persona);
    docs.worldbooks.forEach((w) => add('worldbook', w));
    return m;
  }, [docs]);

  const dark = settings?.ui.theme === 'dark' || (settings?.ui.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const toggleTheme = () => settings && void store.saveSettings({ ui: { ...settings.ui, theme: dark ? 'light' : 'dark' } });

  return (
    <div className="app">
      <header className="topbar">
        <button className="btn ghost icon mobile-only" onClick={() => setMobilePanel(mobilePanel === 'left' ? 'none' : 'left')} aria-label="请求结构">
          <Icon name="panelLeft" />
        </button>
        <div className="brand">
          <span className="brand-mark">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round">
              <path d="M5 16c3-7 10-9 14-8-3 2-5 5-6 9" />
            </svg>
          </span>
          <span className="brand-name">SkyTavern</span>
        </div>
        <div className="topbar-title">
          {docs.character?.avatar && <Avatar name={docs.character.name} size={26} src={avatarUrl(docs.character.id, docs.character.avatar)} />}
          <strong>{docs.character?.name ?? ''}</strong>
          {store.session && <span className="faint desktop-only">{store.session.total} 条</span>}
        </div>
        <div className="topbar-actions">
          <button className={`btn small${view === 'preview' ? ' active' : ''}`} onClick={() => setView(view === 'preview' ? 'chat' : 'preview')} title="查看实际发送的请求">
            <Icon name="eye" size={14} />
            <span className="desktop-only">预览</span>
          </button>
          <button className="btn small" onClick={() => setDialog('regex')} title="预设与角色卡的全部正则">
            <Icon name="regex" size={14} />
            <span className="desktop-only">正则</span>
          </button>
          <button className={`btn small model-pill${modelName ? '' : ' danger-text'}`} onClick={() => setDialog('model')} title="模型配置">
            <Icon name="chip" size={14} />
            <span className="desktop-only">{modelName ?? '选择模型'}</span>
          </button>
          <button className="btn ghost small icon" onClick={toggleTheme} title={dark ? '切换到白天' : '切换到夜晚'}>
            <Icon name={dark ? 'sun' : 'moon'} size={15} />
          </button>
          <button className="btn ghost small" onClick={() => setDialog('settings')} title="系统设置：外观、风格、token 预估">
            <Icon name="gear" size={15} />
            <span className="desktop-only">设置</span>
          </button>
          <a className="btn ghost small icon desktop-only" href="/docs" target="_blank" rel="noreferrer" title="文档">
            <Icon name="book" size={15} />
          </a>
          <a className="btn ghost small icon desktop-only" href="/admin" title="管理与调试">
            <Icon name="wrench" size={15} />
          </a>
          <button className="btn ghost icon mobile-only" onClick={() => setMobilePanel(mobilePanel === 'right' ? 'none' : 'right')} aria-label="角色">
            <Icon name="panelRight" />
          </button>
        </div>
      </header>

      <div className="columns">
        <aside className={`panel left${mobilePanel === 'left' ? ' open' : ''}`}>
          <StructurePanel />
        </aside>
        <main className="center">{view === 'preview' ? <PreviewView data={preview} onClose={() => setView('chat')} entryIndex={entryIndex} /> : <ChatView />}</main>
        <aside className={`panel right${mobilePanel === 'right' ? ' open' : ''}`}>
          <LibraryPanel />
        </aside>
      </div>

      {dialog === 'model' && <ModelDialog onClose={() => setDialog(null)} />}
      {dialog === 'settings' && <SettingsDialog onClose={() => setDialog(null)} />}
      {dialog === 'regex' && <RegexDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
