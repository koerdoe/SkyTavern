// 召回：从当前正文窗口之外的聊天记录里，找出和最新一条用户输入相关的片段。
//
// 分块：每块不少于 100 字符（整条消息不足 100 字符时整条一块），尽量按段落、句子切，单块不超过约 500 字符。
// 打分：
//   关键词：中日韩文字按相邻两字、其他按单词，BM25 打分，不需要嵌入模型；
//   向量：嵌入向量的余弦相似度；
//   混合：两者各自除以最高分后取平均。
// 选出得分最高的若干块作为“命中中心”（当前正文窗口里的消息不能作中心），再带上每个中心的前一块和后一块
// （可以跨消息），去重后按聊天记录的顺序排列。
// 结果通过占位符 {{$recall}} 放进词条，没有结果时是空文字。

export type RecallMode = 'off' | 'keyword' | 'vector' | 'hybrid';

export const MIN_CHUNK = 100;
const MAX_CHUNK = 500;

/** 一条消息切成若干块。 */
export function chunkText(text: string): string[] {
  const t = text.replace(/\r\n/g, '\n').trim();
  if (!t) return [];
  if ([...t].length < MIN_CHUNK) return [t];
  // 先按段落，过长的段落再按句子
  const pieces: string[] = [];
  for (const para of t.split(/\n\s*\n|\n/)) {
    const p = para.trim();
    if (!p) continue;
    if ([...p].length <= MAX_CHUNK) {
      pieces.push(p);
      continue;
    }
    const sentences = p.match(/[^。！？!?.…]+[。！？!?.…]+["”’」』）)]*|[^。！？!?.…]+$/g) ?? [p];
    let cur = '';
    for (const s of sentences) {
      if (cur && [...cur].length + [...s].length > MAX_CHUNK) {
        pieces.push(cur);
        cur = '';
      }
      cur += s;
    }
    if (cur) pieces.push(cur);
  }
  // 合并成不少于 MIN_CHUNK 的块
  const chunks: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (!cur) cur = p;
    else if ([...cur].length < MIN_CHUNK || [...cur].length + [...p].length <= MAX_CHUNK) cur += `\n${p}`;
    else {
      chunks.push(cur);
      cur = p;
    }
    if ([...cur].length >= MAX_CHUNK) {
      chunks.push(cur);
      cur = '';
    }
  }
  if (cur) {
    if (chunks.length && [...cur].length < MIN_CHUNK) chunks[chunks.length - 1] += `\n${cur}`;
    else chunks.push(cur);
  }
  return chunks;
}

export interface Chunk {
  messageId: string;
  seq: number;
  role: 'user' | 'assistant';
  text: string;
}

/** 按聊天记录顺序把消息切块。 */
export function chunkMessages(messages: readonly { id: string; role: string; content: string }[]): Chunk[] {
  const out: Chunk[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    chunkText(m.content).forEach((text, seq) => out.push({ messageId: m.id, seq, role: m.role as 'user' | 'assistant', text }));
  }
  return out;
}

// ---------- 关键词 ----------

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 中日韩文字取相邻两字，其他取单词（小写，至少两个字母）。 */
export function terms(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    const chars = [...w];
    if (chars.some((c) => CJK.test(c))) {
      // 混排时按字切，相邻两个中日韩字成一个词；非中日韩的连续部分作为一个词
      let latin = '';
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i]!;
        if (CJK.test(c)) {
          if (latin.length >= 2) out.push(latin);
          latin = '';
          const n = chars[i + 1];
          if (n && CJK.test(n)) out.push(c + n);
          else if (!chars[i - 1] || !CJK.test(chars[i - 1]!)) out.push(c);
        } else latin += c;
      }
      if (latin.length >= 2) out.push(latin);
    } else if (w.length >= 2) out.push(w);
  }
  return out;
}

/** BM25：对每个文档打分。 */
export function bm25(query: string, docs: readonly string[]): number[] {
  const q = [...new Set(terms(query))];
  if (q.length === 0 || docs.length === 0) return docs.map(() => 0);
  const tokenized = docs.map((d) => terms(d));
  const avg = tokenized.reduce((n, t) => n + t.length, 0) / tokenized.length || 1;
  const df = new Map<string, number>();
  for (const t of tokenized) for (const term of new Set(t)) df.set(term, (df.get(term) ?? 0) + 1);
  const N = docs.length;
  const k1 = 1.2;
  const b = 0.75;
  return tokenized.map((t) => {
    const tf = new Map<string, number>();
    for (const term of t) tf.set(term, (tf.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of q) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avg));
    }
    return score;
  });
}

// ---------- 向量 ----------

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ---------- 选择与排版 ----------

export interface RecallInput {
  chunks: readonly Chunk[];
  /** 当前正文窗口里的消息：不能作命中中心。 */
  windowIds: ReadonlySet<string>;
  query: string;
  mode: Exclude<RecallMode, 'off'>;
  topK: number;
  /** 向量模式：每块的向量（与 chunks 对齐）和查询向量。 */
  vectors?: readonly (ArrayLike<number> | null)[];
  queryVector?: ArrayLike<number>;
}

export interface RecallHit {
  index: number;
  score: number;
}

/** 选出命中中心，返回要放进请求的块的下标（按聊天记录顺序，含前后邻块）。 */
export function selectRecall(input: RecallInput): { centers: RecallHit[]; picked: number[] } {
  const { chunks, windowIds, mode } = input;
  const eligible = chunks.map((c) => !windowIds.has(c.messageId));
  const kw = mode === 'vector' ? null : bm25(input.query, chunks.map((c) => c.text));
  const vec =
    mode === 'keyword' || !input.queryVector || !input.vectors ? null : input.vectors.map((v) => (v ? cosine(input.queryVector!, v) : 0));
  const norm = (xs: number[] | null) => {
    if (!xs) return null;
    const max = Math.max(0, ...xs.filter((_x, i) => eligible[i]));
    return max > 0 ? xs.map((x) => x / max) : xs.map(() => 0);
  };
  const k = norm(kw);
  const v = norm(vec);
  const scores = chunks.map((_c, i) => (mode === 'hybrid' ? ((k?.[i] ?? 0) + (v?.[i] ?? 0)) / 2 : mode === 'keyword' ? (kw?.[i] ?? 0) : (vec?.[i] ?? 0)));
  const centers = scores
    .map((score, index) => ({ index, score }))
    .filter((h) => eligible[h.index] && h.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, input.topK));
  const picked = new Set<number>();
  for (const c of centers) for (const i of [c.index - 1, c.index, c.index + 1]) if (i >= 0 && i < chunks.length) picked.add(i);
  return { centers, picked: [...picked].sort((a, b) => a - b) };
}

/** 排成放进请求的文字：同一条消息的块连在一起，不相邻的片段之间用“……”隔开。 */
export function formatRecall(chunks: readonly Chunk[], picked: readonly number[], names: { user: string; char: string }): string {
  const out: string[] = [];
  let prev = -2;
  let prevMsg = '';
  for (const i of picked) {
    const c = chunks[i]!;
    if (prev >= 0 && i !== prev + 1) out.push('……');
    if (c.messageId !== prevMsg || i !== prev + 1) out.push(`${c.role === 'user' ? names.user : names.char}：${c.text}`);
    else out[out.length - 1] += `\n${c.text}`;
    prev = i;
    prevMsg = c.messageId;
  }
  return out.join('\n');
}
