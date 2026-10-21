// 本地假上游：按协议吐出 SSE，可控制延迟、中断、挂起和错误。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Protocol } from '../../src/core/library.ts';

export interface Script {
  /** 正文分片。 */
  pieces: string[];
  /** 每片之间的间隔。 */
  delayMs?: number;
  /** 发完 n 片后直接断开连接（不发结束事件）。 */
  dropAfter?: number;
  /** 发完所有分片后挂起，直到客户端断开。 */
  hang?: boolean;
  /** 直接返回错误状态。 */
  status?: number;
  errorBody?: unknown;
}

export interface Received {
  url: string;
  headers: IncomingMessage['headers'];
  body: any;
}

const frame = (data: unknown, event?: string): string => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;

function textFrame(p: Protocol, text: string): string {
  switch (p) {
    case 'openai-chat':
      return frame({ choices: [{ delta: { content: text } }] });
    case 'openai-responses':
      return frame({ type: 'response.output_text.delta', delta: text }, 'response.output_text.delta');
    case 'claude':
      return frame({ type: 'content_block_delta', delta: { type: 'text_delta', text } }, 'content_block_delta');
    case 'gemini':
      return frame({ candidates: [{ content: { parts: [{ text }] } }] });
  }
}

function startFrames(p: Protocol): string {
  return p === 'claude'
    ? frame({ type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 0 } } }, 'message_start')
    : '';
}

function endFrames(p: Protocol): string {
  switch (p) {
    case 'openai-chat':
      return frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } }) + 'data: [DONE]\n\n';
    case 'openai-responses':
      return frame({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 5 } } }, 'response.completed');
    case 'claude':
      return (
        frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }, 'message_delta') +
        frame({ type: 'message_stop' }, 'message_stop')
      );
    case 'gemini':
      return frame({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5 } });
  }
}

function protocolOf(url: string): Protocol | 'models' {
  if (url.includes('/chat/completions')) return 'openai-chat';
  if (url.includes('/responses')) return 'openai-responses';
  if (url.includes('/messages')) return 'claude';
  if (url.includes(':streamGenerateContent')) return 'gemini';
  return 'models';
}

/** 假嵌入：按字符落到 32 维里计数。相同的字越多，余弦越大。 */
export function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(32).fill(0);
  for (const ch of text) if (/\p{L}/u.test(ch)) v[ch.codePointAt(0)! % 32]! += 1;
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MockUpstream {
  readonly received: Received[] = [];
  script: Script = { pieces: ['你好', '，旅人'] };
  /** 嵌入接口返回的错误状态（0 为正常）。 */
  embedStatus = 0;
  private server: Server | undefined;
  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
  }

  get last(): Received {
    return this.received.at(-1)!;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = '';
    for await (const c of req) raw += c;
    const url = req.url ?? '';
    this.received.push({ url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
    const p = protocolOf(url);
    const s = this.script;

    if (s.status) {
      res.writeHead(s.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(s.errorBody ?? { error: { message: 'mock error' } }));
      return;
    }
    if (url.includes('/embeddings') || url.includes(':batchEmbedContents')) {
      if (this.embedStatus) {
        res.writeHead(this.embedStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'embed down' } }));
        return;
      }
      const texts: string[] = url.includes('/embeddings') ? this.received.at(-1)!.body.input : this.received.at(-1)!.body.requests.map((r: any) => r.content.parts[0].text);
      const vectors = texts.map(fakeEmbedding);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(url.includes('/embeddings') ? { data: vectors.map((embedding, index) => ({ index, embedding })) } : { embeddings: vectors.map((values) => ({ values })) }));
      return;
    }
    if (p === 'models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(url.includes('v1beta') ? { models: [{ name: 'models/g-1', supportedGenerationMethods: ['generateContent'] }] } : { data: [{ id: 'm-2' }, { id: 'm-1' }] }));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let closed = false;
    res.on('close', () => (closed = true));
    // 先确保已写的数据真正发出去，再掐断连接。
    const drop = async (): Promise<void> => {
      await new Promise<void>((r) => res.write('', () => r()));
      await sleep(20);
      res.socket?.destroy();
    };
    res.write(startFrames(p));
    for (const [i, piece] of s.pieces.entries()) {
      if (s.dropAfter !== undefined && i >= s.dropAfter) return drop();
      if (s.delayMs) await sleep(s.delayMs);
      if (closed) return;
      res.write(textFrame(p, piece));
    }
    if (s.dropAfter !== undefined && s.dropAfter >= s.pieces.length) return drop();
    if (s.hang) {
      await new Promise<void>((r) => res.on('close', () => r()));
      return;
    }
    res.end(endFrames(p));
  }
}
