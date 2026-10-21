import type { ModelConfig, Protocol } from '../../core/library.ts';
import { applyRequestJson } from '../../core/request-json.ts';
import { claude } from './claude.ts';
import { gemini } from './gemini.ts';
import { openaiChat, openaiResponses } from './openai.ts';
import type { Adapter, HttpTarget, ProviderInput, SseEvent, StreamEvent } from './types.ts';

export * from './types.ts';

export const ADAPTERS: Record<Protocol, Adapter> = {
  'openai-chat': openaiChat,
  'openai-responses': openaiResponses,
  claude,
  gemini,
};

/** 完整请求体 = 协议固定部分 + 预设请求参数 + 缺失的必需字段。不含密钥。 */
export function buildRequestBody(input: ProviderInput, model: ModelConfig, requestJson: string): Record<string, unknown> {
  return applyRequestJson(ADAPTERS[model.protocol].buildBody(input, model), requestJson, model.protocol);
}

export class UpstreamError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

/** 从上游错误响应里尽量取出人能看懂的信息。 */
async function errorFrom(res: Response): Promise<UpstreamError> {
  const text = await res.text().catch(() => '');
  let message = text.slice(0, 2000);
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? message;
  } catch {
    /* 不是 JSON，用原文 */
  }
  return new UpstreamError(`上游返回 ${res.status}：${message || res.statusText}`, res.status);
}

/** 逐个产出 SSE 事件。 */
export async function* readSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];

  function* line(l: string): Generator<SseEvent> {
    if (l === '') {
      if (data.length > 0) yield { event, data: data.join('\n') };
      event = undefined;
      data = [];
      return;
    }
    if (l.startsWith(':')) return; // 注释 / 心跳
    const colon = l.indexOf(':');
    const field = colon < 0 ? l : l.slice(0, colon);
    const value = colon < 0 ? '' : l.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      yield* line(buf.slice(0, nl).replace(/\r$/, ''));
      buf = buf.slice(nl + 1);
    }
  }
  // 流结束时未以空行收尾的最后一个事件也要交出去。
  for (const l of (buf + decoder.decode()).split(/\r?\n/)) yield* line(l);
  yield* line('');
}

/** 发送请求体并产出平台事件。body 原样发送（Debug 模式可能改过）。 */
export async function* streamGenerate(model: ModelConfig, body: unknown, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const adapter = ADAPTERS[model.protocol];
  const target = adapter.streamTarget(model);
  const res = await fetch(target.url, {
    method: 'POST',
    headers: { ...target.headers, accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw await errorFrom(res);
  for await (const e of readSse(res.body as unknown as AsyncIterable<Uint8Array>)) yield* adapter.parseEvent(e);
}

export async function listModels(model: ModelConfig, signal?: AbortSignal): Promise<string[]> {
  const adapter = ADAPTERS[model.protocol];
  const target: HttpTarget = adapter.modelsTarget(model);
  const res = await fetch(target.url, { headers: target.headers, ...(signal ? { signal } : {}) });
  if (!res.ok) throw await errorFrom(res);
  return adapter.parseModels(await res.json());
}
