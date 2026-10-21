import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evalCondition } from '../../src/core/expr.ts';
import { detectKind, importCard, importWorldbook } from '../../src/core/import/card.ts';
import { convertMacros, macroReasons, noteMacros } from '../../src/core/import/macros.ts';
import { cardFromPng, isPng, pngTexts, stripPngTexts } from '../../src/core/import/png.ts';
import { checkDoc } from '../../src/core/library.ts';
import { mentionedIn } from '../../src/core/mention.ts';

import { fakePng } from '../fixtures/png.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

test('PNG：优先读 V3（ccv3），其次 V2（chara）；存头像时去掉卡片数据', () => {
  const png = fakePng({ chara: b64('{"name":"v2"}'), ccv3: b64('{"name":"v3 中文"}'), Software: 'x' });
  assert.ok(isPng(png));
  assert.deepEqual(cardFromPng(png), { name: 'v3 中文' });
  assert.deepEqual(cardFromPng(fakePng({ chara: b64('{"name":"v2"}') })), { name: 'v2' });
  const stripped = stripPngTexts(png, ['chara', 'ccv3']);
  assert.deepEqual([...pngTexts(stripped).keys()], ['Software']);
  assert.throws(() => cardFromPng(fakePng({})), /没有角色卡数据/);
});

test('宏：能对上的换成占位符，其他的列出来', () => {
  const r = convertMacros('<USER> 和 <BOT>，{{User}}，{{time}}{{// 注释}}，{{random::a::b}}，{{getvar::hp}}，{{ persona }}');
  assert.equal(r.text, '{{user}} 和 {{char}}，{{user}}，{{$time}}，{{random("a", "b")}}，{{get("hp")}}，{{ persona }}');
  assert.deepEqual(r.unsupported, ['persona']);
});

test('宏：不是酒馆宏的 {{…}} 当作普通文字；会求值的地方转义，不停用', () => {
  const e = convertMacros('{{总属性}}=({{基础属性}}+{{附加属性}})，{{persona}}，{{foo::bar}}');
  assert.equal(e.text, '\\{{总属性}}=(\\{{基础属性}}+\\{{附加属性}})，{{persona}}，{{foo::bar}}');
  assert.equal(e.literals, 3);
  const notes: string[] = [];
  noteMacros(notes, e, 'entry');
  assert.ok(notes.some((n) => n.includes('写成 \\{{…}}')));
  assert.deepEqual(e.unsupported, ['persona', 'foo']);
  const d = convertMacros('<b>{{总属性}}</b>', 'display');
  assert.deepEqual([d.text, d.unsupported.length], ['<b>{{总属性}}</b>', 0]);
});

test('宏转换器：读变量、随机、最近消息、改变量，按所在位置处理', () => {
  const src = '{{getglobalvar::金币}}|{{pick::甲::乙}}|{{random:a,b}}|{{roll:1d20}}|{{roll::2d6+1}}|{{lastUserMessage}}|{{newline}}|{{noop}}|{{isodate}}';
  const e = convertMacros(src, 'entry');
  assert.equal(e.text, '{{get("金币")}}|{{pick("甲", "乙")}}|{{random("a", "b")}}|{{roll("1d20")}}|{{roll("2d6+1")}}|{{$lastUserMessage}}|\n||{{$date}}');
  assert.equal(e.globals, true);
  assert.deepEqual([e.unsupported, e.writes, e.dynamic], [[], [], []]);

  // 改变量：词条里不行，开场白和返回时正则里变成编辑块
  const w = '{{setvar::hp::100}}{{addvar::背包::铜镜}}{{incvar::回合}}{{decvar::回合}}';
  assert.deepEqual(convertMacros(w, 'entry').writes, ['setvar', 'addvar', 'incvar', 'decvar']);
  assert.equal(macroReasons(convertMacros(w, 'entry'), 'entry').length, 1);
  const g = convertMacros(w, 'greeting');
  assert.equal(
    g.text,
    '<var>\nhp = 100\n</var>' +
      '<var>\nif has("背包")\n背包 += "铜镜"\nelse\n背包 = "铜镜"\nend\n</var>' +
      '<var>\nif has("回合")\n回合 += 1\nelse\n回合 = 1\nend\n</var>' +
      '<var>\nif has("回合")\n回合 -= 1\nelse\n回合 = -1\nend\n</var>',
  );
  assert.equal(g.editBlocks, 4);
  // 返回时正则里，值只是捕获组引用时不加引号（替换后就是数字）
  assert.equal(convertMacros('{{setvar::hp::$1}}{{setvar::名字::$2 先生}}', 'receive').text, '<var>\nhp = $1\n</var><var>\n名字 = "$2 先生"\n</var>');
  // 返回时 / 显示用的正则里不能读变量、抽随机数
  assert.deepEqual(convertMacros('{{getvar::hp}}{{random::a::b}}', 'receive').dynamic, ['getvar', 'random']);
  assert.match(macroReasons(convertMacros('{{getvar::hp}}', 'display'), 'display')[0]!, /组件/);
  // 名字不合规、嵌套的宏：不支持
  assert.deepEqual(convertMacros('{{setvar::my var::1}}', 'greeting').unsupported, ['setvar']);
  assert.deepEqual(convertMacros('{{setvar::a::{{getvar::b}}}}', 'greeting').unsupported, ['setvar']);
});

