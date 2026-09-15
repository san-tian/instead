import {
  BindError,
  defaultModelKey,
  deleteBindCode,
  deleteBinding,
  discardOutbound,
  getBool,
  getInt,
  getSessionModel,
  getSessionAlias,
  getSetting,
  insertBinding,
  issueBindCode,
  listBindCodes,
  listBindings,
  listPendingOutbound,
  newBindCode,
  setSessionAlias,
  setSetting,
  setSessionModel,
  SETTINGS,
  type AgentId,
  type Binding,
  type Channel,
  type ChatMember,
  type Db,
  type DoctorCheck,
  type Logger,
  type MirrorMode,
  type ModelInfo,
} from '@instead/core';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { SessionPool } from './session-pool.ts';

export interface UiDirListing {
  path: string;
  parent?: string;
  dirs: { name: string; path: string }[];
}

/** 目录选择器可浏览的根：默认只有 `$HOME`，需要别的就设 `INSTEAD_FS_ROOTS`（冒号分隔） */
export function fsRoots(env = process.env): string[] {
  const raw = env.INSTEAD_FS_ROOTS?.trim();
  const list = raw
    ? raw
        .split(':')
        .map((p) => p.trim())
        .filter(Boolean)
    : [homedir()];
  return list.map((p) => resolve(expandHome(p)));
}

/** `~/RSI` 这种写法得能用 —— 手输路径的人一定会这么写 */
export function expandHome(input: string, home = homedir()): string {
  if (input === '~') return home;
  return input.startsWith('~/') ? join(home, input.slice(2)) : input;
}

function isInsideRoots(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * 手输路径 → 绝对路径。空字符串 = 「给我第一个根」（首次打开）。
 * 纯函数，便于测试：真实路径检查（存不存在/是不是目录）留给 `listDirs`。
 */
export function resolveBrowsePath(input: string | undefined, roots: string[]): string {
  const requested = input?.trim();
  const path = requested ? resolve(expandHome(requested)) : roots[0]!;
  if (!isInsideRoots(path, roots)) {
    throw new UiPathError(
      'outside_roots',
      `只能浏览 ${roots.join('、')} 下的目录；要放开别的请给 daemon 设 INSTEAD_FS_ROOTS`,
    );
  }
  return path;
}

/**
 * 接管已有会话时写别名（§10.4.1）。**opaque 语义（claude/codex）的别名可能是学到的
 * 真实 id** —— 覆盖成自指会让 resume 指向一个不存在的 thread（实测踩过：rebind 时
 * 传逻辑 id，把 codex-test → 01a086e8 抹成了 codex-test → codex-test）。
 * 规则：pi 直接写（无害且更明确）；opaque 只有没有别名时才写。
 */
export function upsertResumeAlias(db: Db, agent: AgentId, sessionId: string): void {
  if (agent === 'pi' || !getSessionAlias(db, sessionId)) {
    setSessionAlias(db, sessionId, agent, sessionId);
  }
}

/** 目录选择器的参数错误：HTTP 层拿它回 400，而不是静默退回 HOME */
export class UiPathError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UiPathError';
    this.code = code;
  }
}

export interface UiSessionOption {
  sessionId: string;
  mtime: number;
}

export interface UiChat {
  chatId: string;
  name: string;
  sessionId?: string;
}

export interface UiSession {
  sessionId: string;
  agent: AgentId;
  cwd: string;
  driver: string;
  idleMs: number;
  model?: string;
  capabilities: { modelSwitch: string };
}

export interface UiSettings {
  bootstrapEnabled: boolean;
  bootstrapMaxMessages: number;
  bootstrapMaxAgeDays: number;
  pendingWindowMax: number;
  codexSandboxMode: string;
  chatToolsEnabled: boolean;
}

