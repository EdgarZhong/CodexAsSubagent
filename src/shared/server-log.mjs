import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

function resolveLevel(value) {
  if (typeof value !== 'string') return LEVELS.info;
  const normalized = value.toLowerCase();
  return Object.hasOwn(LEVELS, normalized) ? LEVELS[normalized] : LEVELS.info;
}

// Runtime Server 长期以 detached 方式运行且 stdio 被丢弃，日志是唯一可观测手段。
// 采用同步追加写：写入量极低，且必须保证进程退出前最后一条关停原因一定落盘。
export function createServerLogger({ dataDir, level = process.env.CODEX_AS_SUBAGENT_LOG_LEVEL, file = null } = {}) {
  const logFile = file ?? (dataDir ? join(dataDir, 'server.log') : null);
  const threshold = resolveLevel(level);
  let ready = false;
  const ensureReady = () => {
    if (ready || !logFile) return;
    try {
      mkdirSync(dataDir, { recursive: true });
      ready = true;
    } catch {
      // 无法创建日志目录时静默降级为不落盘，绝不因日志失败影响运行时。
    }
  };
  const write = (levelName, message, details) => {
    if (LEVELS[levelName] > threshold) return;
    const line = `${new Date().toISOString()} [${levelName}] pid=${process.pid} ${message}${details === undefined ? '' : ` ${safeJson(details)}`}\n`;
    try {
      process.stderr.write(line);
    } catch {
      // stderr 可能已关闭，忽略。
    }
    if (!logFile) return;
    ensureReady();
    if (!ready) return;
    try {
      appendFileSync(logFile, line, 'utf8');
    } catch {
      // 日志写入失败不得抛出。
    }
  };
  return {
    file: logFile,
    level: Object.keys(LEVELS).find((name) => LEVELS[name] === threshold) ?? 'info',
    error: (message, details) => write('error', message, details),
    warn: (message, details) => write('warn', message, details),
    info: (message, details) => write('info', message, details),
    debug: (message, details) => write('debug', message, details),
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
