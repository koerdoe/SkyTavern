// Gemini generateContent：开头的 system 进 systemInstruction，assistant → model。
// 缓存目前依赖 Gemini 的隐式缓存（前缀相同自动命中），显式缓存对象以后再做。

import type { ModelConfig } from '../../core/library.ts';
import { placeholder } from './attachments.ts';
import { joinUrl, splitLeadingSystem, type Adapter, type ProviderInput, type SseEvent, type StreamEvent } from './types.ts';

const headers = (m: ModelConfig): Record<string, string> => ({
  'content-type': 'application/json',
  ...(m.apiKey ? { 'x-goog-api-key': m.apiKey } : {}),
});

export const gemini: Adapter = {
  buildBody(input: ProviderInput) {
    const { system, rest } = splitLeadingSystem(input.messages, 'Gemini');
    return {
      ...(system.length > 0 ? { systemInstruction: { parts: system.map((s) => ({ text: s.msg.content })) } } : {}),
      contents: rest.map((r) => ({
        role: r.msg.role === 'assistant' ? 'model' : 'user',
        // 附件按原文件放进 inline_data（附件在前、文字在后）
        parts: [
          ...(r.msg.attachments ?? []).map((a) => ({ inline_data: { mime_type: a.mime, data: placeholder.base64(a) } })),
          ...(r.msg.content || !r.msg.attachments?.length ? [{ text: r.msg.content }] : []),
        ],
      })),
    };
  },
  streamTarget: (m) => ({
    url: joinUrl(m.baseUrl, 'v1beta', `/models/${encodeURIComponent(m.model)}:streamGenerateContent?alt=sse`),
    headers: headers(m),
  }),
  parseEvent(e: SseEvent): StreamEvent[] {
    let j: Record<string, any>;
    try {
      j = JSON.parse(e.data) as Record<string, any>;
    } catch {
      return [];
    }
    if (j.error) return [{ type: 'error', message: String(j.error.message ?? '上游错误') }];
    const out: StreamEvent[] = [];
    const cand = j.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text !== '' && !part.thought) out.push({ type: 'text', text: part.text });
    }
    const u = j.usageMetadata;
    if (u) out.push({ type: 'usage', input: u.promptTokenCount, output: u.candidatesTokenCount, cacheRead: u.cachedContentTokenCount });
    if (cand?.finishReason) out.push({ type: 'done', stopReason: cand.finishReason });
    return out;
  },
  modelsTarget: (m) => ({ url: joinUrl(m.baseUrl, 'v1beta', '/models?pageSize=1000'), headers: headers(m) }),
  parseModels: (json) =>
    ((json as { models?: { name: string; supportedGenerationMethods?: string[] }[] }).models ?? [])
      .filter((x) => x.supportedGenerationMethods?.includes('generateContent') ?? true)
      .map((x) => x.name.replace(/^models\//, ''))
      .sort(),
};
