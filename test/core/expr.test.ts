import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evalCondition, ExprError } from '../../src/core/index.ts';
import { evalExpr, similarCalls } from '../../src/core/expr.ts';
import { parseSimilarArgs } from '../../src/core/similar.ts';
import { PlaceholderError, renderPlaceholders } from '../../src/core/placeholder.ts';
import type { VarValue } from '../../src/core/types.ts';
import { vars } from './helpers.ts';

const v = vars({ hp: 30, '好感度': 80, 'loc.name': '酒馆', flag: 0 });
const ok = (src: string): boolean => evalCondition(src, v);

test('基本运算与优先级', () => {
  assert.equal(ok('hp > 10 && 好感度 >= 80'), true);
  assert.equal(ok('1 + 2 * 3 == 7'), true);
  assert.equal(ok('(1 + 2) * 3 == 9'), true);
  assert.equal(ok('-hp < 0'), true);
  assert.equal(ok('!flag'), true);
  assert.equal(ok('hp % 7 == 2'), true);
});

test('字符串、含点变量名', () => {
  assert.equal(ok('loc.name == "酒馆"'), true);
  assert.equal(ok("loc.name + '门口' == '酒馆门口'"), true);
  assert.equal(ok('"a\\"b" == \'a"b\''), true);
});

test('== 不做类型转换', () => {
  assert.equal(ok('hp == "30"'), false);
  assert.equal(ok('hp != "30"'), true);
});

test('缺失变量报错，has() 可以短路保护', () => {
  assert.throws(() => ok('missing > 1'), /变量 missing 不存在/);
  assert.equal(ok('has("missing") && missing > 1'), false);
  assert.equal(ok('!has("missing") || missing > 1'), true);
});

test('类型错误与语法错误', () => {
  assert.throws(() => ok('hp < "a"'), ExprError);
  assert.throws(() => ok('loc.name * 2'), ExprError);
  assert.throws(() => ok('hp >'), /表达式不完整/);
  assert.throws(() => ok('hp = 1'), ExprError);
  assert.throws(() => ok('eval("1")'), /没有函数 eval/);
  assert.throws(() => ok('hp 1'), /多余内容/);
  assert.throws(() => ok('"abc'), /字符串没有结束/);
});

test('列表与对象：按路径读取、len()、按内容比较、真值', async () => {
  const { getPath } = await import('../../src/core/vars.ts');
  const state = { 背包: ['草药', '灵泉水'], 商品: { 灵泉水: { 价格: 30, 上架: true } }, 空: [] };
  const look = (n: string) => getPath(state, n);
  const t = (src: string) => evalCondition(src, look);
  assert.equal(t('商品.灵泉水.价格 == 30 && 商品.灵泉水.上架'), true);
  assert.equal(t('背包.1 == "灵泉水"'), true);
  assert.equal(t('len(背包) == 2 && len(商品) == 1 && len("雾港") == 2'), true);
  assert.equal(t("商品.灵泉水 == 商品.灵泉水 && 背包 != 空"), true);
  assert.equal(t('!空 && 背包'), true);
  assert.equal(t('has("商品.灵泉水") && !has("商品.火种") && !has("背包.5")'), true);
  assert.throws(() => t('背包 < 1'), ExprError);
});

test('mentioned()：最近几条消息里有没有提到关键词', async () => {
  const { mentionedIn } = await import('../../src/core/mention.ts');
  const ctx = { mentioned: mentionedIn(['很久以前提到过灯塔', '你好，Eileen', '今天去集市', '买了一只 cat']) };
  const t = (src: string) => evalCondition(src, vars({}), ctx);
  assert.equal(t('mentioned("cat")'), true);
  assert.equal(t('mentioned("CAT")'), true); // 不区分大小写
  assert.equal(t('mentioned("ca")'), false); // 英文按整词
  assert.equal(t('mentioned("集")'), true); // 中文按子串
  assert.equal(t('mentioned("eileen")'), false); // 默认只看最近 2 条
  assert.equal(t('mentioned(3, "eileen")'), true);
  assert.equal(t('mentioned(4, "灯塔") && !mentioned("灯塔")'), true);
  assert.equal(t('mentioned("/集(市|会)/")'), true);
  assert.equal(t('mentioned("狗", "猫", "cat")'), true);
  assert.throws(() => t('mentioned(3)'), ExprError);
  assert.throws(() => t('mentioned("/(/")'), ExprError);
  // 没有聊天记录时不成立
  assert.equal(evalCondition('mentioned("cat")', vars({})), false);
});

