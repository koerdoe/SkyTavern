// token 预估的说明文字：用了哪个分词器、怎么选的、校准到什么程度。

import type { TokenizerInfo } from '../../src/core/views.ts';

export function calibrationText(t: TokenizerInfo): string {
  const f = `×${t.factor.toFixed(2)}`;
  if (t.source === 'session') return `已校准 ${f}（本会话最近 ${t.samples} 次实际用量）`;
  if (t.source === 'recent') return `已校准 ${f}（其他会话最近 ${t.samples} 次实际用量）`;
  return t.factor === 1 ? '还没有实际用量，未校准' : `默认系数 ${f}（还没有实际用量）`;
}

/** 悬停提示：分词器、选择理由、校准情况。 */
export function tokenizerTitle(t: TokenizerInfo | null): string {
  if (!t) return '还没选模型：粗略估算（中日韩字符按 1 个，其余约 4 个字符 1 个）';
  return [
    `分词器：${t.label}${t.exact ? '' : '（近似）'}`.replace('（近似）（近似）', '（近似）'),
    t.reason,
    calibrationText(t),
    ...(t.error ? [`${t.error}，改用粗略估算`] : []),
  ].join('\n');
}

/** 显示用：精确的词表未校准时写“约”，其他情况也写“约”，只是提示里说明来源。 */
export const tokenText = (n: number): string => `约 ${n.toLocaleString()} token`;
