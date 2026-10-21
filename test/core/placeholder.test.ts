import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assemble, checkRisks, OrchestrationError } from '../../src/core/index.ts';
import { chat, contents, ins, mark, pos, vars } from './helpers.ts';

const v = vars({ char: '艾琳', user: '旅人', hp: 30, price: '$1' });

test('词条里的占位符：char、user、变量', () => {
  const r = assemble({ entries: [pos('before', '{{char}}对{{ user }}说：HP {{hp}}')], history: [], vars: v });
  assert.deepEqual(contents(r.messages), ['艾琳对旅人说：HP 30']);
});

test('词条里的未知占位符停止生成并指出词条', () => {
  const e = pos('before', '{{nope}}');
  assert.throws(
    () => assemble({ entries: [e], history: [], vars: v }),
    (err: unknown) => err instanceof OrchestrationError && err.code === 'placeholder-failed' && err.entryId === e.id,
  );
});

test('正文里的占位符只替换存在的，未知的原样保留', () => {
  const r = assemble({ entries: [], history: [{ id: 'h0', role: 'user', content: '你好{{char}}，{{随手写的}}' }], vars: v });
  assert.deepEqual(contents(r.messages), ['你好艾琳，{{随手写的}}']);
});

test('插入模板里的占位符：变量值中的 $ 不会被当作捕获组', () => {
  const r = assemble({ entries: [pos('before', '价格：?'), ins('(价格：)\\?', '$1{{price}}')], history: [], vars: v });
  assert.deepEqual(contents(r.messages), ['价格：$1']);
});

test('预览数据：每个词条落在哪条最终消息', () => {
  const entries = [
    pos('system', 'S', { id: 'p-1' }),
    pos('before', '', { id: 'p-2' }), // 空，被去掉
    pos('before', 'B', { id: 'p-3', if: 'hp > 100' }), // IF 不成立
    pos('before', 'B2', { id: 'p-4', enabled: false }),
    mark('before', { id: 'p-5', priority: -1 }),
    pos('chat', 'D1', { id: 'p-6', depth: 1 }),
    ins('m1', 'M1!', { id: 'p-7', scope: ['chat'] }),
    ins('zzz', 'x', { id: 'p-8' }),
  ];
  const r = assemble({ entries, history: chat(2), vars: v });
  // S m0 D1 M1!
  assert.deepEqual(contents(r.messages), ['S', 'm0', 'D1', 'M1!']);
  assert.deepEqual(r.outcomes, {
    'p-1': { status: 'placed', priority: 0, messageIndex: 0 },
    'p-2': { status: 'placed', priority: 0, messageIndex: null },
    'p-3': { status: 'if-false', priority: 0 },
    'p-4': { status: 'disabled' },
    'p-5': { status: 'cache-mark', priority: -1, messageIndex: 0 },
    'p-6': { status: 'placed', priority: 0, messageIndex: 2 },
    'p-7': { status: 'inserted', priority: 0, messageIndex: 3 },
    'p-8': { status: 'insert-miss', priority: 0 },
  });
});

test('预览数据里的优先级是避让之后的值', () => {
  const r = assemble({
    entries: [
      pos('before', 'A', { id: 'wb1-1', source: 'worldbook', priority: 5 }),
      pos('before', 'B', { id: 'wb2-1', source: 'worldbook', priority: 5 }),
    ],
    history: [],
    vars: v,
  });
  assert.deepEqual(r.outcomes['wb2-1'], { status: 'placed', priority: 6, messageIndex: 0 });
});

test('风险检查：正文前用了会变化的占位符', () => {
  const risks = checkRisks([pos('before', '{{char}}{{user}}'), pos('before', 'HP {{hp}}'), pos('after', '{{hp}}')]);
  assert.equal(risks.length, 1);
  assert.match(risks[0]!.message, /\{\{hp\}\}/);
});

test('风险检查：同一个占位符用了多次只列一次', () => {
  const risks = checkRisks([pos('before', '{{roll("1d100")}} {{roll("1d100")}} {{hp}} {{hp}}')]);
  assert.equal(risks.length, 1);
  assert.equal(risks[0]!.message.match(/\{\{roll\(…\)\}\}/g)!.length, 1);
  assert.equal(risks[0]!.message.match(/\{\{hp\}\}/g)!.length, 1);
});

test('转义：\\{ 输出字面的 {，不当作占位符，也不算缓存风险', () => {
  const r = assemble({ entries: [pos('before', '格式：\\{{总属性}}=(\\{{基础}}+{{hp}})，集合 \\{a}')], history: [], vars: v });
  assert.deepEqual(contents(r.messages), ['格式：{{总属性}}=({{基础}}+30)，集合 {a}']);
  assert.equal(checkRisks([pos('before', '\\{{总属性}} \\{{roll("1d6")}}')]).length, 0);
});