test('函数：get、random、pick、roll', () => {
  const vars: Record<string, VarValue> = { hp: 30 };
  const look = (n: string) => vars[n];
  assert.equal(evalExpr('get("hp")', look), 30);
  assert.equal(evalExpr('get("mp")', look), '');
  assert.equal(evalExpr('get("mp", 5)', look), 5);
  // random 用给定的随机数；pick 同一种子同一结果，换种子可能不同
  assert.equal(evalExpr('random("a", "b", "c")', look, { rand: () => 0.99 }), 'c');
  assert.equal(evalExpr('random("a", "b", "c")', look, { rand: () => 0 }), 'a');
  const p1 = evalExpr('pick("甲", "乙", "丙", "丁")', look, { seed: 's1' });
  assert.equal(evalExpr('pick("甲", "乙", "丙", "丁")', look, { seed: 's1' }), p1);
  const seen = new Set(['s1', 's2', 's3', 's4', 's5', 's6'].map((seed) => evalExpr('pick("甲", "乙", "丙", "丁")', look, { seed })));
  assert.ok(seen.size > 1);
  assert.equal(evalExpr('roll("2d6+1")', look, { rand: () => 0.999 }), 13);
  assert.equal(evalExpr('roll(20)', look, { rand: () => 0 }), 1);
  assert.equal(evalExpr('roll("1d20-2")', look, { rand: () => 0 }), -1);
  assert.throws(() => evalExpr('roll("abc")', look), /roll/);
  assert.throws(() => evalExpr('random()', look), /至少/);
});

test('similar()：参数规则；只认直接写的值；生成前算好的结果按词条查', () => {
  assert.deepEqual(parseSimilarArgs([]), { depth: 2, text: null, threshold: 0.5 });
  assert.deepEqual(parseSimilarArgs([4, '北塔', 0.7]), { depth: 4, text: '北塔', threshold: 0.7 });
  assert.deepEqual(parseSimilarArgs([0.6]), { depth: 2, text: null, threshold: 0.6 });
  assert.throws(() => parseSimilarArgs([1.5]));
  assert.throws(() => parseSimilarArgs(['a', 'b']));
  assert.deepEqual(similarCalls('hp > 0 && (similar(3) || !similar("北塔", 0.6))'), [
    { depth: 3, text: null, threshold: 0.5 },
    { depth: 2, text: '北塔', threshold: 0.6 },
  ]);
  assert.throws(() => evalCondition('similar(x)', () => 1), /只能直接写/);
  assert.equal(evalCondition('similar("北塔")', () => undefined, { similar: (c) => c.text === '北塔' }), true);
  assert.equal(evalCondition('similar()', () => undefined, {}), false);
});

test('占位符的函数写法：词条里求值，正文里失败时原样保留', () => {
  const look = (n: string) => ({ hp: 3 })[n as 'hp'];
  assert.equal(renderPlaceholders('HP {{hp}}，掷出 {{roll("1d6")}}，{{get("mp", "无")}}', look, true, { rand: () => 0 }), 'HP 3，掷出 1，无');
  assert.throws(() => renderPlaceholders('{{roll("x")}}', look, true, {}), PlaceholderError);
  assert.equal(renderPlaceholders('{{roll("x")}} {{hp}}', look, false, {}), '{{roll("x")}} 3');
  // 没给求值环境时不处理函数写法
  assert.equal(renderPlaceholders('{{get("hp")}}', look, false), '{{get("hp")}}');
});
