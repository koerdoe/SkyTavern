// 消息底部的变量操作：显示每条操作（不生效的标红），可以整层手动编辑。

import { useMemo, useState } from 'react';
import { formatOps, isBranch, literal, parseOpLines, type VarOp } from '../../../src/core/vars.ts';
import type { LayerView } from '../../../src/core/views.ts';
import { api } from '../api.ts';
import { useDirtyGuard, useStore } from '../store.tsx';

const SOURCE_LABEL: Record<VarOp['source'], string> = { block: '编辑块', widget: '组件', manual: '手动', tool: '工具' };

export function opText(o: VarOp): string {
  if (isBranch(o)) {
    const n = o.branches.reduce((k, b) => k + b.ops.length, 0);
    const cond = o.branches[0]!.cond ?? '';
    return `如果 ${cond.length > 24 ? `${cond.slice(0, 22)}…` : cond}（${o.branches.length} 支，${n} 条）`;
  }
  if (o.expr !== undefined) return `${o.name} ${o.op} ${o.expr.length > 30 ? `${o.expr.slice(0, 28)}…` : o.expr}`;
  const v = typeof o.value === 'string' ? `“${o.value}”` : literal(o.value);
  const short = v.length > 40 ? `${v.slice(0, 38)}…` : v;
  if (o.op === '=') return `${o.name} = ${short}`;
  if (typeof o.value === 'number') return `${o.name} ${o.op === '+=' ? '+' : '−'}${o.value}`;
  return `${o.name} ${o.op} ${short}`;
}

export function VarOpsBar({ layer, sessionId, editing, onClose }: { layer: LayerView; sessionId: string; editing: boolean; onClose: () => void }) {
  const warned = new Map(layer.varWarnings.map((w) => [w.index, w.message]));
  if (!editing && layer.varOps.length === 0 && layer.varErrors.length === 0) return null;
  return (
    <div className="var-bar">
      {layer.varOps.map((o, i) => (
        <span key={i} className={`chip ${warned.has(i) ? 'danger' : 'ok'}`} title={`${warned.get(i) ?? `来源：${SOURCE_LABEL[o.source]}`}\n${formatOps([o])}`}>
          {opText(o)}
        </span>
      ))}
      {layer.varErrors.length > 0 && (
        <span className="chip warn" title={layer.varErrors.map((e) => (e.text ? `${e.text}：${e.message}` : e.message)).join('\n')}>
          {layer.varErrors.length} 处无效
        </span>
      )}
      {editing && <VarOpsEditor layer={layer} sessionId={sessionId} onClose={onClose} />}
    </div>
  );
}

function VarOpsEditor({ layer, sessionId, onClose }: { layer: LayerView; sessionId: string; onClose: () => void }) {
  const store = useStore();
  const original = formatOps(layer.varOps);
  const [text, setText] = useState(original);
  const parsed = useMemo(() => parseOpLines(text, 'manual'), [text]);
  const dirty = text !== original;

  const save = async (): Promise<boolean> => {
    if (parsed.errors.length > 0) return false;
    try {
      await api.op(sessionId, { op: 'setVarOps', messageId: layer.id, ops: parsed.ops });
      await store.reloadSession();
      onClose();
      return true;
    } catch (e) {
      store.fail(e);
      return false;
    }
  };
  useDirtyGuard(dirty, save, () => setText(original));

  return (
    <div className="var-editor">
      <textarea
        className="textarea code"
        rows={Math.max(3, text.split('\n').length + 1)}
        value={text}
        placeholder={'每行一条，例如：\nhp -= 5\nlocation = "酒馆"'}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        autoFocus
      />
      {parsed.errors.map((e) => (
        <div key={e.line} className="gen-error">
          第 {e.line} 行：{e.message}
        </div>
      ))}
      <div className="row-end">
        <button className="btn small" onClick={() => (setText(original), onClose())}>
          {dirty ? '放弃' : '收起'}
        </button>
        <button className="btn small primary" disabled={!dirty || parsed.errors.length > 0} onClick={() => void save()}>
          保存
        </button>
      </div>
    </div>
  );
}
