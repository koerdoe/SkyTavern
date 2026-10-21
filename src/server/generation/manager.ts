// 生成管理：组装快照 → 上游流 → 广播给客户端 → 完整返回后写库。
// 服务端↔上游、服务端↔客户端两条流互相独立：客户端断开不影响生成。

import { randomUUID } from 'node:crypto';
import type { BuiltRequest } from '../../core/build.ts';
import type { ModelConfig, Protocol } from '../../core/library.ts';
import type { Received, RegexScript } from '../../core/scripts.ts';
import {
  addCandidate,
  appendLayer,
  applyReceived,
  emptySession,
  linearize,
  locate,
  recordOp,
  SessionOpError,
  toHistoryMessage,
  type MessageExtra,
  type SessionDoc,
  type StoredMessage,
  type Usage,
} from '../../core/session.ts';
import { renderPlaceholders } from '../../core/placeholder.ts';
import type { Entry, Role, Warning } from '../../core/types.ts';
import { similarCalls } from '../../core/expr.ts';
import { similarKey, similarQuery, type SimilarityInfo } from '../../core/similar.ts';
import { getPath, type OpWarning } from '../../core/vars.ts';
import { calibrate, chooseTokenizer, promptTotal, type Calibration, type TokenEstimate, type TokenizerProfileId } from '../../core/tokens.ts';
import type { GenEvent as CoreGenEvent, GenStatus, TokenizerInfo } from '../../core/views.ts';
import type { LibraryStore } from '../library/store.ts';
import { buildRequestBody, streamGenerate, UpstreamError } from '../providers/index.ts';
import type { SessionStore } from '../sessions/store.ts';
import { ContextError, loadContext, reservedVars, type GenContext } from './context.ts';
import type { AttachmentStore } from '../attachments/store.ts';
import { resolveAttachments } from '../providers/attachments.ts';
import type { Sandbox } from './sandbox.ts';
import type { RecallService } from '../recall/service.ts';
import { requestVars, varsReport, warningsByMessage, type VarsReport } from './variables.ts';

/** new：在末尾新增一层（发送后、续写）；reroll：在该消息所在层新增候选。 */
export type GenMode = { kind: 'new' } | { kind: 'reroll'; messageId: string };

export interface Prepared {
  mode: GenMode;
  /** reroll 时该层全部候选的 ID，用于在其中某些被删除后仍能找到这一层。 */
  anchorIds: string[];
  presetId: string;
  modelId: string | null;
  protocol: Protocol | null;
  built: BuiltRequest;
  /** 协议请求体（不含密钥）。未选择模型时为 null。 */
  body: Record<string, unknown> | null;
  /** 发送时的正则脚本；回复返回后用它执行返回时正则（与快照一致）。 */
  scripts: RegexScript[];
  /** 预估用的分词器和校准情况。 */
  tokenizer: TokenizerInfo | null;
  /** similar() 的相似度（按词条）。 */
  similarity: Record<string, SimilarityInfo>;
  /** 回复收下时记到消息上的预估（实际值那时再补上）。分词器没加载成功时不记。 */
  estimate: Omit<TokenEstimate, 'actual'> | null;
  createdAt: number;
}

/** 这个账号最近的其他会话里，最多翻几个找校准记录。 */
const RECENT_SESSIONS_FOR_CALIBRATION = 5;

/** 生成过程中广播给客户端的事件（snapshot 由客户端流在连接时单独发送）。 */
export type GenEvent = Exclude<CoreGenEvent, { type: 'snapshot' }>;
export type { GenStatus };

export class GenerationBusy extends Error {
  constructor() {
    super('这个会话正在生成中');
    this.name = 'GenerationBusy';
  }
}

export class Generation {
  readonly id = randomUUID();
  readonly sessionId: string;
  readonly user: string;
  readonly debug: boolean;
  readonly controller = new AbortController();
  status: GenStatus = 'running';
  text = '';
  usage: Usage = {};
  stopReason: string | undefined;
  error: string | undefined;
  messageId: string | undefined;
  finishedAt: number | undefined;
  private readonly listeners = new Set<(e: GenEvent) => void>();

