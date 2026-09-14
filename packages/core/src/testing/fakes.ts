import { newTurnId } from '../ids.ts';
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentSessionHandle,
  ContextBlock,
  ConversationKey,
  DownloadedAttachment,
  InboundAttachment,
  InboundMessage,
  OutboundMessage,
  SessionRef,
  StartOptions,
  TurnEvent,
  TurnHandle,
  TurnResult,
  UserMessage,
} from '../types.ts';
import type { Channel, ChatInfo, DoctorCheck, HistoryMessage, OutboundResult, ReceiptKind, ReceiptOptions } from '../channel.ts';
import type { SessionDriver } from '../session-driver.ts';

export interface FakeChannelState {
  sent: OutboundMessage[];
  receipts: { conversationKey: ConversationKey; kind: ReceiptKind; opts?: ReceiptOptions }[];
  chats: ChatInfo[];
  /** 下一次 send 抛错（测试出站重试） */
  failNextSend: boolean;
}

export class FakeChannel implements Channel {
  readonly id = 'feishu' as const;
  readonly sent: OutboundMessage[] = [];
  /** 决策 29：patch 语义的调用记录（原地更新，不进 sent） */
  readonly patched: { messageId: string; text: string }[] = [];
  /** 决策 29：deleteMessage 调用记录 */
  readonly deleted: string[] = [];
  readonly receipts: { conversationKey: ConversationKey; kind: ReceiptKind; opts?: ReceiptOptions }[] = [];
  /** 渠道能力：支持原地更新（决策 29），测试可关掉验证退化路径 */
  patches = true;
  chats: ChatInfo[] = [];
  /** bootstrapHistory 用：预置的历史消息 */
  history: HistoryMessage[] = [];
  /**
   * 决策 23 测试用：按资源键预置「已下载」的结果；没预置 = 下载失败。
   * 真下载（写到哪个目录、限额）由 channel-feishu 自己覆。
   */
  readonly downloads = new Map<string, DownloadedAttachment>();
  downloadCount = 0;
  failNextSend = false;
  /** 每次 send 挂多久（测试并发 flush 竞态） */
  sendDelayMs = 0;
  private onInbound?: (msg: InboundMessage) => void;

  async start(onInbound: (msg: InboundMessage) => void): Promise<void> {
    this.onInbound = onInbound;
  }
  async stop(): Promise<void> {
    this.onInbound = undefined;
  }
  async send(msg: OutboundMessage): Promise<OutboundResult> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('fake channel send failed');
    }
    if (this.sendDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.sendDelayMs));
    }
    if (msg.patch) {
      this.patched.push({ messageId: msg.patch, text: msg.text });
      return { messageId: msg.patch };
    }
    this.sent.push(msg);
    return { messageId: `fake-msg-${this.sent.length}` };
  }
  async deleteMessage(messageId: string): Promise<void> {
    this.deleted.push(messageId);
  }
  async receipt(
    key: ConversationKey,
    kind: ReceiptKind,
    opts?: ReceiptOptions,
  ): Promise<void> {
    this.receipts.push({ conversationKey: key, kind, ...(opts ? { opts } : {}) });
  }
  async listChats(): Promise<ChatInfo[]> {
    return this.chats;
  }
  async downloadAttachment(
    _msg: InboundMessage,
    att: InboundAttachment,
  ): Promise<DownloadedAttachment | undefined> {
    this.downloadCount += 1;
    return this.downloads.get(att.key);
  }
  async fetchHistory(_chatId: string, limit: number): Promise<HistoryMessage[]> {
    return this.history.slice(-limit);
  }
  async doctor(): Promise<DoctorCheck[]> {
    return [{ id: 'fake', ok: true }];
  }
  /** 测试投递入站事件 */
  async inject(msg: InboundMessage): Promise<void> {
    await this.onInbound?.(msg);
  }
  textsFor(conversationKey: ConversationKey): string[] {
    return this.sent.filter((m) => m.conversationKey === conversationKey).map((m) => m.text);
  }
}

export interface FakeAdapterOptions {
  reply?: string | ((msg: UserMessage) => string);
  /** 每个 turn 的耗时，用来制造排队场景 */
  delayMs?: number;
  /** 决策 29 测试用：turn 里逐个 emit 的 delta（间隔 deltaMs），最后接 final */
  deltas?: string[];
  deltaMs?: number;
  fail?: boolean;
  /** 失败时结算的错误文本（默认 'fake failure'）—— 超时路径测试用 */
  failError?: string;
  sessionId?: string;
  /** 图片输入能力（决策 26），默认 true（像 pi/codex） */
  images?: boolean;
}

interface ActiveTurn {
  turnId: string;
  listeners: Set<(e: TurnEvent) => void>;
  settle: (r: TurnResult) => void;
  done: boolean;
}

