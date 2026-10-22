// 小组件：图标、弹窗、开关、头像、消息文本格式化。

import { useEffect, type ReactNode } from 'react';

const PATHS = {
  panelLeft: 'M3 4h18v16H3zM9 4v16',
  panelRight: 'M3 4h18v16H3zM15 4v16',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  chip: 'M7 7h10v10H7zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 18l-6-6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  redo: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  stop: 'M7 7h10v10H7z',
  send: 'M4 12l16-8-6 16-2.5-6.5L4 12z',
  forward: 'M5 12h12M13 6l6 6-6 6',
  code: 'M9 7l-5 5 5 5M15 7l5 5-5 5',
  chat: 'M4 5h16v11H9l-5 4V5z',
  paperclip: 'M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  branch: 'M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 6c0 6-12 3-12 9',
  tree: 'M4 4h6v4H4zM14 10h6v4h-6zM14 17h6v4h-6zM7 8v11h7M7 12h7',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.8-.4-.4-2.8 2.8-2.4z',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4zM5 17a3 3 0 0 1 3-3h11',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  regex: 'M17 3v10M12.7 5.5l8.6 5M12.7 10.5l8.6-5M4 18a2 2 0 1 0 4 0 2 2 0 0 0-4 0',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** 指向文档某一节的“?”，新窗口打开，不打断手头未保存的编辑。to 形如 `variables#编辑块让模型改变量`。 */
export function HelpLink({ to, title = '查看文档' }: { to: string; title?: string }) {
  const [page, hash] = to.split('#');
  const href = `/docs${page && page !== 'README' ? `/${page}` : ''}${hash ? `#${hash}` : ''}`;
  return (
    <a className="help-link" href={href} target="_blank" rel="noreferrer" title={title} onClick={(e) => e.stopPropagation()}>
      ?
    </a>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    />
  );
}

export function Modal({ title, onClose, children, footer, actions }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <span className="spacer" />
          {actions}
          <button className="btn ghost icon" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

const AVATAR_COLORS = ['#c0703c', '#3f7fc4', '#4f9a6b', '#9a5bb8', '#c2504e', '#3f9c9a', '#b5892e', '#5e6fc9'];

/** 角色头像地址；没有头像时为 null。地址里带版本号，换了头像就是新地址。 */
export const avatarUrl = (characterId: string, version: string | null | undefined): string | null =>
  version ? `/api/library/character/${encodeURIComponent(characterId)}/avatar?v=${encodeURIComponent(version)}` : null;

/** portrait：按角色卡常见的 2:3 竖图显示完整图片（详情里用）；默认是方形，裁掉上下、保留上部（人脸通常在上面）。 */
export function Avatar({ name, size = 32, src, portrait = false }: { name: string; size?: number; src?: string | null; portrait?: boolean }) {
  if (src) {
    return <img className={`avatar avatar-img${portrait ? ' avatar-portrait' : ''}`} src={src} alt="" style={{ width: size, height: portrait ? size * 1.5 : size }} loading="lazy" />;
  }
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return (
    <span className="avatar" style={{ background: AVATAR_COLORS[h % AVATAR_COLORS.length], width: size, height: size, fontSize: size * 0.44 }}>
      {[...name.trim()][0] ?? '?'}
    </span>
  );
}

/** 消息正文：按空行分段，支持 *斜体* 和 **粗体**。不解析 HTML。 */
export function FormattedText({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i}>
          {p.split('\n').map((line, j) => (
            <span key={j}>
              {j > 0 && <br />}
              {inline(line)}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

function inline(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*\n]+)\*/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    if (m.index > last) out.push(line.slice(last, m.index));
    out.push(m[1] !== undefined ? <strong key={m.index}>{m[1]}</strong> : <em key={m.index}>{m[2]}</em>);
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