  constructor(sessionId: string, user: string, debug: boolean) {
    this.sessionId = sessionId;
    this.user = user;
    this.debug = debug;
  }

  subscribe(fn: (e: GenEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: GenEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  endEvent(): GenEvent {
    return {
      type: 'end',
      status: this.status,
      ...(this.error === undefined ? {} : { error: this.error }),
      ...(this.messageId === undefined ? {} : { messageId: this.messageId }),
      ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }),
    };
  }

  toJSON(): unknown {
    return {
      id: this.id,
      sessionId: this.sessionId,
      debug: this.debug,
      status: this.status,
      text: this.text,
      usage: this.usage,
      stopReason: this.stopReason,
      error: this.error,
      messageId: this.messageId,
    };
  }
}

export interface DebugSnapshot extends Prepared {
  body: Record<string, unknown>;
  modelId: string;
  protocol: Protocol;
}

const KEEP_FINISHED_MS = 10 * 60_000;

export class GenerationManager {
  private readonly sessions: SessionStore;
  private readonly library: LibraryStore;
  private readonly sandbox: Sandbox;
  private readonly now: () => number;
  private readonly byId = new Map<string, Generation>();
  /** 每个会话最近一次生成（进行中或已结束）。 */
  private readonly bySession = new Map<string, Generation>();
  /** 普通快照：每个会话最近一次实际发送的请求（只读预览）。 */
  private readonly lastSent = new Map<string, Prepared>();
  private readonly attachments: AttachmentStore | undefined;
  private readonly recall: RecallService | undefined;
  /** 校准系数的缓存：用户 + 模型名 + 分词器 → 最近一次从聊天记录里算出的结果。记录本身在消息上。 */
  private readonly calibrations = new Map<string, Calibration>();
  private readonly debugSnapshots = new Map<string, DebugSnapshot>();
  private readonly running = new Set<Promise<void>>();

  constructor(deps: {
    sessions: SessionStore;
    library: LibraryStore;
    sandbox: Sandbox;
    attachments?: AttachmentStore;
    recall?: RecallService;
    now?: () => number;
  }) {
    this.attachments = deps.attachments;
    this.recall = deps.recall;
    this.sessions = deps.sessions;
    this.library = deps.library;
    this.sandbox = deps.sandbox;
    this.now = deps.now ?? Date.now;
  }

  /** 按当前资料组装一次请求，不修改会话。 */
  async prepare(user: string, sessionId: string, mode: GenMode): Promise<Prepared> {
    const s = this.sessions.get(user, sessionId);
    return this.prepareFrom(user, s.meta.characterId, s.doc, mode, sessionId);
  }

  /** 没有会话时（例如编辑预设时预览）：空正文。 */
  prepareBlank(user: string, characterId: string): Promise<Prepared> {
    return this.prepareFrom(user, characterId, emptySession(), { kind: 'new' });
  }

