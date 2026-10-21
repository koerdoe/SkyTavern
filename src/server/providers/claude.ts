// Claude Messages：开头的 system 进 system 参数；缓存断点落成 cache_control（最多 4 个）。

import type { ModelConfig } from '../../core/library.ts';
import type { AssembledMessage, AttachmentRef } from '../../core/types.ts';
import { isText, placeholder } from './attachments.ts';
import { entryOf, joinUrl, ProtocolError, splitLeadingSystem, type Adapter, type ProviderInput, type SseEvent, type StreamEvent } from './types.ts';

const CLAUDE_IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** 附件 → Claude 的内容块。Claude 只支持这几种图片、PDF 和纯文字，其他直接报错。 */
function attachmentBlock(a: AttachmentRef, m: AssembledMessage): Record<string, unknown> {
  if (CLAUDE_IMAGES.includes(a.mime)) return { type: 'image', source: { type: 'base64', media_type: a.mime, data: placeholder.base64(a) } };
  if (a.mime === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: placeholder.base64(a) }, title: a.name };
  if (isText(a)) return { type: 'document', source: { type: 'text', media_type: 'text/plain', data: placeholder.text(a) }, title: a.name };
  throw new ProtocolError(`Claude 不支持这种附件：${a.name}（${a.mime}）。支持 PNG / JPEG / GIF / WebP 图片、PDF 和纯文字`, entryOf(m));
}

const MAX_BREAKPOINTS = 4;
const VERSION = '2023-06-01';

const headers = (m: ModelConfig): Record<string, string> => ({
  'content-type': 'application/json',
  'anthropic-version': VERSION,
  ...(m.apiKey ? { 'x-api-key': m.apiKey } : {}),
});

type TextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

export const claude: Adapter = {
  buildBody(input: ProviderInput, model: ModelConfig) {
    const { system, rest } = splitLeadingSystem(input.messages, 'Claude');
    // 断点越靠后覆盖越多；超过上限时保留最后几个。
    const marks = new Set(input.cacheBreakpoints.slice(-MAX_BREAKPOINTS));
    const block = (text: string, index: number): TextBlock =>
      marks.has(index) ? { type: 'text', text, cache_control: { type: 'ephemeral' } } : { type: 'text', text };
    // 有附件时：附件块在前，文字在后；缓存标记打在最后一块上
    const content = (m: AssembledMessage, index: number): Record<string, unknown>[] => {
      if (!m.attachments?.length) return [block(m.content, index)];
      const blocks: Record<string, unknown>[] = m.attachments.map((a) => attachmentBlock(a, m));
      if (m.content) blocks.push({ type: 'text', text: m.content });
      if (marks.has(index)) blocks[blocks.length - 1] = { ...blocks.at(-1)!, cache_control: { type: 'ephemeral' } };
      return blocks;
    };

    return {
      model: model.model,
      ...(system.length > 0 ? { system: system.map((s) => block(s.msg.content, s.index)) } : {}),
      messages: rest.map((r) => ({ role: r.msg.role, content: content(r.msg, r.index) })),
      stream: true,
    };
  },
  streamTarget: (m) => ({ url: joinUrl(m.baseUrl, 'v1', '/messages'), headers: headers(m) }),
  parseEvent(e: SseEvent): StreamEvent[] {
    let j: Record<string, any>;
    try {
      j = JSON.parse(e.data) as Record<string, any>;
    } catch {
      return [];
    }
    switch (e.event ?? j.type) {
      case 'message_start': {
        const u = j.message?.usage ?? {};
        return [{ type: 'usage', input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens }];
      }
      case 'content_block_delta':
        return j.delta?.type === 'text_delta' && j.delta.text ? [{ type: 'text', text: j.delta.text }] : [];
      case 'message_delta': {
        const out: StreamEvent[] = [];
        if (j.usage?.output_tokens !== undefined) out.push({ type: 'usage', output: j.usage.output_tokens });
        if (j.delta?.stop_reason) out.push({ type: 'done', stopReason: j.delta.stop_reason });
        return out;
      }
      case 'message_stop':
        return [{ type: 'done' }];
      case 'error':
        return [{ type: 'error', message: String(j.error?.message ?? '上游错误') }];
      default:
        return [];
    }
  },
  modelsTarget: (m) => ({ url: joinUrl(m.baseUrl, 'v1', '/models?limit=1000'), headers: headers(m) }),
  parseModels: (json) => ((json as { data?: { id: string }[] }).data ?? []).map((d) => d.id).sort(),
};
