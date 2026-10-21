import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelConfig, Protocol } from '../../src/core/library.ts';
import type { AssembledMessage, Role, Section } from '../../src/core/types.ts';
import { ADAPTERS, buildRequestBody, ProtocolError, readSse, type StreamEvent } from '../../src/server/providers/index.ts';

const msg = (role: Role, content: string, section: Section = 'chat', entryId?: string): AssembledMessage => ({
  role,
  content,
  section,
  origin: entryId ? { kind: 'entry', entryId } : { kind: 'history', messageId: 'h' },
  protected: false,
  volatile: false,
  insertedBy: [],
});

const model = (protocol: Protocol, baseUrl: string): ModelConfig => ({ id: 'model1', name: 'm', protocol, baseUrl, apiKey: 'sk-secret', model: 'x-1', tokenizer: 'auto', use: 'chat' });
const messages = [msg('system', 'S', 'system', 'p-1'), msg('system', 'B', 'before', 'c-1'), msg('user', 'hi'), msg('assistant', 'yo'), msg('user', 'again')];

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield new TextEncoder().encode(p);
}

const parseAll = async (protocol: Protocol, raw: string[]): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of readSse(chunks(...raw))) out.push(...ADAPTERS[protocol].parseEvent(e));
  return out;
};

test('SSE：跨块切分、多行 data、注释、结尾没有空行', async () => {
  const events = [];
  for await (const e of readSse(chunks('event: a\nda', 'ta: 1\ndata: 2\n\n: ping\n\r\n', 'data: last'))) events.push(e);
  assert.deepEqual(events, [
    { event: 'a', data: '1\n2' },
    { event: undefined, data: 'last' },
  ]);
});

test('OpenAI Chat：请求体保留 role，不含密钥', () => {
  const body = ADAPTERS['openai-chat'].buildBody({ messages, cacheBreakpoints: [1] }, model('openai-chat', 'https://api.openai.com/v1'));
  assert.deepEqual(body.messages, messages.map((m) => ({ role: m.role, content: m.content })));
  assert.equal(JSON.stringify(body).includes('sk-secret'), false);
  const t = ADAPTERS['openai-chat'].streamTarget(model('openai-chat', 'https://api.openai.com/v1/'));
  assert.equal(t.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(t.headers.authorization, 'Bearer sk-secret');
});

test('OpenAI Chat：流解析', async () => {
  const d = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const ev = await parseAll('openai-chat', [
    d({ choices: [{ delta: { role: 'assistant' } }] }),
    d({ choices: [{ delta: { content: '你' } }] }),
    d({ choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] }),
    d({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 8 } } }),
    'data: [DONE]\n\n',
  ]);
  assert.deepEqual(ev, [
    { type: 'text', text: '你' },
    { type: 'text', text: '好' },
    { type: 'done', stopReason: 'stop' },
    { type: 'usage', input: 10, output: 2, cacheRead: 8 },
  ]);
});

test('OpenAI Responses：请求体与流解析', async () => {
  const body = ADAPTERS['openai-responses'].buildBody({ messages, cacheBreakpoints: [] }, model('openai-responses', 'https://api.openai.com/v1'));
  assert.equal((body.input as unknown[]).length, 5);
  const ev = await parseAll('openai-responses', [
    'event: response.created\ndata: {"type":"response.created"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"A"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}\n\n',
  ]);
  assert.deepEqual(ev, [
    { type: 'text', text: 'A' },
    { type: 'usage', input: 5, output: 1, cacheRead: 0 },
    { type: 'done', stopReason: 'completed' },
  ]);
});

test('Claude：开头的 system 进 system 参数，断点落成 cache_control', () => {
  const body = ADAPTERS.claude.buildBody({ messages, cacheBreakpoints: [1, 3] }, model('claude', 'https://api.anthropic.com'));
  assert.deepEqual(body.system, [
    { type: 'text', text: 'S' },
    { type: 'text', text: 'B', cache_control: { type: 'ephemeral' } },
  ]);
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'yo', cache_control: { type: 'ephemeral' } }] },
    { role: 'user', content: [{ type: 'text', text: 'again' }] },
  ]);
  assert.equal(ADAPTERS.claude.streamTarget(model('claude', 'https://api.anthropic.com')).url, 'https://api.anthropic.com/v1/messages');
  assert.equal(ADAPTERS.claude.streamTarget(model('claude', 'https://proxy.example/v1')).url, 'https://proxy.example/v1/messages');
});

