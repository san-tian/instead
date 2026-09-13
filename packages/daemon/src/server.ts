import {
  BindError,
  createLogger,
  deleteBinding,
  getBinding,
  insertBinding,
  issueBindCode,
  listBindings,
  newBindCode,
  paths,
  pruneExpiredBindCodes,
  setMirrorMode,
  SessionQueue,
  Dispatcher,
  countPendingInbound,
  getSessionModel,
  getSetting,
  getSessionAlias,
  setSessionAlias,
  defaultModelKey,
  setSessionModel,
  listSessionSettings,
  type AgentAdapter,
  type AgentId,
  type Binding,
  type Channel,
  type Db,
  type Logger,
  type MirrorMode,
} from '@instead/core';
import { IpcServer, type IpcParams } from './ipc.ts';
import { SessionPool } from './session-pool.ts';
import { UiData } from './ui-data.ts';
import { UiServer } from './http.ts';

export interface DaemonOptions {
  /** 决策 29：流式进度卡（默认开，渠道要声明 patches 能力） */
  streamProgress?: boolean;
  db: Db;
  channel: Channel;
  adapters: Partial<Record<AgentId, AgentAdapter>>;
  socketPath?: string;
  logger?: Logger;
  idleMs?: number;
  queue?: SessionQueue;
  flushIntervalMs?: number;
  sweepIntervalMs?: number;
  /** 仅测试：允许通过 IPC 注入入站事件 */
  allowInjection?: boolean;
}

export interface DaemonStatus {
  channel: string;
  bindings: number;
  sessions: number;
  pendingInbound: number;
  queueBySession: Record<string, number>;
  sessionModels: Record<string, string | undefined>;
}

/**
 * daemon：IPC + 渠道 + 会话池 + 定时任务。
 * 所有写操作走同一套 core 逻辑 —— CLI / pi 扩展 / Web 配置台都是它的前端（§4.4）。
 */
export class Daemon {
  readonly dispatcher: Dispatcher;
  readonly pool: SessionPool;
  readonly queue: SessionQueue;
  private readonly db: Db;
  private readonly channel: Channel;
  private readonly logger: Logger;
  private readonly ipc: IpcServer;
  private readonly uiData: UiData;
  private ui?: UiServer;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly allowInjection: boolean;
  private readonly flushIntervalMs: number;
  private readonly sweepIntervalMs: number;

  constructor(opts: DaemonOptions) {
    this.db = opts.db;
    this.channel = opts.channel;
    this.logger = opts.logger ?? createLogger({ svc: 'daemon' });
    this.allowInjection = opts.allowInjection ?? false;
    this.flushIntervalMs = opts.flushIntervalMs ?? 5_000;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60_000;
    this.queue = opts.queue ?? new SessionQueue({ logger: this.logger });
    this.pool = new SessionPool({
      adapters: opts.adapters,
      logger: this.logger,
      getModel: (sessionId, agent) =>
        getSessionModel(this.db, sessionId) ?? getSetting(this.db, defaultModelKey(agent)),
      resolveSessionId: (logicalId) => getSessionAlias(this.db, logicalId),
      onSessionId: (logicalId, agent, realId) =>
        setSessionAlias(this.db, logicalId, agent, realId),
      // 有别名 = 当初是按「接管已有会话」绑的（pi 写自指别名），或 adapter 已学到
      // 真实 id（claude/codex）。两种情况下这条会话都**应该已经落盘**，找不到就是错。
      expectsExisting: (logicalId) => getSessionAlias(this.db, logicalId) !== undefined,
      ...(opts.idleMs ? { idleMs: opts.idleMs } : {}),
    });
    this.dispatcher = new Dispatcher({
      db: opts.db,
      channel: opts.channel,
      driver: this.pool,
      queue: this.queue,
      logger: this.logger,
      ...(opts.streamProgress !== undefined ? { streamProgress: opts.streamProgress } : {}),
    });
    this.uiData = new UiData({
      db: opts.db,
      channel: opts.channel,
      pool: this.pool,
      flushOutbound: () => this.dispatcher.flushOutbound(),
      pendingInbound: () => countPendingInbound(this.db),
      logger: this.logger,
    });
    this.ipc = new IpcServer(
      opts.socketPath ?? paths.socket(),
      (method, params) => this.handle(method, params),
      this.logger,
    );
  }

  async start(): Promise<void> {
    await this.ipc.listen();
    await this.channel.start((msg) => {
      void this.dispatcher.handleInbound(msg).catch((err) => {
        this.logger.error('handleInbound failed', { error: String(err), eventId: msg.id });
      });
    });
    this.timers.push(
      setInterval(() => void this.dispatcher.flushOutbound(), this.flushIntervalMs),
      setInterval(() => void this.pool.sweep(), this.sweepIntervalMs),
      setInterval(() => pruneExpiredBindCodes(this.db), 60_000),
    );
    for (const t of this.timers) t.unref?.();
    this.logger.info('daemon started', { socket: paths.socket() });
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    await this.ui?.close().catch(() => undefined);
    this.ui = undefined;
    await this.channel.stop().catch(() => undefined);
    await this.pool.closeAll();
    await this.ipc.close();
    this.logger.info('daemon stopped');
  }

