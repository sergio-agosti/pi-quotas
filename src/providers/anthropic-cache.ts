import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { QuotaWindow } from "../types/quotas.js";

/**
 * Shared Claude usage cache + 429 backoff, mirroring @hk_net/pi-usage-bars.
 *
 * The Anthropic /api/oauth/usage endpoint is aggressively rate limited
 * (HTTP 429, "Rate limited. Please try again later.") at the account/IP
 * level. Without any resilience, pi-quotas flips the footer to
 * "usage unavailable" on every throttled poll, and its in-memory 5-minute
 * TTL can even lock in a failed result. This module:
 *
 *   - persists the last successful Anthropic windows to a temp file so
 *     multiple Pi processes share them (coordination + rate-limit relief),
 *   - applies an exponential backoff/cooldown after 429s, and
 *   - falls back to the last-known-good windows during a cooldown so the
 *     footer keeps showing Claude usage instead of erroring.
 */

export const CLAUDE_CACHE_FILE = join(
  tmpdir(),
  "pi",
  "pi-quotas-claude-cache.json",
);

const CLAUDE_SHARED_FRESH_TTL_MS = 2 * 60 * 1000;
const CLAUDE_BASE_BACKOFF_MS = 2 * 60 * 1000;
const CLAUDE_MAX_BACKOFF_MS = 30 * 60 * 1000;
const CLAUDE_LOCK_WAIT_MS = 4_000;

/** resetsAt is a Date; store it as an ISO string for JSON round-tripping. */
interface SerializableWindow extends Omit<QuotaWindow, "resetsAt"> {
  resetsAt: string;
}

interface ClaudeCacheState {
  windows?: SerializableWindow[];
  fetchedAt?: number;
  cooldownUntil?: number;
  consecutive429s?: number;
  lastError?: string;
}

interface ClaudeCacheFile {
  version: 1;
  claude?: ClaudeCacheState;
}

function serializeWindows(windows: QuotaWindow[]): SerializableWindow[] {
  return windows.map((w) => ({ ...w, resetsAt: w.resetsAt.toISOString() }));
}

function deserializeWindows(list: SerializableWindow[]): QuotaWindow[] {
  return list.map((w) => ({ ...w, resetsAt: new Date(w.resetsAt) }));
}

function readCacheFile(): ClaudeCacheFile {
  try {
    const parsed = JSON.parse(
      readFileSync(CLAUDE_CACHE_FILE, "utf8"),
    ) as ClaudeCacheFile;
    if (parsed?.version === 1) return parsed;
  } catch {
    // Missing or invalid cache is treated as empty.
  }
  return { version: 1 };
}

function readClaudeCache(): ClaudeCacheState {
  return readCacheFile().claude ?? {};
}

function writeClaudeCache(state: ClaudeCacheState): boolean {
  try {
    const directory = dirname(CLAUDE_CACHE_FILE);
    if (!existsSync(directory))
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    const cache = readCacheFile();
    cache.claude = state;
    const temporaryPath = `${CLAUDE_CACHE_FILE}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporaryPath, JSON.stringify(cache, null, 2), {
      mode: 0o600,
    });
    renameSync(temporaryPath, CLAUDE_CACHE_FILE);
    return true;
  } catch {
    return false;
  }
}

function computeBackoffMs(
  state: ClaudeCacheState,
  retryAfterMs: number | null,
): number {
  if (retryAfterMs !== null && retryAfterMs > 0) {
    return Math.min(
      CLAUDE_MAX_BACKOFF_MS,
      Math.max(CLAUDE_BASE_BACKOFF_MS, retryAfterMs),
    );
  }
  const count = Math.max(1, state.consecutive429s ?? 0);
  return Math.min(
    CLAUDE_MAX_BACKOFF_MS,
    CLAUDE_BASE_BACKOFF_MS * 2 ** Math.max(0, count - 1),
  );
}

function cooldownMessage(untilMs: number, nowMs: number): string {
  const minutes = Math.max(1, Math.ceil((untilMs - nowMs) / 60_000));
  return `rate limited; retry in ~${minutes}m`;
}

export interface ClaudeCacheOutcome {
  windows: QuotaWindow[];
  stale: boolean;
  warning?: string;
}

/**
 * Return cached Claude windows when they're fresh enough to reuse, or when a
 * 429 cooldown is active (last-known-good fallback). Returns null when the
 * network call should be attempted.
 */
export function readClaudeCacheOutcome(
  nowMs = Date.now(),
): ClaudeCacheOutcome | null {
  const state = readClaudeCache();
  if (state.cooldownUntil && state.cooldownUntil > nowMs) {
    const warning = cooldownMessage(state.cooldownUntil, nowMs);
    return {
      windows: state.windows ? deserializeWindows(state.windows) : [],
      stale: true,
      warning,
    };
  }
  if (
    state.windows &&
    state.fetchedAt &&
    nowMs - state.fetchedAt <= CLAUDE_SHARED_FRESH_TTL_MS
  ) {
    return { windows: deserializeWindows(state.windows), stale: false };
  }
  return null;
}

/** Record a successful fetch, clearing any active cooldown. */
export function recordClaudeSuccess(
  windows: QuotaWindow[],
  nowMs = Date.now(),
): void {
  writeClaudeCache({
    windows: serializeWindows(windows),
    fetchedAt: nowMs,
    cooldownUntil: undefined,
    consecutive429s: 0,
    lastError: undefined,
  });
}

/** Record a 429 and return the last-known-good windows, if any. */
export function recordClaudeRateLimit(
  message: string,
  retryAfterMs: number | null,
  nowMs = Date.now(),
): QuotaWindow[] | null {
  const state = readClaudeCache();
  const consecutive429s = (state.consecutive429s ?? 0) + 1;
  const cooldownUntil =
    nowMs + computeBackoffMs({ ...state, consecutive429s }, retryAfterMs);
  writeClaudeCache({
    ...state,
    cooldownUntil,
    consecutive429s,
    lastError: message,
  });
  return state.windows ? deserializeWindows(state.windows) : null;
}

function safeUnlink(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Ignore cleanup races.
  }
}

async function acquireFileLock(
  signal?: AbortSignal,
): Promise<(() => void) | null> {
  const directory = dirname(CLAUDE_CACHE_FILE);
  if (!existsSync(directory))
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockFile = `${CLAUDE_CACHE_FILE}.lock`;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= CLAUDE_LOCK_WAIT_MS) {
    if (signal?.aborted) return null;
    try {
      const fd = openSync(lockFile, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      closeSync(fd);
      return () => safeUnlink(lockFile);
    } catch (error: unknown) {
      if ((error as { code?: string })?.code !== "EEXIST") return null;
      // Another process holds the lock; wait a moment and retry.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return null;
}

/** Run a critical section guarded by the shared cache lock. */
export async function withClaudeCacheLock<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await acquireFileLock(signal);
  try {
    return await fn();
  } finally {
    release?.();
  }
}