  private async prepareFrom(user: string, characterId: string, doc: SessionDoc, mode: GenMode, sessionId?: string): Promise<Prepared> {
    const { messages, anchorIds } = historyFor(doc, mode);
    const ctx = loadContext(this.library, user, characterId, new Date(this.now()));
    const w = doc.window;
    const windowStartId = w && w.presetId === ctx.preset.id && w.modelId === (ctx.model?.id ?? '') ? w.startId : undefined;

    // 分词器：按模型名选；先加载（第一次较慢，不计入组装超时），再用聊天记录里的预估与实际值校准
    let tokenizer: TokenizerInfo | null = null;
    let pkg: string | undefined;
    if (ctx.model) {
      const choice = chooseTokenizer(ctx.model, this.library.settings(user).tokenizerPriority);
      const load = await this.sandbox.loadTokenizer(choice.profile.pkg);
      const cal = this.calibration(user, doc, ctx.model.model, choice.profile.id);
      if (load.ok) pkg = choice.profile.pkg;
      tokenizer = {
        id: choice.profile.id,
        label: choice.profile.label,
        exact: choice.profile.exact,
        reason: choice.reason,
        auto: choice.auto,
        ...cal,
        error: load.ok ? null : load.error,
      };
    }
    // 变量按本次用到的正文重放（重新生成某层时，只到它之前）
    const vars = { ...requestVars(ctx.initialVars, messages, ctx.reserved), ...lastMessageVars(messages) };
    const build = (v: typeof vars, similar?: Record<string, boolean>) =>
      this.sandbox.build({
        entries: ctx.entries,
        history: messages.map(toHistoryMessage),
        vars: v,
        scripts: ctx.scripts,
        ...(ctx.preset.inputLimit === undefined ? {} : { inputLimit: ctx.preset.inputLimit }),
        trimRounds: ctx.preset.trimRounds,
        ...(windowStartId === undefined ? {} : { windowStartId }),
        cacheMode: ctx.preset.cacheMode,
        ...(pkg === undefined ? {} : { tokenizer: pkg }),
        tokenFactor: tokenizer?.factor ?? 1,
        ...(similar ? { similar } : {}),
        ...(sessionId === undefined ? {} : { seed: sessionId }),
      });
    let built = await build(vars);
    // 召回和 similar()：先组装一次得到裁剪后的正文窗口，再算，最后带着结果组装一次
    // （结果让请求变长时窗口可能再往后挪，不影响）。
    const recall = this.library.settings(user).recall;
    const windowOf = () => {
      const start = built.windowStartId === undefined ? messages.length : messages.findIndex((m) => m.id === built.windowStartId);
      return messages.slice(Math.max(0, start));
    };
    let recallText = '';
    // 召回：只有某个启用的词条用到了 $recall 才做
    if (this.recall && sessionId !== undefined && recall.mode !== 'off' && usesRecall(ctx.entries)) {
      const windowIds = new Set(windowOf().map((m) => m.id));
      recallText = await this.recall.recall(user, sessionId, messages, windowIds, recall, {
        user: String(ctx.reserved.user),
        char: String(ctx.reserved.char),
      });
    }
    // similar()：找出启用词条 IF 里的调用，算好相似度
    const calls = ctx.entries.flatMap((e) => (e.enabled && e.if ? similarCalls(e.if).map((call) => ({ key: similarKey(e.id, call), entryId: e.id, call, query: similarQuery(call, e.content) })) : []));
    let similar: Record<string, boolean> | undefined;
    const similarity: Record<string, SimilarityInfo> = {};
    const extraWarnings: Warning[] = [];
    if (calls.length > 0) {
      const off = !this.recall ? '召回不可用' : sessionId === undefined ? null : this.recall.similarUnavailable(user);
      if (off !== null || sessionId === undefined) {
        // 没有会话（编辑预设时预览）时不提示；召回没开或嵌入模型不可用时按不成立处理并提示
        if (off !== null) {
          for (const id of new Set(calls.map((c) => c.entryId))) {
            extraWarnings.push({ entryId: id, code: 'similar-off', message: `similar() 按不成立处理：${off}` });
          }
        }
      } else {
        const info = await this.recall!.similarity(user, sessionId, calls, windowOf(), recall.similarTopK);
        similar = Object.fromEntries(Object.entries(info).map(([k, v]) => [k, v.passed]));
        for (const c of calls) {
          const v = info[c.key];
          const cur = similarity[c.entryId];
          if (v && (!cur || v.score > cur.score)) similarity[c.entryId] = v;
        }
      }
    }
    if (recallText || similar) built = await build(recallText ? { ...vars, $recall: recallText } : vars, similar);
    if (extraWarnings.length) built = { ...built, warnings: [...built.warnings, ...extraWarnings] };
    return {
      mode,
      anchorIds,
      presetId: ctx.preset.id,
      modelId: ctx.model?.id ?? null,
      protocol: ctx.model?.protocol ?? null,
      built,
      body: ctx.model ? buildRequestBody({ messages: built.messages, cacheBreakpoints: built.cacheBreakpoints }, ctx.model, ctx.preset.requestJson) : null,
      scripts: ctx.scripts,
      tokenizer,
      similarity,
      estimate:
        ctx.model && tokenizer && pkg !== undefined
          ? { model: ctx.model.model, tokenizer: tokenizer.id, raw: built.rawTokens, factor: tokenizer.factor }
          : null,
      createdAt: this.now(),
    };
  }

