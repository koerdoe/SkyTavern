// 召回服务：建索引（向量）、查询、维护。
//
// 向量索引存在 recall_chunks 表里，键是“会话 + 消息 + 块序号”，文字每次按会话文档重新切块，
// 用 hash 和模型名判断是否需要重新嵌入（消息被编辑、换了嵌入模型）。
// - 需要召回时，本次用到的索引没准备好就等它准备好；嵌入接口出错则停止本次生成。
// - 新消息进入会话后在后台补索引；失败时记下原因，可以在 /admin 手动重试。
//   服务重启后不需要专门恢复：下次需要时会自动补齐。
// - 消息删除时（会话文档写回时发现消息不在了），对应的向量立即删除。

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ModelConfig, RecallSettings } from '../../core/library.ts';
import { chunkMessages, cosine, formatRecall, selectRecall, type Chunk } from '../../core/recall.ts';
import type { SimilarCall, SimilarityInfo } from '../../core/similar.ts';
import { linearize, type SessionDoc } from '../../core/session.ts';
import type { RecallStatus } from '../../core/views.ts';
export type { RecallStatus };
import type { LibraryStore } from '../library/store.ts';
import { embed } from '../providers/embed.ts';

export class RecallError extends Error {}

type IndexStatus = Pick<RecallStatus, 'state' | 'error' | 'at'>;

const hashOf = (text: string) => createHash('sha1').update(text).digest('hex');
const toBlob = (v: readonly number[]) => new Uint8Array(new Float32Array(v).buffer);
const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const modelKey = (m: ModelConfig) => `${m.id}:${m.model}`;

export class RecallService {
  private readonly db: DatabaseSync;
  private readonly library: LibraryStore;
  private readonly now: () => number;
  private readonly status = new Map<string, IndexStatus>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, SessionDoc>();
  private readonly queryCache = new Map<string, Float32Array>();

  constructor(db: DatabaseSync, library: LibraryStore, now: () => number = Date.now) {
    this.db = db;
    this.library = library;
    this.now = now;
  }

  /** 召回设置里选的嵌入模型。 */
  embeddingModel(user: string): ModelConfig {
    const { recall } = this.library.settings(user);
    if (!recall.embeddingModelId) throw new RecallError('召回用了向量，但还没有选嵌入模型（系统设置 → 召回）');
    let m: ModelConfig;
    try {
      m = this.library.get(user, 'model', recall.embeddingModelId);
    } catch {
      throw new RecallError('召回设置里的嵌入模型已经不存在了');
    }
    if (m.use !== 'embedding') throw new RecallError(`模型配置“${m.name}”不是嵌入模型（在模型配置里把用途改成“嵌入”）`);
    return m;
  }