test('V2 角色卡：字段、内嵌世界书、正则、停用原因都对', () => {
  const json = fixture('st-card-v2.json');
  assert.equal(detectKind(json), 'card');
  const { character: c, worldbook: wb, reports } = importCard(json);
  const [cr, wr] = reports;

  const byName = new Map(c.entries.map((e) => [e.name, e]));
  assert.equal(byName.get('角色设定')!.content, '{{char}} is the owner of the Rain Lamp tavern. {{user}} is a regular.\n\nteasing, attentive');
  assert.equal(byName.get('场景')!.content, 'A rainy night at the tavern. Today is {{$weekday}}.');
  assert.equal(byName.get('对话示例')!.priority, 500);
  assert.equal(byName.get('卡片系统提示')!.enabled, false);
  assert.equal(byName.get('卡片历史后指令')!.enabled, false);
  const note = byName.get('角色备注')!;
  assert.deepEqual([note.role, note.placement], ['user', { kind: 'position', section: 'chat', depth: 3 }]);
  assert.equal(c.greeting, '*She looks up.* Welcome back, {{user}}.');
  assert.equal(c.alternateGreetings.length, 2);
  assert.deepEqual(c.tags, ['fantasy', 'tavern']);
  assert.ok(!cr!.notes.some((n) => n.includes('Rain Lamp Lore'))); // 有内嵌世界书时，world 指的就是它

  // 正则
  const sc = new Map(c.scripts.map((s) => [s.name, s]));
  assert.deepEqual([sc.get('Hide thoughts')!.stage, sc.get('Hide thoughts')!.target, sc.get('Hide thoughts')!.enabled], ['runtime', 'display', true]);
  assert.deepEqual([sc.get('Damage')!.stage, sc.get('Damage')!.replacement], ['receive', '<var>hp -= $1</var>']);
  assert.equal(sc.get('Broken')!.enabled, false);
  assert.equal(sc.get('Broken')!.replacement, '$&');
  assert.equal(sc.get('WI only')!.enabled, false);
  assert.ok(sc.get('Hide thoughts')!.priority > sc.get('Damage')!.priority);
  assert.ok(cr!.disabled.some((d) => d.name === '正则：Broken'));

  // 世界书
  assert.equal(wb!.name, 'Rain Lamp Book');
  const w = new Map(wb!.entries.map((e) => [e.name, e]));
  assert.equal(w.get('Lighthouse')!.priority, 5899);
  assert.equal(w.get('Lighthouse')!.if, 'mentioned(2, "lighthouse", "Oswin")');
  assert.equal(w.get('City')!.priority, 1949);
  assert.equal(w.get('City')!.if, undefined);
  const storm = w.get('Storms')!;
  assert.equal(storm.if, 'mentioned(5, "storm") && !mentioned(5, "ship", "boat")');
  assert.deepEqual([storm.role, storm.placement, storm.enabled], ['user', { kind: 'position', section: 'chat', depth: 2 }, true]);
  assert.equal(storm.content, 'Storms sink ships here. {{random("a", "b")}}');
  assert.equal(w.get('Orphan')!.enabled, false);
  assert.equal(w.get('Outlet')!.enabled, false);
  assert.deepEqual(wr!.disabled.map((d) => d.name).sort(), ['Orphan', 'Outlet']);
  assert.ok(wr!.notes.some((n) => n.includes('触发概率')));

  // 转换后的 IF 都能求值
  const ctx = { mentioned: mentionedIn(['A storm is coming', 'The lighthouse keeper waves']) };
  assert.equal(evalCondition(w.get('Lighthouse')!.if!, () => undefined, ctx), true);
  assert.equal(evalCondition(storm.if!, () => undefined, ctx), true);

  // 草稿能通过完整校验
  const entries = c.entries.map((e, i) => ({ ...e, id: `char9-${i + 1}` }));
  const scripts = c.scripts.map((s, i) => ({ ...s, id: `char9-s${i + 1}` }));
  checkDoc('character', { ...c, id: 'char9', entries, scripts, avatar: null });
});

