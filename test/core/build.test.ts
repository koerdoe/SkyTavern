import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRequest, checkRisks, OrchestrationError, type TokenCounter } from '../../src/core/index.ts';
import { chat, contents, ins, mark, pos, vars } from './helpers.ts';

// 每条消息的 token 数就是内容长度，方便手算。
const len: TokenCounter = (m) => m.content.length;
const tenEach = (n: number) => chat(n, (i) => `m${i}`.padEnd(10, '.'));

test('未超上限时不裁剪', () => {
  const r = buildRequest({ entries: [], history: tenEach(6), vars: vars(), inputLimit: 60, cacheMode: 'auto', countTokens: len });
  assert.equal(r.messages.length, 6);
  assert.equal(r.windowStartId, 'h0');
  assert.equal(r.tokens, 60);
});

test('超限后从头部整条裁剪，一次腾出约 5 轮', () => {
  // 20 条 × 10 = 200，上限 150。平均每轮 20，目标 = 150 − 100 = 50。
  const r = buildRequest({ entries: [], history: tenEach(20), vars: vars(), inputLimit: 150, cacheMode: 'auto', countTokens: len });
  assert.equal(r.tokens, 50);
  assert.equal(r.windowStartId, 'h15');
  assert.equal(r.messages.at(-1)!.content, 'm19.......');
});

test('保存的起点在下一轮继续使用，不从完整历史重新裁', () => {
  const history = tenEach(22);
  const r = buildRequest({ entries: [], history, vars: vars(), inputLimit: 150, windowStartId: 'h15', cacheMode: 'auto', countTokens: len });
  assert.equal(r.windowStartId, 'h15');
  assert.equal(r.messages.length, 7);
});

test('正文外的提示词计入预算，裁剪后重新计算 Dx', () => {
  const entries = [pos('before', 'P'.repeat(30)), pos('chat', 'D5', { depth: 5 })];
  // 正文 10 条 × 10 = 100，加 32 = 132 > 120。平均每轮 20，目标 = 20。
  const r = buildRequest({ entries, history: tenEach(10), vars: vars(), inputLimit: 120, cacheMode: 'auto', countTokens: len });
  // 目标 20 装不下（前缀已 32），只保留最后一条；D5 落到正文最上方
  assert.deepEqual(contents(r.messages), ['P'.repeat(30), 'D5', 'm9........']);
  assert.equal(r.windowStartId, 'h9');
});

test('最后一条加必需提示词仍超限时报错', () => {
  assert.throws(
    () => buildRequest({ entries: [pos('before', 'x'.repeat(100))], history: tenEach(3), vars: vars(), inputLimit: 50, cacheMode: 'auto', countTokens: len }),
    (e: unknown) => e instanceof OrchestrationError && e.code === 'over-budget',
  );
});

test('自动断点：正文前末尾 + 第一条易变消息之前', () => {
  const entries = [pos('system', 'S'), pos('before', 'B'), pos('chat', 'D2', { depth: 2 }), pos('after', 'A')];
  const r = buildRequest({ entries, history: chat(4), vars: vars(), cacheMode: 'auto' });
  // S B m0 m1 D2 m2 m3 A
  assert.deepEqual(contents(r.messages), ['S', 'B', 'm0', 'm1', 'D2', 'm2', 'm3', 'A']);
  assert.deepEqual(r.cacheBreakpoints, [1, 3]);
});

test('自动断点：没有动态插入时断在正文末尾；被插入修改的正文消息算易变', () => {
  const plain = buildRequest({ entries: [pos('before', 'B'), pos('after', 'A')], history: chat(3), vars: vars(), cacheMode: 'auto' });
  assert.deepEqual(plain.cacheBreakpoints, [0, 3]);
  const edited = buildRequest({ entries: [pos('before', 'B'), ins('m1', 'X', { scope: ['chat'] })], history: chat(3), vars: vars(), cacheMode: 'auto' });
  assert.deepEqual(edited.cacheBreakpoints, [0, 1]);
});

test('手动断点：位置 + 优先级，受 IF 控制', () => {
  const entries = [
    pos('before', 'B1', { priority: 2 }),
    mark('before', { priority: 1 }),
    pos('before', 'B2', { priority: 0 }),
    mark('chat', { depth: 1, if: 'on == 1' }),
  ];
  const on = buildRequest({ entries, history: chat(3), vars: vars({ on: 1 }), cacheMode: 'manual' });
  assert.deepEqual(on.cacheBreakpoints, [0, 3]); // B1 | B2 m0 m1 | m2
  const off = buildRequest({ entries, history: chat(3), vars: vars({ on: 0 }), cacheMode: 'manual' });
  assert.deepEqual(off.cacheBreakpoints, [0]);
});

test('风险检查：缓存破坏与递归插入', () => {
  const a = ins('x', 'Y', { priority: 2, scope: ['before'] });
  const b = ins('Y', 'z', { priority: 1, scope: ['before'] });
  const risks = checkRisks([pos('before', 'p', { if: 'a > 1' }), ins('m', 'n', { scope: ['chat'] }), a, b]);
  assert.deepEqual(
    risks.map((r) => r.kind),
    ['cache-break', 'cache-break', 'recursive-insert'],
  );
  assert.deepEqual(risks[2]!.entryIds, [a.id, b.id]);
});

test('一次腾出的轮数可以设置：轮数越多裁得越狠', async () => {
  const { buildRequest } = await import('../../src/core/index.ts');
  const { chat, vars } = await import('./helpers.ts');
  const history = chat(40, () => '一二三四五六七八九十');
  const base = { entries: [], history, vars: vars(), cacheMode: 'auto' as const, inputLimit: 300 };
  const few = buildRequest({ ...base, trimRounds: 1 });
  const many = buildRequest({ ...base, trimRounds: 10 });
  const kept = (r: typeof few) => r.messages.length;
  assert.ok(kept(many) < kept(few), `${kept(many)} < ${kept(few)}`);
  assert.ok(few.tokens <= 300 && many.tokens <= 300);
});
