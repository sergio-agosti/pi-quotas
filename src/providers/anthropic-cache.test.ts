import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeCacheFile,
  readClaudeCacheOutcome,
  recordClaudeRateLimit,
  recordClaudeSuccess,
} from "./anthropic-cache.js";
import type { QuotaWindow } from "../types/quotas.js";

function window(label: string): QuotaWindow {
  return {
    provider: "anthropic",
    label,
    usedPercent: 19,
    resetsAt: new Date("2026-09-20T18:00:00.000Z"),
    windowSeconds: 7 * 24 * 60 * 60,
    usedValue: 19,
    limitValue: 100,
    showPace: false,
    nextLabel: "Resets",
  };
}

function readRaw(): any {
  return JSON.parse(readFileSync(claudeCacheFile(), "utf8"));
}

/** Rewrite the cache as if an older build of this extension had written it. */
function writeForeignParserCache(state: Record<string, unknown>): void {
  const cache = readRaw();
  cache.claude = { ...cache.claude, ...state };
  writeFileSync(claudeCacheFile(), JSON.stringify(cache));
}

describe("claude cache parser versioning", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "pi-quotas-cache-test-"));
    process.env.PI_QUOTAS_CLAUDE_CACHE_FILE = join(cacheDir, "cache.json");
  });

  afterEach(() => {
    delete process.env.PI_QUOTAS_CLAUDE_CACHE_FILE;
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("stamps successful writes with the parser version and reuses them while fresh", () => {
    const now = Date.now();
    recordClaudeSuccess([window("7d"), window("7d Fable")], now);

    expect(readRaw().claude.parserVersion).toBeTypeOf("number");
    const outcome = readClaudeCacheOutcome(now + 1_000);
    expect(outcome?.stale).toBe(false);
    expect(outcome?.windows.map((w) => w.label)).toEqual(["7d", "7d Fable"]);
  });

  it("ignores fresh windows written by a different parser version", () => {
    // An older Pi process (loaded before model-scoped weekly windows were
    // parsed) writes a window set this build would never produce. Reusing it
    // would silently drop "7d Fable" from the footer.
    const now = Date.now();
    recordClaudeSuccess([window("7d")], now);
    writeForeignParserCache({ parserVersion: 1 });

    expect(readClaudeCacheOutcome(now + 1_000)).toBeNull();
  });

  it("treats an unversioned legacy cache as a miss", () => {
    const now = Date.now();
    recordClaudeSuccess([window("7d")], now);
    const cache = readRaw();
    delete cache.claude.parserVersion;
    writeFileSync(claudeCacheFile(), JSON.stringify(cache));

    expect(readClaudeCacheOutcome(now + 1_000)).toBeNull();
  });

  it("keeps the cooldown but drops foreign windows during a 429 backoff", () => {
    const now = Date.now();
    recordClaudeSuccess([window("7d")], now);
    recordClaudeRateLimit("Rate limited", null, now);
    writeForeignParserCache({ parserVersion: 1 });

    const outcome = readClaudeCacheOutcome(now + 1_000);
    expect(outcome?.stale).toBe(true);
    expect(outcome?.warning).toMatch(/rate limited/i);
    expect(outcome?.windows).toEqual([]);
  });

  it("does not return foreign windows as last-known-good on a 429", () => {
    const now = Date.now();
    recordClaudeSuccess([window("7d")], now);
    writeForeignParserCache({ parserVersion: 1 });

    expect(recordClaudeRateLimit("Rate limited", null, now)).toBeNull();
  });

  it("still returns own-version windows as last-known-good on a 429", () => {
    const now = Date.now();
    recordClaudeSuccess([window("7d"), window("7d Fable")], now);

    const stale = recordClaudeRateLimit("Rate limited", null, now);
    expect(stale?.map((w) => w.label)).toEqual(["7d", "7d Fable"]);
  });
});
