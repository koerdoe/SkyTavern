// token 预估：真实分词器、每条回复记下预估与实际、按记录校准。

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { PreviewView, SessionView } from '../../src/core/views.ts';
import { buildApp, type App } from '../../src/server/app.ts';
import { DEFAULT_CONFIG } from '../../src/server/config.ts';
import { openDatabase } from '../../src/server/db.ts';
import { countText, loadTokenizer } from '../../src/server/generation/tokenizer-pool.ts';
import { MockUpstream } from './mock-upstream.ts';

const upstream = new MockUpstream();
before(() => upstream.start());
after(() => upstream.stop());

test('分词器包能加载，数出的 token 和粗略估算不同；包不存在时退回估算', () => {
  assert.deepEqual(loadTokenizer('gpt4o'), { ok: true });
  assert.equal(countText('gpt4o', 'Hello world'), 2);
  assert.equal(countText('gpt4o', ''), 0);
  const missing = loadTokenizer('no_such_tokenizer');
  assert.equal(missing.ok, false);
  assert.ok(countText('no_such_tokenizer', '你好') > 0);
});

test('回复上记下预估和实际；之后按记录校准，新会话沿用同一模型最近的记录', async () => {
  const ctx: App = buildApp({ config: DEFAULT_CONFIG, db: openDatabase(':memory:'), assembleTimeoutMs: 2000 });
  const api = async (method: string, url: string, payload?: unknown) => {
    const r = await ctx.app.inject({ method: method as 'GET', url, ...(payload === undefined ? {} : { payload: payload as object }) });
    return r.json() as any;
  };
  const m = await api('POST', '/api/library/model', { name: 'm', protocol: 'claude', baseUrl: upstream.baseUrl, apiKey: 'k', model: 'anthropic/claude-opus-4.7' });
  await api('PUT', '/api/settings', { ...(await api('GET', '/api/settings')), modelId: m.id });

  const sid = ((await api('POST', '/api/sessions', { characterId: 'char1' })) as SessionView).meta.id;
  const before = (await api('POST', '/api/preview', { sessionId: sid })) as PreviewView;
  assert.equal(before.tokenizer?.id, 'claude-new');
  assert.equal(before.tokenizer?.source, 'default');
  assert.equal(before.tokenizer?.factor, 1.3);
  assert.equal(before.tokenizer?.error, null);
  assert.ok(Object.values(before.entryTokens).length > 0);

  await api('POST', `/api/sessions/${sid}/ops`, { opId: 'a', op: 'append', role: 'user', content: '你好', generate: true });
  await ctx.manager.drain();
  const reply = ((await api('GET', `/api/sessions/${sid}`)) as SessionView).layers.at(-1)!;
  // 模拟上游：input 100 + 缓存读取 80
  assert.equal(reply.estimate?.actual, 180);
  assert.equal(reply.estimate?.tokenizer, 'claude-new');
  assert.ok(reply.estimate!.tokens > 0);

  const calibrated = (await api('POST', '/api/preview', { sessionId: sid })) as PreviewView;
  assert.equal(calibrated.tokenizer?.source, 'session');
  assert.equal(calibrated.tokenizer?.samples, 1);
  assert.notEqual(calibrated.tokenizer?.factor, 1.3);

  const sid2 = ((await api('POST', '/api/sessions', { characterId: 'char1' })) as SessionView).meta.id;
  const fresh = (await api('POST', '/api/preview', { sessionId: sid2 })) as PreviewView;
  assert.equal(fresh.tokenizer?.source, 'recent');
  assert.equal(fresh.tokenizer?.factor, calibrated.tokenizer?.factor);

  // 手动指定分词器
  await api('PUT', `/api/library/model/${m.id}`, { ...(await api('GET', `/api/library/model/${m.id}`)), tokenizer: 'qwen' });
  const manual = (await api('POST', '/api/preview', { sessionId: sid })) as PreviewView;
  assert.equal(manual.tokenizer?.id, 'qwen');
  assert.equal(manual.tokenizer?.auto, false);
  assert.equal(manual.tokenizer?.source, 'default');
  await ctx.app.close();
});
