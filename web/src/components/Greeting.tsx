// 角色卡的开场白：新会话以它作为第一条 AI 消息；其他开场白是第一层的其他候选，可以左右切换。

import { useEffect, useState } from 'react';
import { useDirtyGuard, useStore } from '../store.tsx';
import { Icon } from '../ui.tsx';

export function Greeting({ id, value, alternates }: { id: string; value: string; alternates: string[] }) {
  const { mutate } = useStore();
  const [main, setMain] = useState(value);
  const [alts, setAlts] = useState(alternates);
  useEffect(() => setMain(value), [value]);
  useEffect(() => setAlts(alternates), [alternates]);
  const dirty = main !== value || JSON.stringify(alts) !== JSON.stringify(alternates);

  const save = (): Promise<boolean> =>
    mutate('character', id, [
      { op: 'set', field: 'greeting', value: main },
      { op: 'set', field: 'alternateGreetings', value: alts.filter((a) => a.trim() !== '') },
    ]);
  useDirtyGuard(dirty, save, () => {
    setMain(value);
    setAlts(alternates);
  });

  const rows = (t: string) => Math.min(10, Math.max(3, t.split('\n').length));

  return (
    <div className="detail-block">
      <h3>
        开场白
        <span className="spacer" />
        {dirty && (
          <button className="btn primary small" onClick={() => void save()}>
            保存
          </button>
        )}
      </h3>
      <textarea className="textarea" rows={rows(main)} value={main} placeholder="新会话的第一条 AI 消息，可以用 {{char}} {{user}}。留空则由你先开口。" onChange={(e) => setMain(e.target.value)} />
      {alts.map((a, i) => (
        <div key={i} className="alt-greeting">
          <div className="row">
            <span className="faint" style={{ fontSize: 12 }}>
              其他开场白 {i + 1}
            </span>
            <span className="spacer" />
            <button className="btn ghost small icon" title="删除这个开场白" onClick={() => setAlts(alts.filter((_x, k) => k !== i))}>
              <Icon name="trash" size={12} />
            </button>
          </div>
          <textarea className="textarea" rows={rows(a)} value={a} onChange={(e) => setAlts(alts.map((x, k) => (k === i ? e.target.value : x)))} />
        </div>
      ))}
      <div className="row">
        <button className="btn ghost small" onClick={() => setAlts([...alts, ''])}>
          <Icon name="plus" size={12} />
          其他开场白
        </button>
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 11.5 }}>
          只影响之后新建的会话；其他开场白是第一条消息的候选，左右切换。
        </span>
      </div>
    </div>
  );
}
