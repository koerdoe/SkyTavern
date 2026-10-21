import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assemble, OrchestrationError } from '../../src/core/index.ts';
import { chat, contents, ins, pos, vars } from './helpers.ts';

const run = (entries: Parameters<typeof assemble>[0]['entries'], n = 4, v = vars()) =>
  assemble({ entries, history: chat(n), vars: v });

test('先按分区，同分区优先级降序，同优先级按 ID 升序', () => {
  const r = run(
    [
      pos('after', 'after'),
      pos('before', 'b-low', { priority: 1 }),
      pos('before', 'b-high', { priority: 9 }),
      pos('system', 'sys'),
      pos('before', 'b-tie-2', { id: 'x-2', priority: 5 }),
      pos('before', 'b-tie-10', { id: 'x-10', priority: 5 }),
    ],
    2,
  );
  assert.deepEqual(contents(r.messages), ['sys', 'b-high', 'b-tie-2', 'b-tie-10', 'b-low', 'm0', 'm1', 'after']);
});

test('Dx 从正文末尾往前数，只计正文消息；超出落到最上方', () => {
  const r = run([
    pos('chat', 'D0', { depth: 0 }),
    pos('chat', 'D1', { depth: 1 }),
    pos('chat', 'D3', { depth: 3 }),
    pos('chat', 'D99', { depth: 99 }),
    pos('chat', 'D4', { depth: 4, priority: 1 }),
  ]);
  // 正文 m0..m3；D4 与 D99 都在最上方，按优先级排列
  assert.deepEqual(contents(r.messages), ['D4', 'D99', 'm0', 'D3', 'm1', 'm2', 'D1', 'm3', 'D0']);
});

test('空正文时 Dx 词条仍然出现', () => {
  const r = run([pos('chat', 'D2', { depth: 2 }), pos('chat', 'D0')], 0);
  assert.deepEqual(contents(r.messages), ['D2', 'D0']);
});

test('禁用词条与 IF 不成立的词条被跳过', () => {
  const r = run(
    [pos('before', 'off', { enabled: false }), pos('before', 'no', { if: 'hp > 50' }), pos('before', 'yes', { if: 'hp > 10' })],
    0,
    vars({ hp: 30 }),
  );
  assert.deepEqual(contents(r.messages), ['yes']);
});

test('IF 出错会停止并指出词条', () => {
  const e = pos('before', 'x', { if: 'nope > 1' });
  assert.throws(
    () => run([e], 0),
    (err: unknown) => err instanceof OrchestrationError && err.code === 'if-failed' && err.entryId === e.id,
  );
  const bad = pos('before', 'x', { if: 'hp >' });
  assert.throws(
    () => run([bad], 0),
    (err: unknown) => err instanceof OrchestrationError && err.code === 'bad-if' && err.entryId === bad.id,
  );
});

test('非预设词条不能超出 ±10000，预设可以', () => {
  assert.throws(() => run([pos('before', 'x', { source: 'character', priority: 10001 })], 0), /±10000/);
  assert.doesNotThrow(() => run([pos('before', 'x', { priority: 20000 })], 0));
});

test('插入法：模板由作者决定 $1 的位置；按优先级依次执行，后者可匹配前者', () => {
  const r = run(
    [
      pos('before', '【场景】酒馆'),
      ins('(【场景】)', '$1雨夜，', { priority: 5 }),
      ins('雨夜', '$&（很冷）', { priority: 1 }),
    ],
    0,
  );
  assert.deepEqual(contents(r.messages), ['【场景】雨夜（很冷），酒馆']);
  assert.deepEqual(r.messages[0]!.insertedBy.length, 2);
});

test('插入只在单条消息内匹配，不跨消息', () => {
  const r = run([pos('before', 'AB'), pos('before', 'CD'), ins('BC', 'X')], 0);
  assert.deepEqual(contents(r.messages), ['AB', 'CD']);
  assert.equal(r.warnings.length, 1);
});