export interface UiState {
  now: number;
  daemon: { pid: number; channel: string };
  bindings: (Binding & { name?: string })[];
  sessions: UiSession[];
  codes: { code: string; sessionId: string; expiresAt: number }[];
  chats: UiChat[];
  models: Record<string, ModelInfo[]>;
  defaultModels: Partial<Record<AgentId, string>>;
  settings: UiSettings;
  recentCwds: string[];
  queue: {
    pendingInbound: number;
    pendingOutbound: { id: number; chatId: string; text: string; attempts: number; createdAt: number }[];
  };
  doctor: { checks: DoctorCheck[]; at: number } | null;
}

export interface UiDataDeps {
  db: Db;
  channel: Channel;
  pool: SessionPool;
  flushOutbound: () => Promise<void>;
  pendingInbound: () => number;
  logger: Logger;
}

/**
 * 配置台的数据/动作层：与 CLI、会话内命令共用同一套 core 逻辑（§4.4）。
 * 写操作一律走这里，UI 不直接碰 SQLite。
 */
export class UiData {
  private readonly deps: UiDataDeps;
  private chatsCache?: { at: number; value: UiChat[] };
  private doctorCache?: { at: number; value: DoctorCheck[] };
  private readonly modelsCache = new Map<string, { at: number; value: ModelInfo[] }>();

  constructor(deps: UiDataDeps) {
    this.deps = deps;
  }

  async state(): Promise<UiState> {
    const chats = await this.chats();
    const nameOf = new Map(chats.map((c) => [c.chatId, c.name]));
    const bindings = listBindings(this.deps.db).map((b) => ({
      ...b,
      ...(getSessionModel(this.deps.db, b.sessionId)
        ? { model: getSessionModel(this.deps.db, b.sessionId)! }
        : {}),
      ...(nameOf.get(b.chatId) ? { name: nameOf.get(b.chatId) } : {}),
    }));
    const sessions: UiSession[] = this.deps.pool.list().map((s) => {
      const live = this.deps.pool.get(s.ref.sessionId);
      return {
        sessionId: s.ref.sessionId,
        agent: s.ref.agent,
        cwd: s.ref.cwd,
        driver: s.ref.driver,
        idleMs: s.idleMs,
        ...(getSessionModel(this.deps.db, s.ref.sessionId)
          ? { model: getSessionModel(this.deps.db, s.ref.sessionId)! }
          : {}),
        capabilities: { modelSwitch: live?.adapter.capabilities.modelSwitch ?? 'none' },
      };
    });
    const models: Record<string, ModelInfo[]> = {};
    for (const s of sessions) {
      const list = await this.modelsFor(s.sessionId);
      if (list.length) models[s.sessionId] = list;
    }
    return {
      now: Date.now(),
      daemon: { pid: process.pid, channel: this.deps.channel.id },
      bindings,
      sessions,
      codes: listBindCodes(this.deps.db).map((c) => ({
        code: c.code,
        sessionId: c.sessionId,
        expiresAt: c.expiresAt,
      })),
      chats,
      models,
      defaultModels: {
        pi: getSetting(this.deps.db, defaultModelKey('pi')),
        claude: getSetting(this.deps.db, defaultModelKey('claude')),
        codex: getSetting(this.deps.db, defaultModelKey('codex')),
      },
      settings: {
        bootstrapEnabled: getBool(this.deps.db, SETTINGS.bootstrapEnabled, true),
        bootstrapMaxMessages: getInt(this.deps.db, SETTINGS.bootstrapMaxMessages, 10),
        bootstrapMaxAgeDays: getInt(this.deps.db, SETTINGS.bootstrapMaxAgeDays, 7),
        pendingWindowMax: getInt(this.deps.db, SETTINGS.pendingWindowMax, 50),
        codexSandboxMode: getSetting(this.deps.db, SETTINGS.codexSandboxMode) ?? '',
        chatToolsEnabled: getBool(this.deps.db, SETTINGS.chatToolsEnabled, false),
      },
      recentCwds: [...new Set(bindings.map((b) => b.cwd))],
      queue: {
        pendingInbound: this.deps.pendingInbound(),
        pendingOutbound: listPendingOutbound(this.deps.db, 50).map((m) => ({
          id: m.id,
          chatId: m.chatId,
          text: m.text,
          attempts: m.attempts,
          createdAt: m.createdAt,
        })),
      },
      doctor: this.doctorCache ? { checks: this.doctorCache.value, at: this.doctorCache.at } : null,
    };
  }

