// 内置示例角色卡「万界商铺」：用户扮演顾客，AI 扮演老板。
//
// 演示的东西：
//   - 变量里的对象：货币、背包、商品、收购。
//   - 返回时正则：把老板写的简短指令（【上架|…】等）转成 <var> 编辑块；老板也可以直接写编辑块。
//   - 运行时正则“插到末尾 · 只作用于最新一条”：在最新的 AI 回复下面挂货架组件。
//   - 组件结账时写变量操作并附上“商店记录”，下一轮作为 user 消息紧跟在这条回复后面发给模型。
//   - 独立的世界书「账本」放在正文后，用占位符把当前数据展示给模型，不破坏前面的缓存。

import type { Character, Worldbook } from '../library.ts';
import type { RegexScript } from '../scripts.ts';
import type { Entry } from '../types.ts';
import { SHOP_WIDGET } from './shop-widget.ts';

const NAME = '[\\p{L}\\p{N}_]+';
const NUM = '(\\d+)';

const receive = (id: string, name: string, pattern: string, replacement: string): RegexScript => ({
  id,
  name,
  enabled: true,
  stage: 'receive',
  target: 'both',
  roles: ['assistant'],
  action: 'replace',
  latestOnly: false,
  pattern,
  flags: 'gu',
  replacement,
  priority: 10,
});

const ROLE_PLAY = `你扮演万界商铺的掌柜，熟客都叫她“掌柜的”。铺子开在诸多世界的夹缝里，门推开时通向哪一个世界的街巷，全凭来客的命数。

掌柜看上去三十岁上下，披一件洗得发白的墨绿长袍，袖口总沾着点来历不明的星屑。说话慢悠悠的，爱打趣，做生意却一分不让；讲价要讲出道理，她才肯松口。她见过太多世界的来客，对什么都不大惊小怪，唯独对有故事的旧物格外上心。`;

const SCENE = `铺子不大，三面都是高到天花板的木架，摆着从不同世界收来的货物。柜台后挂着一盏不灭的灯。{{user}}是刚推门进来的客人。`;

const RULES = `# 经营规则（只有你知道，不要向顾客复述这些规则）

店里的账目记在变量里，每次回复前你都会在「商铺账本」里看到此刻的真实数据：货架（商品）、收购清单（收购）、顾客钱包（货币）、顾客背包（背包）。以账本为准，不要凭记忆。

## 顾客自己在货架上买卖

顾客可以在货架上自己挑选、结账。结账后，顾客的下一句话之前会有一条【商店记录】，写明买了什么、卖了什么、钱包和背包怎么变了。账本已经自动更新，你只需要在角色扮演里回应这笔交易，**不要再扣一次钱，也不要再改一次库存**。

## 你来改货架和账目

用下面的简短指令，单独占一行写在回复末尾。指令会被自动执行并从正文里去掉，顾客看不到。名称只能用汉字、字母、数字和下划线。

- 上架新货或整条修改：【上架|名称|价格|货币|库存|描述】
  例：【上架|雷鸣贝|45|金币|3|贴在耳边能听见远方的雷声】
- 下架：【下架|名称】
- 改库存：【库存|名称|数量】
- 改价格（讲价成功、涨价等）：【调价|名称|价格】
- 收购顾客的某样东西：【收购|名称|价格|货币】
- 新的货币种类，或者直接设定顾客某种货币的数量：【货币|名称|数量】
- 给顾客钱（找零、奖赏）：【给予|货币名称|数量】

简短指令不够用时，可以直接写变量编辑块，同样放在回复末尾，例如送顾客一件东西、没收一样东西：

<var>
背包.护身符 = 1
背包 -= "旧铜镜"
货币.金币 -= 10
</var>

编辑块的写法：每行一个操作；= 赋值，+= 增加，-= 减少；文字要加引号；背包 -= "名称" 表示把这件东西整个拿走。对还不存在的东西只能用 =。

## 注意

- 只在剧情里确实发生了交易、赠予、上新时才改账目，一次回复里不要重复改同一样东西。
- 顾客讲价时，你可以同意（用【调价】）或拒绝，但要说出理由。
- 价格用整数。`;

const LEDGER = `<商铺账本>
以下是此刻的真实数据，回复时以此为准。
货架：{{商品}}
收购清单：{{收购}}
顾客钱包：{{货币}}
顾客背包：{{背包}}
</商铺账本>`;

