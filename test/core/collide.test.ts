import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assemble, OrchestrationError } from '../../src/core/index.ts';
import { contents, ins, pos, vars } from './helpers.ts';

const wb = (id: string, content: string, priority: number, extra: Parameters<typeof pos>[2] = {}) =>
  pos('before', content, { id, source: 'worldbook', priority, ...extra });

const run = (entries: Parameters<typeof assemble>[0]['entries']) => assemble({ entries, history: [], vars: vars() });

test('两本世界书撞车：ID 靠前的保持不动，靠后的 +1', () => {
  const r = run([wb('wb2-1', 'B', 100), wb('wb1-1', 'A', 100)]);
  assert.deepEqual(r.bumped, [{ entryId: 'wb2-1', from: 100, to: 101 }]);
  assert.deepEqual(contents(r.messages), ['B', 'A']); // 101 排在 100 前面
});

test('+1 后仍撞车就继续加，直到有空位', () => {
  const r = run([wb('wb1-1', 'A100', 100), wb('wb1-2', 'A101', 101), wb('wb2-1', 'B', 100)]);
  assert.deepEqual(r.bumped, [{ entryId: 'wb2-1', from: 100, to: 102 }]);
});

test('落到自己容器占的位置时停下，与自己的词条按 ID 排', () => {
  const r = run([wb('wb1-1', 'A', 100), wb('wb2-1', 'B100', 100), wb('wb2-2', 'B101', 101)]);
  assert.deepEqual(r.bumped, [{ entryId: 'wb2-1', from: 100, to: 101 }]);
  assert.deepEqual(contents(r.messages), ['B100', 'B101', 'A']);
});

test('同一容器内同优先级不避让，按 ID 升序', () => {
  const r = run([wb('wb1-2', 'second', 100), wb('wb1-1', 'first', 100)]);
  assert.deepEqual(r.bumped, []);
  assert.deepEqual(contents(r.messages), ['first', 'second']);
});

test('容器ID 按自然顺序：wb2 比 wb10 靠前', () => {
  const r = run([wb('wb10-1', 'ten', 100), wb('wb2-1', 'two', 100)]);
  assert.deepEqual(r.bumped.map((b) => b.entryId), ['wb10-1']);
});

test('预设始终不动；角色卡先于世界书', () => {
  const r = run([
    wb('wb1-1', 'W', 100),
    pos('before', 'C', { id: 'char1-1', source: 'character', priority: 100 }),
    pos('before', 'P', { id: 'preset1-1', source: 'preset', priority: 100 }),
  ]);
  assert.deepEqual(r.bumped, [
    { entryId: 'char1-1', from: 100, to: 101 },
    { entryId: 'wb1-1', from: 100, to: 102 },
  ]);
});

test('不同位置不算撞车：分区不同、深度不同、插入法单独一组', () => {
  const r = run([
    wb('wb1-1', 'A', 100),
    pos('after', 'B', { id: 'wb2-1', source: 'worldbook', priority: 100 }),
    pos('chat', 'C', { id: 'wb2-2', source: 'worldbook', priority: 100, depth: 1 }),
    pos('chat', 'D', { id: 'wb3-1', source: 'worldbook', priority: 100, depth: 2 }),
    ins('A', 'A!', { id: 'wb4-1', source: 'worldbook', priority: 100 }),
  ]);
  assert.deepEqual(r.bumped, []);
});

test('IF 不成立的词条照样占位，结果每轮稳定', () => {
  const r = run([wb('wb1-1', 'A', 100, { if: 'false' }), wb('wb2-1', 'B', 100)]);
  assert.deepEqual(r.bumped, [{ entryId: 'wb2-1', from: 100, to: 101 }]);
  assert.deepEqual(contents(r.messages), ['B']);
});

test('禁用的词条不占位', () => {
  const r = run([wb('wb1-1', 'A', 100, { enabled: false }), wb('wb2-1', 'B', 100)]);
  assert.deepEqual(r.bumped, []);
});

test('避让后超出 ±10000 报错', () => {
  assert.throws(
    () => run([wb('wb1-1', 'A', 10000), wb('wb2-1', 'B', 10000)]),
    (e: unknown) => e instanceof OrchestrationError && e.code === 'bad-priority' && e.entryId === 'wb2-1',
  );
});