  /** 所有写操作入口；返回给前端的 JSON */
  async action(path: string, method: string, body: Record<string, unknown>): Promise<unknown> {
    const log = this.deps.logger.child({ svc: 'ui', action: path });
    switch (path) {
      case '/api/bind': {
        const agent = String(body.agent ?? 'pi') as AgentId;
        const sessionId = String(body.sessionId ?? '');
        const binding = insertBinding(this.deps.db, {
          chatId: String(body.chatId ?? ''),
          sessionId,
          agent,
          cwd: String(body.cwd ?? process.cwd()),
          ownerOpenId: String(body.ownerOpenId ?? ''),
          mirrorMode: 'off' as MirrorMode,
          createdAt: Date.now(),
        });
        // 接管一条**已存在**的会话时要顺手写别名。opaque 语义的 adapter
        // （claude/codex）在 SessionPool 里只认 alias：没有这条记录就传
        // undefined，于是静默新建一条，用户选的会话被无声忽略（§10.4）。
        // pi 是 logical 语义、会回落到 ref.sessionId，写了也无害且更明确。
        if (body.resumeExisting && sessionId) {
          upsertResumeAlias(this.deps.db, agent, sessionId);
          log.info('bind resumes existing session', { sessionId, agent });
        }
        log.info('bind created', { chatId: binding.chatId, sessionId: binding.sessionId });
        return { binding };
      }
      case '/api/unbind': {
        const removed = deleteBinding(this.deps.db, String(body.chatId ?? ''));
        log.info('bind removed', { chatId: String(body.chatId ?? ''), removed });
        return { removed };
      }
      case '/api/code': {
        const sessionId = String(body.sessionId ?? '');
        const agent = String(body.agent ?? 'pi') as AgentId;
        const cwd = String(body.cwd ?? process.cwd());
        for (let i = 0; i < 10; i++) {
          try {
            const issued = issueBindCode(this.deps.db, { code: newBindCode(), sessionId, agent, cwd });
            log.info('code issued', { sessionId, expiresAt: issued.expiresAt });
            return { code: issued.code, expiresAt: issued.expiresAt };
          } catch (err) {
            if (err instanceof BindError) throw err;
            if (String(err).includes('UNIQUE')) continue;
            throw err;
          }
        }
        throw new Error('无法分配唯一绑定码，请重试');
      }
      case '/api/code/delete':
        return { removed: deleteBindCode(this.deps.db, String(body.code ?? '')) };
      case '/api/model': {
        const sessionId = String(body.sessionId ?? '');
        const model = body.model ? String(body.model) : undefined;
        setSessionModel(this.deps.db, sessionId, model);
        const live = this.deps.pool.get(sessionId);
        if (model && live?.adapter.setModel && live.adapter.capabilities.modelSwitch === 'runtime') {
          await live.adapter.setModel(live.handle, model);
          log.info('model switched (runtime)', { sessionId, model });
          return { applied: 'runtime', model };
        }
        log.info('model stored', { sessionId, model: model ?? null });
        return { applied: 'next-start', model: model ?? null };
      }
      case '/api/session/release': {
        return { released: await this.deps.pool.release(String(body.sessionId ?? '')) };
      }
      case '/api/outbound/flush': {
        await this.deps.flushOutbound();
        return { flushed: true };
      }
      case '/api/outbound/discard':
        return { discarded: discardOutbound(this.deps.db, Number(body.id)) };
      case '/api/doctor/refresh':
        return { checks: await this.refreshDoctor() };
      case '/api/chats/refresh':
        return { chats: await this.refreshChats() };
      case '/api/default-model': {
        const agent = String(body.agent ?? 'pi') as AgentId;
        setSetting(
          this.deps.db,
          defaultModelKey(agent),
          body.model ? String(body.model) : undefined,
        );
        log.info('default model set', { agent, model: body.model ?? null });
        return { agent, model: body.model ?? null };
      }
      case '/api/settings': {
        const key = String(body.key ?? '');
        if (!(Object.values(SETTINGS) as string[]).includes(key)) {
          throw new Error(`不允许修改的配置项: ${key}`);
        }
        const raw = body.value;
        const value = raw === undefined || raw === null || raw === '' ? undefined : String(raw);
        setSetting(this.deps.db, key, value);
        log.info('setting set', { key, value: value ?? null });
        return { key, value: value ?? null };
      }
      default:
        throw new Error(`unknown action: ${method} ${path}`);
    }
  }

