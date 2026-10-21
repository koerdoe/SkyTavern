// OpenAI Chat Completions 与 Responses。两者都是自动前缀缓存，不需要断点。

import type { ModelConfig } from '../../core/library.ts';
import type { AssembledMessage } from '../../core/types.ts';
import { isImage, placeholder } from './attachments.ts';
import type { Adapter, ProviderInput, SseEvent, StreamEvent } from './types.ts';

/** Chat Completions：有附件时 content 变成数组，附件在前、文字在后。 */
function chatContent(m: AssembledMessage): unknown {
  if (!m.attachments?.length) return m.content;
  const parts: unknown[] = m.attachments.map((a) => {
    if (isImage(a)) return { type: 'image_url', image_url: { url: placeholder.dataUrl(a) } };
    if (a.mime === 'audio/wav' || a.mime === 'audio/x-wav' || a.mime === 'audio/mpeg' || a.mime === 'audio/mp3') {
      return { type: 'input_audio', input_audio: { data: placeholder.base64(a), format: a.mime.includes('wav') ? 'wav' : 'mp3' } };
    }
    return { type: 'file', file: { filename: a.name, file_data: placeholder.dataUrl(a) } };
  });
  if (m.content) parts.push({ type: 'text', text: m.content });
  return parts;
}

/** Responses：同上，用 input_* 类型。 */
function responsesContent(m: AssembledMessage): unknown {
  if (!m.attachments?.length) return m.content;
  const parts: unknown[] = m.attachments.map((a) =>
    isImage(a) ? { type: 'input_image', image_url: placeholder.dataUrl(a) } : { type: 'input_file', filename: a.name, file_data: placeholder.dataUrl(a) },
  );
  if (m.content) parts.push({ type: 'input_text', text: m.content });
  return parts;
}

const headers = (m: ModelConfig): Record<string, string> => ({
  'content-type': 'application/json',
  ...(m.apiKey ? { authorization: `Bearer ${m.apiKey}` } : {}),
});

const base = (m: ModelConfig): string => m.baseUrl.replace(/\/+$/, '');

const parseJson = (data: string): Record<string, any> | undefined => {
  try {
    return JSON.parse(data) as Record<string, any>;
  } catch {
    return undefined;
  }
};

const listModels = {
  modelsTarget: (m: ModelConfig) => ({ url: `${base(m)}/models`, headers: headers(m) }),
  parseModels: (json: unknown): string[] => ((json as { data?: { id: string }[] }).data ?? []).map((d) => d.id).sort(),
};

export const openaiChat: Adapter = {
  buildBody(input: ProviderInput, model: ModelConfig) {
    return {
      model: model.model,
      messages: input.messages.map((m) => ({ role: m.role, content: chatContent(m) })),
      stream: true,
      stream_options: { include_usage: true },
    };
  },
  streamTarget: (m) => ({ url: `${base(m)}/chat/completions`, headers: headers(m) }),
  parseEvent(e: SseEvent): StreamEvent[] {
    // [DONE] 之后就是流结束；结束原因已由 finish_reason 给出。
    if (e.data.trim() === '[DONE]') return [];
    const j = parseJson(e.data);
    if (!j) return [];
    if (j.error) return [{ type: 'error', message: String(j.error.message ?? JSON.stringify(j.error)) }];
    const out: StreamEvent[] = [];
    const choice = j.choices?.[0];
    const text = choice?.delta?.content;
    if (typeof text === 'string' && text !== '') out.push({ type: 'text', text });
    if (choice?.finish_reason) out.push({ type: 'done', stopReason: choice.finish_reason });
    if (j.usage) {
      out.push({
        type: 'usage',
        input: j.usage.prompt_tokens,
        output: j.usage.completion_tokens,
        cacheRead: j.usage.prompt_tokens_details?.cached_tokens,
      });
    }
    return out;
  },
  ...listModels,
};

export const openaiResponses: Adapter = {
  buildBody(input: ProviderInput, model: ModelConfig) {
    return {
      model: model.model,
      input: input.messages.map((m) => ({ role: m.role, content: responsesContent(m) })),
      stream: true,
      // 默认不在 OpenAI 侧保存对话；需要时可在请求参数里写 store: true
      store: false,
    };
  },
  streamTarget: (m) => ({ url: `${base(m)}/responses`, headers: headers(m) }),
  parseEvent(e: SseEvent): StreamEvent[] {
    const j = parseJson(e.data);
    if (!j) return [];
    const type = e.event ?? j.type;
    switch (type) {
      case 'response.output_text.delta':
        return typeof j.delta === 'string' && j.delta !== '' ? [{ type: 'text', text: j.delta }] : [];
      case 'response.completed':
      case 'response.incomplete': {
        const u = j.response?.usage;
        const usage: StreamEvent[] = u
          ? [{ type: 'usage', input: u.input_tokens, output: u.output_tokens, cacheRead: u.input_tokens_details?.cached_tokens }]
          : [];
        const reason = type === 'response.incomplete' ? (j.response?.incomplete_details?.reason ?? 'incomplete') : 'completed';
        return [...usage, { type: 'done', stopReason: reason }];
      }
      case 'response.failed':
        return [{ type: 'error', message: String(j.response?.error?.message ?? '上游返回失败') }];
      case 'error':
        return [{ type: 'error', message: String(j.message ?? j.error?.message ?? '上游错误') }];
      default:
        return [];
    }
  },
  ...listModels,
};
