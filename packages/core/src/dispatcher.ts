import { readFile, realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { createLogger, type Logger } from './logger.ts';
import {
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  matchMediaLine,
  mediaKindFor,
  resolveInsideCwd,
} from './media-ref.ts';
import { newTraceId } from './ids.ts';
import { formatPendingWindow, formatHistorical, formatChatTools } from './pending-window.ts';
import { decideInbound, chatIdOfKey, conversationKeyFor, sessionRefFor } from './router.ts';
import { SessionQueue } from './queue.ts';
import type { Channel } from './channel.ts';
import type { SessionDriver } from './session-driver.ts';
import type { Db } from './state/db.ts';
import {
  clearPendingWindow,
  chatIdOf,
  markInbound,
  pendingWindowFor,
  recordInbound,
} from './state/inbound.ts';
import {
  enqueueOutbound,
  listPendingOutbound,
  markOutboundFailed,
  markOutboundSent,
} from './state/outbound.ts';
import { getBootstrapRecord, saveBootstrapRecord } from './state/bootstrap.ts';
import { getBool, getInt, SETTINGS } from './state/settings.ts';
import { listBindings, updateBindingSession } from './state/bindings.ts';
import type {
  AgentAdapter,
  AgentSessionHandle,
  Attachment,
  ConversationKey,
  ContextBlock,
  InboundMessage,
  OutboundMessage,
  SessionRef,
  TurnEvent,
  TurnHandle,
} from './types.ts';

export interface DispatcherOptions {
  db: Db;
  channel: Channel;
  driver: SessionDriver;
  queue?: SessionQueue;
  logger?: Logger;
  /** pendingWindow 上限（默认 50，对齐 OpenClaw §6.1） */
  pendingWindowLimit?: number;
  /** 单条出站最大字符数（§10.1，默认 4000） */
  chunkLimit?: number;
  /** 出站重试上限（超过则标记 failed，不再重试） */
  maxSendAttempts?: number;
  /** bootstrapHistory（§6.2）：绑定时回填群历史，默认开、50 条、7 天内 */
  bootstrap?: { enabled?: boolean; maxMessages?: number; maxAgeDays?: number };
  onTurnEvent?: (event: TurnEvent) => void;
}

/**
 * 入站 → 路由 → 会话 → 出站 的编排。daemon 与测试共用这一份逻辑。
 */
export class Dispatcher {
  private readonly db: Db;
  private readonly channel: Channel;
  private readonly driver: SessionDriver;
  private readonly queue: SessionQueue;
  private readonly logger: Logger;
  private readonly pendingWindowLimit: number;
  private readonly chunkLimit: number;
  private readonly maxSendAttempts: number;
  private readonly bootstrap: { enabled: boolean; maxMessages: number; maxAgeDays: number };
  /** 每个 session 正在跑的那条 turn（/cancel 用，决策 28）。queue 保证每 session 最多一条。 */
  private readonly activeTurns = new Map<
    string,
    { adapter: AgentAdapter; handle: AgentSessionHandle; turn: TurnHandle; chatId: string }
  >();
  private readonly onTurnEvent?: (event: TurnEvent) => void;
  /** 串行化 flush：deliver 与 daemon 定时器可能同时触发，不排队就会同一条发两遍 */
  private flushChain: Promise<void> = Promise.resolve();

  constructor(opts: DispatcherOptions) {
    this.db = opts.db;
    this.channel = opts.channel;
    this.driver = opts.driver;
    this.queue = opts.queue ?? new SessionQueue({ logger: opts.logger });
    this.logger = opts.logger ?? createLogger({ svc: 'dispatcher' });
    this.pendingWindowLimit = opts.pendingWindowLimit ?? 50;
    this.chunkLimit = opts.chunkLimit ?? 4000;
    this.maxSendAttempts = opts.maxSendAttempts ?? 3;
    this.bootstrap = {
      enabled: opts.bootstrap?.enabled ?? true,
      maxMessages: opts.bootstrap?.maxMessages ?? 50,
      maxAgeDays: opts.bootstrap?.maxAgeDays ?? 7,
    };
    this.onTurnEvent = opts.onTurnEvent;
  }

  /** 渠道事件入口。幂等：同一 event_id 重复投递不会重复执行。 */
  async handleInbound(msg: InboundMessage): Promise<void> {
    const traceId = newTraceId();
    const log = this.logger.child({ traceId, eventId: msg.id, chatId: chatIdOf(msg) });
    const decision = decideInbound(this.db, msg);
    const sessionId = decision.action === 'unbound' ? null : decision.binding.sessionId;
    const fresh = recordInbound(this.db, msg, sessionId);
    if (!fresh) {
      log.debug('duplicate inbound ignored');
      return;
    }

    if (decision.action === 'unbound') {
      log.info('inbound to unbound chat');
      await this.reply(
        msg.conversationKey,
        '本群未绑定任何会话。请在终端执行 instead bind，或在 agent 会话中完成绑定。',
      );
      markInbound(this.db, msg.id, 'done');
      return;
    }
    if (decision.action === 'context') {
      log.debug('stored as pending-window context');
      return; // 已按 context 落盘，不触发
    }

    const ref = sessionRefFor(this.db, chatIdOf(msg));
    if (!ref) return;

    // /new（决策 25）：控制命令，旁路队列直接执行 —— 排队等一个 agent turn 才轮到换会话没有意义
    const newPayload = parseNewCommand(msg.text);
    if (newPayload !== null) {
      await this.runNew(msg, ref, log, newPayload);
      markInbound(this.db, msg.id, 'done');
      return;
    }

    // /cancel（决策 28）：同理由旁路 —— 等排队排到自己再取消没有意义
    if (isCancelCommand(msg.text)) {
      await this.runCancel(msg, ref, log);
      markInbound(this.db, msg.id, 'done');
      return;
    }

    await this.enqueueTurn(msg, ref, log);
  }

  /** 正常入队：组 pending 窗口、进队列、回执。runNew 的带参形式也走这里。 */
  private async enqueueTurn(
    msg: InboundMessage,
    ref: NonNullable<ReturnType<typeof sessionRefFor>>,
    log: Logger,
  ): Promise<void> {
    const window = pendingWindowFor(
      this.db,
      chatIdOf(msg),
      getInt(this.db, SETTINGS.pendingWindowMax, this.pendingWindowLimit),
    );
    const context = formatPendingWindow(msg, window);
    const traceId = newTraceId();

    const { ahead, dropped } = this.queue.enqueue(ref.sessionId, {
      chatId: chatIdOf(msg),
      enqueuedAt: Date.now(),
      run: () => this.runTurn(msg, ref, context, traceId),
      onDrop: (reason) => {
        // cancelled（/cancel 撤掉的）不回消息：runCancel 的统一确认文案已覆盖
        if (reason !== 'cancelled') {
          void this.reply(
            msg.conversationKey,
            reason === 'overflow' ? '消息队列已满，本条已丢弃。' : '消息排队超时，本条已丢弃。',
          );
        }
        markInbound(this.db, msg.id, 'dropped');
      },
    });
    if (dropped) return;
    if (ahead > 0) {
      await this.channel
        .receipt(msg.conversationKey, 'queued', {
          text: `排队中（前面 ${ahead} 条 · 本会话正在响应其他群）`,
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
        })
        .catch(() => undefined);
    } else {
      await this.channel
        .receipt(msg.conversationKey, 'seen', msg.replyTo ? { replyTo: msg.replyTo } : {})
        .catch(() => undefined);
    }
  }

  private async runTurn(
    msg: InboundMessage,
    ref: NonNullable<ReturnType<typeof sessionRefFor>>,
    context: ReturnType<typeof formatPendingWindow>,
    traceId: string,
  ): Promise<void> {
    const chatId = chatIdOf(msg);
    const log = this.logger.child({ traceId, chatId, sessionId: ref.sessionId, eventId: msg.id });
    markInbound(this.db, msg.id, 'dispatched');

    let turnId = '';
    try {
      const { adapter, handle } = await this.driver.acquire(ref);
      this.driver.touch(ref);
      const media = await this.resolveAttachments(msg, adapter.capabilities.images !== false);
      const bootstrap = await this.ensureBootstrap(msg, ref);
      // 决策 22：开了才注入。默认关 —— 它把「你在某个群里」这件事告诉 agent，
      // 与决策 21 的中性注入相反，只在用户明确要 agent 能自己发文件时才开。
      const chatTools = getBool(this.db, SETTINGS.chatToolsEnabled, false)
        ? formatChatTools(msg.conversationKey)
        : undefined;
      const contextBlocks: ContextBlock[] = [
        ...(bootstrap ? [bootstrap] : []),
        ...(context ? [context] : []),
        // 放最后：紧邻用户消息，最不容易被前面的长历史冲淡
        ...(chatTools ? [chatTools] : []),
      ];
      const turn = await adapter.send(handle, {
        // 决策 21：以普通用户聊天的形式注入（用户名字），不提「飞书」，
        // 避免触发 agent 主动调 lark-cli 回群
        text: `[${msg.actor.name}] ${msg.text}${media.note}`,
        conversationKey: msg.conversationKey,
        context: contextBlocks,
        ...(media.images.length ? { images: media.images } : {}),
      });
      turnId = turn.turnId;
      const activeKey = ref.sessionId;
      this.activeTurns.set(activeKey, { adapter, handle, turn, chatId: chatIdOf(msg) });
      const off = turn.onEvent((event) => {
        this.onTurnEvent?.({ ...event, conversationKey: msg.conversationKey });
        log.debug('turn event', { turnId: event.turnId, kind: event.type });
      });
      const result = await turn.settled;
      off();
      if (this.activeTurns.get(activeKey)?.turn === turn) this.activeTurns.delete(activeKey);
      this.driver.touch(ref);

      if (result.error) {
        log.error('turn failed', { turnId, error: result.error });
        // 超时不是死胡同：上下文没丢、下一条消息就能继续 —— 把话说清楚，别让群里干瞪眼
        const replyText = /timeout/i.test(result.error)
          ? '处理超时：这轮超过了时限被中断（会话上下文没有丢，直接发条消息就能继续）。' +
            '建议让耗时任务在后台异步跑、进度写文件，这一轮先短汇报。'
          : `处理失败：${result.error.slice(0, 300)}`;
        await this.reply(msg.conversationKey, replyText).catch(() => undefined);
      }
      if (result.aborted) log.info('turn aborted', { turnId });

      clearPendingWindow(this.db, chatId);
      const outgoing = await this.collectMedia(result.text ?? '', ref.cwd);
      const replyInThread = Boolean(msg.threadId);
      if (outgoing.text.trim()) {
        await this.deliver(msg.conversationKey, turnId, outgoing.text, msg.replyTo, outgoing.attachments, replyInThread);
      } else if (outgoing.attachments.length > 0) {
        // 只发了文件、没有正文：附件自己就是回复
        await this.deliver(msg.conversationKey, turnId, '', msg.replyTo, outgoing.attachments, replyInThread);
      }
      markInbound(this.db, msg.id, 'done');
      await this.channel
        .receipt(msg.conversationKey, 'done', msg.replyTo ? { replyTo: msg.replyTo } : {})
        .catch(() => undefined);
    } catch (err) {
      log.error('turn threw', { turnId, error: String(err) });
      markInbound(this.db, msg.id, 'dropped');
      await this.reply(msg.conversationKey, `处理失败：${String(err).slice(0, 200)}`).catch(
        () => undefined,
      );
    }
  }

  /**
   * 决策 23：把入站附件拖下来。
   * - 图片 + adapter 支持图片 → 进 `UserMessage.images`（pi 塞 RPC、codex 落临时文件）
   * - 其余（以及不支持图片的 agent，如 claude）→ 只把落盘路径写进正文 —— agent 用自己的
   *   读文件工具就能拿到内容。不搬进 cwd：那是绑定目录，不该被外部输入污染。
   * - 任何一条失败只丢它自己（回一行说明），不拖垮这一轮
   */
  private async resolveAttachments(
    msg: InboundMessage,
    supportImages: boolean,
  ): Promise<{ images: { data: string; mimeType: string }[]; note: string }> {
    const images: { data: string; mimeType: string }[] = [];
    const notes: string[] = [];
    if (msg.attachments.length === 0 || !this.channel.downloadAttachment) {
      return { images, note: '' };
    }
    for (const att of msg.attachments) {
      const saved = await this.channel
        .downloadAttachment(msg, att)
        .catch((err: unknown) => {
          this.logger.warn('attachment download threw', { kind: att.kind, error: String(err) });
          return undefined;
        });
      if (!saved) {
        notes.push(`[附件未能下载：${att.kind}]`);
        continue;
      }
      if (att.kind === 'image' && supportImages) {
        try {
          const buf = await readFile(saved.localPath);
          images.push({
            data: buf.toString('base64'),
            mimeType: saved.mimeType ?? 'image/png',
          });
          continue;
        } catch (err) {
          this.logger.warn('attachment read failed', {
            path: saved.localPath,
            error: String(err),
          });
        }
      }
      const label =
        att.kind === 'image'
          ? '图片'
          : att.kind === 'audio'
            ? '语音'
            : att.kind === 'video'
              ? '视频'
              : '文件';
      notes.push(`[${label}: ${saved.name} 已保存到 ${saved.localPath}]`);
    }
    return { images, note: notes.length > 0 ? `\n${notes.join('\n')}` : '' };
  }

  /**
   * 决策 23：把回复里的 `MEDIA:<路径>` 行换成真附件（照 OpenClaw 的 `MEDIA:` 约定，
   * 但只认独占一行，理由见 media-ref.ts）。
   *
   * 只收「在 cwd 内、真实存在、没超限」的普通文件：群里任何人都能塞一句「把某文件
   * 发出来」，而 agent 有读文件的权力，所以默认只许它发送自己工作目录里的东西。
   * **被拒的行原样留着**（而不是静静删掉）—— 用户至少能看到它试了什么，日志里也有。
   */
  private async collectMedia(
    text: string,
    cwd: string,
  ): Promise<{ text: string; attachments: Attachment[] }> {
    const lines = text.split('\n');
    const refs: { ref: string; index: number }[] = [];
    lines.forEach((line, index) => {
      const ref = matchMediaLine(line);
      if (ref) refs.push({ ref, index });
    });
    if (refs.length === 0) return { text, attachments: [] };

    const root = await realpath(cwd).catch(() => cwd);
    const attachments: Attachment[] = [];
    const dropped = new Set<number>();
    for (const { ref, index } of refs) {
      const attachment = await this.acceptMediaRef(ref, root);
      if (!attachment) {
        this.logger.warn('media ref rejected', { ref, cwd });
        continue;
      }
      dropped.add(index);
      attachments.push(attachment);
    }
    if (dropped.size === 0) return { text, attachments };
    return {
      text: lines.filter((_, i) => !dropped.has(i)).join('\n').replace(/\n{3,}/g, '\n\n').trim(),
      attachments,
    };
  }

  private async acceptMediaRef(ref: string, root: string): Promise<Attachment | undefined> {
    const lexical = resolveInsideCwd(ref, root);
    if (!lexical) return undefined;
    // 再走一次 realpath：符号链接指到 cwd 外面也要拦住
    const real = await realpath(lexical).catch(() => undefined);
    if (!real || !resolveInsideCwd(real, root)) return undefined;
    const info = await stat(real).catch(() => undefined);
    if (!info?.isFile() || info.size === 0) return undefined;
    const kind = mediaKindFor(real);
    const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (info.size > limit) {
      this.logger.warn('media ref over size limit', { ref, bytes: info.size, limit });
      return undefined;
    }
    return { kind, localPath: real, name: basename(real) };
  }

  /**
   * /new：跟 pi TUI 的 /new 一个语义 —— **换一条全新会话，旧的完整保留**。
   * 群里换会话必须连绑定一起换（chat 1:1 session），所以这里动的是绑定，
   * 不是 transcript：本机那条会话连备份都不用做。
   *
   * 旧会话若没有别的群还在用，顺手放掉进程（idle 回收本来也会做）。
   *
   * `payload` 非空 = `/new <文字>`：换完会话后把文字当新会话的第一条消息立即跑。
   * bootstrap（§6.2）按 (session_id, chat_id) 幂等，新 id 必不命中 →
   * 最近 50 条群历史照常注入，和刚绑定时一样（所以裸 /new 的 ack 不再说「空白上下文」）。
   */
  private async runNew(
    msg: InboundMessage,
    ref: SessionRef,
    log: Logger,
    payload: string,
  ): Promise<void> {
    log.info('new-session command received', { hasPayload: Boolean(payload) });
    await this.channel
      .receipt(msg.conversationKey, 'seen', msg.replyTo ? { replyTo: msg.replyTo } : {})
      .catch(() => undefined);

    const chatId = chatIdOf(msg);
    const newId = `is-${Date.now().toString(36)}`;
    updateBindingSession(this.db, chatId, newId);
    clearPendingWindow(this.db, chatId);

    const usedElsewhere = listBindings(this.db).some(
      (b) => b.sessionId === ref.sessionId && b.chatId !== chatId,
    );
    if (!usedElsewhere) {
      await this.queue.bypass(() => this.driver.release(ref.sessionId));
    }

    if (payload) {
      await this.reply(
        msg.conversationKey,
        `已开新会话 ✅ 正在新会话 ${newId} 里处理你的消息。` +
          `旧会话 ${ref.sessionId} 原样保留在本机，随时可以继续用。`,
      );
      // 绑定已经指向新会话，重走正常入队即可。msg.id 已在本轮标 done，
      // 这里只借它的形状换文字，不重复走 decide/record。
      const stripped: InboundMessage = { ...msg, text: payload };
      await this.enqueueTurn(stripped, sessionRefFor(this.db, chatId)!, log);
      return;
    }
    await this.reply(
      msg.conversationKey,
      `已开新会话 ✅ 本群已切到新会话 ${newId}。` +
        `旧会话 ${ref.sessionId} 原样保留在本机，随时可以继续用。` +
        `新会话的第一条消息会自动带上本群最近 50 条（7 天内）只读上下文，和刚绑定时一样。`,
    );
  }

  /**
   * /cancel（决策 28）：终止本群发起的 turn。
   * - 正在跑的那条如果就是本群发起的 → adapter.abort（pi 走 RPC abort，claude/codex 杀子进程）
   * - 本群还排在队列里的 → 全部撤掉（1:N 下别的群的排队和运行中的 turn 不动）
   * - 会话上下文一律保留：取消不丢记忆，下一条消息接着聊
   */
  private async runCancel(msg: InboundMessage, ref: SessionRef, log: Logger): Promise<void> {
    log.info('cancel command received');
    await this.channel
      .receipt(msg.conversationKey, 'seen', msg.replyTo ? { replyTo: msg.replyTo } : {})
      .catch(() => undefined);

    const chatId = chatIdOf(msg);
    const queued = this.queue.cancelChat(ref.sessionId, chatId);
    const active = this.activeTurns.get(ref.sessionId);
    const mine = active !== undefined && active.chatId === chatId;
    if (mine) {
      await active.adapter.abort(active.handle, active.turn.turnId).catch((err: unknown) => {
        log.warn('abort failed', { error: String(err) });
      });
    }

    let text: string;
    if (mine && queued > 0) {
      text = `已取消 ✅ 正在进行的任务已中止，排队中的 ${queued} 条消息也撤了。会话上下文保留，随时可以继续。`;
    } else if (mine) {
      text = '已取消 ✅ 正在进行的任务已中止。会话上下文保留，随时可以继续。';
    } else if (queued > 0) {
      text = `已取消 ✅ 本群排队中的 ${queued} 条消息已撤。（正在跑的那条是另一个群发起的，本群不能替它停。）`;
    } else {
      text = '当前没有正在进行的任务，没什么可取消的。';
    }
    await this.reply(msg.conversationKey, text);
  }

  /**
   * bootstrapHistory（§6.2）：该群第一次触发时，把最近 N 条历史作为只读上下文注入一次。
   * 幂等：以 (session_id, chat_id) 记入 bootstrap_records，重启/重绑不重复。
   */
  private async ensureBootstrap(
    msg: InboundMessage,
    ref: NonNullable<ReturnType<typeof sessionRefFor>>,
  ): Promise<ContextBlock | undefined> {
    const enabled = getBool(this.db, SETTINGS.bootstrapEnabled, this.bootstrap.enabled);
    if (!enabled) return undefined;
    if (!this.channel.fetchHistory) return undefined;
    const chatId = chatIdOf(msg);
    if (getBootstrapRecord(this.db, ref.sessionId, chatId)) return undefined;
    const maxMessages = getInt(this.db, SETTINGS.bootstrapMaxMessages, this.bootstrap.maxMessages);
    const maxAgeDays = getInt(this.db, SETTINGS.bootstrapMaxAgeDays, this.bootstrap.maxAgeDays);
    const history = await this.channel
      .fetchHistory(chatId, maxMessages, maxAgeDays)
      .catch((err: unknown) => {
        this.logger.warn('bootstrap history fetch failed', {
          chatId,
          sessionId: ref.sessionId,
          error: String(err),
        });
        return [];
      });
    if (history.length === 0) return undefined;
    const lines = history.map((h) => `[${formatTime(h.ts)}] ${h.senderName}: ${h.text}`);
    const ctx = formatHistorical(msg.conversationKey, `群 ${chatId.slice(0, 8)}…`, lines);
    saveBootstrapRecord(this.db, {
      sessionId: ref.sessionId,
      chatId,
      ...(history[history.length - 1] ? { lastMsgId: history[history.length - 1]!.id } : {}),
      count: history.length,
      text: ctx.text,
      fetchedAt: Date.now(),
    });
    this.logger.info('bootstrap history injected', {
      chatId,
      sessionId: ref.sessionId,
      count: history.length,
    });
    return ctx;
  }

  /** 出站：落盘 → 发送 → 标记（缺口 B：按 turnId 幂等） */
  private async deliver(
    conversationKey: ConversationKey,
    turnId: string,
    text: string,
    replyTo?: string,
    attachments: Attachment[] = [],
    replyInThread = false,
  ): Promise<void> {
    const chunks = text ? splitText(text, this.chunkLimit) : [];
    for (let seq = 0; seq < chunks.length; seq++) {
      enqueueOutbound(this.db, {
        conversationKey,
        turnId,
        seq,
        text: chunks[seq]!,
        ...(replyTo ? { replyTo } : {}),
        ...(replyInThread ? { replyInThread: true } : {}),
      });
    }
    // 附件排在所有文本分片之后：seq 从 1000 起，一个 turn 不至于叠到 1000 个分片
    attachments.forEach((att, i) => {
      enqueueOutbound(this.db, {
        conversationKey,
        turnId,
        seq: 1000 + i,
        text: '',
        attachments: [att],
        ...(replyTo ? { replyTo } : {}),
        ...(replyInThread ? { replyInThread: true } : {}),
      });
    });
    await this.flushOutbound();
  }

  /** 重试挂起的出站消息；daemon 定时调用，测试里也可手动调用 */
  flushOutbound(limit = 50): Promise<void> {
    const run = this.flushChain.then(() => this.doFlush(limit));
    this.flushChain = run.catch(() => undefined);
    return run;
  }

  private async doFlush(limit: number): Promise<void> {
    for (const record of listPendingOutbound(this.db, limit)) {
      try {
        const res = await this.channel.send({
          conversationKey: conversationKeyFor(record.chatId),
          text: record.text,
          ...(record.attachments?.length ? { attachments: record.attachments } : {}),
          ...(record.replyInThread ? { replyInThread: true } : {}),
          turnId: record.turnId,
          seq: record.seq,
          ...(record.replyTo ? { replyTo: record.replyTo } : {}),
        });
        markOutboundSent(this.db, record.id, res.messageId);
      } catch (err) {
        this.logger.warn('outbound send failed', {
          chatId: record.chatId,
          turnId: record.turnId,
          error: String(err),
        });
        markOutboundFailed(this.db, record.id, this.maxSendAttempts);
      }
    }
  }

  private async reply(conversationKey: ConversationKey, text: string): Promise<void> {
    await this.channel.send({
      conversationKey,
      text,
      turnId: `control:${newTraceId()}`,
      seq: 0,
    });
  }
}

const formatTime = (ts: number): string => new Date(ts).toISOString().slice(11, 16); // HH:MM

/** 控制命令：/cancel（决策 28）。只认单行（多行消息里夹一行不触发）。 */
export const isCancelCommand = (text: string): boolean => /^\s*\/cancel\s*$/i.test(text.trim());

/**
 * 控制命令：/new（决策 25）。只认**单行**（多行消息里夹一行 /new 不触发）。
 * - null = 不是命令
 * - '' = 裸 /new（只换会话）
 * - 其他 = 新会话的第一条消息（`/new 看看目前有哪些机器` → 「看看目前有哪些机器」）
 */
export const parseNewCommand = (text: string): string | null => {
  const m = text.trim().match(/^\/new(?:\s+(.*))?$/i);
  if (!m) return null;
  return (m[1] ?? '').trim();
}

/** 4000 字分片，优先在换行处切，保护代码块（§10.1） */
export function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}