  async chats(): Promise<UiChat[]> {
    if (this.chatsCache && Date.now() - this.chatsCache.at < 60_000) return this.chatsCache.value;
    return this.refreshChats();
  }

  private async refreshChats(): Promise<UiChat[]> {
    const bound = new Map(listBindings(this.deps.db).map((b) => [b.chatId, b.sessionId]));
    const value: UiChat[] = (await this.deps.channel.listChats()).map((c) => ({
      chatId: c.chatId,
      name: c.name,
      ...(bound.get(c.chatId) ? { sessionId: bound.get(c.chatId)! } : {}),
    }));
    this.chatsCache = { at: Date.now(), value };
    return value;
  }

  private async refreshDoctor(): Promise<DoctorCheck[]> {
    const checks = await this.deps.channel.doctor();
    this.doctorCache = { at: Date.now(), value: checks };
    return checks;
  }

  private async modelsFor(sessionId: string): Promise<ModelInfo[]> {
    const cached = this.modelsCache.get(sessionId);
    if (cached && Date.now() - cached.at < 30_000) return cached.value;
    const live = this.deps.pool.get(sessionId);
    if (!live?.adapter.models) return [];
    try {
      const value = await live.adapter.models(live.handle);
      this.modelsCache.set(sessionId, { at: Date.now(), value });
      return value;
    } catch {
      return [];
    }
  }

  /** 某 agent 的可选模型（不需要会话在运行，adapter 自行探测） */
  async listModels(agent: AgentId): Promise<ModelInfo[]> {
    const adapter = this.deps.pool.adapterFor(agent);
    if (!adapter?.models) return [];
    try {
      return await adapter.models();
    } catch {
      return [];
    }
  }

  /**
   * 目录选择器。限制在允许的根内（默认 `$HOME`，可用 `INSTEAD_FS_ROOTS` 放宽）——
   * 配置台默认绑在 tailnet 上，不该变成一个任意路径浏览器。
   *
   * 写错路径要**明确报错**，不能静静退回 HOME：现在这一栏是可以直接手输的，
   * 静默回落会让用户以为「跳过去了」。
   */
  async listDirs(input?: string): Promise<UiDirListing> {
    const roots = fsRoots();
    const path = resolveBrowsePath(input, roots);
    const entries = await readdir(path, { withFileTypes: true }).catch((err: unknown) => {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') throw new UiPathError('not_found', `目录不存在：${path}`);
      if (code === 'ENOTDIR') throw new UiPathError('not_a_dir', `这不是目录：${path}`);
      if (code === 'EACCES') throw new UiPathError('denied', `没有权限读这个目录：${path}`);
      throw new UiPathError('unreadable', `读不了这个目录：${path}`);
    });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: join(path, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      path,
      ...(path === roots[0] || !isInsideRoots(dirname(path), roots) ? {} : { parent: dirname(path) }),
      dirs,
    };
  }

  /** 某目录下已有的 agent 会话，供会话选择器使用 */
  async listSessions(agent: AgentId, cwd: string): Promise<UiSessionOption[]> {
    if (agent === 'codex') return listCodexSessions(cwd);
    const dir = sessionDirFor(agent, cwd);
    if (!dir) return [];
    const entries = await readdir(dir).catch(() => []);
    const out: UiSessionOption[] = [];
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = sessionIdFromFile(agent, name);
      if (!sessionId) continue;
      const info = await stat(join(dir, name)).catch(() => undefined);
      out.push({ sessionId, mtime: info?.mtimeMs ?? 0 });
    }
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, 50);
  }

  async listMembers(chatId: string): Promise<ChatMember[]> {
    if (!this.deps.channel.listMembers) return [];
    return this.deps.channel.listMembers(chatId).catch(() => []);
  }
}

