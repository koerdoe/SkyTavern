// 角色卡详情里的几个小编辑器：头像、作者备注。

import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useDirtyGuard, useStore } from '../store.tsx';
import { Avatar, avatarUrl, Icon } from '../ui.tsx';

const AVATAR_LIMIT = 10 * 1024 * 1024;

/** 点头像换图；有头像时可以移除。 */
export function AvatarEditor({ id, name, version }: { id: string; name: string; version: string | null }) {
  const store = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    if (file.size > AVATAR_LIMIT) return store.notify('头像不能超过 10 MB', 'error');
    setBusy(true);
    try {
      await api.setAvatar(id, file);
      await store.reloadList('character');
    } catch (e) {
      store.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm('移除头像？')) return;
    try {
      await api.removeAvatar(id);
      await store.reloadList('character');
    } catch (e) {
      store.fail(e);
    }
  };

  return (
    <div className="avatar-editor">
      <button className="avatar-pick" title="点击更换头像（PNG、JPEG、WebP、GIF）" disabled={busy} onClick={() => input.current?.click()}>
        <Avatar name={name} size={64} src={avatarUrl(id, version)} />
        <span className="avatar-pick-hint">
          <Icon name="edit" size={12} />
        </span>
      </button>
      {version && (
        <button className="btn ghost small" onClick={() => void remove()}>
          移除
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void upload(f);
        }}
      />
    </div>
  );
}

/** 作者备注：给使用者看的说明，不发给模型。 */
export function CreatorNotes({ id, value }: { id: string; value: string }) {
  const { mutate } = useStore();
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(value.trim() !== '');
  useEffect(() => setText(value), [value]);
  const dirty = text !== value;
  const save = (): Promise<boolean> => mutate('character', id, [{ op: 'set', field: 'creatorNotes', value: text }]);
  useDirtyGuard(dirty, save, () => setText(value));

  return (
    <div className="detail-block">
      <h3>
        <button className="btn ghost small" style={{ padding: 0, height: 'auto' }} onClick={() => setOpen((v) => !v)}>
          {open ? '▾' : '▸'} 作者备注
        </button>
        <span className="spacer" />
        {dirty && (
          <button className="btn primary small" onClick={() => void save()}>
            保存
          </button>
        )}
      </h3>
      {open && (
        <>
          <textarea className="textarea" rows={Math.min(8, Math.max(3, text.split('\n').length))} value={text} placeholder="给使用者看的说明：怎么玩、注意事项……不会发给模型。" onChange={(e) => setText(e.target.value)} />
        </>
      )}
    </div>
  );
}
