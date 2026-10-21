// 召回：词条用到 {{$recall}} 时，从正文窗口之外的记录里找相关片段；向量模式下建索引、出错处理、删除消息时清理。

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { PreviewView, SessionView } from '../../src/core/views.ts';
import { buildApp } from '../../src/server/app.ts';
import { DEFAULT_CONFIG } from '../../src/server/config.ts';
import { openDatabase } from '../../src/server/db.ts';
import { fakeEmbedding, MockUpstream } from './mock-upstream.ts';
import { cosine } from '../../src/core/recall.ts';

const upstream = new MockUpstream();
before(() => upstream.start());
after(() => upstream.stop());

const FILLER = '我们沿着小路继续往前走，天色渐渐暗了下来，远处传来几声鸟叫。';
const KEY_TEXT = '老人把一把蓝色钥匙塞进你手里，说它能打开北塔地下室的铁门，千万不要弄丢。';

async function setup() {
  const db = openDatabase(':memory:');
  const built = buildApp({ config: DEFAULT_CONFIG, db });
  const { app } = built;
  const api = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as 'GET', url, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: r.statusCode, json: r.body ? (r.json() as any) : undefined };
  };
  const chat = (await api('POST', '/api/library/model', { name: 'chat', protocol: 'openai-chat', baseUrl: `${upstream.baseUrl}/v1`, apiKey: 'k', model: 'x' })).json;
  const emb = (await api('POST', '/api/library/model', { name: 'emb', protocol: 'openai-chat', baseUrl: `${upstream.baseUrl}/v1`, apiKey: 'k', model: 'e', use: 'embedding' })).json;
  const preset = (await api('GET', '/api/library/preset/preset1')).json;
  await api('PUT', '/api/library/preset/preset1', { ...preset, inputLimit: 260 });
  await api('PATCH', '/api/library/preset/preset1', {
    ops: [{ op: 'addEntry', entry: { enabled: true, role: 'user', content: '相关往事：\n{{$recall}}', priority: 1, if: '$recall != ""', placement: { kind: 'position', section: 'after' } } }],
  });
  const setRecall = async (recall: object) => {
    const s = (await api('GET', '/api/settings')).json;
    return api('PUT', '/api/settings', { ...s, modelId: chat.id, recall: { ...s.recall, ...recall } });
  };
  const sid = ((await api('POST', '/api/sessions', { characterId: 'char1' })).json as SessionView).meta.id;
  const append = (i: number, role: string, content: string) => api('POST', `/api/sessions/${sid}/ops`, { opId: `m${i}`, op: 'append', role, content });
  await append(0, 'user', '我们出发吧。');
  await append(1, 'assistant', KEY_TEXT);
  for (let i = 2; i < 14; i++) await append(i, i % 2 ? 'assistant' : 'user', FILLER);
  await append(14, 'user', '那把蓝色钥匙还在吗？');
  const preview = async () => (await api('POST', '/api/preview', { sessionId: sid })) as { status: number; json: PreviewView & { message?: string } };
  return { ...built, db, api, sid, emb, setRecall, preview };
}

const bodyText = (p: PreviewView) => JSON.stringify(p.body);
const msgText = (p: PreviewView) => JSON.stringify(p.messages);

test('关键词召回：窗口外的相关片段放进 {{$recall}}；关闭时词条不出现', async () => {
  const { app, setRecall, preview } = await setup();
  let p = await preview();
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.ok(!bodyText(p.json).includes('相关往事'), '召回关闭时 $recall 为空，词条不放置');
  assert.ok(!bodyText(p.json).includes('蓝色钥匙塞进'), '那条消息应已被裁出正文窗口');

  await setRecall({ mode: 'keyword', topK: 1 });
  p = await preview();
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.ok(bodyText(p.json).includes('相关往事'), bodyText(p.json));
  assert.ok(bodyText(p.json).includes('蓝色钥匙塞进'), '应召回含“蓝色钥匙”的片段');
  await app.close();
});

