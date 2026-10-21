import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { Protocol } from '../../src/core/library.ts';
import { buildApp, type App } from '../../src/server/app.ts';
import { DEFAULT_CONFIG } from '../../src/server/config.ts';
import { openDatabase } from '../../src/server/db.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionView } from '../../src/server/sessions/routes.ts';
import { MockUpstream } from './mock-upstream.ts';

const upstream = new MockUpstream();
before(() => upstream.start());
after(() => upstream.stop());

let ctx: App;
let db: DatabaseSync;
beforeEach(() => {
  upstream.script = { pieces: ['你好', '，旅人'] };
  db = openDatabase(':memory:');
  ctx = buildApp({ config: DEFAULT_CONFIG, db, assembleTimeoutMs: 1000 });
});

const api = async (method: string, url: string, payload?: unknown) => {
  const r = await ctx.app.inject({ method: method as 'GET', url, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: r.statusCode, json: r.body ? (r.json() as any) : undefined };
};

/** 新建模型配置并选用。 */
async function useModel(protocol: Protocol, baseUrl = upstream.baseUrl) {
  const m = await api('POST', '/api/library/model', { name: protocol, protocol, baseUrl: protocol.startsWith('openai') ? `${baseUrl}/v1` : baseUrl, apiKey: 'sk-test', model: 'x-1' });
  assert.equal(m.status, 201, JSON.stringify(m.json));
  const s = (await api('GET', '/api/settings')).json;
  await api('PUT', '/api/settings', { ...s, modelId: m.json.id });
  return m.json.id as string;
}

async function newSession(): Promise<string> {
  return (await api('POST', '/api/sessions', { characterId: 'char1' })).json.meta.id;
}

async function send(sessionId: string, content: string, opId = `op-${Math.random()}`) {
  const r = await api('POST', `/api/sessions/${sessionId}/ops`, { opId, op: 'append', role: 'user', content, generate: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json as { generationId: string };
}

const layers = async (sessionId: string) => ((await api('GET', `/api/sessions/${sessionId}`)).json as SessionView).layers;

// ---------- 资料 ----------

test('第一次访问写入默认资料：预设、占位角色、名为“用户”的自机', async () => {
  const settings = (await api('GET', '/api/settings')).json;
  assert.deepEqual(settings, {
    presetId: 'preset1',
    modelId: null,
    personaId: 'persona1',
    worldbookIds: [],
    tokenizerPriority: 'name',
    recall: { mode: 'off', embeddingModelId: null, topK: 3, similarTopK: 5 },
    ui: { theme: 'system', readingMode: 'long', loadCount: 50, styles: [], activeStyle: null, ackedRisks: [] },
  });
  assert.equal((await api('GET', '/api/library/persona/persona1')).json.name, '用户');
  assert.equal((await api('GET', '/api/library/character')).json[0].name, '占位角色');
});

test('模型配置：密钥不下发；不带密钥的整份替换保留原密钥', async () => {
  const id = await useModel('claude');
  const got = (await api('GET', `/api/library/model/${id}`)).json;
  assert.equal(got.apiKey, undefined);
  assert.equal(got.hasKey, true);
  await api('PUT', `/api/library/model/${id}`, { ...got, name: '改名' });
  assert.equal((await api('GET', `/api/library/model/${id}`)).json.hasKey, true);
});

test('词条变更：分配 ID、序号不复用、非法内容整批拒绝', async () => {
  const add = (content: string) => ({ op: 'addEntry', entry: { enabled: true, role: 'system', content, priority: 1, placement: { kind: 'position', section: 'after' } } });
  let doc = (await api('PATCH', '/api/library/preset/preset1', { ops: [add('A')] })).json;
  assert.equal(doc.entries.at(-1).id, 'preset1-2');
  doc = (await api('PATCH', '/api/library/preset/preset1', { ops: [{ op: 'removeEntry', entryId: 'preset1-2' }, add('B')] })).json;
  assert.equal(doc.entries.at(-1).id, 'preset1-3');

  const bad = await api('PATCH', '/api/library/preset/preset1', {
    ops: [add('ok'), { op: 'updateEntry', entryId: 'preset1-1', patch: { if: 'hp >' } }],
  });
  assert.equal(bad.status, 400);
  assert.equal((await api('GET', '/api/library/preset/preset1')).json.entries.length, 2);

  // JSON 模式：nextEntryId 不会倒退
  const replaced = (await api('PUT', '/api/library/preset/preset1', { ...doc, nextEntryId: 1 })).json;
  assert.equal(replaced.nextEntryId, 4);
});

test('被引用的角色卡、世界书不能删除', async () => {
  await newSession();
  const r = await api('DELETE', '/api/library/character/char1');
  assert.equal(r.status, 409);
  assert.match(r.json.message, /1 个会话/);

  const wb = (await api('POST', '/api/library/worldbook', { name: '设定集', entries: [] })).json;
  await api('PATCH', '/api/library/character/char1', { ops: [{ op: 'set', field: 'worldbookIds', value: [wb.id] }] });
  assert.equal((await api('DELETE', `/api/library/worldbook/${wb.id}`)).status, 409);
});

// ---------- 预览 ----------

test('预设预览：没有会话也能预览；未选模型时只有消息没有请求体', async () => {
  const r = (await api('POST', '/api/preview', { characterId: 'char1' })).json;
  assert.equal(r.body, null);
  assert.match(r.messages[0].content, /你是占位角色。请以占位角色的身份与用户进行角色扮演/);
  assert.deepEqual(r.outcomes['preset1-1'], { status: 'placed', priority: 0, messageIndex: 0 });
  assert.deepEqual(r.outcomes['persona1-1'], { status: 'placed', priority: 4000, messageIndex: null }); // 空设定被去掉
});

test('预览带出协议请求体，不含密钥', async () => {
  await useModel('claude');
  const sid = await newSession();
  await api('POST', `/api/sessions/${sid}/ops`, { opId: 'a', op: 'append', role: 'user', content: '在吗' });
  const r = (await api('POST', '/api/preview', { sessionId: sid })).json;
  assert.equal(r.protocol, 'claude');
  assert.equal(JSON.stringify(r.body).includes('sk-test'), false);
  assert.deepEqual(r.body.messages, [{ role: 'user', content: [{ type: 'text', text: '在吗', cache_control: { type: 'ephemeral' } }] }]);
  assert.equal(r.body.max_tokens, 4096); // Claude 必需字段，预设没写时自动补上
});

test('预设请求参数：合并进请求体；写了固定字段或有语法错误时不能保存；旧版 params 自动迁移', async () => {
  await useModel('claude');
  const preset = (await api('GET', '/api/library/preset/preset1')).json;
  assert.equal(preset.requestJson, '');
  assert.equal(preset.inputLimit, 32000);

  const ok = await api('PATCH', '/api/library/preset/preset1', { ops: [{ op: 'set', field: 'requestJson', value: 'thinking: {"type":"disabled"},\nmax_tokens: 1000' }] });
  assert.equal(ok.status, 200);
  const body = (await api('POST', '/api/preview', { characterId: 'char1' })).json.body;
  assert.deepEqual([body.thinking, body.max_tokens], [{ type: 'disabled' }, 1000]);

  const fixed = await api('PATCH', '/api/library/preset/preset1', { ops: [{ op: 'set', field: 'requestJson', value: 'stream: false' }] });
  assert.equal(fixed.status, 400);
  assert.match(fixed.json.message, /stream 由平台固定填写/);
  const comma = await api('PATCH', '/api/library/preset/preset1', { ops: [{ op: 'set', field: 'requestJson', value: 'a: 1\nb: 2' }] });
  assert.equal(comma.status, 400);
  assert.match(comma.json.message, /第 2 行第 1 列：这里缺少逗号/);

  // 库里直接存着旧结构的预设（升级前的数据）：读出来时就已补齐，生成照常
  const { requestJson: _rj, inputLimit: _il, ...rest } = preset;
  db.prepare("UPDATE library SET doc = jsonb(?) WHERE kind = 'preset' AND id = 'preset1'").run(JSON.stringify({ ...rest, params: { maxTokens: 1, inputLimit: 7000 } }));
  const upgraded = (await api('GET', '/api/library/preset/preset1')).json;
  assert.deepEqual([upgraded.requestJson, upgraded.inputLimit, 'params' in upgraded], ['', 7000, false]);
  assert.equal((await api('POST', '/api/preview', { characterId: 'char1' })).status, 200);

  // 按旧格式写入：params 里的 inputLimit 迁移过来，其余旧字段丢弃
  const legacy = await api('PUT', '/api/library/preset/preset1', { ...rest, params: { maxTokens: 2048, temperature: 1, inputLimit: 9000 } });
  assert.equal(legacy.json.inputLimit, 9000);
  assert.equal(legacy.json.requestJson, '');
  assert.equal('params' in legacy.json, false);
});

// ---------- 生成 ----------

for (const protocol of ['openai-chat', 'openai-responses', 'claude', 'gemini'] as const) {
  test(`生成（${protocol}）：完整返回后写入新一层，带用量`, async () => {
    await useModel(protocol);
    const sid = await newSession();
    await send(sid, '你好');
    await ctx.manager.drain();
    const ls = await layers(sid);
    assert.deepEqual(ls.map((l) => [l.role, l.content, l.partial]), [
      ['user', '你好', false],
      ['assistant', '你好，旅人', false],
    ]);
    assert.equal(ls[1]!.usage?.input, 100);
    assert.equal(ls[1]!.usage?.output, 5);
    // 密钥在请求头里，不在请求体里
    const auth = upstream.last.headers['authorization'] ?? upstream.last.headers['x-api-key'] ?? upstream.last.headers['x-goog-api-key'];
    assert.match(String(auth), /sk-test/);
    assert.equal(JSON.stringify(upstream.last.body).includes('sk-test'), false);
  });
}

test('客户端流：先给当前全文再给增量；断开不影响生成', async () => {
  await useModel('openai-chat');
  upstream.script = { pieces: ['一', '二', '三', '四'], delayMs: 40 };
  const sid = await newSession();
  const { generationId } = await send(sid, 'hi');

  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (ctx.app.server.address() as { port: number }).port;
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/generations/${generationId}/events`, { signal: ac.signal });
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /^event: snapshot/);
  ac.abort(); // 客户端断开

  await ctx.manager.drain();
  assert.equal((await layers(sid))[1]!.content, '一二三四');

  // 结束后再连上：拿到全文和结束事件
  const again = await (await fetch(`http://127.0.0.1:${port}/api/generations/${generationId}/events`)).text();
  assert.match(again, /"text":"一二三四"/);
  assert.match(again, /event: end\ndata: \{"type":"end","status":"completed"/);
  await ctx.app.close();
});

test('停止：已收到的正文保存为未完成回复', async () => {
  await useModel('claude');
  upstream.script = { pieces: ['半', '截'], hang: true };
  const sid = await newSession();
  const { generationId } = await send(sid, 'hi');
  while ((ctx.manager.get('root', generationId)?.text ?? '') !== '半截') await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual((await api('POST', `/api/generations/${generationId}/stop`)).json, { stopped: true });
  await ctx.manager.drain();
  const last = (await layers(sid))[1]!;
  assert.deepEqual([last.content, last.partial], ['半截', true]);
  assert.equal(ctx.manager.get('root', generationId)!.status, 'stopped');
});

test('上游中途断开：保存为未完成回复；一个字都没收到则不写', async () => {
  await useModel('gemini');
  upstream.script = { pieces: ['断', '在', '这'], dropAfter: 2 };
  const sid = await newSession();
  const g1 = await send(sid, 'hi');
  await ctx.manager.drain();
  assert.equal(ctx.manager.get('root', g1.generationId)!.status, 'interrupted');
  assert.deepEqual((await layers(sid)).map((l) => [l.content, l.partial]), [['hi', false], ['断在', true]]);

  upstream.script = { pieces: [], status: 401, errorBody: { error: { message: 'bad key' } } };
  const g2 = await api('POST', `/api/sessions/${sid}/ops`, { opId: 'c', op: 'continue' });
  await ctx.manager.drain();
  const g = ctx.manager.get('root', g2.json.generationId)!;
  assert.equal(g.status, 'failed');
  assert.match(g.error!, /401.*bad key/);
  assert.equal((await layers(sid)).length, 2);
});

test('同一会话同时只能有一个生成；生成中可以编辑，不能追加', async () => {
  await useModel('openai-chat');
  upstream.script = { pieces: ['慢', '慢'], delayMs: 60 };
  const sid = await newSession();
  await send(sid, '第一句');
  assert.equal((await api('POST', `/api/sessions/${sid}/ops`, { opId: 'x', op: 'continue' })).status, 409);
  assert.equal((await api('POST', `/api/sessions/${sid}/ops`, { opId: 'y', op: 'append', role: 'user', content: '插队' })).status, 409);
  const first = (await layers(sid))[0]!;
  assert.equal((await api('POST', `/api/sessions/${sid}/ops`, { opId: 'z', op: 'edit', messageId: first.id, content: '改过的第一句' })).status, 200);
  await ctx.manager.drain();
  // 本次生成用的是发送时的快照
  assert.equal(upstream.last.body.messages.at(-1).content, '第一句');
  assert.deepEqual((await layers(sid)).map((l) => l.content), ['改过的第一句', '慢慢']);
});

test('不同会话可以并行生成', async () => {
  await useModel('openai-chat');
  upstream.script = { pieces: ['a', 'b'], delayMs: 30 };
  const [s1, s2] = [await newSession(), await newSession()];
  await send(s1, '1');
  await send(s2, '2');
  await ctx.manager.drain();
  assert.equal((await layers(s1))[1]!.content, 'ab');
  assert.equal((await layers(s2))[1]!.content, 'ab');
});

test('重新生成：在原层新增候选并选用，请求里不含被重生成的那层', async () => {
  await useModel('openai-chat');
  const sid = await newSession();
  await send(sid, '你好');
  await ctx.manager.drain();
  const reply = (await layers(sid))[1]!;

  upstream.script = { pieces: ['换个说法'] };
  await api('POST', `/api/sessions/${sid}/ops`, { opId: 'r1', op: 'reroll', messageId: reply.id });
  await ctx.manager.drain();
  assert.deepEqual(upstream.last.body.messages.map((m: { content: string }) => m.content).slice(-1), ['你好']);
  const now = (await layers(sid))[1]!;
  assert.equal(now.content, '换个说法');
  assert.equal(now.candidateIds.length, 2);
  assert.equal(now.selectedIndex, 1);

  // 不能对 user 消息重新生成
  const user = (await layers(sid))[0]!;
  assert.equal((await api('POST', `/api/sessions/${sid}/ops`, { opId: 'r2', op: 'reroll', messageId: user.id })).status, 400);
});

test('重复的 opId 不会重复生成', async () => {
  await useModel('openai-chat');
  const sid = await newSession();
  await send(sid, 'hi');
  await ctx.manager.drain();
  const a = await api('POST', `/api/sessions/${sid}/ops`, { opId: 'same', op: 'continue' });
  await ctx.manager.drain();
  const b = await api('POST', `/api/sessions/${sid}/ops`, { opId: 'same', op: 'continue' });
  assert.equal(a.json.applied, true);
  assert.deepEqual(b.json, { applied: false, generationId: null });
  assert.equal((await layers(sid)).length, 3);
});

test('普通快照：最近一次实际发送的请求，只读', async () => {
  await useModel('claude');
  const sid = await newSession();
  assert.equal((await api('GET', `/api/sessions/${sid}/snapshot`)).status, 404);
  await send(sid, 'hi');
  await ctx.manager.drain();
  const snap = (await api('GET', `/api/sessions/${sid}/snapshot`)).json;
  assert.deepEqual(snap.body, upstream.last.body);
});

test('Debug：截取后可编辑，之后配置变化不影响它；发送后回复写入正式聊天', async () => {
  await useModel('openai-chat');
  const sid = await newSession();
  await api('POST', `/api/sessions/${sid}/ops`, { opId: 'a', op: 'append', role: 'user', content: '原话' });
  const snap = (await api('POST', `/api/sessions/${sid}/debug`, {})).json;
  const edited = { ...snap.body, messages: [...snap.body.messages.slice(0, -1), { role: 'user', content: '手改的话' }], temperature: 0.1 };
  await api('PUT', `/api/sessions/${sid}/debug`, { body: edited });

  // 截取之后改预设，不影响快照
  await api('PATCH', '/api/library/preset/preset1', { ops: [{ op: 'updateEntry', entryId: 'preset1-1', patch: { content: '新的主提示' } }] });
  assert.deepEqual((await api('GET', `/api/sessions/${sid}/debug`)).json.body, edited);

  const { generationId } = (await api('POST', `/api/sessions/${sid}/debug/send`)).json;
  await ctx.manager.drain();
  assert.deepEqual(upstream.last.body, edited);
  assert.equal(ctx.manager.get('root', generationId)!.debug, true);
  assert.deepEqual((await layers(sid)).map((l) => l.content), ['原话', '你好，旅人']);
});

test('裁剪起点在生成时保存下来', async () => {
  await useModel('openai-chat');
  const preset = (await api('GET', '/api/library/preset/preset1')).json;
  await api('PUT', '/api/library/preset/preset1', { ...preset, inputLimit: 150 });
  const sid = await newSession();
  for (let i = 0; i < 12; i++) {
    await api('POST', `/api/sessions/${sid}/ops`, { opId: `m${i}`, op: 'append', role: i % 2 ? 'assistant' : 'user', content: '这是一段二十个字左右的聊天内容用来占位。' });
  }
  await api('POST', `/api/sessions/${sid}/ops`, { opId: 'go', op: 'continue' });
  await ctx.manager.drain();
  const doc = ctx.sessions.get('root', sid).doc;
  assert.ok(doc.window, '应保存裁剪起点');
  assert.equal(doc.window.presetId, 'preset1');
  assert.ok(upstream.last.body.messages.length < 13);
});

test('组装错误：IF 出错指出词条；正则回溯失控会超时终止，之后仍可正常组装', async () => {
  await api('PATCH', '/api/library/preset/preset1', { ops: [{ op: 'updateEntry', entryId: 'preset1-1', patch: { if: 'nope > 1' } }] });
  const r = await api('POST', '/api/preview', { characterId: 'char1' });
  assert.equal(r.status, 422);
  assert.equal(r.json.entryId, 'preset1-1');

  await api('PATCH', '/api/library/preset/preset1', {
    ops: [
      { op: 'updateEntry', entryId: 'preset1-1', patch: { if: '', content: `${'a'.repeat(40)}!` } },
      { op: 'addEntry', entry: { enabled: true, role: 'system', content: 'x', priority: 0, placement: { kind: 'insert', pattern: '(a+)+$', scope: ['system'], pick: 'first', onMiss: 'silent' } } },
    ],
  });
  const slow = await api('POST', '/api/preview', { characterId: 'char1' });
  assert.equal(slow.status, 422);
  assert.equal(slow.json.error, 'timeout');

  await api('PATCH', '/api/library/preset/preset1', { ops: [{ op: 'removeEntry', entryId: 'preset1-2' }] });
  assert.equal((await api('POST', '/api/preview', { characterId: 'char1' })).status, 200);
});

test('Claude：正文后使用 system 角色时报错并指出词条', async () => {
  await useModel('claude');
  await api('PATCH', '/api/library/preset/preset1', {
    ops: [{ op: 'addEntry', entry: { enabled: true, role: 'system', content: '动态', priority: 0, placement: { kind: 'position', section: 'after' } } }],
  });
  const sid = await newSession();
  const r = await api('POST', `/api/sessions/${sid}/ops`, { opId: 'a', op: 'append', role: 'user', content: 'hi', generate: true });
  assert.equal(r.status, 422);
  assert.equal(r.json.entryId, 'preset1-2');
});

test('拉取模型列表：用表单当前值，不必先保存', async () => {
  const id = await useModel('openai-chat');
  assert.deepEqual((await api('POST', '/api/models/list', { protocol: 'openai-chat', baseUrl: `${upstream.baseUrl}/v1`, modelId: id })).json, { models: ['m-1', 'm-2'] });
  // 用表单里未保存的地址，而不是库里的旧地址；密钥留空时沿用已保存的
  await api('PUT', `/api/library/model/${id}`, { name: 'x', protocol: 'openai-chat', baseUrl: 'https://old.invalid/v1', model: 'x-1' });
  const r = await api('POST', '/api/models/list', { protocol: 'openai-chat', baseUrl: `${upstream.baseUrl}/v1`, modelId: id });
  assert.deepEqual(r.json, { models: ['m-1', 'm-2'] });
  assert.equal(upstream.last.headers.authorization, 'Bearer sk-test');
  // 填了新密钥就用新密钥
  await api('POST', '/api/models/list', { protocol: 'openai-chat', baseUrl: `${upstream.baseUrl}/v1`, apiKey: 'sk-new', modelId: id });
  assert.equal(upstream.last.headers.authorization, 'Bearer sk-new');
  // 地址不合法时给出明确错误
  assert.equal((await api('POST', '/api/models/list', { protocol: 'openai-chat', baseUrl: 'not a url' })).status, 400);
  const gid = await useModel('gemini');
  assert.deepEqual((await api('POST', '/api/models/list', { protocol: 'gemini', baseUrl: upstream.baseUrl, modelId: gid })).json, { models: ['g-1'] });
});