  // ---------- 校准 ----------

  /**
   * 校准系数：优先用本会话里同一模型、同一分词器的最近几条记录；
   * 本会话还没有时，用这个账号最近其他会话里的记录（结果缓存起来，新记录写入时更新）。
   */
  private calibration(user: string, doc: SessionDoc, model: string, tokenizer: TokenizerProfileId): Calibration & { source: TokenizerInfo['source'] } {
    const key = `${user}\n${model}\n${tokenizer}`;
    const own = calibrate(newestFirst(doc), model, tokenizer);
    if (own.samples > 0) {
      this.calibrations.set(key, own);
      return { ...own, source: 'session' };
    }
    let cached = this.calibrations.get(key);
    if (!cached) {
      cached = calibrate(this.recentRecords(user), model, tokenizer);
      this.calibrations.set(key, cached);
    }
    return { ...cached, source: cached.samples > 0 ? 'recent' : 'default' };
  }

  /** 最近活跃的几个会话里的预估记录，从新到旧。 */
  private *recentRecords(user: string): Generator<TokenEstimate | undefined> {
    for (const meta of this.sessions.list(user).slice(0, RECENT_SESSIONS_FOR_CALIBRATION)) {
      let doc: SessionDoc;
      try {
        doc = this.sessions.get(user, meta.id).doc;
      } catch {
        continue;
      }
      yield* newestFirst(doc);
    }
  }

  // ---------- 变量与返回时正则 ----------

  /** 新消息进入会话前：执行当前的返回时正则并取出编辑块。 */
  async receiveIncoming(user: string, sessionId: string, text: string, role: Role): Promise<MessageExtra & { text: string }> {
    const s = this.sessions.get(user, sessionId);
    const ctx = loadContext(this.library, user, s.meta.characterId, new Date(this.now()));
    return toExtra(await this.receive(text, role, ctx.scripts));
  }

  /**
   * 新会话加上角色卡的开场白：替换 {{char}} {{user}} 等占位符，执行返回时正则，作为第一条 AI 消息。
   * 有其他开场白时，它们是第一层的其他候选。
   * 还没选预设时不执行正则（没有预设就没有完整的正则列表），开场白照常加上。
   */
  async greet(user: string, sessionId: string): Promise<void> {
    const s = this.sessions.get(user, sessionId);
    const character = this.library.get(user, 'character', s.meta.characterId);
    const greetings = [character.greeting, ...character.alternateGreetings].filter((g) => g.trim() !== '');
    if (greetings.length === 0) return;
    let ctx: GenContext | null = null;
    try {
      ctx = loadContext(this.library, user, s.meta.characterId, new Date(this.now()));
    } catch (e) {
      if (!(e instanceof ContextError)) throw e;
    }
    const persona = ctx?.persona ?? null;
    const reserved = ctx?.reserved ?? reservedVars(character, persona, new Date(this.now()));
    // 每个开场白各自执行返回时正则；第一个是这一层选用的，其余作为候选
    const received: (MessageExtra & { text: string })[] = [];
    for (const g of greetings) {
      // 开场白里的 {{random(…)}} 等在这时抽一次，之后固定
      const text = renderPlaceholders(g, (n) => getPath(reserved, n), false, { seed: sessionId });
      received.push(toExtra(await this.receive(text, 'assistant', ctx?.scripts ?? [])));
    }
    this.sessions.mutate(user, sessionId, (doc) => {
      if (doc.layers.length !== 0) return;
      const now = this.now();
      received.forEach(({ text, ...extra }, i) => {
        if (i === 0) appendLayer(doc, 'assistant', text, now, extra);
        else addCandidate(doc, 0, text, now, extra);
      });
      doc.selected[0] = 0;
    });
  }

