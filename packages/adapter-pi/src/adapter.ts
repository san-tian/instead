import {
  createLogger,
  newTurnId,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentSessionHandle,
  type HistoryEntry,
  type Logger,
  type ModelInfo,
  type SessionRef,
  type StartOptions,
  type TurnEvent,
  type TurnHandle,
  type TurnResult,
  type UserMessage,
} from '@instead/core';
import { PiRpcClient, type PiEvent } from './rpc-client.ts';
import { lazyServers, readMcpServers } from './mcp-config.ts';

export interface PiAdapterOptions {
  command?: string;
  /** 显式指定 pi 的 session 目录；默认不传，让 pi 用项目默认目录，这样 TUI 能 `pi --session <id>` 接回 */
  sessionDir?: string;
  /**
   * 默认 **false**：保留用户全部扩展。
   * 不要因为冷启动慢就关掉 —— 它会把 pi-subagents / pi-web-access 一起干掉（见 DESIGN §11.10）。
   * 真要隔离时才设为 true。
   */
  isolateExtensions?: boolean;
  /** 需要显式加载的扩展路径（M0b 的 instead 扩展） */
  extensionPaths?: string[];
  /**
   * 默认 true：session 就绪后，对非 eager 的 MCP server 发 `/mcp:start <name>`。
   * 这样 lazy server 的工具照常可用，而启动路径不被阻塞（spike 2 实测：扩展命令不触发 LLM）。
   */
  prestartMcp?: boolean;
  defaultModel?: string;
  /** 会话级系统提示（`--append-system-prompt`，决策 21：回复契约） */
  appendSystemPrompt?: string;
  extraArgs?: string[];
  /** 额外环境变量（如 PI_CODING_AGENT_DIR），与 process.env 合并 */
  env?: Record<string, string>;
  turnTimeoutMs?: number;
  logger?: Logger;
}

interface ActiveTurn {
  turnId: string;
  listeners: Set<(event: TurnEvent) => void>;
  settle: (result: TurnResult) => void;
  done: boolean;
  text: string;
  aborted: boolean;
  timer: NodeJS.Timeout;
}

interface PiSession {
  ref: SessionRef;
  client: PiRpcClient;
  sessionFile?: string;
  current?: ActiveTurn;
  off?: () => void;
}

const extractText = (message: unknown): string => {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = block as { type?: string; text?: string };
      return b.type === 'text' ? (b.text ?? '') : '';
    })
    .join('');
};

/**
 * pi 的 AgentAdapter：一个 session 一个 `pi --mode rpc` 子进程。
 * 协议细节见 docs/spikes/01-pi-rpc.md。
 */
export class PiAdapter implements AgentAdapter {
  readonly id = 'pi' as const;
  readonly capabilities: AgentCapabilities = {
    persistent: true,
    steer: true,
    liveAttach: 'in-proc',
    approvals: false,
    // pi RPC 支持 set_model，可运行时切换（不用重启进程）
    modelSwitch: 'runtime',
    sessionIdSemantics: 'logical',
    images: true,
  };

  private readonly opts: PiAdapterOptions;
  private readonly logger: Logger;
  private readonly sessions = new Map<string, PiSession>();
  private probeModels?: { at: number; value: ModelInfo[] };

  constructor(opts: PiAdapterOptions = {}) {
    this.opts = opts;
    this.logger = opts.logger ?? createLogger({ svc: 'adapter-pi' });
  }

  async start(opts: StartOptions): Promise<AgentSessionHandle> {
    const args = ['--mode', 'rpc'];
    if (this.opts.isolateExtensions ?? false) args.push('--no-extensions');
    for (const ext of this.opts.extensionPaths ?? []) args.push('-e', ext);
    if (this.opts.sessionDir) args.push('--session-dir', this.opts.sessionDir);
    if (opts.sessionId) args.push('--session-id', opts.sessionId);
    const model = opts.model ?? this.opts.defaultModel;
    if (model) args.push('--model', model);
    if (this.opts.appendSystemPrompt) {
      args.push('--append-system-prompt', this.opts.appendSystemPrompt);
    }
    args.push(...(this.opts.extraArgs ?? []));

    this.logger.info('starting pi rpc', { cwd: opts.cwd, args: args.join(' ') });
    const client = new PiRpcClient({
      command: this.opts.command,
      args,
      cwd: opts.cwd,
      logger: this.logger,
      ...(this.opts.env ? { env: this.opts.env } : {}),
    });
    const stats = (await client.request('get_session_stats')) as {
      sessionId?: string;
      sessionFile?: string;
    };
    // 「接管已有会话」失败时 pi 会**静默**新建一条同 id 的空会话（只写 stderr），
    // 症状是飞书那边「绑了会话但完全没有上下文」，所以这里硬失败。
    if (opts.expectExisting) {
      if (!client.missingSession()) await client.settleStderr();
      const missing = client.missingSession();
      if (missing) {
        await client.close();
        throw new Error(
          `pi 在 ${opts.cwd} 下找不到会话 ${missing}（--session-id 只查当前项目目录）。` +
            '会话文件里记录的 cwd 与绑定的目录不一致时就会这样。' +
            '直接继续只会得到一条同 id 的空会话；因此这里中止，也还没发过任何消息，' +
            '所以磁盘上不会留下痕迹。',
        );
      }
    }
    const sessionId = stats?.sessionId ?? opts.sessionId ?? newTurnId();
    const ref: SessionRef = { agent: 'pi', sessionId, cwd: opts.cwd, driver: 'daemon' };
    this.sessions.set(sessionId, { ref, client, ...(stats?.sessionFile ? { sessionFile: stats.sessionFile } : {}) });
    this.logger.info('pi session ready', { sessionId, sessionFile: stats?.sessionFile });
    if ((this.opts.prestartMcp ?? true) && !(this.opts.isolateExtensions ?? false)) {
      this.prestartMcpServers(client, opts.cwd);
    }
    return { ref, capabilities: this.capabilities };
  }

