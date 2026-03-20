/**
 * Global per-account Telegram send queue.
 *
 * When multiple cron jobs or agent turns fire simultaneously, they can all
 * hit Telegram at once, triggering 429 "Too Many Requests" errors. Telegram
 * responds with a `retry_after` value (in seconds). Without serialization,
 * every concurrent sender independently backs off and retries, causing an
 * ever-widening crash spiral.
 *
 * This module provides:
 *  - A per-account FIFO queue that serializes outbound sends.
 *  - Automatic delay injection when a 429 is detected (`retry_after`).
 *  - A shared global singleton so the queue is effective across module
 *    boundaries (monorepo bundles, multiple plugin loads, etc.).
 */

import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/infra-runtime";

const SEND_QUEUE_KEY = Symbol.for("openclaw.telegram.sendQueue");
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;

const log = createSubsystemLogger("telegram/send-queue");

type SendTask = {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

type AccountQueue = {
  queue: SendTask[];
  draining: boolean;
  /** Timestamp (ms) until which sends are blocked due to a 429. */
  blockedUntil: number;
};

type SendQueueMap = Map<string, AccountQueue>;

declare const globalThis: Record<symbol, unknown>;

function resolveGlobalSendQueue(): SendQueueMap {
  if (!(SEND_QUEUE_KEY in globalThis)) {
    (globalThis as Record<symbol, unknown>)[SEND_QUEUE_KEY] = new Map<string, AccountQueue>();
  }
  return globalThis[SEND_QUEUE_KEY] as SendQueueMap;
}

const SEND_QUEUES = resolveGlobalSendQueue();

function getAccountQueue(accountKey: string): AccountQueue {
  let q = SEND_QUEUES.get(accountKey);
  if (!q) {
    q = { queue: [], draining: false, blockedUntil: 0 };
    SEND_QUEUES.set(accountKey, q);
  }
  return q;
}

function extractRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  // Grammy wraps Telegram errors: err.parameters.retry_after or err.error.parameters.retry_after
  const candidates: unknown[] = [err];
  const maybeError = (err as { error?: unknown }).error;
  if (maybeError && typeof maybeError === "object") {
    candidates.push(maybeError);
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const params = (candidate as { parameters?: { retry_after?: unknown } }).parameters;
    if (params && typeof params.retry_after === "number" && Number.isFinite(params.retry_after)) {
      return Math.min(Math.max(Math.ceil(params.retry_after * 1_000), DEFAULT_RETRY_AFTER_MS), MAX_RETRY_AFTER_MS);
    }
  }
  return undefined;
}

function isTelegramRateLimitError(err: unknown): boolean {
  const msg = formatErrorMessage(err).toLowerCase();
  if (msg.includes("429") || msg.includes("too many requests") || msg.includes("retry after")) {
    return true;
  }
  // Check error_code on grammy errors
  if (err && typeof err === "object") {
    const code = (err as { error_code?: unknown }).error_code;
    if (code === 429) return true;
    const inner = (err as { error?: { error_code?: unknown } }).error;
    if (inner?.error_code === 429) return true;
  }
  return false;
}

async function drainQueue(accountKey: string): Promise<void> {
  const q = getAccountQueue(accountKey);
  if (q.draining) {
    return;
  }
  q.draining = true;
  try {
    while (q.queue.length > 0) {
      // Respect 429 backoff window before processing next item
      const waitMs = q.blockedUntil - Date.now();
      if (waitMs > 0) {
        log.warn(`telegram send-queue: account ${accountKey} rate-limited, waiting ${waitMs}ms`);
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }

      const task = q.queue.shift();
      if (!task) {
        break;
      }

      try {
        const result = await task.run();
        task.resolve(result);
      } catch (err) {
        if (isTelegramRateLimitError(err)) {
          const retryAfterMs = extractRetryAfterMs(err) ?? DEFAULT_RETRY_AFTER_MS;
          q.blockedUntil = Date.now() + retryAfterMs;
          log.warn(
            `telegram send-queue: 429 on account ${accountKey}, blocking for ${retryAfterMs}ms`,
          );
          // Re-enqueue the task at the front so it retries after the delay
          q.queue.unshift(task);
        } else {
          task.reject(err);
        }
      }
    }
  } finally {
    q.draining = false;
    // If new items were added while draining, restart
    if (q.queue.length > 0) {
      void drainQueue(accountKey);
    }
  }
}

/**
 * Enqueue a Telegram send operation, serializing per-account to avoid 429 spirals.
 * Returns the result of `sendFn` once it is executed.
 */
export function enqueueTelegramSend<T>(accountKey: string, sendFn: () => Promise<T>): Promise<T> {
  const q = getAccountQueue(accountKey);
  return new Promise<T>((resolve, reject) => {
    q.queue.push({
      run: sendFn as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    if (!q.draining) {
      void drainQueue(accountKey);
    }
  });
}

/** Exposed for testing only. Clears all queues. */
export function resetTelegramSendQueuesForTests(): void {
  SEND_QUEUES.clear();
}
