import { createWriteStream, writeFileSync, unlinkSync } from 'node:fs';
import {
  createLogger,
  ensureHome,
  pruneMedia,
  getSetting,
  listCredentials,
  loadCredential,
  migrateLegacyHome,
  openDb,
  paths,
  setLogSink,
} from '@instead/core';
import { PiAdapter } from '@instead/adapter-pi';
import { ClaudeAdapter } from '@instead/adapter-claude';
import { CodexAdapter, type SandboxMode } from '@instead/adapter-codex';
import { FeishuChannel } from '@instead/channel-feishu';
import { Daemon } from './server.ts';
import { DEFAULT_TURN_GUIDANCE } from './guidance.ts';

/**
 * daemon 入口：`instead daemon run`（前台）或 `daemon start`（后台，输出重定向到日志）。
 */
export async function runDaemon(): Promise<void> {
  const migrated = migrateLegacyHome();
  ensureHome();
  const logger = createLogger({ svc: 'daemon' });
  const logStream = createWriteStream(paths.logFile(), { flags: 'a' });
  setLogSink((line) => {
    process.stderr.write(line + '\n');
    logStream.write(line + '\n');
  });
  if (migrated) logger.info('migrated legacy state dir → ~/.instead', { home: paths.home() });

  const appId = process.env.INSTEAD_APP_ID ?? listCredentials()[0]?.appId;
  if (!appId) {
    logger.error('no feishu app configured; run: instead connect <app_id>');
    process.exit(1);
  }
  const cred = loadCredential(appId);
  if (!cred) {
    logger.error('credential file missing or unreadable', { appId });
    process.exit(1);
  }

  // 决策 23：入站附件会一直堆在 ~/.instead/media，启动时扫一次旧的
  const pruned = await pruneMedia();
  if (pruned > 0) logger.info('pruned stale inbound attachments', { count: pruned });

  const db = openDb();
  // 防御：清掉陈旧 socket（上次异常退出时可能没 unlink）
  try {
    unlinkSync(paths.socket());
  } catch {
    /* 不存在即可 */
  }
  const channel = new FeishuChannel({
    appId: cred.appId,
    appSecret: cred.appSecret,
    logger,
  });
  // 决策 27：长任务异步化引导（默认文案可用 INSTEAD_AGENT_GUIDANCE 整体替换）
  const turnGuidance = process.env.INSTEAD_AGENT_GUIDANCE ?? DEFAULT_TURN_GUIDANCE;
  const daemon = new Daemon({
    db,
    channel,
    adapters: {
      pi: new PiAdapter({ logger, appendSystemPrompt: turnGuidance }),
      claude: new ClaudeAdapter({ logger, appendSystemPrompt: turnGuidance }),
      codex: new CodexAdapter({
        logger,
        appendSystemPrompt: turnGuidance,
        getSandboxMode: () => getSetting(db, 'codex.sandbox_mode') as SandboxMode | undefined,
      }),
    },
    logger,
  });

  await daemon.start();
  writeFileSync(paths.pidFile(), String(process.pid));
  logger.info('daemon ready', { pid: process.pid, appId });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    await daemon.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runDaemon().catch((err: unknown) => {
    process.stderr.write(`daemon failed: ${String(err)}\n`);
    process.exit(1);
  });
}
