// 导入接口：PNG / JSON 角色卡、世界书；头像；多个开场白成为第一层候选。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { SessionView } from '../../src/core/views.ts';
import { buildApp } from '../../src/server/app.ts';
import { DEFAULT_CONFIG } from '../../src/server/config.ts';
import { openDatabase } from '../../src/server/db.ts';
import { fakePng } from '../fixtures/png.ts';

const card = readFileSync(new URL('../fixtures/st-card-v2.json', import.meta.url), 'utf8');
const world = readFileSync(new URL('../fixtures/st-world.json', import.meta.url), 'utf8');

function setup() {
  const { app } = buildApp({ config: DEFAULT_CONFIG, db: openDatabase(':memory:') });
  const inj = async (method: string, url: string, payload?: object | Buffer, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method: method as 'GET', url, ...(payload ? { payload } : {}), headers });
    return { status: r.statusCode, json: r.headers['content-type']?.includes('json') && r.body ? (r.json() as any) : undefined, raw: r.rawPayload, headers: r.headers };
  };
  return { app, inj };
}

test('导入 PNG 角色卡：角色卡 + 内嵌世界书（已关联）+ 头像；新会话第一层有多个开场白候选', async () => {
  const { app, inj } = setup();
  const png = fakePng({ chara: Buffer.from(card).toString('base64') });
  const r = await inj('POST', '/api/import', { filename: 'eileen.png', data: Buffer.from(png).toString('base64') });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const [ch, wb] = r.json.items;
  assert.deepEqual([ch.kind, ch.name, wb.kind, wb.name], ['character', 'Eileen', 'worldbook', 'Rain Lamp Book']);
  assert.ok(ch.report.notes.some((n: string) => n.includes('头像')));

  const doc = (await inj('GET', `/api/library/character/${ch.id}`)).json;
  assert.deepEqual(doc.worldbookIds, [wb.id]);
  assert.ok(doc.avatar);
  const avatar = await inj('GET', `/api/library/character/${ch.id}/avatar?v=${doc.avatar}`);
  assert.equal(avatar.status, 200);
  assert.equal(avatar.headers['content-type'], 'image/png');
  assert.equal(avatar.raw.includes(Buffer.from('chara')), false); // 卡片数据已去掉
  const list = (await inj('GET', '/api/library/character')).json as { id: string; avatar: string | null }[];
  assert.equal(list.find((c) => c.id === ch.id)!.avatar, doc.avatar);

  const s = (await inj('POST', '/api/sessions', { characterId: ch.id })).json as SessionView;
  assert.equal(s.layers.length, 1);
  assert.equal(s.layers[0]!.candidateIds.length, 3);
  assert.equal(s.layers[0]!.selectedIndex, 0);
  assert.equal(s.layers[0]!.content, '*She looks up.* Welcome back, 用户.');

  // 删除角色卡时头像一起删
  await inj('DELETE', `/api/sessions/${s.meta.id}`);
  assert.equal((await inj('DELETE', `/api/library/character/${ch.id}`)).status, 204);
  assert.equal((await inj('GET', `/api/library/character/${ch.id}/avatar`)).status, 404);
  await app.close();
});

test('导入 JSON 角色卡和世界书；坏文件给出原因', async () => {
  const { app, inj } = setup();
  const r1 = await inj('POST', '/api/import', { filename: 'eileen.json', data: Buffer.from(card).toString('base64') });
  assert.equal(r1.status, 201);
  assert.equal(r1.json.items.length, 2);
  const r2 = await inj('POST', '/api/import', { filename: '雾港.json', data: Buffer.from(world).toString('base64') });
  assert.equal(r2.status, 201);
  assert.deepEqual(r2.json.items.map((i: { kind: string; name: string }) => [i.kind, i.name]), [['worldbook', '雾港']]);
  const bad = await inj('POST', '/api/import', { filename: 'x.json', data: Buffer.from('{"hello":1}').toString('base64') });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /认不出/);
  const notJson = await inj('POST', '/api/import', { filename: 'x.json', data: Buffer.from('nope').toString('base64') });
  assert.equal(notJson.status, 400);
  await app.close();
});

test('头像接口：上传、替换、类型检查、移除', async () => {
  const { app, inj } = setup();
  const up = await inj('PUT', '/api/library/character/char1/avatar', Buffer.from([1, 2, 3]), { 'content-type': 'image/jpeg' });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const v = up.json.avatar as string;
  assert.equal((await inj('GET', `/api/library/character/char1`)).json.avatar, v);
  assert.equal((await inj('PUT', '/api/library/character/char1/avatar', Buffer.from('x'), { 'content-type': 'text/plain' })).status, 415);
  // JSON 模式整份替换不会改掉头像
  const doc = (await inj('GET', '/api/library/character/char1')).json;
  await inj('PUT', '/api/library/character/char1', { ...doc, avatar: null });
  assert.equal((await inj('GET', '/api/library/character/char1')).json.avatar, v);
  assert.equal((await inj('DELETE', '/api/library/character/char1/avatar')).status, 204);
  assert.equal((await inj('GET', '/api/library/character/char1')).json.avatar, null);
  await app.close();
});

test('开场白里的宏：改变量成为第一层的变量操作，随机在新会话时抽一次', async () => {
  const { app, inj } = setup();
  const json = {
    spec: 'chara_card_v2',
    data: { name: '赌徒', description: '你有 {{getvar::金币}} 枚金币。', first_mes: '{{setvar::金币::100}}{{incvar::回合}}*骰子落下：{{roll:1d6}}。*{{random::你好::欢迎}}，{{user}}。' },
  };
  const r = await inj('POST', '/api/import', { filename: 'gambler.json', data: Buffer.from(JSON.stringify(json)).toString('base64') });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const ch = r.json.items[0];
  assert.ok(ch.report.notes.some((n: string) => n.includes('编辑块')));
  const doc = (await inj('GET', `/api/library/character/${ch.id}`)).json;
  assert.equal(doc.entries.find((e: { name: string }) => e.name === '角色设定').content, '你有 {{get("金币")}} 枚金币。');
  assert.ok(doc.entries.every((e: { enabled: boolean }) => e.enabled));

  const s = (await inj('POST', '/api/sessions', { characterId: ch.id })).json as SessionView;
  const first = s.layers[0]!;
  assert.match(first.content, /^\*骰子落下：[1-6]。\*(你好|欢迎)，用户。$/);
  assert.deepEqual(first.varOps.map((o: any) => o.op), ['=', 'if']);
  const vars = (await inj('GET', `/api/sessions/${s.meta.id}/vars`)).json;
  assert.deepEqual([vars.layers[0].state['金币'], vars.layers[0].state['回合']], [100, 1]);
  assert.deepEqual(vars.layers[0].warnings, []);
  // 词条里的 {{get("金币")}} 能读到
  const p = (await inj('POST', '/api/preview', { sessionId: s.meta.id })).json;
  assert.ok(JSON.stringify(p.messages).includes('你有 100 枚金币。'));
  await app.close();
});
