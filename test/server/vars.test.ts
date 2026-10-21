import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { ScriptDraft } from '../../src/core/library.ts';
import type { SessionView, VarsReport } from '../../src/core/views.ts';
import { buildApp, type App } from '../../src/server/app.ts';
import { DEFAULT_CONFIG } from '../../src/server/config.ts';
import { openDatabase } from '../../src/server/db.ts';
import { MockUpstream } from './mock-upstream.ts';

const upstream = new MockUpstream();
before(() => upstream.start());
after(() => upstream.stop());

let ctx: App;
beforeEach(async () => {
  upstream.script = { pieces: ['好的。'] };
  ctx = buildApp({ config: DEFAULT_CONFIG, db: openDatabase(':memory:'), assembleTimeoutMs: 1000 });
  const m = await api('POST', '/api/library/model', { name: 'm', protocol: 'openai-chat', baseUrl: `${upstream.baseUrl}/v1`, apiKey: 'k', model: 'x' });
  const s = (await api('GET', '/api/settings')).json;
  await api('PUT', '/api/settings', { ...s, modelId: m.json.id });
});

const api = async (method: string, url: string, payload?: unknown) => {
  const r = await ctx.app.inject({ method: method as 'GET', url, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: r.statusCode, json: r.body ? (r.json() as any) : undefined };
};

const script = (over: Partial<ScriptDraft>): ScriptDraft => ({
  name: '',
  enabled: true,
  stage: 'receive',
  target: 'both',
  roles: ['assistant'],
  action: 'replace',
  latestOnly: false,
  pattern: '',
  flags: 'g',
  replacement: '',
  priority: 0,
  ...over,
});

async function newSession(): Promise<string> {
  return (await api('POST', '/api/sessions', { characterId: 'char1' })).json.meta.id;
}
const layers = async (sid: string) => ((await api('GET', `/api/sessions/${sid}`)).json as SessionView).layers;
const vars = async (sid: string) => (await api('GET', `/api/sessions/${sid}/vars`)).json as VarsReport;
const op = (sid: string, body: object) => api('POST', `/api/sessions/${sid}/ops`, { opId: `o${Math.random()}`, ...body });
/** 修改预设，并确认修改成功。 */
async function patchPreset(ops: object[]): Promise<void> {
  const r = await api('PATCH', '/api/library/preset/preset1', { ops });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}

test('回复里的编辑块：合法操作挂到这一层，编辑块从正文删掉；不合法的行记下来', async () => {
  await patchPreset([{ op: 'set', field: 'initialVars', value: 'hp = 100' }]);
  upstream.script = { pieces: ['她递给你一杯酒。\n<var>\nhp -= 5\n', 'gold = 20\n乱写\n</var>'] };
  const sid = await newSession();
  await op(sid, { op: 'append', role: 'user', content: '来杯酒', generate: true });
  await ctx.manager.drain();
  const reply = (await layers(sid))[1]!;
  assert.equal(reply.content, '她递给你一杯酒。');
  assert.deepEqual(reply.varOps.map((o: any) => [o.name, o.op, o.value, o.source]), [
    ['hp', '-=', 5, 'block'],
    ['gold', '=', 20, 'block'],
  ]);
  assert.equal(reply.varErrors[0]!.text, '乱写');
  assert.deepEqual((await vars(sid)).final, { hp: 95, gold: 20 });
});

test('返回时正则先执行，再取编辑块；作用于哪种消息由脚本决定；未完成的回复同样处理', async () => {
  await patchPreset([
    { op: 'set', field: 'initialVars', value: 'hp = 100\ngold = 0' },
    { op: 'addScript', script: script({ name: '伤害', pattern: '【伤害(\\d+)】', replacement: '<var>hp -= $1</var>' }) },
    { op: 'addScript', script: script({ name: '加钱', pattern: '^/加钱(\\d+)\\s*', flags: '', replacement: '<var>gold += $1</var>', roles: ['user'] }) },
  ]);
  const sid = await newSession();
  upstream.script = { pieces: ['你被砍了【伤害12】又被砍了【伤害3】'], dropAfter: 1 }; // 中途断开
  await op(sid, { op: 'append', role: 'user', content: '/加钱50 买把剑', generate: true });
  await ctx.manager.drain();
  const [u, a] = await layers(sid);
  assert.equal(u!.content, '买把剑');
  assert.deepEqual(u!.varOps.map((o: any) => [o.name, o.value]), [['gold', 50]]);
  assert.equal(a!.partial, true);
  assert.equal(a!.content, '你被砍了又被砍了');
  assert.deepEqual((await vars(sid)).final, { hp: 85, gold: 50 });
});

test('IF 与占位符读取变量；重新生成某层时读的是它之前的状态', async () => {
  await patchPreset([
    { op: 'set', field: 'initialVars', value: 'hp = 100' },
    { op: 'addEntry', entry: { enabled: true, role: 'user', content: '【状态】HP {{hp}}', priority: 0, placement: { kind: 'position', section: 'after' } } },
    { op: 'addEntry', entry: { enabled: true, role: 'user', content: '（你快撑不住了）', priority: -1, if: 'hp < 50', placement: { kind: 'position', section: 'after' } } },
  ]);
  const sid = await newSession();
  upstream.script = { pieces: ['重击！<var>hp -= 60</var>'] };
  await op(sid, { op: 'append', role: 'user', content: '战斗', generate: true });
  await ctx.manager.drain();

  const after = (await api('POST', '/api/preview', { sessionId: sid })).json;
  const tail = after.messages.slice(-2).map((m: { content: string }) => m.content);
  assert.deepEqual(tail, ['【状态】HP 40', '（你快撑不住了）']);

  // 重新生成第 1 层：用的是它之前（hp=100）的状态
  const reply = (await layers(sid))[1]!;
  const reroll = (await api('POST', '/api/preview', { sessionId: sid, mode: 'reroll', messageId: reply.id })).json;
  assert.equal(reroll.messages.at(-1).content, '【状态】HP 100');
});

test('切换候选后变量随之重算', async () => {
  await patchPreset([{ op: 'set', field: 'initialVars', value: 'hp = 100' }]);
  const sid = await newSession();
  upstream.script = { pieces: ['<var>hp -= 10</var>A'] };
  await op(sid, { op: 'append', role: 'user', content: 'x', generate: true });
  await ctx.manager.drain();
  const first = (await layers(sid))[1]!;
  upstream.script = { pieces: ['<var>hp -= 30</var>B'] };
  await op(sid, { op: 'reroll', messageId: first.id });
  await ctx.manager.drain();
  assert.equal((await vars(sid)).final.hp, 70);
  await op(sid, { op: 'select', messageId: first.id });
  assert.equal((await vars(sid)).final.hp, 90);
});

test('手动编辑整层操作、组件追加操作；不合法的拒绝', async () => {
  const sid = await newSession();
  await op(sid, { op: 'append', role: 'user', content: 'x' });
  const m = (await layers(sid))[0]!;
  const set = await op(sid, { op: 'setVarOps', messageId: m.id, ops: [{ name: 'hp', op: '=', value: 10 }] });
  assert.deepEqual(set.json.layer.varOps, [{ name: 'hp', op: '=', value: 10, source: 'manual' }]);
  const add = await op(sid, { op: 'addVarOps', messageId: m.id, ops: [{ name: 'hp', op: '+=', value: 5 }] });
  assert.deepEqual(add.json.layer.varOps.map((o: { source: string }) => o.source), ['manual', 'widget']);
  assert.equal((await vars(sid)).final.hp, 15);
  assert.equal((await op(sid, { op: 'addVarOps', messageId: m.id, ops: [{ name: 'char', op: '=', value: 'x' }] })).status, 400);
  assert.equal((await op(sid, { op: 'addVarOps', messageId: m.id, ops: [{ name: 'hp', op: '=', value: null }] })).status, 400);
});

test('重放警告：不存在的变量 +=、类型不符的赋值，在会话视图和变量表里都能看到', async () => {
  const sid = await newSession();
  await op(sid, { op: 'append', role: 'user', content: 'x' });
  const m = (await layers(sid))[0]!;
  await op(sid, { op: 'setVarOps', messageId: m.id, ops: [{ name: 'gold', op: '+=', value: 1 }, { name: 'name', op: '=', value: 'a' }, { name: 'name', op: '=', value: 2 }] });
  const view = (await layers(sid))[0]!;
  assert.deepEqual(view.varWarnings.map((w) => w.index), [0, 2]);
  const report = await vars(sid);
  assert.deepEqual(report.layers[0]!.state, { name: 'a' });
  assert.equal(report.layers[0]!.warnings.length, 2);
});

test('运行时正则：作用于请求的只改本次请求，不改存储；作用于显示的不进请求', async () => {
  await patchPreset([
    { op: 'addScript', script: script({ stage: 'runtime', target: 'request', roles: ['user'], pattern: '哥布林', replacement: '地精' }) },
    { op: 'addScript', script: script({ stage: 'runtime', target: 'display', roles: ['user'], pattern: '哥布林', replacement: '👹' }) },
  ]);
  const sid = await newSession();
  await op(sid, { op: 'append', role: 'user', content: '一只哥布林', generate: true });
  await ctx.manager.drain();
  assert.equal(upstream.last.body.messages.at(-1).content, '一只地精');
  assert.equal((await layers(sid))[0]!.content, '一只哥布林');
});

test('手动重新执行返回时正则：改过正则后补处理旧消息', async () => {
  const sid = await newSession();
  upstream.script = { pieces: ['获得金币【+30】'] };
  await op(sid, { op: 'append', role: 'user', content: 'x', generate: true });
  await ctx.manager.drain();
  const reply = (await layers(sid))[1]!;
  assert.equal(reply.content, '获得金币【+30】');

  await patchPreset([
    { op: 'set', field: 'initialVars', value: 'gold = 0' },
    { op: 'addScript', script: script({ pattern: '【\\+(\\d+)】', replacement: '<var>gold += $1</var>' }) },
  ]);
  const r = await api('POST', `/api/sessions/${sid}/receive`, { messageIds: [reply.id] });
  assert.deepEqual(r.json, { layers: [1] });
  const again = (await layers(sid))[1]!;
  assert.equal(again.content, '获得金币');
  assert.equal((await vars(sid)).final.gold, 30);
});

test('初始变量：角色卡覆盖预设；写错时不能保存', async () => {
  await patchPreset([{ op: 'set', field: 'initialVars', value: 'hp = 100\nname = "旅人"' }]);
  assert.equal((await api('PATCH', '/api/library/character/char1', { ops: [{ op: 'set', field: 'initialVars', value: 'hp = 80' }] })).status, 200);
  const sid = await newSession();
  assert.deepEqual((await vars(sid)).initial, { hp: 80, name: '旅人' });
  const bad = await api('PATCH', '/api/library/character/char1', { ops: [{ op: 'set', field: 'initialVars', value: 'hp += 1' }] });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /初始变量第 1 行/);
});

