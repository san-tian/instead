import { createLogger, type Logger } from './logger.ts';

export interface QueueOptions {
  /** 每个 chat 的排队上限（§9.1），含正在执行的那条 */
  maxPerChat?: number;
  /** 排队过期时间，超时丢弃并告知群里 */
  expiryMs?: number;
  logger?: Logger;
}

export interface EnqueueResult {
  /** 本任务前面还有几个（0 = 立刻执行） */
  ahead: number;
  /** 因排队上限被丢弃 */
  dropped: boolean;
}

interface Pending {
  chatId: string;
  enqueuedAt: number;
  run: () => Promise<void>;
  onDrop?: (reason: 'overflow' | 'expired' | 'cancelled') => void;
}

const chatKey = (sessionId: string, chatId: string): string => `${sessionId}\u0000${chatId}`;

/**
 * 按 `session_id` 串行（§9：不是按 chat —— 1:N 下按 chat 会让两个群并发驱动同一条会话）。
 * chat 只用于入站顺序与排队回执。
 */
export class SessionQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, Pending[]>();
  /** 正在执行的任务数（每个 session 最多 1） */
  private readonly inflight = new Map<string, number>();
  /** 每个 chat 正在执行 + 排队的数量 */
  private readonly perChat = new Map<string, number>();
  private readonly opts: Required<Omit<QueueOptions, 'logger'>> & { logger: Logger };

  constructor(opts: QueueOptions = {}) {
    this.opts = {
      maxPerChat: opts.maxPerChat ?? 20,
      expiryMs: opts.expiryMs ?? 10 * 60 * 1000,
      logger: opts.logger ?? createLogger({ svc: 'queue' }),
    };
  }

  /** 入队。返回它前面排了多少条（含正在执行的那条），用于「排队中（前面 N 条）」回执。 */
  enqueue(sessionId: string, task: Pending): EnqueueResult {
    this.evictExpired(sessionId);
    const list = this.pending.get(sessionId) ?? [];
    const sameChat = this.perChat.get(chatKey(sessionId, task.chatId)) ?? 0;
    if (sameChat >= this.opts.maxPerChat) {
      this.opts.logger.warn('queue overflow, dropping task', {
        sessionId,
        chatId: task.chatId,
      });
      task.onDrop?.('overflow');
      return { ahead: list.length, dropped: true };
    }
    const ahead = (this.inflight.get(sessionId) ?? 0) + list.length;
    list.push(task);
    this.pending.set(sessionId, list);
    this.perChat.set(chatKey(sessionId, task.chatId), sameChat + 1);
    void this.drain(sessionId);
    return { ahead, dropped: false };
  }

  /** 控制类消息（/stop 等）旁路，不排队（缺口 A） */
  async bypass<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  /**
   * /cancel（决策 28）：撤掉某 chat 还没开跑的排队任务（正在跑的那条由 dispatcher
   * 直接 abort，不在这里）。只撤这个 chat 的 —— 1:N 下别的群排的队不能动。
   * 返回撤掉了几条。
   */
  cancelChat(sessionId: string, chatId: string): number {
    const list = this.pending.get(sessionId);
    if (!list?.length) return 0;
    let removed = 0;
    const keep: Pending[] = [];
    for (const p of list) {
      if (p.chatId === chatId) {
        this.decPerChat(sessionId, chatId);
        p.onDrop?.('cancelled');
        removed++;
      } else {
        keep.push(p);
      }
    }
    this.pending.set(sessionId, keep);
    if (removed > 0) {
      this.opts.logger.info('cancel command dropped queued tasks', { sessionId, chatId, removed });
    }
    return removed;
  }

  pendingCount(sessionId: string): number {
    return (this.inflight.get(sessionId) ?? 0) + (this.pending.get(sessionId)?.length ?? 0);
  }

  pendingForChat(sessionId: string, chatId: string): number {
    return this.perChat.get(chatKey(sessionId, chatId)) ?? 0;
  }

  /** 等待某条 session 的队列排空（测试用） */
  async idle(sessionId: string): Promise<void> {
    for (;;) {
      const chain = this.chains.get(sessionId);
      if (!chain) return;
      await chain;
    }
  }

  private evictExpired(sessionId: string): void {
    const list = this.pending.get(sessionId);
    if (!list?.length) return;
    const now = Date.now();
    const keep: Pending[] = [];
    for (const p of list) {
      if (now - p.enqueuedAt > this.opts.expiryMs) {
        this.opts.logger.warn('queue expired, dropping task', { sessionId, chatId: p.chatId });
        this.decPerChat(sessionId, p.chatId);
        p.onDrop?.('expired');
      } else {
        keep.push(p);
      }
    }
    this.pending.set(sessionId, keep);
  }

  private decPerChat(sessionId: string, chatId: string): void {
    const k = chatKey(sessionId, chatId);
    const next = (this.perChat.get(k) ?? 1) - 1;
    if (next <= 0) this.perChat.delete(k);
    else this.perChat.set(k, next);
  }

  private drain(sessionId: string): Promise<void> {
    const existing = this.chains.get(sessionId);
    if (existing) return existing;
    const chain = (async () => {
      for (;;) {
        const list = this.pending.get(sessionId);
        const next = list?.shift();
        if (!next) break;
        this.inflight.set(sessionId, (this.inflight.get(sessionId) ?? 0) + 1);
        try {
          await next.run();
        } catch (err) {
          this.opts.logger.error('queue task failed', {
            sessionId,
            chatId: next.chatId,
            error: String(err),
          });
        } finally {
          this.inflight.set(sessionId, (this.inflight.get(sessionId) ?? 1) - 1);
          if ((this.inflight.get(sessionId) ?? 0) <= 0) this.inflight.delete(sessionId);
          this.decPerChat(sessionId, next.chatId);
        }
      }
      this.chains.delete(sessionId);
      // 竞态：删除瞬间可能有新任务入队，需要重新拉起
      if ((this.pending.get(sessionId)?.length ?? 0) > 0) void this.drain(sessionId);
    })();
    this.chains.set(sessionId, chain);
    return chain;
  }
}
