// 万界商铺的货架组件：由角色卡里一条“运行时 · 显示 · 插到末尾 · 只作用于最新一条”的正则挂在最新的 AI 回复下面。
//
// 读取的变量：
//   货币 = { 金币: 200, … }                     顾客钱包
//   背包 = { 止血草: 3, … }                     顾客背包：物品 → 数量
//   商品 = { 灵泉水: { 价格, 货币, 库存, 描述 } } 货架
//   收购 = { 旧铜镜: { 价格, 货币 } }            老板额外收购的物品
// 结账时写下变量操作，并附上一条“商店记录”附加消息，下一轮发给模型。
//
// 注意：这段 HTML 放在 ```html 代码块里，脚本里不能出现连续三个反引号；
// 整段用 String.raw 包起来，脚本里不要用反引号和美元符加花括号。

export const SHOP_WIDGET = String.raw`<style>
  .shop { padding: 10px 12px; font-size: 13px; }
  .shop h4 { margin: 0; font-size: 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .wallet { display: flex; gap: 6px; flex-wrap: wrap; font-weight: 400; }
  .coin { background: var(--surface-2); border-radius: 999px; padding: 1px 8px; font-size: 12px; }
  .tabs { display: flex; gap: 4px; margin: 8px 0 6px; }
  .tabs button { border: 1px solid var(--border); background: transparent; color: var(--text-2); border-radius: 6px; padding: 3px 10px; cursor: pointer; font: inherit; }
  .tabs button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; align-items: center; padding: 6px 0; border-top: 1px dashed var(--border); }
  .name { font-weight: 600; }
  .desc { color: var(--text-2); font-size: 12px; }
  .meta { color: var(--text-2); font-size: 12px; white-space: nowrap; text-align: right; }
  .step { display: flex; align-items: center; gap: 4px; }
  .step button { width: 24px; height: 24px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); border-radius: 6px; cursor: pointer; font: inherit; line-height: 1; }
  .step button:disabled { opacity: .35; cursor: default; }
  .step span { min-width: 18px; text-align: center; font-variant-numeric: tabular-nums; }
  .empty { color: var(--text-2); padding: 8px 0; }
  .foot { border-top: 1px solid var(--border); margin-top: 6px; padding-top: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .sum { flex: 1; min-width: 160px; }
  .warn { color: #c0392b; font-size: 12px; }
  .ok { color: #2d7a4c; font-size: 12px; }
  .go { border: 0; background: var(--accent); color: #fff; border-radius: 6px; padding: 5px 14px; cursor: pointer; font: inherit; }
  .go:disabled { opacity: .4; cursor: default; }
  .ghost { border: 1px solid var(--border); background: transparent; color: var(--text-2); border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit; }
</style>
<div class="shop">
  <h4>万界商铺 · 货架 <span class="wallet" id="wallet"></span></h4>
  <div class="tabs"><button id="tab-buy" class="on">购买</button><button id="tab-sell">出售</button></div>
  <div id="list"></div>
  <div class="foot">
    <div class="sum" id="sum"></div>
    <button class="ghost" id="clear">清空</button>
    <button class="go" id="checkout">结账</button>
  </div>
</div>
<script>
  var state = { 货币: {}, 背包: {}, 商品: {}, 收购: {} };
  var cart = { buy: {}, sell: {} };
  var tab = 'buy';
  var flash = '';
  var $ = function (id) { return document.getElementById(id); };
  var obj = function (v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  // 老板收这件东西的价格：收购清单优先，其次是货架上的回收价，最后按售价的一半。
  function buyBack(name) {
    var special = obj(state.收购)[name];
    if (special && typeof special.价格 === 'number') return { 价格: special.价格, 货币: special.货币 || '金币' };
    var item = obj(state.商品)[name];
    if (!item || typeof item.价格 !== 'number') return null;
    var price = typeof item.回收价 === 'number' ? item.回收价 : Math.floor(item.价格 / 2);
    return { 价格: price, 货币: item.货币 || '金币' };
  }

  function goods() {
    var out = [];
    var all = obj(state.商品);
    for (var name in all) {
      var it = obj(all[name]);
      if (typeof it.价格 === 'number' && (it.库存 || 0) > 0) out.push({ name: name, it: it });
    }
    return out;
  }

  function sellables() {
    var out = [];
    var bag = obj(state.背包);
    for (var name in bag) {
      if (typeof bag[name] === 'number' && bag[name] > 0) out.push({ name: name, have: bag[name], back: buyBack(name) });
    }
    return out;
  }

  // 本次交易后各货币的变化（花出去为负、卖得的为正）
  function money() {
    var delta = {};
    var add = function (cur, n) { delta[cur] = (delta[cur] || 0) + n; };
    var all = obj(state.商品);
    for (var b in cart.buy) { var it = obj(all[b]); add(it.货币 || '金币', -it.价格 * cart.buy[b]); }
    for (var s in cart.sell) { var back = buyBack(s); if (back) add(back.货币, back.价格 * cart.sell[s]); }
    return delta;
  }

  function problems() {
    var out = [];
    var wallet = obj(state.货币);
    var d = money();
    for (var cur in d) {
      var have = typeof wallet[cur] === 'number' ? wallet[cur] : null;
      if (d[cur] < 0 && have === null) out.push('你没有' + cur);
      else if (have !== null && have + d[cur] < 0) out.push(cur + '不够（还差 ' + -(have + d[cur]) + '）');
    }
    return out;
  }

  function count(o) { var n = 0; for (var k in o) n += o[k]; return n; }

  function stepper(kind, name, max) {
    var n = cart[kind][name] || 0;
    return '<div class="step"><button data-k="' + kind + '" data-n="' + esc(name) + '" data-d="-1"' + (n <= 0 ? ' disabled' : '') + '>−</button>' +
      '<span>' + n + '</span><button data-k="' + kind + '" data-n="' + esc(name) + '" data-d="1"' + (n >= max ? ' disabled' : '') + '>+</button></div>';
  }

  function render() {
    var wallet = obj(state.货币);
    var w = '';
    for (var cur in wallet) w += '<span class="coin">' + esc(cur) + ' ' + wallet[cur] + '</span>';
    $('wallet').innerHTML = w || '<span class="coin">身无分文</span>';
    $('tab-buy').className = tab === 'buy' ? 'on' : '';
    $('tab-sell').className = tab === 'sell' ? 'on' : '';

    var html = '';
    if (tab === 'buy') {
      var g = goods();
      if (!g.length) html = '<div class="empty">货架空空如也。</div>';
      g.forEach(function (x) {
        html += '<div class="row"><div><div class="name">' + esc(x.name) + '</div><div class="desc">' + esc(x.it.描述 || '') + '</div></div>' +
          '<div class="meta">' + x.it.价格 + ' ' + esc(x.it.货币 || '金币') + '<br>余 ' + x.it.库存 + '</div>' + stepper('buy', x.name, x.it.库存) + '</div>';
      });
    } else {
      var s = sellables();
      if (!s.length) html = '<div class="empty">背包里没有东西。</div>';
      s.forEach(function (x) {
        html += '<div class="row"><div><div class="name">' + esc(x.name) + '</div><div class="desc">持有 ' + x.have + '</div></div>' +
          '<div class="meta">' + (x.back ? '收 ' + x.back.价格 + ' ' + esc(x.back.货币) : '老板不收') + '</div>' + stepper('sell', x.name, x.back ? x.have : 0) + '</div>';
      });
    }
    $('list').innerHTML = html;

    var d = money();
    var parts = [];
    for (var c in d) if (d[c]) parts.push(c + ' ' + (d[c] > 0 ? '+' : '') + d[c]);
    var errs = problems();
    var busy = count(cart.buy) + count(cart.sell) > 0;
    $('sum').innerHTML = busy
      ? '共 ' + count(cart.buy) + ' 件买入、' + count(cart.sell) + ' 件卖出' + (parts.length ? '：' + esc(parts.join('，')) : '') +
        (errs.length ? '<div class="warn">' + esc(errs.join('；')) + '</div>' : '')
      : flash ? '<span class="ok">' + esc(flash) + '</span>' : '<span class="desc">挑好了点结账。</span>';
    $('checkout').disabled = !busy || errs.length > 0;
    $('clear').style.display = busy ? '' : 'none';
  }

  async function load() {
    var v = await sky.vars();
    state = { 货币: obj(v.货币), 背包: obj(v.背包), 商品: obj(v.商品), 收购: obj(v.收购) };
    render();
  }

  async function checkout() {
    var ops = [];
    var lines = [];
    var all = obj(state.商品);
    var bag = obj(state.背包);
    var wallet = obj(state.货币);
    var bagDelta = {};
    var bought = [];
    var sold = [];
    for (var b in cart.buy) {
      var n = cart.buy[b];
      var it = obj(all[b]);
      ops.push({ name: '商品.' + b + '.库存', op: '-=', value: n });
      bagDelta[b] = (bagDelta[b] || 0) + n;
      bought.push(b + ' ×' + n + '（' + it.价格 * n + ' ' + (it.货币 || '金币') + '）');
    }
    for (var s in cart.sell) {
      var m = cart.sell[s];
      var back = buyBack(s);
      if (obj(all[s]).价格 !== undefined) ops.push({ name: '商品.' + s + '.库存', op: '+=', value: m });
      bagDelta[s] = (bagDelta[s] || 0) - m;
      sold.push(s + ' ×' + m + '（+' + back.价格 * m + ' ' + back.货币 + '）');
    }
    var d = money();
    var walletLines = [];
    for (var cur in d) {
      if (!d[cur]) continue;
      var had = typeof wallet[cur] === 'number' ? wallet[cur] : null;
      if (had === null) ops.push({ name: '货币.' + cur, op: '=', value: d[cur] });
      else ops.push({ name: '货币.' + cur, op: d[cur] > 0 ? '+=' : '-=', value: Math.abs(d[cur]) });
      walletLines.push(cur + ' ' + (had || 0) + ' → ' + ((had || 0) + d[cur]));
    }
    var bagLines = [];
    for (var name in bagDelta) {
      var delta = bagDelta[name];
      if (!delta) continue;
      var before = typeof bag[name] === 'number' ? bag[name] : 0;
      var after = before + delta;
      if (!(name in bag)) ops.push({ name: '背包.' + name, op: '=', value: after });
      else if (after <= 0) ops.push({ name: '背包', op: '-=', value: name });
      else ops.push({ name: '背包.' + name, op: delta > 0 ? '+=' : '-=', value: Math.abs(delta) });
      bagLines.push(name + ' ' + before + ' → ' + after);
    }
    lines.push('【商店记录】顾客刚在货架上自己完成了一笔交易，账本已经更新：');
    if (bought.length) lines.push('购买：' + bought.join('、'));
    if (sold.length) lines.push('出售：' + sold.join('、'));
    if (walletLines.length) lines.push('钱包：' + walletLines.join('，'));
    if (bagLines.length) lines.push('背包：' + bagLines.join('，'));

    ops.forEach(function (o) {
      if (o.op === '=') sky.set(o.name, o.value);
      else if (o.op === '+=') sky.add(o.name, o.value);
      else sky.sub(o.name, o.value);
    });
    sky.note(lines.join('\n'));
    $('checkout').disabled = true;
    try {
      await sky.commit();
      cart = { buy: {}, sell: {} };
      flash = '成交！记录会随你的下一句话一起交给老板。';
    } catch (e) {
      sky.discard();
      flash = '';
      $('sum').innerHTML = '<span class="warn">结账失败：' + esc(e.message) + '</span>';
      return;
    }
    await load();
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === 'tab-buy' || t.id === 'tab-sell') { tab = t.id === 'tab-buy' ? 'buy' : 'sell'; render(); return; }
    if (t.id === 'clear') { cart = { buy: {}, sell: {} }; render(); return; }
    if (t.id === 'checkout') { checkout(); return; }
    if (t.dataset && t.dataset.k) {
      var k = t.dataset.k, n = t.dataset.n;
      var next = (cart[k][n] || 0) + Number(t.dataset.d);
      if (next <= 0) delete cart[k][n]; else cart[k][n] = next;
      flash = '';
      render();
    }
  });

  load();
</script>`;
