import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bm25, chunkMessages, chunkText, formatRecall, MIN_CHUNK, selectRecall, terms } from '../../src/core/recall.ts';

const len = (s: string) => [...s].length;

test('分块：短消息整条一块；长消息每块不少于 100 字符、不超过约 500', () => {
  assert.deepEqual(chunkText('  你好  '), ['你好']);
  assert.deepEqual(chunkText(''), []);
  const para = '雨下了一整夜。'.repeat(20); // 140 字
  const long = Array.from({ length: 10 }, () => para).join('\n\n');
  const chunks = chunkText(long);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => len(c) >= MIN_CHUNK && len(c) <= 600), chunks.map(len).join(','));
  // 一整段超长文字按句子切
  const huge = '他走进酒馆，点了一杯酒。'.repeat(100);
  assert.ok(chunkText(huge).every((c) => len(c) <= 520));
});

test('关键词：中文按相邻两字，英文按单词；BM25 能把相关的排在前面', () => {
  assert.deepEqual(terms('灯塔守夜人 Oswin, the keeper'), ['灯塔', '塔守', '守夜', '夜人', 'oswin', 'the', 'keeper']);
  const s = bm25('灯塔在哪里', ['今天去了集市', '北岸的灯塔很高', '灯塔守夜人说话很慢，灯塔']);
  assert.equal(s[0], 0);
  assert.ok(s[2]! > s[1]! && s[1]! > 0);
});

test('选择：窗口内的不作中心；带前后邻块；按聊天顺序排列并排版', () => {
  const msgs = [
    { id: 'm1', role: 'user', content: '我们聊聊灯塔吧' },
    { id: 'm2', role: 'assistant', content: '灯塔在北岸，守夜人叫奥斯维' },
    { id: 'm3', role: 'user', content: '集市上有什么' },
    { id: 'm4', role: 'assistant', content: '集市卖鱼' },
    { id: 'm5', role: 'user', content: '灯塔今晚亮吗' },
  ];
  const chunks = chunkMessages(msgs);
  const r = selectRecall({ chunks, windowIds: new Set(['m4', 'm5']), query: '守夜人在灯塔吗', mode: 'keyword', topK: 1 });
  assert.equal(chunks[r.centers[0]!.index]!.messageId, 'm2');
  assert.deepEqual(r.picked, [0, 1, 2]);
  assert.equal(formatRecall(chunks, r.picked, { user: '我', char: '艾琳' }), '我：我们聊聊灯塔吧\n艾琳：灯塔在北岸，守夜人叫奥斯维\n我：集市上有什么');
  // 没有相关的就什么都不选
  assert.deepEqual(selectRecall({ chunks, windowIds: new Set(), query: '飞船', mode: 'keyword', topK: 3 }).picked, []);
  // 向量模式
  const vectors = chunks.map((_c, i) => (i === 3 ? [1, 0] : [0, 1]));
  const v = selectRecall({ chunks, windowIds: new Set(['m5']), query: 'x', mode: 'vector', topK: 1, vectors, queryVector: [1, 0] });
  assert.equal(v.centers[0]!.index, 3);
  assert.deepEqual(v.picked, [2, 3, 4]);
});