test('Claude：断点超过 4 个时保留最后 4 个', () => {
  const many = Array.from({ length: 8 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `m${i}`));
  const body = ADAPTERS.claude.buildBody({ messages: many, cacheBreakpoints: [0, 1, 2, 3, 4, 5] }, model('claude', 'https://a'));
  const marked = (body.messages as { content: { cache_control?: unknown }[] }[]).flatMap((m, i) => (m.content[0]!.cache_control ? [i] : []));
  assert.deepEqual(marked, [2, 3, 4, 5]);
});

test('Claude / Gemini：对话中间的 system 直接报错并指出词条', () => {
  const bad = [msg('user', 'hi'), msg('system', '动态', 'after', 'preset1-9')];
  for (const p of ['claude', 'gemini'] as const) {
    assert.throws(
      () => ADAPTERS[p].buildBody({ messages: bad, cacheBreakpoints: [] }, model(p, 'https://a')),
      (e: unknown) => e instanceof ProtocolError && e.entryId === 'preset1-9',
    );
  }
});

test('Claude：流解析', async () => {
  const ev = await parseAll('claude', [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":15,"cache_creation_input_tokens":0}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"想"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"嗨"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]);
  assert.deepEqual(ev, [
    { type: 'usage', input: 20, cacheRead: 15, cacheWrite: 0 },
    { type: 'text', text: '嗨' },
    { type: 'usage', output: 3 },
    { type: 'done', stopReason: 'end_turn' },
    { type: 'done' },
  ]);
});

test('Gemini：请求体与流解析（跳过思考部分）', async () => {
  const body = ADAPTERS.gemini.buildBody({ messages, cacheBreakpoints: [] }, model('gemini', 'https://g'));
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'S' }, { text: 'B' }] });
  assert.deepEqual((body.contents as { role: string }[]).map((c) => c.role), ['user', 'model', 'user']);
  assert.equal(
    ADAPTERS.gemini.streamTarget(model('gemini', 'https://generativelanguage.googleapis.com')).url,
    'https://generativelanguage.googleapis.com/v1beta/models/x-1:streamGenerateContent?alt=sse',
  );
  const ev = await parseAll('gemini', [
    'data: {"candidates":[{"content":{"parts":[{"text":"想","thought":true},{"text":"好"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"的"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":2}}\n\n',
  ]);
  assert.deepEqual(ev, [
    { type: 'text', text: '好' },
    { type: 'text', text: '的' },
    { type: 'usage', input: 9, output: 2, cacheRead: undefined },
    { type: 'done', stopReason: 'STOP' },
  ]);
});

test('模型列表解析', () => {
  assert.deepEqual(ADAPTERS['openai-chat'].parseModels({ data: [{ id: 'b' }, { id: 'a' }] }), ['a', 'b']);
  assert.deepEqual(
    ADAPTERS.gemini.parseModels({
      models: [
        { name: 'models/gemini-x', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
      ],
    }),
    ['gemini-x'],
  );
});

test('请求参数合并进请求体；Claude 没写 max_tokens 时补默认值；固定字段不被覆盖', () => {
  const input = { messages, cacheBreakpoints: [] };
  const c = buildRequestBody(input, model('claude', 'https://a'), 'thinking: {"type":"disabled"}');
  assert.deepEqual(c.thinking, { type: 'disabled' });
  assert.equal(c.max_tokens, 4096);
  assert.equal(c.stream, true);
  const o = buildRequestBody(input, model('openai-chat', 'https://a/v1'), 'max_tokens: 800, temperature: 0.9');
  assert.equal(o.max_tokens, 800);
  assert.equal(o.temperature, 0.9);
  const g = buildRequestBody(input, model('gemini', 'https://a'), 'generationConfig: { maxOutputTokens: 900, thinkingConfig: { thinkingBudget: 0 } }');
  assert.deepEqual(g.generationConfig, { maxOutputTokens: 900, thinkingConfig: { thinkingBudget: 0 } });
  assert.equal('max_tokens' in g, false);
  assert.throws(() => buildRequestBody(input, model('claude', 'https://a'), 'messages: []'), /由平台固定填写/);
});
