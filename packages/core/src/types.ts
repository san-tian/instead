/**
 * 统一消息协议 + adapter 契约（DESIGN §10.2 / §10.3）
 */

export type AgentId = 'pi' | 'claude' | 'codex';
export type ChannelId = 'feishu';

/** 渠道侧会话标识：`feishu:chat:<chat_id>`，与 SessionRef.sessionId 多对一（§1.1） */
export type ConversationKey = `${ChannelId}:chat:${string}`;

export type DriverKind = 'daemon' | 'native-tui' | 'in-proc';
export type MirrorMode = 'off' | 'user' | 'user+assistant' | 'full';

export interface Actor {
  id: string;
  name: string;
}

/** 已经落盘的附件（出站用，也可表示已下载的入站件） */
export interface Attachment {
  kind: 'image' | 'file' | 'video';
  localPath: string;
  name: string;
}

/**
 * 入站附件（决策 23）：事件里只有渠道侧的定位信息（飞书 `image_key` / `file_key`），
 * **下载推迟到这一轮真要跑的时候**（dispatcher），否则群里每张图都会被拖下来。
 */
export interface InboundAttachment {
  kind: 'image' | 'file' | 'video' | 'audio';
  /** 渠道侧资源键 */
  key: string;
  name?: string;
}

/** 渠道把入站附件落到本地后的结果 */
export interface DownloadedAttachment {
  localPath: string;
  name: string;
  mimeType?: string;
  bytes: number;
}

/** 入站消息（渠道无关的规范化形态） */
export interface InboundMessage {
  /** 渠道事件 id，去重键（飞书 event_id） */
  id: string;
  channel: ChannelId;
  conversationKey: ConversationKey;
  actor: Actor;
  text: string;
  attachments: InboundAttachment[];
  ts: number;
  replyTo?: string;
  /** 是否 @ 了机器人（决定触发还是进 pendingWindow） */
  mentioned: boolean;
  /** 话题群标识（缺口 H：M0 检测到就提示不支持） */
  threadId?: string;
}

export interface OutboundMessage {
  conversationKey: ConversationKey;
  text: string;
  attachments?: Attachment[];
  replyTo?: string;
  /** 回复落在话题里（决策 24）：触发消息来自话题时置 true */
  replyInThread?: boolean;
  /** 幂等键：同一 turn 的同一 seq 只发一次（缺口 B） */
  turnId: string;
  seq: number;
  /**
   * 原地替换该消息而不是新建（决策 29，飞书 = PATCH 卡片）。
   * 流式进度卡用：过程不断 patch 同一张卡，结束后把过程卡替换成结果。
   */
  patch?: string;
}

export interface SessionRef {
  agent: AgentId;
  sessionId: string;
  cwd: string;
  driver: DriverKind;
}

export type TurnEventType = 'started' | 'delta' | 'tool' | 'final' | 'error' | 'aborted';

export interface TurnEvent {
  turnId: string;
  /** 由 dispatcher 填（adapter 不知道路由信息） */
  conversationKey?: ConversationKey;
  type: TurnEventType;
  text?: string;
}

/** 绑定记录（chat 1:1 session） */
export interface Binding {
  chatId: string;
  sessionId: string;
  agent: AgentId;
  cwd: string;
  ownerOpenId: string;
  mirrorMode: MirrorMode;
  createdAt: number;
}

export interface BindCode {
  code: string;
  sessionId: string;
  agent: AgentId;
  cwd: string;
  createdAt: number;
  expiresAt: number;
}

export interface ModelInfo {
  id: string;
  label?: string;
  provider?: string;
}

/** 注入到 agent 的只读上下文（pendingWindow / bootstrapHistory / 指令） */
export interface ContextBlock {
  kind: 'pending-window' | 'historical' | 'instructions';
  conversationKey: ConversationKey;
  chatName?: string;
  text: string;
}

/** adapter 入参（缺口 G：图片由 adapter 各自转换） */
export interface UserMessage {
  text: string;
  /** 触发该 turn 的群；adapter 可据此给事件打标 */
  conversationKey?: ConversationKey;
  images?: { data: string; mimeType: string }[];
  context?: ContextBlock[];
}

export interface AgentCapabilities {
  persistent: boolean;
  steer: boolean;
  liveAttach: 'in-proc' | 'lease' | 'none';
  approvals: boolean;
  /** 配置台据此决定模型下拉是否可用（§4.4.2） */
  modelSwitch: 'runtime' | 'restart' | 'none';
  /**
   * 会话 id 语义：
   * - `logical`：adapter 能被指定任意 id（pi 的 `--session-id`）
   * - `opaque`：CLI 自己生成真实 id（claude/codex），只能拿**之前学到的** id 来 resume；
   *   否则由 daemon 传 undefined 让它新建，并在首轮学完后通过 handle.ref.sessionId 回传。
   */
  sessionIdSemantics: 'logical' | 'opaque';
  /**
   * 图片输入能力（决策 26）：false 时 dispatcher 会把入站图片落盘、
   * 只把路径写进正文，而不是整轮失败 —— agent 自己能用读文件工具看图。
   */
  images: boolean;
}

export interface StartOptions {
  cwd: string;
  sessionId?: string;
  model?: string;
  /**
   * 这条会话**应当已经存在**（接管已有会话，或已学到真实 id）。
   * adapter 找不到它时必须硬失败，而不是**静默新建**一条同 id 的空会话 ——
   * 后者在飞书里表现为「绑定了会话，但 bot 完全没有上下文」。
   */
  expectExisting?: boolean;
}

/** adapter 返回的会话句柄（各 adapter 可扩展） */
export interface AgentSessionHandle {
  readonly ref: SessionRef;
  readonly capabilities: AgentCapabilities;
}

export interface TurnResult {
  text: string;
  aborted: boolean;
  error?: string;
}

export interface TurnHandle {
  turnId: string;
  /** turn 完全结束（对应 pi 的 agent_settled，不是 agent_end，见 spike 1） */
  settled: Promise<TurnResult>;
  onEvent(listener: (event: TurnEvent) => void): () => void;
}

export interface HistoryEntry {
  id: string;
  role: 'user' | 'assistant' | 'other';
  text: string;
  ts?: number;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly capabilities: AgentCapabilities;
  start(opts: StartOptions): Promise<AgentSessionHandle>;
  send(handle: AgentSessionHandle, msg: UserMessage): Promise<TurnHandle>;
  abort(handle: AgentSessionHandle, turnId: string): Promise<void>;
  stop(handle: AgentSessionHandle): Promise<void>;
  history?(handle: AgentSessionHandle, cursor?: string): AsyncIterable<HistoryEntry>;
  injectContext?(handle: AgentSessionHandle, ctx: ContextBlock): Promise<void>;
  /** 列出可切换的模型（有 handle 时查该会话；不传 handle 时 adapter 可自行探测） */
  models?(handle?: AgentSessionHandle): Promise<ModelInfo[]>;
  /** 仅 `modelSwitch === 'runtime'` 时实现；`model` 支持 `<provider>/<modelId>` */
  setModel?(handle: AgentSessionHandle, model: string): Promise<void>;
}