  /** 手动对若干层重新执行返回时正则（例如改过正则之后补处理旧消息）。 */
  async reapplyReceive(user: string, sessionId: string, messageIds: readonly string[]): Promise<number[]> {
    const s = this.sessions.get(user, sessionId);
    const ctx = loadContext(this.library, user, s.meta.characterId, new Date(this.now()));
    const results: { id: string; r: Received }[] = [];
    for (const id of messageIds) {
      const { layer, index } = locate(s.doc, id);
      const msg = s.doc.layers[layer]!.candidates[index]!;
      results.push({ id, r: await this.receive(msg.content, msg.role, ctx.scripts) });
    }
    return this.sessions.mutate(user, sessionId, (doc) => results.map(({ id, r }) => applyReceived(doc, id, r)));
  }

  /** 逐层变量表。 */
  varsReport(user: string, sessionId: string): VarsReport {
    const s = this.sessions.get(user, sessionId);
    return varsReport(loadContext(this.library, user, s.meta.characterId, new Date(this.now())).initialVars, s.doc);
  }

  /** 当前选用路径上每条消息的重放警告（会话视图用）。 */
  varWarnings(user: string, characterId: string, doc: SessionDoc): Map<string, OpWarning[]> {
    return warningsByMessage(loadContext(this.library, user, characterId, new Date(this.now())).initialVars, doc);
  }

  /** 执行返回时正则；正则本身出错或超时时保留原文，并把原因记在这条消息上，不丢回复。 */
  private async receive(text: string, role: Role, scripts: readonly RegexScript[]): Promise<Received> {
    try {
      return await this.sandbox.receive(text, role, [...scripts]);
    } catch (e) {
      return { text, ops: [], errors: [{ line: 0, text: '', message: `返回时正则执行失败：${(e as Error).message}` }] };
    }
  }

  /** 普通生成：组装 → 记下快照与裁剪起点 → 开始。opId 重复时返回 null。 */
  async generate(user: string, sessionId: string, mode: GenMode, opId: string): Promise<Generation | null> {
    this.assertIdle(sessionId);
    const prepared = await this.prepare(user, sessionId, mode);
    if (!prepared.body || !prepared.modelId) throw new ContextError('还没有选择模型配置');
    const model = this.library.get(user, 'model', prepared.modelId);
    this.assertIdle(sessionId); // 组装期间可能有另一个请求抢先开始
    const fresh = this.sessions.mutate(user, sessionId, (doc) => {
      if (!recordOp(doc, opId)) return false;
      const start = prepared.built.windowStartId;
      if (start !== undefined) doc.window = { startId: start, presetId: prepared.presetId, modelId: prepared.modelId! };
      return true;
    });
    if (!fresh) return null;
    this.lastSent.set(sessionId, prepared);
    return this.start(user, sessionId, prepared, model, prepared.body, false);
  }

  // ---------- Debug ----------

  async createDebug(user: string, sessionId: string, mode: GenMode): Promise<DebugSnapshot> {
    const p = await this.prepare(user, sessionId, mode);
    if (!p.body || !p.modelId || !p.protocol) throw new ContextError('还没有选择模型配置');
    const snap: DebugSnapshot = { ...p, body: p.body, modelId: p.modelId, protocol: p.protocol };
    this.debugSnapshots.set(sessionId, snap);
    return snap;
  }

  getDebug(user: string, sessionId: string): DebugSnapshot | undefined {
    this.sessions.get(user, sessionId); // 权限检查
    return this.debugSnapshots.get(sessionId);
  }

  updateDebugBody(user: string, sessionId: string, body: Record<string, unknown>): DebugSnapshot {
    const snap = this.getDebug(user, sessionId);
    if (!snap) throw new ContextError('还没有 Debug 快照');
    snap.body = body;
    return snap;
  }

