import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDoc, checkSettings, defaultLibrary, upgradeDoc } from '../../src/core/library.ts';

const base = { presetId: null, modelId: null, personaId: null, worldbookIds: [] };

test('旧版的一段自定义 CSS 转成一套风格并启用；风格校验', () => {
  const s = checkSettings({ ...base, ui: { customCss: 'body{color:red}' } });
  assert.deepEqual(s.ui.styles, [{ id: 'style1', name: '我的风格', css: 'body{color:red}' }]);
  assert.equal(s.ui.activeStyle, 'style1');
  assert.equal(s.tokenizerPriority, 'name');
  assert.deepEqual(checkSettings({ ...base, ui: { customCss: '  ' } }).ui.styles, []);
  // 指向不存在的风格时视为不用
  assert.equal(checkSettings({ ...base, ui: { styles: [{ id: 'a', name: '', css: '' }], activeStyle: 'b' } }).ui.activeStyle, null);
  assert.equal(checkSettings({ ...base, ui: { styles: [{ id: 'a', name: '', css: '' }], activeStyle: 'a' } }).ui.styles[0]!.name, '未命名风格');
  assert.throws(() => checkSettings({ ...base, ui: { styles: [{ id: 'a', name: 'x', css: '' }, { id: 'a', name: 'y', css: '' }] } }), /重复/);
  assert.throws(() => checkSettings({ ...base, tokenizerPriority: 'model' }), /tokenizerPriority/);
});

test('预设的裁剪轮数：默认 5，范围 1–50，旧数据补上', () => {
  const p = defaultLibrary().presets[0]!;
  assert.equal(p.trimRounds, 5);
  assert.equal(checkDoc('preset', { ...p, trimRounds: 12 }).trimRounds, 12);
  assert.throws(() => checkDoc('preset', { ...p, trimRounds: 0 }), /trimRounds/);
  const { trimRounds: _t, ...old } = p;
  assert.equal(upgradeDoc('preset', old as never).trimRounds, 5);
});