function sessionDirFor(agent: AgentId, cwd: string): string | undefined {
  if (agent === 'pi') {
    const slug = `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`;
    return join(homedir(), '.pi', 'agent', 'sessions', slug);
  }
  if (agent === 'claude') return join(homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'));
  return undefined; // codex 不按目录分，见 listCodexSessions
}

function sessionIdFromFile(agent: AgentId, name: string): string | undefined {
  if (agent === 'pi') return /_([^_]+)\.jsonl$/.exec(name)?.[1];
  if (agent === 'claude') return /^(.+)\.jsonl$/.exec(name)?.[1];
  return undefined;
}

const CODEX_SESSIONS_DIR = (): string =>
  process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, 'sessions')
    : join(homedir(), '.codex', 'sessions');

/**
 * codex 的 rollout 按日期分目录（`YYYY/MM/DD/rollout-<ISO>-<thread_id>.jsonl`），
 * 路径里没有 cwd —— 但首行 `payload.cwd` 有。所以按 mtime 取最近的一批，
 * 只读首行来筛出属于这个目录的。
 *
 * 上限：最多看 200 个文件、返回 50 条。全量扫描（本机已有 183 个）不值得
 * 为一个下拉付代价。
 */
async function listCodexSessions(cwd: string): Promise<UiSessionOption[]> {
  const root = CODEX_SESSIONS_DIR();
  const names = await readdir(root, { recursive: true, encoding: 'utf8' }).catch(() => []);
  const files: { path: string; sessionId: string; mtime: number }[] = [];
  for (const rel of names) {
    const sessionId = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
      .exec(rel)?.[1];
    if (!sessionId) continue;
    const path = join(root, rel);
    const info = await stat(path).catch(() => undefined);
    if (info) files.push({ path, sessionId, mtime: info.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const out: UiSessionOption[] = [];
  for (const f of files.slice(0, 200)) {
    if ((await codexRolloutCwd(f.path)) !== cwd) continue;
    out.push({ sessionId: f.sessionId, mtime: f.mtime });
    if (out.length >= 50) break;
  }
  return out;
}

/** 单行上限 1 MiB —— 够任何正常 rollout 头，又不至于让畸形文件吃满内存 */
const MAX_HEADER_BYTES = 1024 * 1024;
const HEADER_CHUNK = 64 * 1024;

/**
 * 只读 rollout 首行的 `payload.cwd`，不把整个文件读进内存。
 *
 * 必须读到换行才解析：首行是完整的 session meta，实测能到 ~23 KB。
 * 早先这里用固定 4 KiB buffer，首行被截断 → JSON.parse 抛错 → 和「cwd 不匹配」
 * 撞成同一个 undefined，于是 codex 的会话列表永远是空的。
 */
async function codexRolloutCwd(file: string): Promise<string | undefined> {
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    let acc = '';
    let pos = 0;
    const buf = Buffer.alloc(HEADER_CHUNK);
    while (pos < MAX_HEADER_BYTES) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break; // EOF：文件只有一行且没有结尾换行
      acc += buf.subarray(0, bytesRead).toString('utf8');
      pos += bytesRead;
      const nl = acc.indexOf('\n');
      if (nl >= 0) {
        acc = acc.slice(0, nl);
        break;
      }
    }
    if (!acc) return undefined;
    const parsed = JSON.parse(acc) as { payload?: { cwd?: unknown } };
    return typeof parsed.payload?.cwd === 'string' ? parsed.payload.cwd : undefined;
  } catch {
    return undefined; // 真正畸形的行：当作不匹配
  } finally {
    await handle.close();
  }
}