  dropDebug(user: string, sessionId: string): void {
    this.sessions.get(user, sessionId);
    this.debugSnapshots.delete(sessionId);
  }

  /** 按 Debug 快照里（可能改过的）请求体原样发送，回复写入正式聊天。 */
  sendDebug(user: string, sessionId: string): Generation {
    const snap = this.getDebug(user, sessionId);
    if (!snap) throw new ContextError('还没有 Debug 快照');
    this.assertIdle(sessionId);
    const model = this.library.get(user, 'model', snap.modelId);
    if (model.protocol !== snap.protocol) throw new ContextError('模型配置的协议已改变，请重新截取 Debug 快照');
    return this.start(user, sessionId, snap, model, snap.body, true);
  }

  // ---------- 查询与控制 ----------

  get(user: string, id: string): Generation | undefined {
    const g = this.byId.get(id);
    return g && g.user === user ? g : undefined;
  }

  latest(user: string, sessionId: string): Generation | undefined {
    const g = this.bySession.get(sessionId);
    return g && g.user === user ? g : undefined;
  }

  lastSentSnapshot(user: string, sessionId: string): Prepared | undefined {
    this.sessions.get(user, sessionId);
    return this.lastSent.get(sessionId);
  }

  isBusy(sessionId: string): boolean {
    return this.bySession.get(sessionId)?.status === 'running';
  }

  stop(user: string, id: string): boolean {
    const g = this.get(user, id);
    if (!g || g.status !== 'running') return false;
    g.controller.abort();
    return true;
  }

  /** 等待所有进行中的生成结束（测试与关闭时用）。abort 为 true 时先停止它们，已收到的正文照常保存。 */
  async drain(abort = false): Promise<void> {
    if (abort) for (const g of this.byId.values()) if (g.status === 'running') g.controller.abort();
    await Promise.all([...this.running]);
  }

  private assertIdle(sessionId: string): void {
    if (this.isBusy(sessionId)) throw new GenerationBusy();
  }

  private start(user: string, sessionId: string, prepared: Prepared, model: ModelConfig, body: unknown, debug: boolean): Generation {
    this.sweep();
    const g = new Generation(sessionId, user, debug);
    this.byId.set(g.id, g);
    this.bySession.set(sessionId, g);
    const run = this.run(g, prepared, model, body).finally(() => this.running.delete(run));
    this.running.add(run);
    return g;
  }

  private async run(g: Generation, prepared: Prepared, model: ModelConfig, body: unknown): Promise<void> {
    let completed = false;
    try {
      // 附件占位符换成文件内容（预览和快照里保留占位符）
      const sendBody = this.attachments ? resolveAttachments(body, (id) => this.attachments!.data(g.user, id)) : body;
      for await (const ev of streamGenerate(model, sendBody, g.controller.signal)) {
        switch (ev.type) {
          case 'text':
            g.text += ev.text;
            g.emit({ type: 'delta', text: ev.text });
            break;
          case 'usage':
            for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) if (ev[k] !== undefined) g.usage[k] = ev[k];
            break;
          case 'done':
            completed = true;
            if (ev.stopReason !== undefined) g.stopReason = ev.stopReason;
            break;
          case 'error':
            throw new UpstreamError(ev.message);
        }
      }
      g.status = completed ? 'completed' : 'interrupted';
      if (!completed) g.error = '上游连接在回复结束前断开';
    } catch (e) {
      if (g.controller.signal.aborted) {
        g.status = 'stopped';
      } else {
        g.status = g.text === '' ? 'failed' : 'interrupted';
        g.error = (e as Error).message;
      }
    }

