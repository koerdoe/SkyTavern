import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addMissingFields, applyRequestJson, checkRequestJson, parseRequestJson, RequestJsonError, RequestJsonInvalid } from '../../src/core/request-json.ts';

test('宽松写法：省略外层花括号、键不加引号、末尾逗号、注释', () => {
  assert.deepEqual(parseRequestJson('thinking: {"type":"disabled"}'), { thinking: { type: 'disabled' } });
  assert.deepEqual(
    parseRequestJson('// 关闭思考\nthinking: { type: "disabled" },\nmax_tokens: 4096, // 输出上限\n'),
    { thinking: { type: 'disabled' }, max_tokens: 4096 },
  );
  assert.deepEqual(parseRequestJson('{ "temperature": 0.8, "stop": ["\\n\\n", "END"] }'), { temperature: 0.8, stop: ['\n\n', 'END'] });
  assert.deepEqual(parseRequestJson('generationConfig: {}, safetySettings: [{a: 1}]'), { generationConfig: {}, safetySettings: [{ a: 1 }] });
  assert.deepEqual(parseRequestJson('  \n // 只有注释\n'), {});
});

test('缺逗号指出行列', () => {
  assert.throws(
    () => parseRequestJson('thinking: {"type":"disabled"}\nmax_tokens: 4096'),
    (e: unknown) => e instanceof RequestJsonError && e.line === 2 && e.col === 1 && /缺少逗号/.test(e.message),
  );
  assert.throws(() => parseRequestJson('{ a: 1 b: 2 }'), /第 1 行第 8 列：这里缺少逗号/);
  assert.throws(() => parseRequestJson('a: {"x": 1 "y": 2}'), /缺少逗号/);
  assert.throws(() => parseRequestJson('a: [1 2]'), /缺少逗号/);
});

test('其他语法错误', () => {
  assert.throws(() => parseRequestJson('a 1'), /缺少冒号/);
  assert.throws(() => parseRequestJson('a: "x'), /字符串没有结束/);
  assert.throws(() => parseRequestJson('a: 1, a: 2'), /重复/);
  assert.throws(() => parseRequestJson('a: {'), /缺少右花括号/);
  assert.throws(() => parseRequestJson('a: nope'), /应该是一个值/);
});

test('固定字段不能写；缺少的必需字段按当前协议列出', () => {
  const r = checkRequestJson('model: "x", stream: false, temperature: 1', 'claude');
  assert.deepEqual(r.errors, ['model 由平台固定填写，不能在请求参数里修改', 'stream 由平台固定填写，不能在请求参数里修改']);
  assert.deepEqual(r.missing, ['max_tokens']);
  assert.deepEqual(checkRequestJson('', 'openai-chat').missing, []);
  assert.deepEqual(checkRequestJson('max_tokens: 100', 'claude').missing, []);
});

test('自动补上必需字段：保留原写法，逗号不会落进注释', () => {
  assert.equal(addMissingFields('', 'claude').text, 'max_tokens: 4096');
  assert.equal(addMissingFields('thinking: {"type":"disabled"} // 关思考', 'claude').text, 'thinking: {"type":"disabled"}, // 关思考\nmax_tokens: 4096');
  assert.equal(addMissingFields('temperature: 1,\n', 'claude').text, 'temperature: 1,\nmax_tokens: 4096');
  assert.equal(addMissingFields('{\n  "temperature": 1\n}', 'claude').text, '{\n  "temperature": 1,\n  max_tokens: 4096\n}');
  assert.equal(addMissingFields('{}', 'claude').text, '{\n  max_tokens: 4096\n}');
  // 补完后可以正常解析
  for (const t of ['', 'a: 1 // x', '{ "a": 1 }', '{}']) assert.equal(checkRequestJson(addMissingFields(t, 'claude').text, 'claude').missing.length, 0);
  // 有错误或不缺时原样返回
  assert.deepEqual(addMissingFields('a: 1 b: 2', 'claude'), { text: 'a: 1 b: 2', added: [] });
  assert.deepEqual(addMissingFields('max_tokens: 1', 'claude'), { text: 'max_tokens: 1', added: [] });
});

test('合并进请求体：对象逐层合并，缺的必需字段用默认值', () => {
  const fixed = { model: 'm', messages: [], stream: true, generationConfig: { a: 1 } };
  assert.deepEqual(applyRequestJson(fixed, 'thinking: {type: "disabled"}, generationConfig: {b: 2}', 'claude'), {
    model: 'm',
    messages: [],
    stream: true,
    generationConfig: { a: 1, b: 2 },
    thinking: { type: 'disabled' },
    max_tokens: 4096,
  });
  assert.throws(() => applyRequestJson(fixed, 'model: "x"', 'claude'), RequestJsonInvalid);
  assert.throws(() => applyRequestJson(fixed, 'a: 1 b: 2', 'claude'), /请求参数有误：第 1 行/);
});
