// 附件：输入框旁的上传按钮和待发送列表；消息里的附件显示（图片缩略图，其他文件可下载）。

import { useRef, useState } from 'react';
import type { AttachmentRef } from '../../../src/core/types.ts';
import { api, errorText } from '../api.ts';
import { useStore } from '../store.tsx';
import { Icon } from '../ui.tsx';

export const fileSize = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

const url = (a: AttachmentRef, download = false) => `/api/attachments/${encodeURIComponent(a.id)}${download ? '?download' : ''}`;

/** 消息里的附件。 */
export function AttachmentList({ items }: { items: readonly AttachmentRef[] }) {
  if (items.length === 0) return null;
  return (
    <div className="attachments">
      {items.map((a) =>
        a.mime.startsWith('image/') ? (
          <a key={a.id} className="attachment-image" href={url(a)} target="_blank" rel="noreferrer" title={`${a.name}（${fileSize(a.size)}）`}>
            <img src={url(a)} alt={a.name} loading="lazy" />
          </a>
        ) : (
          <a key={a.id} className="attachment-file" href={url(a, true)} title="下载">
            <Icon name="paperclip" size={13} />
            <span className="attachment-name">{a.name}</span>
            <span className="faint">{fileSize(a.size)}</span>
          </a>
        ),
      )}
    </div>
  );
}

/** 上传按钮 + 待发送的附件。上传在选好文件时就进行，发送时只带 ID。 */
export function useComposerAttachments() {
  const store = useStore();
  const [items, setItems] = useState<AttachmentRef[]>([]);
  const [uploading, setUploading] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const add = async (files: File[]) => {
    setUploading((n) => n + files.length);
    for (const f of files) {
      try {
        const ref = await api.uploadAttachment(f);
        setItems((list) => (list.some((x) => x.id === ref.id) ? list : [...list, ref]));
      } catch (e) {
        store.notify(`${f.name}：${errorText(e)}`, 'error');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const button = (
    <>
      <button className="btn icon" title="添加附件（按原文件发送，模型不支持的类型会报错）" onClick={() => input.current?.click()} disabled={uploading > 0}>
        <Icon name="paperclip" size={15} />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) void add(files);
        }}
      />
    </>
  );

  const pending =
    items.length > 0 || uploading > 0 ? (
      <div className="composer-attachments">
        {items.map((a) => (
          <span key={a.id} className="chip plain attachment-chip" title={`${a.name}（${a.mime}，${fileSize(a.size)}）`}>
            <Icon name="paperclip" size={11} />
            <span className="attachment-name">{a.name}</span>
            <button aria-label="移除" onClick={() => setItems((list) => list.filter((x) => x.id !== a.id))}>
              ×
            </button>
          </span>
        ))}
        {uploading > 0 && <span className="faint">上传中…</span>}
      </div>
    ) : null;

  return { items, uploading: uploading > 0, clear: () => setItems([]), add, button, pending };
}
