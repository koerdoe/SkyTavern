// 按向量相似度触发：IF 里的 similar(...)。
//
//   similar()                    这个词条自己的内容，和最近 2 条消息比，相似度 ≥ 0.5 成立
//   similar(0.6)                 小于 1 的数是阈值
//   similar(4)                   大于等于 1 的整数是检查最近几条消息
//   similar("北塔的地下室")       写明一段描述去比（词条内容很长时，用一句话概括它的主题）
//   similar(4, "北塔", 0.6)       都写也可以，顺序不限
//
// 生成前由服务端算好：每条消息按召回的方式切块，取最近 N 条消息所有块里和查询最相似的那一块的分数。
// 过了阈值的再按分数排，最多取前 K 条（召回设置里的“按内容触发最多几条”），其余算不成立。
// 召回关闭、没选嵌入模型、没有会话（例如编辑预设时预览）时一律不成立。

import type { VarValue } from './types.ts';

export const DEFAULT_SIMILAR_THRESHOLD = 0.5;
export const DEFAULT_SIMILAR_DEPTH = 2;
/** 用词条内容作查询时最多取多少字（嵌入接口有长度上限）。 */
export const SIMILAR_QUERY_LIMIT = 2000;

export interface SimilarCall {
  depth: number;
  /** 写明的描述；null 表示用词条自己的内容。 */
  text: string | null;
  threshold: number;
}

export function parseSimilarArgs(args: readonly VarValue[]): SimilarCall {
  let depth: number | undefined;
  let text: string | undefined;
  let threshold: number | undefined;
  for (const a of args) {
    if (typeof a === 'string') {
      if (text !== undefined) throw new Error('similar() 只能写一段描述');
      if (!a.trim()) throw new Error('similar() 的描述不能是空的');
      text = a;
    } else if (typeof a === 'number' && a > 0 && a < 1) {
      if (threshold !== undefined) throw new Error('similar() 只能写一个阈值');
      threshold = a;
    } else if (typeof a === 'number' && Number.isInteger(a) && a >= 1 && a <= 100) {
      if (depth !== undefined) throw new Error('similar() 只能写一个条数');
      depth = a;
    } else {
      throw new Error('similar() 的参数：小于 1 的数是阈值，1–100 的整数是检查最近几条消息，文字是描述');
    }
  }
  return { depth: depth ?? DEFAULT_SIMILAR_DEPTH, text: text ?? null, threshold: threshold ?? DEFAULT_SIMILAR_THRESHOLD };
}

/** 某个词条里某个 similar() 调用的键（算好的结果按它查）。 */
export const similarKey = (entryId: string, c: SimilarCall): string => `${entryId}\n${c.depth}\n${c.threshold}\n${c.text ?? ''}`;

/** 查询文字：写明的描述，或词条内容（截断）。 */
export const similarQuery = (c: SimilarCall, entryContent: string): string => (c.text ?? [...entryContent.trim()].slice(0, SIMILAR_QUERY_LIMIT).join(''));

/** 预览里显示的相似度。 */
export interface SimilarityInfo {
  score: number;
  threshold: number;
  passed: boolean;
  /** 过了阈值但超出前 K 条。 */
  cut?: boolean;
}