  /** 非阻塞地把 lazy MCP server 拉起来：命令会异步执行，失败只记日志 */
  private prestartMcpServers(client: PiRpcClient, cwd: string): void {
    const servers = readMcpServers(cwd);
    const names = lazyServers(servers);
    if (names.length === 0) return;
    this.logger.info('prestarting lazy mcp servers', { servers: names.join(',') });
    for (const name of names) client.write({ type: 'prompt', message: `/mcp:start ${name}` });
  }

  async send(handle: AgentSessionHandle, msg: UserMessage): Promise<TurnHandle> {
    const session = this.requireSession(handle);
    const turnId = newTurnId();
    const listeners = new Set<(event: TurnEvent) => void>();
    let settle!: (result: TurnResult) => void;
    const settled = new Promise<TurnResult>((res) => {
      settle = res;
    });
    const timeoutMs = this.opts.turnTimeoutMs ?? 10 * 60 * 1000;
    const active: ActiveTurn = {
      turnId,
      listeners,
      settle,
      done: false,
      text: '',
      aborted: false,
      timer: setTimeout(() => {
        this.logger.warn('turn timeout', { turnId, sessionId: session.ref.sessionId });
        // 决策 33：超时也要叫停 pi 侧。不 abort 的话 pi 会继续跑完旧 turn，
        // 之后的每条消息都被 pi 拒成「Agent is already processing」（线上踩过）。
        session.client.write({ type: 'abort' });
        void this.finish(session, active, { error: 'turn timeout' });
      }, timeoutMs),
    };
    session.current = active;
    session.off = session.client.onEvent((event) => this.onEvent(session, active, event));

    const payload: Record<string, unknown> = { message: buildPrompt(msg) };
    if (msg.images?.length) {
      payload.images = msg.images.map((img) => ({
        type: 'image',
        data: img.data,
        mimeType: img.mimeType,
      }));
    }
    try {
      await session.client.request('prompt', payload);
    } catch (err) {
      // 决策 33：上一轮超时/被中止后 pi 可能还没停 —— prompt 会被拒
      // 「Agent is already processing」。按 pi 的提示用 streamingBehavior:
      // 'followUp' 排队（等 pi 处理完旧 turn 再接我们的消息），而不是把会话卡死。
      if (/already processing/i.test(String(err)) && !('streamingBehavior' in payload)) {
        this.logger.warn('pi busy, requeueing with followUp', { turnId, sessionId: session.ref.sessionId });
        try {
          await session.client.request('prompt', { ...payload, streamingBehavior: 'followUp' });
        } catch (err2) {
          await this.finish(session, active, { error: String(err2) });
        }
      } else {
        await this.finish(session, active, { error: String(err) });
      }
    }

    return {
      turnId,
      settled,
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  async abort(handle: AgentSessionHandle, turnId: string): Promise<void> {
    const session = this.requireSession(handle);
    const active = session.current;
    if (!active || active.turnId !== turnId) return;
    active.aborted = true;
    this.logger.info('aborting turn', { turnId });
    session.client.write({ type: 'abort' });
    // 兜底：abort 后没等到 agent_settled 就强制收尾
    setTimeout(() => {
      if (session.current === active) {
        void this.finish(session, active, { aborted: true });
      }
    }, 5000);
  }

  async stop(handle: AgentSessionHandle): Promise<void> {
    const session = this.sessions.get(handle.ref.sessionId);
    if (!session) return;
    this.sessions.delete(handle.ref.sessionId);
    if (session.current) {
      clearTimeout(session.current.timer);
      session.current.done = true;
      session.current.settle({ text: session.current.text, aborted: true });
    }
    session.off?.();
    await session.client.close();
    this.logger.info('pi session stopped', { sessionId: session.ref.sessionId });
  }

  async *history(handle: AgentSessionHandle, cursor?: string): AsyncIterable<HistoryEntry> {    const session = this.requireSession(handle);
    const data = (await session.client.request(
      'get_entries',
      cursor ? { since: cursor } : {},
    )) as { entries?: Record<string, unknown>[] };
    for (const entry of data?.entries ?? []) {
      if (entry.type !== 'message') continue;
      const message = entry.message as { role?: string; content?: unknown } | undefined;
      const role = message?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      yield {
        id: String(entry.id),
        role,
        text: extractText(message),
        ...(entry.timestamp ? { ts: Date.parse(String(entry.timestamp)) } : {}),
      };
    }
  }

  /** pi 的 `get_available_models`；不传 handle 时用一个临时进程探测（带缓存） */
  async models(handle?: AgentSessionHandle): Promise<ModelInfo[]> {
    if (handle) {
      const session = this.requireSession(handle);
      const data = (await session.client.request('get_available_models')) as {
        models?: Array<{ id?: string; name?: string; provider?: string }>;
      };
      return mapModels(data);
    }
    if (this.probeModels && Date.now() - this.probeModels.at < 5 * 60 * 1000) {
      return this.probeModels.value;
    }
    // 探测进程刻意隔离扩展，避免 eager MCP 拖慢（spike 1）
    const client = new PiRpcClient({
      command: this.opts.command,
      args: ['--mode', 'rpc', '--no-session', '--no-extensions'],
      cwd: process.cwd(),
      logger: this.logger,
    });
    try {
      await client.request('get_session_stats');
      const data = (await client.request('get_available_models')) as {
        models?: Array<{ id?: string; name?: string; provider?: string }>;
      };
      const value = mapModels(data);
      this.probeModels = { at: Date.now(), value };
      return value;
    } finally {
      await client.close();
    }
  }

  /** pi 的 `set_model`；`model` 支持 `<provider>/<modelId>`，只给 modelId 时自动找 provider */
  async setModel(handle: AgentSessionHandle, model: string): Promise<void> {
    const session = this.requireSession(handle);
    let provider: string | undefined;
    let modelId = model;
    const slash = model.indexOf('/');
    if (slash > 0) {
      provider = model.slice(0, slash);
      modelId = model.slice(slash + 1);
    }
    if (!provider) {
      const found = (await this.models(handle)).find((m) => m.id === modelId);
      provider = found?.provider;
    }
    if (!provider) {
      throw new Error(`找不到模型 "${model}" 的 provider，请用 <provider>/<modelId> 形式`);
    }
    await session.client.request('set_model', { provider, modelId });
    this.logger.info('model switched', { sessionId: session.ref.sessionId, provider, modelId });
  }

  private onEvent(session: PiSession, active: ActiveTurn, event: PiEvent): void {
    if (session.current !== active || active.done) return;
    switch (event.type) {
      case 'message_update': {
        const delta = event.assistantMessageEvent as
          | { type?: string; delta?: string }
          | undefined;
        if (delta?.type === 'text_delta' && delta.delta) {
          active.text += delta.delta;
          this.emit(active, { turnId: active.turnId, type: 'delta', text: delta.delta });
        }
        break;
      }
      case 'tool_execution_start': {
        this.emit(active, {
          turnId: active.turnId,
          type: 'tool',
          text: String(event.toolName ?? 'tool'),
        });
        break;
      }
      case 'agent_settled': {
        void this.finish(session, active, { aborted: active.aborted });
        break;
      }
      default:
        break;
    }
  }

  private emit(active: ActiveTurn, event: TurnEvent): void {
    for (const listener of active.listeners) listener(event);
  }

  /** 用 `get_last_assistant_text` 作为最终文本的权威来源（spike 1） */
  private async finish(
    session: PiSession,
    active: ActiveTurn,
    outcome: { aborted?: boolean; error?: string },
  ): Promise<void> {
    if (active.done) return;
    active.done = true;
    clearTimeout(active.timer);
    session.off?.();
    session.off = undefined;
    if (session.current === active) session.current = undefined;

    let text = active.text;
    if (!outcome.error) {
      try {
        const data = (await session.client.request('get_last_assistant_text')) as {
          text?: string | null;
        };
        if (data?.text) text = data.text;
      } catch (err) {
        this.logger.warn('get_last_assistant_text failed, using streamed text', {
          error: String(err),
        });
      }
    }
    if (text) this.emit(active, { turnId: active.turnId, type: 'final', text });
    if (outcome.aborted) this.emit(active, { turnId: active.turnId, type: 'aborted' });
    if (outcome.error) {
      this.emit(active, { turnId: active.turnId, type: 'error', text: outcome.error });
    }
    active.settle({ text, aborted: Boolean(outcome.aborted), ...(outcome.error ? { error: outcome.error } : {}) });
  }

  private requireSession(handle: AgentSessionHandle): PiSession {
    const session = this.sessions.get(handle.ref.sessionId);
    if (!session) throw new Error(`pi session not started: ${handle.ref.sessionId}`);
    return session;
  }
}

export function buildPrompt(msg: UserMessage): string {
  const parts: string[] = [];
  for (const ctx of msg.context ?? []) parts.push(ctx.text);
  parts.push(msg.text);
  return parts.join('\n\n');
}

function mapModels(data: {
  models?: Array<{ id?: string; name?: string; provider?: string }>;
}): ModelInfo[] {
  return (data?.models ?? []).flatMap((m) =>
    m.id
      ? [
          {
            id: m.id,
            ...(m.name ? { label: m.name } : {}),
            ...(m.provider ? { provider: m.provider } : {}),
          },
        ]
      : [],
  );
}