    if (g.text === '') {
      if (g.status === 'completed') {
        g.status = 'failed';
        g.error = '上游返回了空回复';
      }
    } else {
      try {
        g.messageId = await this.persist(g, prepared);
      } catch (e) {
        g.status = 'failed';
        g.error = `回复未能保存：${(e as Error).message}`;
      }
    }
    g.finishedAt = this.now();
    g.emit(g.endEvent());
  }

  /** 完整返回（或中断）后：执行返回时正则、取出编辑块，一次性写库。未完成的回复同样处理。 */
  private async persist(g: Generation, prepared: Prepared): Promise<string> {
    const received = await this.receive(g.text, 'assistant', prepared.scripts);
    const actual = prepared.protocol ? promptTotal(g.usage, prepared.protocol) : undefined;
    const estimate: TokenEstimate | undefined = prepared.estimate ? { ...prepared.estimate, ...(actual ? { actual } : {}) } : undefined;
    const extra: MessageExtra = {
      ...toExtra(received),
      ...(g.status === 'completed' ? {} : { partial: true as const }),
      ...(Object.keys(g.usage).length > 0 ? { usage: g.usage } : {}),
      ...(estimate ? { estimate } : {}),
    };
    // 有了新的实际值，这个模型的校准缓存作废，下次按聊天记录重新算
    if (estimate?.actual) this.calibrations.delete(`${g.user}\n${estimate.model}\n${estimate.tokenizer}`);
    return this.sessions.mutate(g.user, g.sessionId, (doc) => {
      const now = this.now();
      if (prepared.mode.kind === 'reroll') {
        for (const id of prepared.anchorIds) {
          try {
            return addCandidate(doc, locate(doc, id).layer, received.text, now, extra).id;
          } catch (e) {
            if (!(e instanceof SessionOpError)) throw e;
          }
        }
      }
      // 新增一层；reroll 的那一层已被整体删除时也退回到这里。
      return appendLayer(doc, 'assistant', received.text, now, extra).id;
    });
  }

  private sweep(): void {
    const cutoff = this.now() - KEEP_FINISHED_MS;
    for (const [id, g] of this.byId) {
      if (g.finishedAt !== undefined && g.finishedAt < cutoff) {
        this.byId.delete(id);
        if (this.bySession.get(g.sessionId) === g) this.bySession.delete(g.sessionId);
      }
    }
  }
}

/** 当前选用路径上的预估记录，从新到旧。 */
function* newestFirst(doc: SessionDoc): Generator<TokenEstimate | undefined> {
  const path = linearize(doc);
  for (let i = path.length - 1; i >= 0; i--) yield path[i]!.estimate;
}

/** 本次生成使用的正文：new 用全部；reroll 用目标层之前的部分。 */
/** 最近一条消息、最近一条用户消息、最近一条角色消息（酒馆的 {{lastMessage}} 等）。 */
function lastMessageVars(messages: readonly StoredMessage[]): Record<string, string> {
  const last = (role?: string) => [...messages].reverse().find((m) => (role ? m.role === role : m.role !== 'system'))?.content ?? '';
  return { $lastMessage: last(), $lastUserMessage: last('user'), $lastCharMessage: last('assistant') };
}

/** 有启用的词条（内容或 IF）用到了 $recall。 */
function usesRecall(entries: readonly Entry[]): boolean {
  return entries.some((e) => e.enabled && (e.content.includes('$recall') || (e.if ?? '').includes('$recall')));
}

function historyFor(doc: SessionDoc, mode: GenMode): { messages: StoredMessage[]; anchorIds: string[] } {
  const all = linearize(doc);
  if (mode.kind === 'new') return { messages: all, anchorIds: [] };
  const { layer } = locate(doc, mode.messageId);
  const l = doc.layers[layer]!;
  if (l.candidates[0]!.role !== 'assistant') throw new SessionOpError('invalid', '只能重新生成 assistant 消息');
  return { messages: all.slice(0, layer), anchorIds: l.candidates.map((c) => c.id) };
}

/** 返回时处理的结果 → 消息附带的信息（空的不写）。 */
function toExtra(r: Received): MessageExtra & { text: string } {
  return {
    text: r.text,
    ...(r.ops.length > 0 ? { varOps: r.ops } : {}),
    ...(r.errors.length > 0 ? { varErrors: r.errors } : {}),
  };
}
