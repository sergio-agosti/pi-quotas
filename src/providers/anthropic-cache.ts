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
 *
 * Because the file is shared across processes that may run *different builds*
 * of this extension, cached windows are stamped with CLAUDE_PARSER_VERSION and
 * only reused by a matching parser.
 */

/**
 * Path to the shared last-known-good cache.
 *
 * Overridable via PI_QUOTAS_CLAUDE_CACHE_FILE so tests can isolate themselves
 * from the real cache: this file is shared with every other Pi process on the
 * machine, so a running Pi (or an earlier test) writing it would otherwise
 * decide what the fetch tests see.
 */
export function claudeCacheFile(): string {
  return (
    process.env.PI_QUOTAS_CLAUDE_CACHE_FILE ??
    join(tmpdir(), "pi", "pi-quotas-claude-cache.json")
  );
}

/**
 * Identity of the parser that produced the cached windows.
 *
 * The cache stores *parsed* windows and is shared by every Pi process on the
 * machine, including long-running sessions that loaded an older build of this
 * extension (extensions are loaded once at process start). An older parser
 * writes a window set this build would not produce — e.g. before model-scoped
 * weekly limits were read from `limits[]`, its successful poll overwrote the
 * cache with `5h` + `7d` only, and every newer process then rendered a footer
 * with the scoped "7d Fable" window missing for up to the shared TTL (or the
 * whole 429 cooldown).
 *
 * Entries are stamped with this version and a mismatch is treated as a cache
 * miss for *reads*, so version skew can only cost an extra fetch, never a
 * silently degraded footer. Bump it whenever parseAnthropicUsage starts
 * producing a different set of windows for the same payload.
 */
const CLAUDE_PARSER_VERSION = 2;

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
  /** Parser that produced `windows`; see CLAUDE_PARSER_VERSION. */
  parserVersion?: number;
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
      readFileSync(claudeCacheFile(), "utf8"),
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

/**
 * Windows from another parser version are unusable: they may be missing
 * windows this build knows how to show. The rate-limit bookkeeping
 * (cooldownUntil / consecutive429s) stays valid regardless of parser version,
 * since it describes the endpoint, not the payload shape.
 */
function usableWindows(state: ClaudeCacheState): SerializableWindow[] | undefined {
  if (!state.windows) return undefined;
  return state.parserVersion === CLAUDE_PARSER_VERSION ? state.windows : undefined;
}

function writeClaudeCache(state: ClaudeCacheState): boolean {
  try {
    const file = claudeCacheFile();
    const directory = dirname(file);
    if (!existsSync(directory))
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    const cache = readCacheFile();
    cache.claude = state;
    const temporaryPath = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporaryPath, JSON.stringify(cache, null, 2), {
      mode: 0o600,
    });
    renameSync(temporaryPath, file);
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
  const windows = usableWindows(state);
  if (state.cooldownUntil && state.cooldownUntil > nowMs) {
    const warning = cooldownMessage(state.cooldownUntil, nowMs);
    return {
      windows: windows ? deserializeWindows(windows) : [],
      stale: true,
      warning,
    };
  }
  if (
    windows &&
    state.fetchedAt &&
    nowMs - state.fetchedAt <= CLAUDE_SHARED_FRESH_TTL_MS
  ) {
    return { windows: deserializeWindows(windows), stale: false };
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
    parserVersion: CLAUDE_PARSER_VERSION,
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
  const windows = usableWindows(state);
  return windows ? deserializeWindows(windows) : null;
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
  const file = claudeCacheFile();
  const directory = dirname(file);
  if (!existsSync(directory))
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockFile = `${file}.lock`;
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
