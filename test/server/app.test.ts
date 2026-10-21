import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/server/app.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../../src/server/config.ts';
import { openDatabase } from '../../src/server/db.ts';
import type { SessionView } from '../../src/server/sessions/routes.ts';
import { SessionStore, sessionIdFrom } from '../../src/server/sessions/store.ts';

function setup(auth: AppConfig['auth'] = DEFAULT_CONFIG.auth) {
  let clock = 1000;
  const db = openDatabase(':memory:');
  const built = buildApp({ config: { ...DEFAULT_CONFIG, auth }, db, now: () => clock++ });
  return { ...built, db };
}

const basic = (name: string, pw: string) => ({ authorization: `Basic ${Buffer.from(`${name}:${pw}`).toString('base64')}` });

test('未开启认证时以 root 访问', async () => {
  const { app } = setup();
  const r = await app.inject({ url: '/api/me' });
  assert.deepEqual(r.json(), { user: 'root' });
});

test('开启认证后任何路径未认证都只返回 401', async () => {
  const { app } = setup({ enabled: true, users: [{ name: 'alice', password: 'pw' }] });
  for (const url of ['/api/me', '/', '/assets/x.js', '/nope']) {
    const r = await app.inject({ url });
    assert.equal(r.statusCode, 401, url);
    assert.match(String(r.headers['www-authenticate']), /^Basic /);
  }
  assert.equal((await app.inject({ url: '/api/me', headers: basic('alice', 'bad') })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/me', headers: basic('bob', 'pw') })).statusCode, 401);
  const ok = await app.inject({ url: '/api/me', headers: basic('alice', 'pw') });
  assert.deepEqual(ok.json(), { user: 'alice' });
});

test('会话：新建、追加、打开最近活跃、按条数加载', async () => {
  const { app } = setup();
  const created = (await app.inject({ method: 'POST', url: '/api/sessions', payload: { characterId: 'char1' } })).json() as SessionView;
  assert.match(created.meta.id, /^[0-9A-Za-z]{16}$/);
  const id = created.meta.id;

  for (const [i, role] of (['user', 'assistant', 'user'] as const).entries()) {
    const r = await app.inject({ method: 'POST', url: `/api/sessions/${id}/ops`, payload: { opId: `o${i}`, op: 'append', role, content: `m${i}` } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().layer.layer, i);
  }

  const latest = (await app.inject({ url: '/api/sessions/latest?characterId=char1&limit=2' })).json() as SessionView;
  assert.equal(latest.meta.id, id);
  assert.equal(latest.total, 3);
  assert.equal(latest.from, 1);
  assert.deepEqual(latest.layers.map((l) => l.content), ['m1', 'm2']);

  assert.equal((await app.inject({ url: '/api/sessions/latest?characterId=none' })).statusCode, 404);
  // 角色不存在时不能建会话
  assert.equal((await app.inject({ method: 'POST', url: '/api/sessions', payload: { characterId: 'nope' } })).statusCode, 404);
});

test('重试同一个 opId 不会重复追加', async () => {
  const { app } = setup();
  const id = ((await app.inject({ method: 'POST', url: '/api/sessions', payload: { characterId: 'char1' } })).json() as SessionView).meta.id;
  const payload = { opId: 'dup', op: 'append', role: 'user', content: 'x' };
  await app.inject({ method: 'POST', url: `/api/sessions/${id}/ops`, payload });
  const again = await app.inject({ method: 'POST', url: `/api/sessions/${id}/ops`, payload });
  assert.equal(again.json().applied, false);
  assert.equal(((await app.inject({ url: `/api/sessions/${id}` })).json() as SessionView).total, 1);
});

test('非法操作返回 400，找不到返回 404', async () => {
  const { app } = setup();
  const id = ((await app.inject({ method: 'POST', url: '/api/sessions', payload: { characterId: 'char1' } })).json() as SessionView).meta.id;
  const bad = await app.inject({ method: 'POST', url: `/api/sessions/${id}/ops`, payload: { opId: 'a', op: 'append', role: 'system', content: 'x' } });
  assert.equal(bad.statusCode, 400);
  const missing = await app.inject({ method: 'POST', url: `/api/sessions/${id}/ops`, payload: { opId: 'b', op: 'edit', messageId: 'nope', content: '' } });
  assert.equal(missing.statusCode, 404);
  assert.equal((await app.inject({ url: '/api/sessions/AAAAAAAAAAAAAAAA' })).statusCode, 404);
});

test('账号之间数据隔离', async () => {
  const { app } = setup({ enabled: true, users: [{ name: 'a', password: '1' }, { name: 'b', password: '2' }] });
  const id = ((await app.inject({ method: 'POST', url: '/api/sessions', headers: basic('a', '1'), payload: { characterId: 'char1' } })).json() as SessionView).meta.id;
  assert.equal((await app.inject({ url: `/api/sessions/${id}`, headers: basic('b', '2') })).statusCode, 404);
  assert.deepEqual((await app.inject({ url: '/api/sessions', headers: basic('b', '2') })).json(), []);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/sessions/${id}`, headers: basic('b', '2') })).statusCode, 404);
});

test('会话以 JSONB 落库，移出内存后能原样读回', async () => {
  const { app, sessions, db } = setup();
  const id = ((await app.inject({ method: 'POST', url: '/api/sessions', payload: { characterId: 'char1' } })).json() as SessionView).meta.id;
  await app.inject({ method: 'POST', url: `/api/sessions/${id}/ops`, payload: { opId: 'a', op: 'append', role: 'user', content: '你好' } });
  const row = db.prepare('SELECT typeof(doc) AS t, json_extract(doc, \'$.layers[0].candidates[0].content\') AS c FROM sessions').get() as { t: string; c: string };
  assert.deepEqual({ ...row }, { t: 'blob', c: '你好' });

  assert.equal(sessions.residentCount, 1);
  const fresh = buildApp({ config: DEFAULT_CONFIG, db });
  const view = (await fresh.app.inject({ url: `/api/sessions/${id}` })).json() as SessionView;
  assert.deepEqual(view.layers.map((l) => l.content), ['你好']);
});

test('会话 ID 冲突时加扰动值重新生成', () => {
  const db = openDatabase(':memory:');
  const store = new SessionStore(db, { now: () => 42 });
  const taken = sessionIdFrom(42, 'c', 0, 0);
  // 另一个用户已经占用了这个 ID
  db.prepare("INSERT INTO sessions (id, user, character_id, created_at, last_active_at, doc) VALUES (?, 'other', 'x', 0, 0, jsonb('{}'))").run(taken);
  const s = store.create('root', 'c');
  assert.equal(s.meta.id, sessionIdFrom(42, 'c', 0, 1));
});

test('长时间未使用的会话移出内存', () => {
  let t = 0;
  const store = new SessionStore(openDatabase(':memory:'), { now: () => t, idleMs: 100 });
  const { meta } = store.create('root', 'c');
  t = 50;
  store.sweep();
  assert.equal(store.residentCount, 1);
  t = 200;
  store.sweep();
  assert.equal(store.residentCount, 0);
  assert.equal(store.get('root', meta.id).meta.id, meta.id); // 仍可从库中读回
});

test('托管前端：/、/admin、/docs 返回页面，静态资源可取；同样需要认证', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>SkyTavern</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');

  const open = buildApp({ config: DEFAULT_CONFIG, db: openDatabase(':memory:'), webDir: dir }).app;
  for (const url of ['/', '/admin', '/docs', '/docs/variables']) assert.match((await open.inject({ url })).body, /SkyTavern/);
  assert.equal((await open.inject({ url: '/assets/app.js' })).statusCode, 200);

  const locked = buildApp({ config: { ...DEFAULT_CONFIG, auth: { enabled: true, users: [{ name: 'a', password: '1' }] } }, db: openDatabase(':memory:'), webDir: dir }).app;
  assert.equal((await locked.inject({ url: '/' })).statusCode, 401);
  assert.equal((await locked.inject({ url: '/assets/app.js' })).statusCode, 401);
  assert.equal((await locked.inject({ url: '/', headers: basic('a', '1') })).statusCode, 200);
});

test('文档：目录页在最前，文档间链接和锚点都能找到', async () => {
  const { join } = await import('node:path');
  const { headingsOf, slugger } = await import('../../src/core/docs.ts');
  const db = openDatabase(':memory:');
  const docsDir = join(import.meta.dirname, '../../docs');
  const { app } = buildApp({ config: DEFAULT_CONFIG, db, docsDir });

  const list = (await app.inject({ url: '/api/docs' })).json() as { docs: { name: string; title: string }[] };
  assert.equal(list.docs[0]?.name, 'README');
  assert.deepEqual(
    list.docs.map((d) => d.name),
    ['README', 'getting-started', 'request-structure', 'request-params', 'import', 'variables'],
  );

  assert.equal((await app.inject({ url: '/api/docs/nope' })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/docs/..%2Fpackage' })).statusCode, 404);

  const md = new Map<string, string>();
  for (const d of list.docs) md.set(d.name, ((await app.inject({ url: `/api/docs/${d.name}` })).json() as { markdown: string }).markdown);
  const anchors = new Map([...md].map(([n, text]) => [n, new Set(headingsOf(text).map(slugger()))]));
  for (const [name, text] of md) {
    for (const [, href] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^https?:/.test(href!)) continue;
      const m = /^(?:([A-Za-z0-9-]+)\.md)?(?:#(.+))?$/.exec(href!);
      assert.ok(m, `${name}: 无法识别的链接 ${href}`);
      const target = m[1] ?? name;
      assert.ok(md.has(target), `${name}: 链接到不存在的文档 ${href}`);
      if (m[2]) assert.ok(anchors.get(target)!.has(m[2]), `${name}: 锚点不存在 ${href}`);
    }
  }
  await app.close();
});

test('会话树：从某条消息分支、改名、列表摘要；删除时分支改挂到上一级', async () => {
  const { app } = setup();
  const inj = async (method: string, url: string, payload?: object) => {
    const r = await app.inject({ method: method as 'GET', url, ...(payload ? { payload } : {}) });
    return { status: r.statusCode, json: r.body ? (r.json() as any) : undefined };
  };
  const root = (await inj('POST', '/api/sessions', { characterId: 'char1' })).json as SessionView;
  const op = (sid: string, body: object) => inj('POST', `/api/sessions/${sid}/ops`, { opId: `o${Math.random()}`, ...body });
  for (const [role, content] of [['user', '第一句'], ['assistant', '回答一'], ['user', '第二句'], ['assistant', '回答二']]) {
    await op(root.meta.id, { op: 'append', role, content });
  }
  const layers = (await inj('GET', `/api/sessions/${root.meta.id}`)).json.layers as { id: string }[];

  const branch = await inj('POST', `/api/sessions/${root.meta.id}/branch`, { messageId: layers[1]!.id });
  assert.equal(branch.status, 201);
  const b = branch.json as SessionView;
  assert.equal(b.meta.parentId, root.meta.id);
  assert.equal(b.meta.branchFrom, layers[1]!.id);
  assert.deepEqual(b.layers.map((l) => l.content), ['第一句', '回答一']);
  assert.equal(b.meta.layerCount, 2);
  assert.equal(b.meta.lastText, '回答一');

  // 分支里继续，原会话不受影响
  await op(b.meta.id, { op: 'append', role: 'user', content: '另一条路\n换行' });
  const grand = (await inj('POST', `/api/sessions/${b.meta.id}/branch`, { messageId: layers[0]!.id })).json as SessionView;
  assert.equal((await inj('GET', `/api/sessions/${root.meta.id}`)).json.layers.length, 4);

  const renamed = (await inj('PATCH', `/api/sessions/${b.meta.id}`, { title: '  坏结局  线 ' })).json;
  assert.equal(renamed.title, '坏结局 线');

  const list = (await inj('GET', '/api/sessions?characterId=char1')).json as { id: string; parentId: string | null; lastText: string; layerCount: number }[];
  const byId = new Map(list.map((m) => [m.id, m]));
  assert.equal(byId.get(b.meta.id)!.lastText, '另一条路 换行');
  assert.equal(byId.get(b.meta.id)!.layerCount, 3);
  assert.equal(byId.get(grand.meta.id)!.parentId, b.meta.id);

  assert.equal((await inj('POST', `/api/sessions/${root.meta.id}/branch`, { messageId: 'nope' })).status, 404);

  // 删掉中间一层，孙会话改挂到根会话下
  assert.equal((await inj('DELETE', `/api/sessions/${b.meta.id}`)).status, 204);
  const after = (await inj('GET', '/api/sessions?characterId=char1')).json as { id: string; parentId: string | null }[];
  assert.equal(after.find((m) => m.id === grand.meta.id)!.parentId, root.meta.id);
  assert.equal((await inj('GET', `/api/sessions/${grand.meta.id}`)).json.meta.parentId, root.meta.id);
});