test('正则脚本写错时不能保存；返回时正则回溯失控会超时，但回复照常保存并记下原因', async () => {
  const bad = await api('PATCH', '/api/library/preset/preset1', { ops: [{ op: 'addScript', script: script({ pattern: '(a)', replacement: '$2' }) }] });
  assert.equal(bad.status, 400);
  assert.match(bad.json.message, /不存在的捕获组/);

  await patchPreset([{ op: 'addScript', script: script({ pattern: '(a+)+$', replacement: 'x' }) }]);
  upstream.script = { pieces: [`${'a'.repeat(40)}!`] };
  const sid = await newSession();
  await op(sid, { op: 'append', role: 'user', content: 'x', generate: true });
  await ctx.manager.drain();
  const reply = (await layers(sid))[1]!;
  assert.equal(reply.content, `${'a'.repeat(40)}!`);
  assert.match(reply.varErrors[0]!.message, /返回时正则执行失败.*超过/);
});

test('组件提交可以附上附加消息：显示在这一层，下一轮作为 user 消息紧跟其后发送；可以删除', async () => {
  await patchPreset([{ op: 'set', field: 'initialVars', value: '钱包 = { 金币: 100 }\n背包 = []' }]);
  const sid = await newSession();
  await op(sid, { op: 'append', role: 'user', content: '有什么卖的？', generate: true });
  await ctx.manager.drain();
  const reply = (await layers(sid))[1]!;
  const r = await op(sid, {
    op: 'addVarOps',
    messageId: reply.id,
    ops: [
      { name: '钱包.金币', op: '-=', value: 30 },
      { name: '背包', op: '+=', value: { 名称: '灵泉水', 数量: 1 } },
    ],
    note: '【商店记录】购买 灵泉水 ×1（30 金币）',
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.layer.notes, ['【商店记录】购买 灵泉水 ×1（30 金币）']);
  assert.deepEqual((await vars(sid)).final, { 钱包: { 金币: 70 }, 背包: [{ 名称: '灵泉水', 数量: 1 }] });

  await op(sid, { op: 'append', role: 'user', content: '谢谢' });
  const msgs = (await api('POST', '/api/preview', { sessionId: sid })).json.messages as { role: string; content: string }[];
  const tail = msgs.slice(-3).map((m) => [m.role, m.content]);
  assert.deepEqual(tail, [
    ['assistant', '好的。'],
    ['user', '【商店记录】购买 灵泉水 ×1（30 金币）'],
    ['user', '谢谢'],
  ]);

  assert.equal((await op(sid, { op: 'removeNote', messageId: reply.id, index: 3 })).status, 404);
  const rm = await op(sid, { op: 'removeNote', messageId: reply.id, index: 0 });
  assert.deepEqual(rm.json.layer.notes, []);
});