test('向量召回：缺的索引当场补齐，之后新消息在后台补；嵌入出错时停止并在状态里记下原因', async () => {
  const { app, api, sid, emb, setRecall, preview, recall } = await setup();
  assert.equal((await setRecall({ mode: 'vector', embeddingModelId: null })).status, 200);
  let p = await preview();
  assert.equal(p.status, 422);
  assert.match(p.json.message!, /嵌入模型/);

  await setRecall({ mode: 'vector', embeddingModelId: emb.id, topK: 1 });
  p = await preview();
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.ok(bodyText(p.json).includes('蓝色钥匙塞进'));
  let st = (await api('GET', `/api/sessions/${sid}/recall`)).json;
  assert.equal(st.chunks, st.indexed);
  assert.equal(st.state, 'idle');

  // 新消息：后台补索引
  await api('POST', `/api/sessions/${sid}/ops`, { opId: 'n1', op: 'append', role: 'assistant', content: '新的一条回复。' });
  await recall.drain();
  st = (await api('GET', `/api/sessions/${sid}/recall`)).json;
  assert.equal(st.indexed, st.chunks);

  // 嵌入接口出错：后台失败记下原因；当场需要时报错；手动重试成功后恢复
  upstream.embedStatus = 500;
  await api('POST', `/api/sessions/${sid}/ops`, { opId: 'n2', op: 'append', role: 'user', content: '换个话题，北塔在哪里？' });
  await recall.drain();
  st = (await api('GET', `/api/sessions/${sid}/recall`)).json;
  assert.equal(st.state, 'error');
  assert.ok(st.error);
  assert.equal((await preview()).status, 422);
  assert.equal((await api('POST', `/api/sessions/${sid}/recall/reindex`)).status, 422);
  upstream.embedStatus = 0;
  const re = await api('POST', `/api/sessions/${sid}/recall/reindex`);
  assert.equal(re.status, 200);
  assert.deepEqual([re.json.state, re.json.indexed], ['idle', re.json.chunks]);
  await app.close();
});

