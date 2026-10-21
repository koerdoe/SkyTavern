import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receiveMessage, runScripts, validateScript, type RegexScript } from '../../src/core/scripts.ts';
import { checkOps, extractVarBlocks, formatOps, parseInitialVars, parseOpLines, replay } from '../../src/core/vars.ts';

test('编辑块：合法操作取出，编辑块从正文删掉；不合法的行不生效并记错误', () => {
  const r = extractVarBlocks('她笑了。\n<var>\nhp -= 5\ngold += 10.5\nlocation = "酒馆"\nmood = \'好\'\n// 注释\nbad line\n</var>\n');
  assert.equal(r.text, '她笑了。');
  assert.deepEqual(
    r.ops.map((o: any) => [o.name, o.op, o.value]),
    [
      ['hp', '-=', 5],
      ['gold', '+=', 10.5],
      ['location', '=', '酒馆'],
      ['mood', '=', '好'],
    ],
  );
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0]!.text, 'bad line');
});

test('编辑块单独成行时整行删掉，段落不被合并；嵌在句中时只删编辑块', () => {
  assert.equal(extractVarBlocks('第一段。\n\n<var>hp -= 1</var>\n\n第二段。').text, '第一段。\n\n第二段。');
  assert.equal(extractVarBlocks('正文。\n\n<var>hp -= 1</var>').text, '正文。');
  assert.equal(extractVarBlocks('第一段。\n<var>\nhp -= 1\n</var>\n第二段。').text, '第一段。\n第二段。');
  assert.equal(extractVarBlocks('他说<var>x = 1</var>好。').text, '他说好。');
});

test('编辑块：多个都生效；没闭合的留在正文里', () => {
  const r = extractVarBlocks('a<var>x = 1</var>b<var>y = 2</var>c<var>z = 3');
  assert.equal(r.text, 'abc<var>z = 3');
  assert.deepEqual(r.ops.map((o: any) => o.name), ['x', 'y']);
});

test('操作格式：保留名、名称和值的写法', () => {
  const { errors } = parseOpLines('char = "x"\n$time = 1\nname = 艾琳\n1a = 2\nhp = 1 2', 'block');
  assert.deepEqual(
    errors.map((e) => e.line),
    [1, 2, 4, 5],
  );
  // 不带引号的文字现在按算式理解（读变量“艾琳”），重放时变量不存在会提示加引号
  const r = parseOpLines('name = 艾琳', 'block');
  assert.equal((r.ops[0] as any).expr, '艾琳');
  assert.match(replay({}, [{ messageId: 'm', ops: r.ops }]).warnings[0]!.message, /要加引号/);
  assert.equal(parseOpLines('好感.艾琳 += 3', 'block').ops[0]!['name' as never], '好感.艾琳');
  // += 文字在解析时是合法的（文字拼接），类型在重放时检查
  assert.equal(parseOpLines('hp += "a"', 'block').errors.length, 0);
});

test('列表与对象：可以跨行、字段名不加引号、允许末尾逗号和注释', () => {
  const r = parseOpLines(
    [
      '商品.灵泉水 = {',
      '  价格: 30, // 金币',
      "  货币: '金币',",
      '  标签: ["饮品", "恢复"],',
      '}',
      '背包 = []',
      'ok = true',
      '坏 = { a: 1 b: 2 }',
      'hp -= 1',
    ].join('\n'),
    'block',
  );
  assert.deepEqual(
    r.ops.map((o: any) => [o.name, o.op, o.value]),
    [
      ['商品.灵泉水', '=', { 价格: 30, 货币: '金币', 标签: ['饮品', '恢复'] }],
      ['背包', '=', []],
      ['ok', '=', true],
      ['hp', '-=', 1],
    ],
  );
  assert.deepEqual(r.lines, [1, 6, 7, 9]);
  assert.deepEqual(r.errors.map((e) => e.line), [8]);
  // 写回再解析得到相同的值
  assert.deepEqual(parseOpLines(formatOps(r.ops), 'manual').ops, r.ops.map((o: any) => ({ ...o, source: 'manual' })));
});

