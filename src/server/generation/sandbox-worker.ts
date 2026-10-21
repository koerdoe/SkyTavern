// 在 worker 线程里执行作者写的正则：组装请求、处理新进入会话的消息。
// 正则可能回溯失控，放在这里才能超时终止。

import { parentPort } from 'node:worker_threads';
import { buildRequest, type BuildInput } from '../../core/build.ts';
import { receiveMessage, ScriptError, type RegexScript } from '../../core/scripts.ts';
import { OrchestrationError, type Role, type VarValue } from '../../core/types.ts';
import { getPath } from '../../core/vars.ts';
import { loadTokenizer, messageCounter } from './tokenizer-pool.ts';

/** tokenizer：用哪个分词器包（@lenml/tokenizer-<pkg>）；没有时用粗略估算。 */
export type BuildJob = {
  kind: 'build';
  input: Omit<BuildInput, 'vars' | 'countTokens'> & { vars: Record<string, VarValue>; tokenizer?: string };
};
export type ReceiveJob = { kind: 'receive'; text: string; role: Role; scripts: RegexScript[] };
/** 预先加载分词器（第一次要零点几秒到两秒，不计入组装的超时）。 */
export type TokenizerJob = { kind: 'tokenizer'; pkg: string };
export type Job = BuildJob | ReceiveJob | TokenizerJob;

export type WireError = { code: string; detail: string; entryId: string | undefined } | { scriptId: string; detail: string } | { message: string };
export type WorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: WireError };

function run(job: Job): unknown {
  if (job.kind === 'receive') return receiveMessage(job.text, job.role, job.scripts);
  if (job.kind === 'tokenizer') return loadTokenizer(job.pkg);
  const { vars, tokenizer, ...input } = job.input;
  return buildRequest({ ...input, vars: (n) => getPath(vars, n), countTokens: messageCounter(tokenizer) });
}

parentPort!.on('message', ({ id, job }: { id: number; job: Job }) => {
  let reply: WorkerReply;
  try {
    reply = { id, ok: true, result: run(job) };
  } catch (e) {
    const error: WireError =
      e instanceof OrchestrationError
        ? { code: e.code, detail: e.detail, entryId: e.entryId }
        : e instanceof ScriptError
          ? { scriptId: e.scriptId, detail: e.detail }
          : { message: String((e as Error)?.message ?? e) };
    reply = { id, ok: false, error };
  }
  parentPort!.postMessage(reply);
});