  /** 确保这些块都用当前嵌入模型建好了索引，返回与 chunks 对齐的向量。 */
  async ensureIndexed(user: string, sessionId: string, chunks: readonly Chunk[], model: ModelConfig): Promise<Float32Array[]> {
    const key = modelKey(model);
    const rows = this.db
      .prepare('SELECT message_id AS m, seq, hash, model, vector FROM recall_chunks WHERE user = ? AND session_id = ?')
      .all(user, sessionId) as { m: string; seq: number; hash: string; model: string; vector: Uint8Array }[];
    const have = new Map(rows.map((r) => [`${r.m}#${r.seq}`, r]));
    const out: (Float32Array | null)[] = chunks.map((c) => {
      const r = have.get(`${c.messageId}#${c.seq}`);
      return r && r.model === key && r.hash === hashOf(c.text) ? fromBlob(r.vector) : null;
    });
    const missing = out.flatMap((v, i) => (v ? [] : [i]));
    if (missing.length) {
      const vectors = await embed(model, missing.map((i) => chunks[i]!.text));
      const up = this.db.prepare(
        `INSERT INTO recall_chunks (user, session_id, message_id, seq, hash, model, vector) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user, session_id, message_id, seq) DO UPDATE SET hash = excluded.hash, model = excluded.model, vector = excluded.vector`,
      );
      this.db.exec('BEGIN');
      try {
        missing.forEach((i, k) => {
          const c = chunks[i]!;
          up.run(user, sessionId, c.messageId, c.seq, hashOf(c.text), key, toBlob(vectors[k]!));
          out[i] = Float32Array.from(vectors[k]!);
        });
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
    return out as Float32Array[];
  }

  private async queryVector(model: ModelConfig, text: string): Promise<Float32Array> {
    return (await this.queryVectors(model, [text]))[0]!;
  }

  /** 一批查询文字 → 向量，缓存过的不再请求，没缓存的一次发出去。 */
  private async queryVectors(model: ModelConfig, texts: readonly string[]): Promise<Float32Array[]> {
    const key = (t: string) => `${modelKey(model)}\n${t}`;
    const missing = [...new Set(texts.filter((t) => !this.queryCache.has(key(t))))];
    if (missing.length) {
      const vs = await embed(model, missing);
      if (this.queryCache.size + missing.length > 1000) this.queryCache.clear();
      missing.forEach((t, i) => this.queryCache.set(key(t), Float32Array.from(vs[i]!)));
    }
    return texts.map((t) => this.queryCache.get(key(t))!);
  }

  /** 召回设置里的嵌入模型能不能用；不能用时给出原因（similar() 据此一律不成立）。 */
  similarUnavailable(user: string): string | null {
    const settings = this.library.settings(user).recall;
    if (settings.mode === 'off') return '召回没有开启';
    try {
      this.embeddingModel(user);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  /**
   * similar() 的相似度：每个调用取“最近 depth 条消息里所有块”和查询最相似的那块的分数。
   * 过了阈值的按分数从高到低，最多 topK 个成立。返回值的键与 calls 的 key 对应。
   */
  async similarity(
    user: string,
    sessionId: string,
    calls: readonly { key: string; call: SimilarCall; query: string }[],
    window: readonly { id: string; role: string; content: string }[],
    topK: number,
  ): Promise<Record<string, SimilarityInfo>> {
    const out: Record<string, SimilarityInfo> = {};
    const live = calls.filter((c) => c.query.trim());
    for (const c of calls) if (!c.query.trim()) out[c.key] = { score: 0, threshold: c.call.threshold, passed: false };
    if (live.length === 0) return out;
    const model = this.embeddingModel(user);
    const maxDepth = Math.max(...live.map((c) => c.call.depth));
    const recent = window.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-maxDepth);
    const chunks = chunkMessages(recent);
    let vectors: Float32Array[];
    let queries: Float32Array[];
    this.setStatus(user, sessionId, { state: 'indexing', error: null, at: this.now() });
    try {
      vectors = await this.ensureIndexed(user, sessionId, chunks, model);
      queries = await this.queryVectors(model, live.map((c) => c.query));
      this.setStatus(user, sessionId, { state: 'idle', error: null, at: this.now() });
    } catch (e) {
      this.setStatus(user, sessionId, { state: 'error', error: (e as Error).message, at: this.now() });
      throw new RecallError(`similar() 计算相似度失败：${(e as Error).message}`);
    }
    // 每条消息在 recent 里的位置（从新往旧数第几条，0 是最新）
    const age = new Map(recent.map((m, i) => [m.id, recent.length - 1 - i]));
    const scored = live.map((c, i) => {
      let best = 0;
      chunks.forEach((ch, j) => {
        if ((age.get(ch.messageId) ?? Infinity) < c.call.depth) best = Math.max(best, cosine(queries[i]!, vectors[j]!));
      });
      return { c, score: best };
    });
    const over = scored.filter((x) => x.score >= x.c.call.threshold).sort((a, b) => b.score - a.score);
    const winners = new Set(over.slice(0, Math.max(0, topK)).map((x) => x.c.key));
    for (const { c, score } of scored) {
      const passed = winners.has(c.key);
      out[c.key] = { score, threshold: c.call.threshold, passed, ...(score >= c.call.threshold && !passed ? { cut: true } : {}) };
    }
    return out;
  }

  /**
   * 召回：messages 是本次请求用到的聊天记录（从旧到新），windowIds 是裁剪后仍在正文窗口里的消息。
   * 用最新一条用户消息作查询；返回放进 {{$recall}} 的文字（没有结果时为空）。
   */
  async recall(
    user: string,
    sessionId: string,
    messages: readonly { id: string; role: string; content: string }[],
    windowIds: ReadonlySet<string>,
    settings: RecallSettings,
    names: { user: string; char: string },
  ): Promise<string> {
    if (settings.mode === 'off') return '';
    const query = [...messages].reverse().find((m) => m.role === 'user')?.content.trim();
    if (!query) return '';
    const chunks = chunkMessages(messages);
    if (!chunks.some((c) => !windowIds.has(c.messageId))) return '';
    let vectors: Float32Array[] | undefined;
    let queryVector: Float32Array | undefined;
    if (settings.mode !== 'keyword') {
      const model = this.embeddingModel(user);
      this.setStatus(user, sessionId, { state: 'indexing', error: null, at: this.now() });
      try {
        vectors = await this.ensureIndexed(user, sessionId, chunks, model);
        queryVector = await this.queryVector(model, query);
        this.setStatus(user, sessionId, { state: 'idle', error: null, at: this.now() });
      } catch (e) {
        this.setStatus(user, sessionId, { state: 'error', error: (e as Error).message, at: this.now() });
        throw new RecallError(`召回失败：${(e as Error).message}`);
      }
    }
    const { picked } = selectRecall({
      chunks,
      windowIds,
      query,
      mode: settings.mode,
      topK: settings.topK,
      ...(vectors ? { vectors } : {}),
      ...(queryVector ? { queryVector } : {}),
    });
    return formatRecall(chunks, picked, names);
  }

  /**
   * 会话写回后在后台补索引（只在向量 / 混合模式下）。失败时记下原因。
   * 正在补的时候又有写入，就记住最新的文档，补完再来一轮。
   */
  background(user: string, sessionId: string, doc: SessionDoc): void {
    const settings = this.library.settings(user).recall;
    if (settings.mode !== 'vector' && settings.mode !== 'hybrid') return;
    const key = `${user}\n${sessionId}`;
    if (this.running.has(key)) {
      this.pending.set(key, doc);
      return;
    }
    const job = (async () => {
      let next: SessionDoc | undefined = doc;
      while (next) {
        this.pending.delete(key);
        const chunks = chunkMessages(linearize(next));
        try {
          const model = this.embeddingModel(user);
          this.setStatus(user, sessionId, { state: 'indexing', error: null, at: this.now() });
          await this.ensureIndexed(user, sessionId, chunks, model);
          this.setStatus(user, sessionId, { state: 'idle', error: null, at: this.now() });
        } catch (e) {
          this.setStatus(user, sessionId, { state: 'error', error: (e as Error).message, at: this.now() });
        }
        next = this.pending.get(key);
      }
    })().finally(() => this.running.delete(key));
    this.running.set(key, job);
  }

  /** /admin 手动重试：立即补齐索引，失败时抛出原因。 */
  async reindex(user: string, sessionId: string, doc: SessionDoc): Promise<void> {
    const model = this.embeddingModel(user);
    this.setStatus(user, sessionId, { state: 'indexing', error: null, at: this.now() });
    try {
      await this.ensureIndexed(user, sessionId, chunkMessages(linearize(doc)), model);
      this.setStatus(user, sessionId, { state: 'idle', error: null, at: this.now() });
    } catch (e) {
      this.setStatus(user, sessionId, { state: 'error', error: (e as Error).message, at: this.now() });
      throw new RecallError(`建索引失败：${(e as Error).message}`);
    }
  }

  /**
   * 服务启动时：把建过索引的会话逐个补齐（上次关闭时可能没做完）。一个接一个做，不并发打满嵌入接口；
   * 只补缺的块，已经齐全的会话只是读一下数据库。
   */
  async resume(load: (user: string, sessionId: string) => SessionDoc | null): Promise<number> {
    const rows = this.db.prepare('SELECT DISTINCT user, session_id AS sid FROM recall_chunks').all() as { user: string; sid: string }[];
    let n = 0;
    for (const { user, sid } of rows) {
      const doc = load(user, sid);
      if (!doc) {
        this.prune(user, sid, null);
        continue;
      }
      this.background(user, sid, doc);
      const job = this.running.get(`${user}\n${sid}`);
      if (job) {
        n++;
        await job;
      }
    }
    return n;
  }

  /** 等后台任务结束（测试、关闭时用）。 */
  async drain(): Promise<void> {
    await Promise.all(this.running.values());
  }

  /** 会话文档写回后：删掉已经不存在的消息的向量；会话删除时（doc 为 null）全部删除。 */
  prune(user: string, sessionId: string, doc: SessionDoc | null): void {
    if (!doc) {
      this.db.prepare('DELETE FROM recall_chunks WHERE user = ? AND session_id = ?').run(user, sessionId);
      this.status.delete(`${user}\n${sessionId}`);
      return;
    }
    const ids = new Set(doc.layers.flatMap((l) => l.candidates.map((c) => c.id)));
    const stored = this.db.prepare('SELECT DISTINCT message_id AS m FROM recall_chunks WHERE user = ? AND session_id = ?').all(user, sessionId) as { m: string }[];
    const del = this.db.prepare('DELETE FROM recall_chunks WHERE user = ? AND session_id = ? AND message_id = ?');
    for (const { m } of stored) if (!ids.has(m)) del.run(user, sessionId, m);
  }

  /** /admin 用：索引进度与状态。 */
  statusOf(user: string, sessionId: string, doc: SessionDoc): RecallStatus {
    const settings = this.library.settings(user).recall;
    const chunks = chunkMessages(linearize(doc));
    let model: ModelConfig | null = null;
    try {
      model = settings.mode === 'vector' || settings.mode === 'hybrid' ? this.embeddingModel(user) : null;
    } catch {
      model = null;
    }
    let indexed = 0;
    if (model) {
      const key = modelKey(model);
      const rows = this.db.prepare('SELECT message_id AS m, seq, hash, model FROM recall_chunks WHERE user = ? AND session_id = ?').all(user, sessionId) as {
        m: string;
        seq: number;
        hash: string;
        model: string;
      }[];
      const have = new Map(rows.map((r) => [`${r.m}#${r.seq}`, r]));
      indexed = chunks.filter((c) => {
        const r = have.get(`${c.messageId}#${c.seq}`);
        return r && r.model === key && r.hash === hashOf(c.text);
      }).length;
    }
    const st = this.status.get(`${user}\n${sessionId}`) ?? { state: 'idle', error: null, at: null };
    return { ...st, mode: settings.mode, model: model ? `${model.name}（${model.model}）` : null, chunks: chunks.length, indexed };
  }

  private setStatus(user: string, sessionId: string, s: IndexStatus): void {
    this.status.set(`${user}\n${sessionId}`, s);
  }
}