test('路径操作：赋值自动建立对象，列表追加与删除，对象合并与删字段', () => {
  const ops = (t: string) => parseOpLines(t, 'block').ops;
  const init = { 背包: ['草药'], 商品: { 灵泉水: { 价格: 30, 库存: 5 } } };
  const r = replay(init, [
    {
      messageId: 'a',
      ops: ops(
        [
          '商品.灵泉水.库存 -= 2',
          '商品.火种 = { 价格: 80, 库存: 1 }',
          '背包 += "灵泉水"',
          '背包 += "灵泉水"',
          '背包 -= "草药"',
          '钱包.金币 = 100',
          '商品.灵泉水 += { 描述: "清心" }',
        ].join('\n'),
      ),
    },
    {
      messageId: 'b',
      ops: ops(
        [
          '商品 -= "火种"',
          '背包.0 = "灵泉水·满"',
          '背包.5 = "x"',
          '背包 -= "不存在"',
          '商品.灵泉水.价格 = "贵"',
          '商品.灵泉水.库存.x = 1',
          '任务 += 1',
          '新.路径 += 1',
        ].join('\n'),
      ),
    },
  ], true);
  assert.deepEqual(r.final, {
    背包: ['灵泉水·满', '灵泉水'],
    商品: { 灵泉水: { 价格: 30, 库存: 3, 描述: '清心' } },
    钱包: { 金币: 100 },
  });
  assert.deepEqual(r.warnings.map((w) => w.index), [2, 3, 4, 5, 6, 7]);
  // 初始值和上一层的快照没有被改动
  assert.deepEqual(init.商品.灵泉水, { 价格: 30, 库存: 5 });
  assert.deepEqual(r.states![0]!['背包'], ['灵泉水', '灵泉水']);
  assert.ok('火种' in (r.states![0]!['商品'] as object));
});

test('重放：第一次赋值决定类型；不存在的变量不能 +=；不合法的跳过并记警告', () => {
  const ops = (t: string) => parseOpLines(t, 'block').ops;
  const r = replay({ hp: 100 }, [
    { messageId: 'a', ops: ops('hp -= 30\nname = "艾琳"') },
    { messageId: 'b', ops: ops('gold += 5\nname = 3\nhp += 5') },
  ], true);
  assert.deepEqual(r.final, { hp: 75, name: '艾琳' });
  assert.deepEqual(r.states, [{ hp: 70, name: '艾琳' }, { hp: 75, name: '艾琳' }]);
  assert.deepEqual(r.warnings.map((w) => [w.messageId, w.index]), [
    ['b', 0],
    ['b', 1],
  ]);
});

test('初始变量只允许 =，错误带行号；操作可以写回文本', () => {
  const r = parseInitialVars('hp = 100\n\nhp += 1\nname = "x"');
  assert.deepEqual(r.state, { hp: 100, name: 'x' });
  assert.deepEqual(r.errors.map((e) => e.line), [3]);
  const round = parseOpLines(formatOps(parseOpLines('a += 1\nb = "引号\\"里"', 'manual').ops), 'manual').ops;
  assert.deepEqual(round.map((o: any) => o.value), [1, '引号"里']);
});

test('客户端提交的操作要校验', () => {
  assert.deepEqual(checkOps([{ name: 'hp', op: '-=', value: 3 }], 'widget'), [{ name: 'hp', op: '-=', value: 3, source: 'widget' }]);
  assert.throws(() => checkOps([{ name: 'user', op: '=', value: 'x' }], 'widget'), /保留名/);
  assert.throws(() => checkOps([{ name: 'hp', op: '*=', value: 3 }], 'widget'), /只能是/);
  assert.throws(() => checkOps([{ name: 'hp', op: '=', value: Infinity }], 'widget'), /值应为/);
  assert.throws(() => checkOps([{ name: 'hp', op: '=', value: null }], 'widget'), /值应为/);
  assert.throws(() => checkOps([{ name: 'a..b', op: '=', value: 1 }], 'widget'), /不合法/);
  assert.deepEqual((checkOps([{ name: '商品.灵泉水', op: '=', value: { 价格: 3, 标签: ['x'] } }], 'widget')[0] as any).value, { 价格: 3, 标签: ['x'] });
});

