// 执行作者正则的沙箱：单个常驻 worker，任务依次执行；超时则终止该 worker 并重建。

import { Worker } from 'node:worker_threads';
import type { BuiltRequest } from '../../core/build.ts';
import { ScriptError, type Received } from '../../core/scripts.ts';
import { OrchestrationError, type OrchestrationErrorCode } from '../../core/types.ts';
import type { BuildJob, Job, ReceiveJob, WorkerReply } from './sandbox-worker.ts';
import type { LoadResult } from './tokenizer-pool.ts';

/** 加载分词器的时限（读几十 MB 的词表，慢机器上也够）。 */
const TOKENIZER_TIMEOUT_MS = 60_000;

export class Sandbox {
  private worker: Worker | undefined;
  private seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly timeoutMs: number;

  constructor(timeoutMs = 5000) {
    this.timeoutMs = timeoutMs;
  }

  /** 组装请求（运行时请求正则、插入法、IF、占位符都在里面）。 */
  build(input: BuildJob['input']): Promise<BuiltRequest> {
    return this.enqueue({ kind: 'build', input }) as Promise<BuiltRequest>;
  }

  /** 预先加载分词器；已加载时很快返回。失败时返回原因，组装会退回到粗略估算。 */
  loadTokenizer(pkg: string): Promise<LoadResult> {
    return this.enqueue({ kind: 'tokenizer', pkg }) as Promise<LoadResult>;
  }

  /** 消息进入会话：返回时正则 → 取出编辑块。 */
  receive(text: string, role: ReceiveJob['role'], scripts: ReceiveJob['scripts']): Promise<Received> {
    return this.enqueue({ kind: 'receive', text, role, scripts }) as Promise<Received>;
  }

  async close(): Promise<void> {
    await this.worker?.terminate();
    this.worker = undefined;
  }

  private enqueue(job: Job): Promise<unknown> {
    const run = this.queue.then(() => this.runOne(job));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private spawn(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./sandbox-worker.ts', import.meta.url));
      this.worker.unref();
    }
    return this.worker;
  }

  private runOne(job: Job): Promise<unknown> {
    const worker = this.spawn();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
      };
      const limit = job.kind === 'tokenizer' ? TOKENIZER_TIMEOUT_MS : this.timeoutMs;
      const timer = setTimeout(() => {
        cleanup();
        this.worker = undefined;
        void worker.terminate();
        if (job.kind === 'tokenizer') return resolve({ ok: false, error: `分词器 ${job.pkg} 加载超时` });
        const what = job.kind === 'build' ? '组装' : '执行返回时正则';
        reject(new OrchestrationError('timeout', `${what}超过 ${limit / 1000} 秒未完成，可能是某条正则回溯失控，已终止`));
      }, limit);
      const onMessage = (reply: WorkerReply): void => {
        if (reply.id !== id) return;
        cleanup();
        if (reply.ok) return resolve(reply.result);
        const err = reply.error;
        if ('code' in err) reject(new OrchestrationError(err.code as OrchestrationErrorCode, err.detail, err.entryId));
        else if ('scriptId' in err) reject(new ScriptError(err.scriptId, err.detail));
        else reject(new Error(err.message));
      };
      const onError = (e: Error): void => {
        cleanup();
        this.worker = undefined;
        reject(e);
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.postMessage({ id, job });
    });
  }
}
