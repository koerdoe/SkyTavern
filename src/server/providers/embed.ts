// 嵌入接口：OpenAI 兼容的 /embeddings（OpenAI 两种协议的模型配置都走这里）和 Gemini 的 batchEmbedContents。
// Claude 没有嵌入接口。

import type { ModelConfig } from '../../core/library.ts';
import { joinUrl } from './types.ts';
import { UpstreamError } from './index.ts';

const BATCH = 64;

export class EmbedError extends Error {}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  } catch (e) {
    throw new UpstreamError(`连不上嵌入接口：${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 500);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string };
      message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? message;
    } catch {
      // 原样显示
    }
    throw new UpstreamError(`嵌入接口返回 ${res.status}：${message}`, res.status);
  }
  return JSON.parse(text);
}

/** 一批文字 → 向量（顺序与输入一致）。 */
export async function embed(model: ModelConfig, texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    if (model.protocol === 'claude') throw new EmbedError('Claude 没有嵌入接口，请用 OpenAI 兼容或 Gemini 的嵌入模型');
    if (model.protocol === 'gemini') {
      const name = model.model.startsWith('models/') ? model.model : `models/${model.model}`;
      const j = await post(
        joinUrl(model.baseUrl, 'v1beta', `/${name}:batchEmbedContents`),
        model.apiKey ? { 'x-goog-api-key': model.apiKey } : {},
        { requests: batch.map((t) => ({ model: name, content: { parts: [{ text: t }] } })) },
        signal,
      );
      const vs = (j.embeddings ?? []) as { values: number[] }[];
      if (vs.length !== batch.length) throw new EmbedError('嵌入接口返回的数量不对');
      out.push(...vs.map((v) => v.values));
    } else {
      const j = await post(
        `${model.baseUrl.replace(/\/+$/, '')}/embeddings`,
        model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {},
        { model: model.model, input: batch },
        signal,
      );
      const data = ((j.data ?? []) as { index?: number; embedding: number[] }[]).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== batch.length) throw new EmbedError('嵌入接口返回的数量不对');
      out.push(...data.map((d) => d.embedding));
    }
  }
  return out;
}
