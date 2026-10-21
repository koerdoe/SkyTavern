import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addCandidate,
  appendLayer,
  applyOp,
  emptySession,
  linearize,
  parseSessionDoc,
  RECENT_OPS_LIMIT,
  serializeSessionDoc,
  SessionOpError,
} from '../../src/core/session.ts';

const text = (doc: ReturnType<typeof emptySession>) => linearize(doc).map((m) => m.content);

test('追加新层，消息 ID 为 时间-层级-序号', () => {
  const doc = emptySession();
  applyOp(doc, 'o1', { op: 'append', role: 'user', content: 'hi' }, 100);
  applyOp(doc, 'o2', { op: 'append', role: 'assistant', content: 'yo' }, 200);
  assert.deepEqual(text(doc), ['hi', 'yo']);
  assert.deepEqual(linearize(doc).map((m) => m.id), ['100-0-0', '200-1-0']);
  assert.deepEqual(doc.selected, [0, 0]);
});

test('重 roll 在原层新增候选并选用；可以切回旧候选', () => {
  const doc = emptySession();
  applyOp(doc, 'o1', { op: 'append', role: 'assistant', content: 'A' }, 1);
  const b = addCandidate(doc, 0, 'B', 2);
  assert.equal(b.id, '2-0-1');
  assert.deepEqual(text(doc), ['B']);
  applyOp(doc, 'o2', { op: 'select', messageId: '1-0-0' }, 3);
  assert.deepEqual(text(doc), ['A']);
});

test('重复的 opId 不会重复执行', () => {
  const doc = emptySession();
  assert.deepEqual(applyOp(doc, 'same', { op: 'append', role: 'user', content: 'x' }, 1), { applied: true, layer: 0 });
  assert.deepEqual(applyOp(doc, 'same', { op: 'append', role: 'user', content: 'x' }, 2), { applied: false });
  assert.equal(doc.layers.length, 1);
});

test('opId 记录有上限', () => {
  const doc = emptySession();
  applyOp(doc, 'first', { op: 'append', role: 'user', content: 'x' }, 0);
  for (let i = 0; i < RECENT_OPS_LIMIT; i++) applyOp(doc, `e${i}`, { op: 'edit', messageId: '0-0-0', content: `${i}` }, i);
  assert.equal(doc.recentOps.length, RECENT_OPS_LIMIT);
  assert.equal(doc.recentOps.includes('first'), false);
});

test('编辑会清除未完成标记', () => {
  const doc = emptySession();
  appendLayer(doc, 'assistant', '半截', 0, { partial: true });
  assert.equal(linearize(doc)[0]!.partial, true);
  applyOp(doc, 'e', { op: 'edit', messageId: '0-0-0', content: '补完' }, 1);
  assert.equal(linearize(doc)[0]!.partial, undefined);
});

test('删除候选：选中位置跟随；删最后一个候选时整层移除，其他 ID 不变', () => {
  const doc = emptySession();
  applyOp(doc, 'a', { op: 'append', role: 'user', content: 'u' }, 1);
  applyOp(doc, 'b', { op: 'append', role: 'assistant', content: 'A' }, 2);
  addCandidate(doc, 1, 'B', 3);
  addCandidate(doc, 1, 'C', 4); // 选中 C（下标 2）
  applyOp(doc, 'c', { op: 'delete', messageId: '2-1-0' }, 5); // 删 A
  assert.deepEqual(text(doc), ['u', 'C']);
  assert.equal(doc.selected[1], 1);
  applyOp(doc, 'd', { op: 'delete', messageId: '4-1-2' }, 6); // 删选中的 C
  assert.deepEqual(text(doc), ['u', 'B']);
  applyOp(doc, 'e', { op: 'delete', messageId: '1-0-0' }, 7); // 删整层
  assert.deepEqual(text(doc), ['B']);
  assert.equal(linearize(doc)[0]!.id, '3-1-1');
});

test('对不存在的消息操作会报错，且不记录 opId', () => {
  const doc = emptySession();
  assert.throws(() => applyOp(doc, 'x', { op: 'edit', messageId: 'nope', content: '' }, 0), SessionOpError);
  assert.equal(doc.recentOps.length, 0);
});

test('序列化时 selected 在末尾，可以原样读回', () => {
  const doc = emptySession();
  applyOp(doc, 'a', { op: 'append', role: 'user', content: '中文' }, 1);
  const json = serializeSessionDoc(doc);
  assert.match(json, /"selected":\[0\]\}$/);
  assert.deepEqual(parseSessionDoc(json), doc);
});