test('first / last 选取与作用范围', () => {
  const entries = [pos('before', 'tag'), pos('after', 'tag')];
  const first = run([...entries, ins('tag', 'F')], 0);
  assert.deepEqual(contents(first.messages), ['F', 'tag']);
  const last = run([...entries, ins('tag', 'L', { pick: 'last' })], 0);
  assert.deepEqual(contents(last.messages), ['tag', 'L']);
  const scoped = run([...entries, ins('tag', 'S', { scope: ['after'] })], 0);
  assert.deepEqual(contents(scoped.messages), ['tag', 'S']);
  // 同一条消息内取最后一处
  const inMsg = run([pos('before', 'a-a-a'), ins('a', 'Z', { pick: 'last' })], 0);
  assert.deepEqual(contents(inMsg.messages), ['a-a-Z']);
});

test('每条规则每次请求只执行一次；$1$1 可以复制文字', () => {
  const r = run([pos('before', 'x x'), ins('(x)', '$1$1')], 0);
  assert.deepEqual(contents(r.messages), ['xx x']);
});

test('不能匹配受保护的头尾词条', () => {
  const r = run([pos('before', 'tag', { priority: 20000 }), pos('before', 'tag'), ins('tag', 'hit')], 0);
  assert.deepEqual(contents(r.messages), ['tag', 'hit']);
});

test('插入修改正文时只影响请求，不改原始记录', () => {
  const history = chat(2);
  const r = assemble({ entries: [ins('m1', 'changed', { scope: ['chat'] })], history, vars: vars() });
  assert.deepEqual(contents(r.messages), ['m0', 'changed']);
  assert.equal(history[1]!.content, 'm1');
  assert.equal(r.messages[1]!.volatile, true);
});

test('未匹配：warn 给警告，silent 不给', () => {
  assert.equal(run([ins('none', 'x')], 0).warnings.length, 1);
  assert.equal(run([ins('none', 'x', { onMiss: 'silent' })], 0).warnings.length, 0);
});

test('模板引用不存在的捕获组视为配置错误', () => {
  assert.throws(() => run([ins('(a)', '$2')], 0), /不存在的捕获组 \$2/);
  assert.throws(() => run([ins('a', '$<n>')], 0), /不存在的命名组/);
  assert.doesNotThrow(() => run([ins('(?<n>a)', '$<n>$$1')], 0));
  assert.throws(() => run([ins('(', 'x')], 0), /正则无法编译/);
  assert.throws(() => run([ins('a', 'x', { flags: 'g' })], 0), /正则标志/);
});

test('可选组未参与匹配时替换为空', () => {
  const r = run([pos('before', 'b'), ins('(a)?b', '[$1]')], 0);
  assert.deepEqual(contents(r.messages), ['[]']);
});

test('空内容的消息被去掉', () => {
  const r = run([pos('before', ''), pos('before', '  '), pos('before', 'x')], 0);
  assert.deepEqual(contents(r.messages), ['x']);
});

test('附加消息紧跟在所属消息后作为 user 消息，不参与 Dx 计数', () => {
  const history = chat(4);
  history[1] = { ...history[1]!, notes: ['【商店】买了灵泉水', '【商店】卖了草药'] };
  const r = assemble({ entries: [pos('chat', 'D2', { depth: 2 }), pos('chat', 'D1', { depth: 1 })], history, vars: vars() });
  assert.deepEqual(
    r.messages.map((m) => [m.role, m.content, m.origin.kind]),
    [
      ['user', 'm0', 'history'],
      ['assistant', 'm1', 'history'],
      ['user', '【商店】买了灵泉水\n\n【商店】卖了草药', 'note'],
      ['system', 'D2', 'entry'],
      ['user', 'm2', 'history'],
      ['system', 'D1', 'entry'],
      ['assistant', 'm3', 'history'],
    ],
  );
});