test('独立的世界书 JSON：位置、次要关键词逻辑、正则关键词、原本停用的', () => {
  const json = fixture('st-world.json');
  assert.equal(detectKind(json), 'worldbook');
  const { worldbook, report } = importWorldbook(json, '雾港');
  assert.equal(worldbook.name, '雾港');
  const w = new Map(worldbook.entries.map((e) => [e.name, e]));
  assert.equal(w.get('艾琳')!.if, 'mentioned(2, "艾琳", "Eileen")');
  assert.equal(w.get('灯塔')!.if, 'mentioned(2, "灯塔") && mentioned(2, "夜") && mentioned(2, "雨")');
  assert.ok(w.get('灯塔')!.priority < w.get('艾琳')!.priority); // order 大的更靠后
  assert.equal(w.get('常驻')!.content, '这里终年下雨。现在是{{$time}}。');
  assert.equal(w.get('停用的')!.enabled, false);
  assert.equal(report.disabled.length, 0); // 原本就停用的不算
  const port = w.get('正则键')!;
  assert.deepEqual([port.role, port.placement], ['assistant', { kind: 'position', section: 'chat', depth: 1 }]);
  assert.equal(evalCondition(port.if!, () => undefined, { mentioned: mentionedIn(['去港湾看看']) }), true);
  // 向量触发 → similar()；有关键词时两者满足其一
  assert.deepEqual([w.get('向量')!.if, w.get('向量')!.enabled], ['similar(3)', true]);
  assert.equal(w.get('向量加关键词')!.if, 'similar(2) || (mentioned(2, "铁门"))');
  assert.ok(report.notes.some((n) => n.includes('similar()')));
  assert.equal(evalCondition('similar(3)', () => undefined, {}), false); // 没算好时不成立
  assert.throws(() => importWorldbook({ entries: {} }, 'x'), /没有条目/);
});

test('显示用正则替换出 HTML 时包成 ```html 组件块；请求用的、编辑块不包', () => {
  const html = '<div style="color:red">$1</div>';
  const card = {
    spec: 'chara_card_v2',
    data: {
      name: 'HTML Test',
      extensions: {
        regex_scripts: [
          { scriptName: 'Status', findRegex: '/<S>(.*?)<\/S>/g', replaceString: html, placement: [2], markdownOnly: true, promptOnly: false },
          { scriptName: 'Both', findRegex: '/<S>(.*?)<\/S>/g', replaceString: html, placement: [2], markdownOnly: true, promptOnly: true },
          { scriptName: 'Fenced', findRegex: '/x/g', replaceString: '```html\n<b>x</b>\n```', placement: [2], markdownOnly: true, promptOnly: false },
          { scriptName: 'Var', findRegex: '/\[DMG (\d+)\]/g', replaceString: '<var>hp -= $1</var>', placement: [2], markdownOnly: true, promptOnly: false },
        ],
      },
    },
  };
  const { character: c, reports } = importCard(card);
  const sc = new Map(c.scripts.map((s) => [s.name, s.replacement]));
  assert.equal(sc.get('Status'), '```html\n' + html + '\n```');
  assert.equal(sc.get('Both'), html);
  assert.equal(sc.get('Fenced'), '```html\n<b>x</b>\n```');
  assert.equal(sc.get('Var'), '<var>hp -= $1</var>');
  assert.ok(reports[0]!.notes.some((n) => n.includes('1 条显示用正则替换出的是 HTML')));
});
