// 初始变量编辑：每行 `名称 = 值`。预设与角色卡各有一份，角色卡的覆盖预设的。

import { useEffect, useMemo, useState } from 'react';
import { parseInitialVars } from '../../../src/core/vars.ts';
import { useDirtyGuard, useStore } from '../store.tsx';
import { HelpLink } from '../ui.tsx';

export function InitialVars({ kind, id, value }: { kind: 'preset' | 'character'; id: string; value: string }) {
  const { mutate } = useStore();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const { errors } = useMemo(() => parseInitialVars(text), [text]);
  const dirty = text !== value;

  const save = async (): Promise<boolean> => (errors.length > 0 ? false : mutate(kind, id, [{ op: 'set', field: 'initialVars', value: text }]));
  useDirtyGuard(dirty, save, () => setText(value));

  return (
    <div className="detail-block">
      <h3>
        初始变量
        <HelpLink to="variables#初始变量" />
        <span className="spacer" />
        {dirty && (
          <button className="btn primary small" disabled={errors.length > 0} onClick={() => void save()}>
            保存
          </button>
        )}
      </h3>
      <textarea
        className="textarea code"
        rows={Math.max(2, text.split('\n').length)}
        value={text}
        placeholder={'每行一个，例如：\nhp = 100\nlocation = "酒馆"'}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
      {errors.map((e) => (
        <div key={e.line} className="gen-error">
          第 {e.line} 行：{e.message}
        </div>
      ))}
      <span className="faint" style={{ fontSize: 11.5 }}>
        {kind === 'character' ? '同名时覆盖预设里的初始值。' : '角色卡里同名的初始变量会覆盖这里。'}
      </span>
    </div>
  );
}