test('删除消息时删掉它的向量；删除会话时全部删除', async () => {
  const { app, api, sid, emb, setRecall, db } = await setup();
  await setRecall({ mode: 'hybrid', embeddingModelId: emb.id });
  await api('POST', `/api/sessions/${sid}/recall/reindex`);
  const count = () => (db.prepare('SELECT count(*) AS n FROM recall_chunks').get() as { n: number }).n;
  const before = count();
  assert.ok(before > 0);
  const layers = (await api('GET', `/api/sessions/${sid}`)).json.layers;
  const r = await api('POST', `/api/sessions/${sid}/ops`, { opId: 'del', op: 'delete', messageId: layers[1].id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(count() < before);
  await api('DELETE', `/api/sessions/${sid}`);
  assert.equal(count(), 0);
  await app.close();
});

test('服务重启后：建过索引的会话自动补齐；会话已不存在的清掉', async () => {
  const { app, api, sid, emb, setRecall, db, recall, sessions } = await setup();
  await setRecall({ mode: 'vector', embeddingModelId: emb.id });
  await api('POST', `/api/sessions/${sid}/recall/reindex`);
  // 模拟关闭前没补完：删掉一部分，再加一个不存在的会话的残留
  db.prepare("DELETE FROM recall_chunks WHERE rowid IN (SELECT rowid FROM recall_chunks LIMIT 3)").run();
  db.prepare("INSERT INTO recall_chunks (user, session_id, message_id, seq, hash, model, vector) VALUES ('root', 'gone', 'm', 0, 'h', 'x', x'00')").run();
  const n = await recall.resume((user, id) => {
    try {
      return sessions.get(user, id).doc;
    } catch {
      return null;
    }
  });
  assert.equal(n, 1);
  const st = (await api('GET', `/api/sessions/${sid}/recall`)).json;
  assert.equal(st.indexed, st.chunks);
  assert.equal((db.prepare("SELECT count(*) AS n FROM recall_chunks WHERE session_id = 'gone'").get() as { n: number }).n, 0);
  await app.close();
});

test('similar()：召回没开时按不成立并提示；开了按相似度和前 K 条决定', async () => {
  const { app, api, emb, setRecall, preview } = await setup();
  const add = async (name: string, cond: string) => {
    const doc = (await api('PATCH', '/api/library/preset/preset1', {
      ops: [{ op: 'addEntry', entry: { name, enabled: true, role: 'user', content: `【${name}】`, priority: 2, if: cond, placement: { kind: 'position', section: 'after' } } }],
    })).json;
    return doc.entries.at(-1).id as string;
  };
  const key = await add('钥匙', 'similar("蓝色的钥匙还在不在", 0.01)');
  const other = await add('天气', 'similar(1, "今天天气晴朗适合出门", 0.01)');

  // 召回关着：不成立，有提示
  let p = await preview();
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.ok(!bodyText(p.json).includes('【钥匙】'));
  assert.ok(p.json.warnings.some((w) => w.code === 'similar-off' && w.entryId === key));

  // 打开：分数是最近几条消息所有块里最相似的那块
  await setRecall({ mode: 'vector', embeddingModelId: emb.id, similarTopK: 5 });
  p = await preview();
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.ok(!p.json.warnings.some((w) => w.code === 'similar-off'));
  const expected = (q: string, texts: string[]) => Math.max(...texts.map((t) => cosine(fakeEmbedding(q), fakeEmbedding(t))));
  const s1 = p.json.similarity[key]!;
  assert.ok(Math.abs(s1.score - expected('蓝色的钥匙还在不在', [FILLER, '那把蓝色钥匙还在吗？'])) < 1e-6);
  const s2 = p.json.similarity[other]!;
  assert.ok(Math.abs(s2.score - expected('今天天气晴朗适合出门', ['那把蓝色钥匙还在吗？'])) < 1e-6); // similar(1, …) 只看最近 1 条
  assert.ok(s1.passed && s2.passed);
  assert.ok(bodyText(p.json).includes('【钥匙】') && bodyText(p.json).includes('【天气】'));

  // 最多 1 条：分数低的那个被挤掉
  await setRecall({ similarTopK: 1 });
  p = await preview();
  const [hi, lo] = s1.score >= s2.score ? [key, other] : [other, key];
  assert.equal(p.json.similarity[hi]!.passed, true);
  assert.deepEqual([p.json.similarity[lo]!.passed, p.json.similarity[lo]!.cut], [false, true]);

  // 阈值没过
  await api('PATCH', '/api/library/preset/preset1', { ops: [{ op: 'updateEntry', entryId: key, patch: { if: 'similar("蓝色的钥匙还在不在", 0.999)' } }] });
  p = await preview();
  assert.equal(p.json.similarity[key]!.passed, false);
  assert.equal(p.json.similarity[key]!.cut, undefined);

  // 编辑预设时的预览（没有会话）：不成立，也不提示
  const blank = await api('POST', '/api/preview', { characterId: 'char1' });
  assert.equal(blank.status, 200);
  assert.ok(!blank.json.warnings.some((w: { code: string }) => w.code === 'similar-off'));
  await app.close();
});

test('最近消息和 pick：$lastUserMessage 有值；pick 同一会话里固定', async () => {
  const { app, api, preview } = await setup();
  await api('PATCH', '/api/library/preset/preset1', {
    ops: [{ op: 'addEntry', entry: { enabled: true, role: 'system', content: '上一句：{{$lastUserMessage}}｜{{pick("甲", "乙", "丙", "丁", "戊")}}', priority: 3, placement: { kind: 'position', section: 'after' } } }],
  });
  const a = msgText((await preview()).json);
  assert.ok(a.includes('上一句：那把蓝色钥匙还在吗？'), a);
  const pickOf = (t: string) => /｜(.)/.exec(t)![1];
  assert.equal(pickOf(msgText((await preview()).json)), pickOf(a));
  await app.close();
});
