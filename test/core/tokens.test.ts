import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calibrate, chooseTokenizer, matchTokenizer, normalizeModelName, promptTotal, type TokenEstimate } from '../../src/core/tokens.ts';

const pick = (name: string, protocol: Parameters<typeof matchTokenizer>[1] = 'openai-chat') => matchTokenizer(name, protocol).profile.id;

test('模型名部分匹配：各种渠道的写法', () => {
  assert.equal(normalizeModelName(' Anthropic/Claude-Opus-4.7:beta '), 'claude-opus-4.7');
  const cases: [string, string][] = [
    ['claude-3-5-sonnet-20241022', 'claude-legacy'],
    ['anthropic.claude-3-5-sonnet-20240620-v1:0', 'claude-legacy'],
    ['claude-sonnet-4-5-20250929', 'claude-legacy'],
    ['claude-opus-4-6', 'claude-legacy'],
    ['claude-opus-4', 'claude-legacy'],
    ['anthropic/claude-opus-4.7', 'claude-new'],
    ['claude-opus-4-7@20260416', 'claude-new'],
    ['claude-opus-5-5', 'claude-new'],
    ['claude-4.5-sonnet', 'claude-legacy'],
    ['claude-fable-5-1', 'claude-new'],
    ['openai/gpt-4o-mini', 'openai-o200k'],
    ['gpt-5.1-chat-latest', 'openai-o200k'],
    ['o3-mini', 'openai-o200k'],
    ['gpt-oss-120b', 'openai-o200k'],
    ['gpt-4-turbo', 'openai-cl100k'],
    ['gpt-3.5-turbo', 'openai-cl100k'],
    ['models/gemini-2.5-pro', 'gemini-2'],
    ['google/gemini-3.1-flash-lite', 'gemini-3'],
    ['gemini-exp-1206', 'gemini-3'],
    ['gemma-3-27b-it', 'gemma'],
    ['deepseek-ai/DeepSeek-R1', 'deepseek-v3'],
    ['deepseek-chat', 'deepseek-v4'],
    ['Qwen/Qwen3-235B-A22B', 'qwen'],
    ['meta-llama/llama-3.3-70b-instruct', 'llama'],
    ['mistral-large-latest', 'mistral'],
    ['glm-4.6', 'reference'],
    ['moonshotai/kimi-k2', 'reference'],
    ['llama-3.1-nemotron-70b', 'llama'],
  ];
  for (const [name, want] of cases) assert.equal(pick(name), want, name);
});

test('没匹配到时按协议兜底；手动指定优先', () => {
  assert.equal(pick('my-deployment', 'claude'), 'claude-new');
  assert.equal(pick('my-deployment', 'gemini'), 'gemini-3');
  assert.equal(pick('my-deployment', 'openai-responses'), 'openai-o200k');
  assert.equal(pick('my-deployment', 'openai-chat'), 'reference');
  const c = chooseTokenizer({ model: 'gpt-4o', protocol: 'openai-chat', tokenizer: 'qwen' });
  assert.equal(c.profile.id, 'qwen');
  assert.equal(c.auto, false);
  assert.equal(chooseTokenizer({ model: 'gpt-4o', protocol: 'openai-chat', tokenizer: 'auto' }).profile.id, 'openai-o200k');
});

test('校准：同模型同分词器的最近几条，实际总和 / 预估总和；没有记录用默认系数', () => {
  const r = (raw: number, actual: number | undefined, model = 'm', tokenizer: TokenEstimate['tokenizer'] = 'claude-new'): TokenEstimate => ({
    model,
    tokenizer,
    raw,
    factor: 1,
    ...(actual === undefined ? {} : { actual }),
  });
  assert.deepEqual(calibrate([], 'm', 'claude-new'), { factor: 1.3, samples: 0 });
  const c = calibrate([r(1000, 1200), undefined, r(1000, undefined), r(500, 999, 'other'), r(1000, 1400), r(100, 100, 'm', 'claude-legacy')], 'm', 'claude-new');
  assert.equal(c.samples, 2);
  assert.equal(c.factor, 1.3);
  // 只取最近 5 条
  const many = [...Array(5).fill(r(100, 110)), r(100, 900)];
  assert.equal(calibrate(many, 'm', 'claude-new').factor, 1.1);
  // 离谱的值被限制在范围内
  assert.equal(calibrate([r(100, 10000)], 'm', 'claude-new').factor, 2.5);
});

test('实际输入：Claude 要加上缓存部分', () => {
  assert.equal(promptTotal({ input: 10, cacheRead: 1000, cacheWrite: 50 }, 'claude'), 1060);
  assert.equal(promptTotal({ input: 1060, cacheRead: 1000 }, 'openai-chat'), 1060);
  assert.equal(promptTotal({ output: 3 } as never, 'gemini'), undefined);
});

test('接口类型优先：Claude / Gemini / Responses 接口直接决定，OpenAI Chat 仍看模型名', () => {
  const pr = (model: string, protocol: Parameters<typeof matchTokenizer>[1]) => chooseTokenizer({ model, protocol }, 'protocol').profile.id;
  assert.equal(pr('my-azure-deployment', 'claude'), 'claude-new');
  assert.equal(pr('claude-sonnet-4-5', 'claude'), 'claude-legacy');
  assert.equal(pr('deepseek-chat', 'claude'), 'claude-new'); // 模型名优先时会是 deepseek-v4
  assert.equal(chooseTokenizer({ model: 'deepseek-chat', protocol: 'claude' }, 'name').profile.id, 'deepseek-v4');
  assert.equal(pr('gemini-2.5-pro', 'gemini'), 'gemini-2');
  assert.equal(pr('whatever', 'openai-responses'), 'openai-o200k');
  assert.equal(pr('qwen3-max', 'openai-chat'), 'qwen');
  // 手动指定仍然最优先
  assert.equal(chooseTokenizer({ model: 'x', protocol: 'claude', tokenizer: 'qwen' }, 'protocol').profile.id, 'qwen');
});