export class FakeAdapter implements AgentAdapter {
  readonly id = 'pi' as const;
  readonly capabilities: AgentCapabilities = {
    persistent: true,
    steer: false,
    liveAttach: 'lease',
    approvals: false,
    modelSwitch: 'restart',
    sessionIdSemantics: 'logical',
    images: true,
  };
  readonly received: UserMessage[] = [];
  readonly aborted: string[] = [];
  readonly contexts: ContextBlock[] = [];
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly reply: string | ((msg: UserMessage) => string);
  private readonly delayMs: number;
  private readonly deltas?: string[];
  private readonly deltaMs: number;
  private readonly fail: boolean;
  private readonly failError?: string;
  private readonly sessionId: string;
  private started = 0;
  /** 每次 start 的入参，便于断言池子往里传了什么 */
  readonly startCalls: StartOptions[] = [];

  constructor(opts: FakeAdapterOptions = {}) {
    this.reply = opts.reply ?? 'fake reply';
    this.delayMs = opts.delayMs ?? 0;
    this.deltas = opts.deltas;
    this.deltaMs = opts.deltaMs ?? 10;
    this.fail = opts.fail ?? false;
    this.failError = opts.failError;
    this.sessionId = opts.sessionId ?? 'fake-session';
    this.capabilities = { ...this.capabilities, images: opts.images ?? true };
  }

  async start(opts: StartOptions): Promise<AgentSessionHandle> {
    this.started += 1;
    this.startCalls.push(opts);
    return {
      ref: {
        agent: 'pi',
        sessionId: opts.sessionId ?? this.sessionId,
        cwd: opts.cwd,
        driver: 'daemon',
      },
      capabilities: this.capabilities,
    };
  }

  async send(handle: AgentSessionHandle, msg: UserMessage): Promise<TurnHandle> {
    this.received.push(msg);
    for (const c of msg.context ?? []) this.contexts.push(c);
    const turnId = newTurnId();
    const listeners = new Set<(e: TurnEvent) => void>();
    let settle!: (r: TurnResult) => void;
    const settled = new Promise<TurnResult>((res) => {
      settle = res;
    });
    const active: ActiveTurn = { turnId, listeners, settle, done: false };
    this.turns.set(turnId, active);
    const emit = (e: TurnEvent): void => {
      for (const l of listeners) l(e);
    };
    const finish = (r: TurnResult): void => {
      if (active.done) return;
      active.done = true;
      this.turns.delete(turnId);
      active.settle(r);
    };

    setTimeout(() => {
      if (active.done) return;
      const key = msg.conversationKey ?? ('feishu:chat:unknown' as ConversationKey);
      emit({ turnId, conversationKey: key, type: 'started' });
      if (this.deltas && this.deltas.length > 0) {
        let i = 0;
        const t = setInterval(() => {
          if (active.done) {
            clearInterval(t);
            return;
          }
          if (i < this.deltas!.length) {
            emit({ turnId, conversationKey: key, type: 'delta', text: this.deltas![i++] });
          } else {
            clearInterval(t);
            if (this.fail) {
              const err = this.failError ?? 'fake failure';
              emit({ turnId, conversationKey: key, type: 'error', text: err });
              finish({ text: '', aborted: false, error: err });
            } else {
              const text = typeof this.reply === 'function' ? this.reply(msg) : this.reply;
              emit({ turnId, conversationKey: key, type: 'final', text });
              finish({ text, aborted: false });
            }
          }
        }, this.deltaMs ?? 10);
        return;
      }
      if (this.fail) {
        const err = this.failError ?? 'fake failure';
        emit({ turnId, conversationKey: key, type: 'error', text: err });
        finish({ text: '', aborted: false, error: err });
        return;
      }
      const text = typeof this.reply === 'function' ? this.reply(msg) : this.reply;
      emit({ turnId, conversationKey: key, type: 'delta', text });
      emit({ turnId, conversationKey: key, type: 'final', text });
      finish({ text, aborted: false });
    }, this.delayMs);

    return {
      turnId,
      settled,
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  async abort(_handle: AgentSessionHandle, turnId: string): Promise<void> {
    this.aborted.push(turnId);
    const active = this.turns.get(turnId);
    if (active && !active.done) {
      active.done = true;
      this.turns.delete(turnId);
      active.settle({ text: '', aborted: true });
    }
  }

  async stop(): Promise<void> {
    for (const [id, active] of this.turns) {
      active.done = true;
      active.settle({ text: '', aborted: true });
      this.turns.delete(id);
    }
  }

  get startCount(): number {
    return this.started;
  }
  get activeTurns(): number {
    return this.turns.size;
  }
}

/** 测试用 SessionDriver：一个 adapter 服务所有 session（记录 ref 用于断言） */
export class FakeDriver implements SessionDriver {
  readonly acquired: SessionRef[] = [];
  readonly touched: SessionRef[] = [];
  readonly released: string[] = [];
  readonly adapter: AgentAdapter;

  constructor(adapter: AgentAdapter) {
    this.adapter = adapter;
  }

  async acquire(ref: SessionRef): Promise<{ adapter: AgentAdapter; handle: AgentSessionHandle }> {
    this.acquired.push(ref);
    const handle = await this.adapter.start({ cwd: ref.cwd, sessionId: ref.sessionId });
    return { adapter: this.adapter, handle };
  }
  touch(ref: SessionRef): void {
    this.touched.push(ref);
  }
  async release(sessionId: string): Promise<boolean> {
    this.released.push(sessionId);
    return true;
  }
}