  status(): DaemonStatus {
    const bindings = listBindings(this.db);
    const sessions = this.pool.list();
    const queueBySession: Record<string, number> = {};
    const sessionModels: Record<string, string | undefined> = {};
    for (const s of sessions) {
      queueBySession[s.ref.sessionId] = this.queue.pendingCount(s.ref.sessionId);
      sessionModels[s.ref.sessionId] = getSessionModel(this.db, s.ref.sessionId);
    }
    return {
      channel: this.channel.id,
      bindings: bindings.length,
      sessions: sessions.length,
      pendingInbound: countPendingInbound(this.db),
      queueBySession,
      sessionModels,
    };
  }

  private async handle(method: string, params: IpcParams): Promise<unknown> {
    switch (method) {
      case 'ping':
        return { ok: true, pid: process.pid };
      case 'status':
        return this.status();
      case 'bind.list':
        return listBindings(this.db);
      case 'bind.get':
        return getBinding(this.db, String(params.chatId)) ?? null;
      case 'bind.add':
        return this.bindAdd(params);
      case 'bind.remove':
        return { removed: deleteBinding(this.db, String(params.chatId)) };
      case 'bind.code.issue':
        return this.issueCode(params);
      case 'mirror.set':
        return {
          updated: setMirrorMode(
            this.db,
            String(params.chatId),
            String(params.mode) as MirrorMode,
          ),
        };
      case 'session.list':
        return this.pool.list().map((s) => ({ ...s, model: getSessionModel(this.db, s.ref.sessionId) }));
      case 'session.release':
        return { released: await this.pool.release(String(params.sessionId)) };
      case 'session.setModel':
        return this.setModel(String(params.sessionId), params.model ? String(params.model) : undefined);
      case 'session.models':
        return this.listModels(String(params.sessionId));
      case 'doctor':
        return { checks: await this.channel.doctor() };
      case 'ui.start': {
        await this.ui?.close().catch(() => undefined);
        this.ui = new UiServer({
          data: this.uiData,
          ...(params.token ? { token: String(params.token) } : {}),
          ...(params.host ? { host: String(params.host) } : {}),
          ...(Array.isArray(params.allowHosts)
            ? { allowHosts: params.allowHosts.map(String) }
            : {}),
          ...(params.port ? { port: Number(params.port) } : {}),
          logger: this.logger,
        });
        const { url, host } = await this.ui.start();
        return { url, host };
      }
      case 'ui.stop':
        await this.ui?.close().catch(() => undefined);
        this.ui = undefined;
        return { stopped: true };
      case 'ui.status':
        return { running: Boolean(this.ui?.listening) };
      case 'channel.chats':
        return this.channel.listChats();
      case 'inbound.inject':
        if (!this.allowInjection) throw new Error('injection disabled');
        await this.dispatcher.handleInbound(params.message as never);
        return { injected: true };
      case 'shutdown':
        setTimeout(() => void this.stop(), 10).unref?.();
        return { stopping: true };
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  /** 模型：先落盘，会话在运行且 adapter 支持运行时切换就立即生效（§4.4.2） */
  private async setModel(
    sessionId: string,
    model: string | undefined,
  ): Promise<{ model?: string; applied: 'runtime' | 'next-start' }> {
    setSessionModel(this.db, sessionId, model);
    const live = this.pool.get(sessionId);
    if (!model) return { applied: 'next-start' };
    if (!live) return { model, applied: 'next-start' };
    const { adapter, handle } = live;
    if (adapter.capabilities.modelSwitch !== 'runtime' || !adapter.setModel) {
      return { model, applied: 'next-start' };
    }
    await adapter.setModel(handle, model);
    return { model, applied: 'runtime' };
  }

  private async listModels(
    sessionId: string,
  ): Promise<{ models?: unknown[]; running: boolean }> {
    const live = this.pool.get(sessionId);
    if (!live?.adapter.models) return { running: Boolean(live) };
    return { models: await live.adapter.models(live.handle), running: true };
  }

  private bindAdd(params: IpcParams): Binding {
    return insertBinding(this.db, {
      chatId: String(params.chatId),
      sessionId: String(params.sessionId),
      agent: String(params.agent ?? 'pi') as AgentId,
      cwd: String(params.cwd ?? process.cwd()),
      ownerOpenId: String(params.ownerOpenId ?? ''),
      mirrorMode: (params.mirrorMode ? String(params.mirrorMode) : 'off') as MirrorMode,
      createdAt: Date.now(),
    });
  }

  private issueCode(params: IpcParams): { code: string; expiresAt: number } {
    const sessionId = String(params.sessionId);
    const agent = String(params.agent ?? 'pi') as AgentId;
    const cwd = String(params.cwd ?? process.cwd());
    const ttlMs = params.ttlMs ? Number(params.ttlMs) : undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = newBindCode();
      try {
        const issued = issueBindCode(this.db, {
          code,
          sessionId,
          agent,
          cwd,
          ...(ttlMs ? { ttlMs } : {}),
        });
        return { code: issued.code, expiresAt: issued.expiresAt };
      } catch (err) {
        if (err instanceof BindError) throw err;
        if (String(err).includes('UNIQUE')) continue;
        throw err;
      }
    }
    throw new Error('failed to allocate a unique bind code');
  }
}
