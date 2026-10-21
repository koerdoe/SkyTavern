// 会话变量：初始值（预设 + 角色卡）+ 依次重放当前选用路径上每一层的操作。

import { linearize, type SessionDoc, type StoredMessage } from '../../core/session.ts';
import type { VarValue } from '../../core/types.ts';
import { replay, type OpWarning, type VarState } from '../../core/vars.ts';
import type { VarsReport } from '../../core/views.ts';

export type { VarsReport };

const layersOf = (messages: readonly StoredMessage[]) => messages.map((m) => ({ messageId: m.id, ops: m.varOps ?? [] }));

/** 重放到给定消息为止的状态（这些消息就是本次请求用到的正文）。 */
export function stateAfter(initial: VarState, messages: readonly StoredMessage[]): VarState {
  return replay(initial, layersOf(messages)).final;
}

/** IF 与占位符读取的变量：会话变量 + 系统保留变量（保留名优先）。 */
export function requestVars(initial: VarState, messages: readonly StoredMessage[], reserved: Record<string, VarValue>): Record<string, VarValue> {
  return { ...stateAfter(initial, messages), ...reserved };
}

/** 当前选用路径上每条消息的重放警告。 */
export function warningsByMessage(initial: VarState, doc: SessionDoc): Map<string, OpWarning[]> {
  const map = new Map<string, OpWarning[]>();
  for (const w of replay(initial, layersOf(linearize(doc))).warnings) {
    const list = map.get(w.messageId);
    if (list) list.push(w);
    else map.set(w.messageId, [w]);
  }
  return map;
}

/** 逐层变量表（/admin 与组件读取用）。 */
export function varsReport(initial: VarState, doc: SessionDoc): VarsReport {
  const messages = linearize(doc);
  const r = replay(initial, layersOf(messages), true);
  return {
    initial,
    final: r.final,
    layers: messages.map((m, i) => ({
      layer: i,
      messageId: m.id,
      role: m.role,
      ops: m.varOps ?? [],
      warnings: r.warnings.filter((w) => w.messageId === m.id),
      errors: m.varErrors ?? [],
      state: r.states![i]!,
    })),
  };
}
