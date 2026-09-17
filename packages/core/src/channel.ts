import type {
  ChannelId,
  ConversationKey,
  DownloadedAttachment,
  InboundAttachment,
  InboundMessage,
  OutboundMessage,
} from './types.ts';

export interface OutboundResult {
  /** 渠道侧消息 id，用于审计与出站幂等核对 */
  messageId: string;
}

export interface ChatInfo {
  chatId: string;
  name: string;
  /** 机器人是否在群里 */
  botInChat: boolean;
}

export interface DoctorCheck {
  id: string;
  ok: boolean;
  /** 缺失时告诉用户去哪儿补，而不是只报错 */
  hint?: string;
  detail?: string;
}

export interface ChatMember {
  id: string;
  name: string;
}

export interface HistoryMessage {
  id: string;
  senderName: string;
  text: string;
  ts: number;
}

/**
 * 渠道适配层契约。飞书是第一个实现（packages/channel-feishu），
 * 后续 Slack/企微沿用同一形状。
 */
export interface Channel {
  readonly id: ChannelId;
  start(onInbound: (msg: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<OutboundResult>;
  /**
   * 轻量回执，失败不应影响主流程。
   * - `seen`：渠道应尽量用表情回应（比文字轻）
   * - `queued`：带 `text` 说明排队情况
   * - `started`：可选，已由 `seen` 覆盖时渠道可忽略
   * - `done`：收尾（撤掉处理中的表情 / 换成完成态）
   */
  receipt(conversationKey: ConversationKey, kind: ReceiptKind, opts?: ReceiptOptions): Promise<void>;
  /** 机器人所在的群，供 `/feishu-bind` 面板使用 */
  listChats(): Promise<ChatInfo[]>;
  /** 群成员（open_id + 名字），供「仅我」选择器使用（决策 19） */
  listMembers?(chatId: string): Promise<ChatMember[]>;
  /** 拉取群历史（bootstrapHistory，§6.2）；返回 oldest→newest */
  fetchHistory?(chatId: string, limit: number, maxAgeDays: number): Promise<HistoryMessage[]>;
  /**
   * 下载一条入站附件（决策 23）。失败返回 `undefined` —— 附件是附带信息，
   * 不该把这一轮拖垮。
   */
  downloadAttachment?(
    msg: InboundMessage,
    att: InboundAttachment,
  ): Promise<DownloadedAttachment | undefined>;
  doctor(): Promise<DoctorCheck[]>;
  /**
   * 支持原地更新消息（飞书卡片 PATCH，决策 29）。
   * dispatcher 据此决定是否开启流式进度卡。
   */
  readonly patches?: boolean;
  /** 删除自己发过的消息（结果超长时替换进度卡用，xbot 同款 fallback）。失败只记日志 */
  deleteMessage?(messageId: string): Promise<void>;
  /**
   * 原生流式卡（决策 32，cardkit）：开一张流式卡片实例并发出消息。
   * 飞书客户端会按 cardElement.content 的增量做打字机动画（dsh-lark 同款）。
   * 没实现的渠道 = 不支持原生流式，dispatcher 自动退回 PATCH 整卡模式。
   */
  openStreamCard?(
    target: { conversationKey: ConversationKey; replyTo?: string; replyInThread?: boolean },
    initialText: string,
  ): Promise<{ cardId: string; messageId: string }>;
  /** 流式更新卡内文本（全量内容，sequence/uuid 由渠道内部管理） */
  updateStreamCard?(cardId: string, content: string): Promise<void>;
  /** 结束流式（关打字机光标 + 更新消息列表摘要） */
  finishStreamCard?(cardId: string, summary: string): Promise<void>;
}

export interface ReceiptOptions {
  /** 文字回执内容（仅 queued 这类需要说明的场景） */
  text?: string;
  /** 触发消息的 id；有它时渠道可以打表情回应而不是发文字 */
  replyTo?: string;
}

export type ReceiptKind = 'seen' | 'queued' | 'started' | 'done';