const script = (over: Partial<RegexScript>): RegexScript => ({
  id: 'p-s1',
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

test('返回时正则：按优先级执行，作用角色由脚本决定；执行完再取编辑块', () => {
  const scripts = [
    script({ id: 'a', pattern: '【伤害(\\d+)】', replacement: '<var>hp -= $1</var>', priority: 1 }),
    script({ id: 'b', pattern: '<var>', replacement: '<var>\n', priority: 0 }),
    script({ id: 'u', pattern: '/加钱(\\d+)\\s*', replacement: '<var>gold += $1</var>', roles: ['user'] }),
  ];
  const a = receiveMessage('被砍了【伤害12】又被砍【伤害3】', 'assistant', scripts);
  assert.equal(a.text, '被砍了又被砍');
  assert.deepEqual(a.ops.map((o: any) => o.value), [12, 3]);
  // 用户消息只跑作用于 user 的脚本
  const u = receiveMessage('/加钱50 买酒', 'user', scripts);
  assert.equal(u.text, '买酒');
  assert.deepEqual(u.ops.map((o: any) => [o.name, o.value]), [['gold', 50]]);
});

test('运行时正则：按显示 / 请求分开；不带 g 只替换第一处', () => {
  const scripts = [
    script({ id: 'd', stage: 'runtime', target: 'display', pattern: '\\*', replacement: '', roles: ['user', 'assistant'] }),
    script({ id: 'r', stage: 'runtime', target: 'request', pattern: 'x', flags: '', replacement: 'Y' }),
  ];
  assert.equal(runScripts('*x* x', 'assistant', scripts, { stage: 'runtime', target: 'display' }), 'x x');
  assert.equal(runScripts('*x* x', 'assistant', scripts, { stage: 'runtime', target: 'request' }), '*Y* x');
  assert.equal(runScripts('*x*', 'user', scripts, { stage: 'runtime', target: 'request' }), '*x*');
  // 禁用的不执行
  assert.equal(runScripts('*', 'user', [{ ...scripts[0]!, enabled: false }], { stage: 'runtime', target: 'display' }), '*');
});

test('正则脚本的静态检查', () => {
  assert.throws(() => validateScript(script({ pattern: '(a)', replacement: '$2' })), /不存在的捕获组/);
  assert.throws(() => validateScript(script({ pattern: '(' })), /无法编译/);
  assert.throws(() => validateScript(script({ pattern: 'a', flags: 'y' })), /标志/);
  assert.throws(() => validateScript(script({ pattern: 'a', roles: [] })), /至少/);
});

test('固定插入：插到开头 / 末尾，内容原样插入；正则可作条件；只作用于最新一条', async () => {
  const { latestChecker } = await import('../../src/core/scripts.ts');
  const widget = script({ id: 'w', stage: 'runtime', target: 'display', action: 'append', latestOnly: true, flags: '', replacement: '```html\n<b>${price}</b> $1\n```' });
  const head = script({ id: 'h', stage: 'runtime', target: 'display', action: 'prepend', pattern: '营业', flags: '', replacement: '【公告】' });
  validateScript(widget);
  validateScript(head);
  const latest = latestChecker(['assistant', 'user', 'assistant', 'user']);
  const show = (text: string, i: number) => runScripts(text, 'assistant', [widget, head], { stage: 'runtime', target: 'display', isLatest: latest(i) });
  assert.equal(show('第二条，营业中', 2), '【公告】\n\n第二条，营业中\n\n```html\n<b>${price}</b> $1\n```');
  assert.equal(show('第一条', 0), '第一条');
  // 不给 isLatest（试运行）时当作最新
  assert.equal(runScripts('', 'assistant', [widget], { stage: 'runtime', target: 'display' }), '```html\n<b>${price}</b> $1\n```');
  // 替换必须写正则
  assert.throws(() => validateScript(script({ pattern: '' })), /需要填写正则/);
});

test('算式赋值与分支：按重放时的状态求值；初始变量不能用；可以写回文本', () => {
  const text = [
    'hp -= 伤害 * 2',
    'if hp <= 0',
    '  状态 = "倒下"',
    'elif hp < 30 // 注释',
    '  状态 = "重伤"',
    '  if has("护盾")',
    '    护盾 -= 1',
    '  end',
    'else',
    '  状态 = "正常"',
    'end',
    '上次伤害 = 伤害 * 2',
  ].join('\n');
  const r = parseOpLines(text, 'block');
  assert.deepEqual(r.errors, []);
  assert.equal(r.ops.length, 3);
  assert.deepEqual(r.lines, [1, 2, 12]);
  const run = (init: Record<string, any>) => replay(init, [{ messageId: 'm', ops: r.ops }]);
  assert.deepEqual(run({ hp: 100, 伤害: 40, 护盾: 2 }).final, { hp: 20, 伤害: 40, 护盾: 1, 状态: '重伤', 上次伤害: 80 });
  assert.deepEqual(run({ hp: 10, 伤害: 10 }).final, { hp: -10, 伤害: 10, 状态: '倒下', 上次伤害: 20 });
  assert.equal(run({ hp: 100, 伤害: 1 }).final.状态, '正常');
  // 算式出错只记警告
  const w = run({ hp: 100 });
  assert.match(w.warnings[0]!.message, /伤害/);
  // 写回文本再解析，结果一样
  assert.deepEqual(parseOpLines(formatOps(r.ops), 'block').ops, r.ops);
  // 初始变量不能用算式和 if
  const init = parseInitialVars('a = 1\nb = a + 1\nif a\n  c = 1\nend');
  assert.deepEqual(init.errors.map((e) => e.line), [2, 3]);
  // 结构错误
  const bad = parseOpLines('else\nif hp >\nend\nif 1\nx = 1', 'block');
  assert.deepEqual(bad.ops, []);
  assert.equal(bad.errors.length, 3);
  // 客户端提交的分支要校验
  assert.throws(() => checkOps([{ op: 'if', branches: [{ cond: null, ops: [] }, { cond: 'a', ops: [] }] }], 'manual'), /else/);
  assert.throws(() => checkOps([{ name: 'a', op: '=', expr: '1 +' }], 'manual'), /算式/);
  assert.equal((checkOps([{ name: 'a', op: '=', expr: 'b * 2' }], 'widget')[0] as any).expr, 'b * 2');
});
