// 附件：上传（同内容去重）、随消息发送（按协议封装，发送前才换成文件内容）、引用关系与清理。

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { PreviewView, SessionView } from '../../src/core/views.ts';
import { buildApp } from '../../src/server/app.ts';
import { DEFAULT_CONFIG } from '../../src/server/config.ts';
import { openDatabase } from '../../src/server/db.ts';
import { MockUpstream } from './mock-upstream.ts';

const upstream = new MockUpstream();
before(() => upstream.start());
after(() => upstream.stop());

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

async function setup(protocol: 'claude' | 'openai-chat' | 'gemini' | 'openai-responses') {
  let clock = 1_000_000;
  const built = buildApp({ config: DEFAULT_CONFIG, db: openDatabase(':memory:'), now: () => clock });
  const { app } = built;
  const inj = async (method: string, url: string, payload?: object | Buffer, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method: method as 'GET', url, ...(payload ? { payload } : {}), headers });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') && r.body ? (r.json() as any) : undefined, raw: r.rawPayload };
  };
  const baseUrl = protocol.startsWith('openai') ? `${upstream.baseUrl}/v1` : upstream.baseUrl;
  const m = await inj('POST', '/api/library/model', { name: 'm', protocol, baseUrl, apiKey: 'k', model: 'x' });
  await inj('PUT', '/api/settings', { ...(await inj('GET', '/api/settings')).json, modelId: m.json.id });
  const upload = (name: string, mime: string, data: Buffer) =>
    inj('POST', '/api/attachments', data, { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name), 'x-mime': mime });
  return { ...built, inj, upload, tick: (ms: number) => (clock += ms) };
}

test('上传：相同内容只存一份；可以按原文件取回', async () => {
  const { app, upload, inj } = await setup('claude');
  const a = await upload('猫.png', 'image/png', PNG);
  assert.equal(a.status, 201);
  assert.deepEqual([a.json.name, a.json.mime, a.json.size], ['猫.png', 'image/png', PNG.length]);
  const b = await upload('另一个名字.png', 'image/png', PNG);
  assert.equal(b.json.id, a.json.id);
  const got = await inj('GET', `/api/attachments/${a.json.id}`);
  assert.deepEqual(Buffer.from(got.raw), PNG);
  assert.equal((await inj('GET', '/api/attachments/nope')).status, 404);
  assert.equal((await upload('空', 'text/plain', Buffer.alloc(0))).status, 400);
  await app.close();
});

for (const [protocol, check] of [
  ['claude', (body: any) => {
    const content = body.messages.at(-1).content;
    assert.deepEqual(content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });
    assert.deepEqual(content[1], { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '笔记内容' }, title: 'note.txt' });
    assert.equal(content[2].text, '看看这个');
  }],
  ['openai-chat', (body: any) => {
    const content = body.messages.at(-1).content;
    assert.equal(content[0].image_url.url, `data:image/png;base64,${PNG.toString('base64')}`);
    assert.equal(content[1].type, 'file');
    assert.deepEqual(content.at(-1), { type: 'text', text: '看看这个' });
  }],
  ['gemini', (body: any) => {
    const parts = body.contents.at(-1).parts;
    assert.deepEqual(parts[0], { inline_data: { mime_type: 'image/png', data: PNG.toString('base64') } });
    assert.equal(parts.at(-1).text, '看看这个');
  }],
] as const) {
  test(`随消息发送（${protocol}）：预览里是占位符，发送时换成文件内容`, async () => {
    const { app, upload, inj, manager } = await setup(protocol);
    const img = (await upload('猫.png', 'image/png', PNG)).json;
    const txt = (await upload('note.txt', 'text/plain', Buffer.from('笔记内容'))).json;
    const sid = ((await inj('POST', '/api/sessions', { characterId: 'char1' })).json as SessionView).meta.id;
    const r = await inj('POST', `/api/sessions/${sid}/ops`, { opId: 'a', op: 'append', role: 'user', content: '看看这个', attachments: [img.id, txt.id] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.layer.attachments.map((a: { name: string }) => a.name), ['猫.png', 'note.txt']);

    const preview = (await inj('POST', '/api/preview', { sessionId: sid })).json as PreviewView;
    assert.ok(JSON.stringify(preview.body).includes(`sky-attachment`));
    assert.ok(!JSON.stringify(preview.body).includes(PNG.toString('base64')));

    await inj('POST', `/api/sessions/${sid}/ops`, { opId: 'b', op: 'continue' });
    await manager.drain();
    check(upstream.last.body);
    await app.close();
  });
}

test('Claude 不支持的附件类型直接报错', async () => {
  const { app, upload, inj } = await setup('claude');
  const zip = (await upload('a.zip', 'application/zip', Buffer.from('PK'))).json;
  const sid = ((await inj('POST', '/api/sessions', { characterId: 'char1' })).json as SessionView).meta.id;
  await inj('POST', `/api/sessions/${sid}/ops`, { opId: 'a', op: 'append', role: 'user', content: 'x', attachments: [zip.id] });
  const p = await inj('POST', '/api/preview', { sessionId: sid });
  assert.equal(p.status, 422);
  assert.match(p.json.message, /Claude 不支持这种附件/);
  assert.equal((await inj('POST', `/api/sessions/${sid}/ops`, { opId: 'b', op: 'append', role: 'user', content: 'x', attachments: ['nope'] })).status, 400);
  await app.close();
});

test('引用关系：被引用的不能删；会话删掉后开始计时，到期清理；重新引用计时清零', async () => {
  const { app, upload, inj, attachments, tick } = await setup('openai-chat');
  const a = (await upload('a.txt', 'text/plain', Buffer.from('aaa'))).json;
  const sid = ((await inj('POST', '/api/sessions', { characterId: 'char1' })).json as SessionView).meta.id;
  await inj('POST', `/api/sessions/${sid}/ops`, { opId: 'a', op: 'append', role: 'user', content: 'x', attachments: [a.id] });
  const info = () => (attachments.list('root').find((x) => x.id === a.id));
  assert.equal(info()!.refs, 1);
  assert.equal(info()!.orphanedAt, null);
  assert.equal((await inj('DELETE', `/api/attachments/${a.id}`)).status, 409);

  // 分支会复制引用
  const msg = (await inj('GET', `/api/sessions/${sid}`)).json.layers[0].id;
  const branch = (await inj('POST', `/api/sessions/${sid}/branch`, { messageId: msg })).json as SessionView;
  assert.equal(info()!.refs, 2);
  await inj('DELETE', `/api/sessions/${branch.meta.id}`);
  await inj('DELETE', `/api/sessions/${sid}`);
  assert.equal(info()!.refs, 0);
  assert.ok(info()!.orphanedAt !== null);

  const day = 24 * 3600_000;
  tick(6 * day);
  assert.equal(attachments.sweep(7 * day), 0);
  // 重新被引用：计时清零
  const sid2 = ((await inj('POST', '/api/sessions', { characterId: 'char1' })).json as SessionView).meta.id;
  await inj('POST', `/api/sessions/${sid2}/ops`, { opId: 'c', op: 'append', role: 'user', content: 'y', attachments: [a.id] });
  assert.equal(info()!.orphanedAt, null);
  await inj('DELETE', `/api/sessions/${sid2}`);
  tick(6 * day);
  assert.equal(attachments.sweep(7 * day), 0);
  tick(2 * day);
  assert.equal(attachments.sweep(7 * day), 1);
  assert.equal(info(), undefined);
  await app.close();
});