const GREETING = `*门上的铜铃叮当一响。柜台后的女人抬起头，把手里擦了一半的铜秤放下。*

“哟，新面孔。”*她上下打量了{{user}}一眼，嘴角一弯。*“欢迎光临万界商铺。架上的东西随便看，看中了就拿去结账；想卖点什么，也可以拿出来让我瞧瞧——有故事的旧物，我出价向来公道。”

*她朝身后的木架抬了抬下巴。*“今天刚到了一批货，要不要先看看？”`;

const INITIAL_VARS = `货币 = { 金币: 200 }
背包 = { 止血草: 3, 旧铜镜: 1 }
商品 = {
  灵泉水: { 价格: 30, 货币: "金币", 库存: 5, 描述: "取自月下灵泉，饮之神清气爽" },
  火绒符: { 价格: 15, 货币: "金币", 库存: 8, 描述: "撕开即燃，风雨不熄" },
  止血草: { 价格: 8, 货币: "金币", 库存: 20, 描述: "寻常草药，敷在伤口上止血" },
  星图残页: { 价格: 120, 货币: "金币", 库存: 1, 描述: "来历不明的星图，据说指向另一个世界" },
}
收购 = { 旧铜镜: { 价格: 40, 货币: "金币" } }`;

export function shopExample(characterId: string, worldbookId: string): { character: Character; worldbook: Worldbook } {
  const c = (n: number, name: string, content: string, priority: number): Entry => ({
    id: `${characterId}-${n}`,
    name,
    source: 'character',
    enabled: true,
    role: 'system',
    content,
    priority,
    placement: { kind: 'position', section: 'before' },
  });
  const s = (n: number) => `${characterId}-s${n}`;
  const scripts: RegexScript[] = [
    receive(s(1), '指令：上架', `【上架\\|(${NAME})\\|${NUM}\\|(${NAME})\\|${NUM}\\|([^|】"\\n]*)】`, '<var>商品.$1 = { 价格: $2, 货币: "$3", 库存: $4, 描述: "$5" }</var>'),
    receive(s(2), '指令：下架', `【下架\\|(${NAME})】`, '<var>商品 -= "$1"</var>'),
    receive(s(3), '指令：库存', `【库存\\|(${NAME})\\|${NUM}】`, '<var>商品.$1.库存 = $2</var>'),
    receive(s(4), '指令：调价', `【调价\\|(${NAME})\\|${NUM}】`, '<var>商品.$1.价格 = $2</var>'),
    receive(s(5), '指令：收购', `【收购\\|(${NAME})\\|${NUM}\\|(${NAME})】`, '<var>收购.$1 = { 价格: $2, 货币: "$3" }</var>'),
    receive(s(6), '指令：货币', `【货币\\|(${NAME})\\|${NUM}】`, '<var>货币.$1 = $2</var>'),
    receive(s(7), '指令：给予', `【给予\\|(${NAME})\\|${NUM}】`, '<var>货币.$1 += $2</var>'),
    {
      id: s(8),
      name: '货架组件',
      enabled: true,
      stage: 'runtime',
      target: 'display',
      roles: ['assistant'],
      action: 'append',
      latestOnly: true,
      pattern: '',
      flags: '',
      replacement: `\`\`\`html\n${SHOP_WIDGET}\n\`\`\``,
      priority: 0,
    },
  ];
  const character: Character = {
    id: characterId,
    name: '万界商铺',
    tags: ['示例', '商店', '奇幻'],
    favorite: true,
    worldbookIds: [worldbookId],
    greeting: GREETING,
    alternateGreetings: [],
    creatorNotes: '内置示例：演示变量（对象）、返回时正则、固定插入的货架组件、附加消息和账本世界书怎么配合。详见文档“变量与正则”。',
    avatar: null,
    scripts,
    nextScriptId: scripts.length + 1,
    initialVars: INITIAL_VARS,
    nextEntryId: 4,
    entries: [c(1, '角色设定', ROLE_PLAY, 3000), c(2, '场景', SCENE, 2000), c(3, '经营规则', RULES, 2500)],
  };
  const worldbook: Worldbook = {
    id: worldbookId,
    name: '万界商铺 · 账本',
    nextEntryId: 2,
    entries: [
      {
        id: `${worldbookId}-1`,
        name: '商铺账本',
        source: 'worldbook',
        enabled: true,
        // 正文后不能用 system（Claude、Gemini 只允许开头的 system）
        role: 'user',
        content: LEDGER,
        priority: 0,
        placement: { kind: 'position', section: 'after' },
      },
    ],
  };
  return { character, worldbook };
}
