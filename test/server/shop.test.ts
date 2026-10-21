// 内置示例「万界商铺」：数据合法，开场白、账本、老板指令、货架组件和商店记录串起来能用。

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { checkDoc, defaultLibrary } from '../../src/core/library.ts';
import { latestChecker, runScripts } from '../../src/core/scripts.ts';
import type { SessionView, VarsReport } from '../../src/core/views.ts';
import { buildApp, type App } from '../../src/server/app.ts';
import { DEFAULT_CONFIG } from '../../src/server/config.ts';
import { openDatabase } from '../../src/server/db.ts';
import { MockUpstream } from './mock-upstream.ts';

const upstream = new MockUpstream();
before(() => upstream.start());
after(() => upstream.stop());

let ctx: App;
const api = async (method: string, url: string, payload?: unknown) => {
  const r = await ctx.app.inject({ method: method as 'GET', url, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: r.statusCode, json: r.body ? (r.json() as any) : undefined };
};
const op = (sid: string, body: object) => api('POST', `/api/sessions/${sid}/ops`, { opId: `o${Math.random()}`, ...body });
const vars = async (sid: string) => ((await api('GET', `/api/sessions/${sid}/vars`)).json as VarsReport).final;

beforeEach(async () => {
  ctx = buildApp({ config: DEFAULT_CONFIG, db: openDatabase(':memory:'), assembleTimeoutMs: 2000 });
  const m = await api('POST', '/api/library/model', { name: 'm', protocol: 'claude', baseUrl: upstream.baseUrl, apiKey: 'k', model: 'x' });
  const s = (await api('GET', '/api/settings')).json;
  await api('PUT', '/api/settings', { ...s, modelId: m.json.id });
});

test('示例数据能通过完整校验', () => {
  const d = defaultLibrary();
  for (const c of d.characters) assert.deepEqual(checkDoc('character', c), c);
  for (const w of d.worldbooks) assert.deepEqual(checkDoc('worldbook', w), w);
});

test('新账号带示例卡和账本；新会话以开场白开始，货架只挂在最新一条 AI 回复下面', async () => {
  const chars = (await api('GET', '/api/library/character')).json as { id: string; name: string }[];
  assert.ok(chars.some((c) => c.id === 'char2' && c.name === '万界商铺'));
  // 之后新建的角色不会撞上内置 ID
  assert.equal((await api('POST', '/api/library/character', { name: '新角色', entries: [] })).json.id, 'char3');

  const created = (await api('POST', '/api/sessions', { characterId: 'char2' })).json as SessionView;
  assert.equal(created.layers.length, 1);
  assert.equal(created.layers[0]!.role, 'assistant');
  assert.match(created.layers[0]!.content, /欢迎光临万界商铺/);
  assert.doesNotMatch(created.layers[0]!.content, /\{\{user\}\}/);

  const character = (await api('GET', '/api/library/character/char2')).json;
  const display = (text: string, i: number, roles: ('user' | 'assistant')[]) =>
    runScripts(text, 'assistant', character.scripts, { stage: 'runtime', target: 'display', isLatest: latestChecker(roles)(i) });
  assert.match(display('你好', 0, ['assistant']), /```html\n<style>/);
  assert.equal(display('你好', 0, ['assistant', 'user', 'assistant']), '你好');
});

test('老板的简短指令和编辑块都能改账目；账本在正文后展示当前数据', async () => {
  const sid = ((await api('POST', '/api/sessions', { characterId: 'char2' })).json as SessionView).meta.id;
  upstream.script = {
    pieces: [
      '“这可是好东西。”\n\n【上架|雷鸣贝|45|金币|3|贴在耳边能听见远方的雷声】\n【下架|火绒符】\n',
      '【调价|灵泉水|25】\n【货币|灵石|2】\n【给予|金币|10】\n<var>\n背包.护身符 = 1\n</var>',
    ],
  };
  await op(sid, { op: 'append', role: 'user', content: '有新货吗？', generate: true });
  await ctx.manager.drain();
  const session = (await api('GET', `/api/sessions/${sid}`)).json as SessionView;
  const reply = session.layers.at(-1)!;
  assert.equal(reply.content, '“这可是好东西。”');
  assert.equal(reply.varErrors.length, 0);
  const v = await vars(sid);
  assert.deepEqual(v.货币, { 金币: 210, 灵石: 2 });
  assert.deepEqual(Object.keys(v.商品 as object).sort(), ['星图残页', '止血草', '灵泉水', '雷鸣贝'].sort());
  assert.equal((v.商品 as any).灵泉水.价格, 25);
  assert.deepEqual((v.商品 as any).雷鸣贝, { 价格: 45, 货币: '金币', 库存: 3, 描述: '贴在耳边能听见远方的雷声' });
  assert.equal((v.背包 as any).护身符, 1);

  // 顾客在货架上结账：变量操作 + 商店记录
  await op(sid, {
    op: 'addVarOps',
    messageId: reply.id,
    ops: [
      { name: '商品.雷鸣贝.库存', op: '-=', value: 1 },
      { name: '背包.雷鸣贝', op: '=', value: 1 },
      { name: '背包', op: '-=', value: '旧铜镜' },
      { name: '货币.金币', op: '-=', value: 5 },
    ],
    note: '【商店记录】购买：雷鸣贝 ×1（45 金币）\n出售：旧铜镜 ×1（+40 金币）',
  });
  await op(sid, { op: 'append', role: 'user', content: '这贝壳真能听到雷声？' });
  const preview = (await api('POST', '/api/preview', { sessionId: sid })).json;
  const msgs = preview.messages as { role: string; content: string; section: string }[];
  const chat = msgs.filter((m) => m.section === 'chat').slice(-3);
  assert.deepEqual(chat.map((m) => m.role), ['assistant', 'user', 'user']);
  assert.match(chat[1]!.content, /^【商店记录】/);
  const ledger = msgs.at(-1)!;
  assert.equal(ledger.section, 'after');
  assert.equal(ledger.role, 'user');
  assert.match(ledger.content, /顾客钱包：\{"金币":205,"灵石":2\}/);
  assert.match(ledger.content, /"雷鸣贝":1/);
  assert.doesNotMatch(ledger.content, /旧铜镜":1/);
});
