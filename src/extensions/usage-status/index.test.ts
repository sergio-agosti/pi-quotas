import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import usageStatusExtension from "./index.js";
import { fetchProviderQuotas } from "../../lib/quotas.js";
import { assessWindow } from "../../utils/quotas-severity.js";
import { QUOTAS_USAGE_UPDATED_EVENT, type QuotasUsagePayload } from "./feed.js";

vi.mock("../../config.js", () => ({
  QUOTAS_CONFIG_UPDATED_EVENT: "quotas:config:updated",
  QUOTAS_EXTENSIONS_REGISTER_EVENT: "quotas:extensions:register",
  QUOTAS_EXTENSIONS_REQUEST_EVENT: "quotas:extensions:request",
  configLoader: {
    load: vi.fn(async () => undefined),
    getConfig: vi.fn(() => ({
      configVersion: "test",
      quotasCommand: true,
      providerCommands: true,
      usageStatus: true,
      quotaWarnings: true,
      deferToSynthetic: true,
    })),
  },
}));

vi.mock("../../lib/quotas.js", () => ({
  isSupportedProvider: (provider: string | undefined) => provider === "anthropic",
  fetchProviderQuotas: vi.fn(async () => ({
    success: true,
    data: { provider: "anthropic", windows: [] },
  })),
}));

const STALE_CONTEXT_ERROR =
  "This extension ctx is stale after session replacement or reload.";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function createFakePi() {
  const extensionHandlers = new Map<string, EventHandler[]>();
  const eventBusHandlers = new Map<string, Array<(data: unknown) => void>>();

  const pi = {
    on(event: string, handler: EventHandler) {
      const handlers = extensionHandlers.get(event) ?? [];
      handlers.push(handler);
      extensionHandlers.set(event, handlers);
    },
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        const handlers = eventBusHandlers.get(channel) ?? [];
        handlers.push(handler);
        eventBusHandlers.set(channel, handlers);
        return () => {
          const current = eventBusHandlers.get(channel) ?? [];
          eventBusHandlers.set(channel, current.filter((entry) => entry !== handler));
        };
      },
      emit(channel: string, data: unknown) {
        for (const handler of eventBusHandlers.get(channel) ?? []) handler(data);
      },
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    async emitExtensionEvent(event: string, ctx: ExtensionContext) {
      for (const handler of extensionHandlers.get(event) ?? []) {
        await handler({ type: event, reason: "test" }, ctx);
      }
    },
    emitBusEvent(channel: string, data: unknown) {
      pi.events.emit(channel, data);
    },
    listenerCount(channel: string) {
      return eventBusHandlers.get(channel)?.length ?? 0;
    },
  };
}

function createContext(provider: string) {
  let stale = false;
  const setStatus = vi.fn(() => {
    if (stale) throw new Error(STALE_CONTEXT_ERROR);
  });

  const ctx = {
    get hasUI() {
      if (stale) throw new Error(STALE_CONTEXT_ERROR);
      return true;
    },
    get model() {
      if (stale) throw new Error(STALE_CONTEXT_ERROR);
      return { provider };
    },
    modelRegistry: { authStorage: {} },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus,
    },
  } as unknown as ExtensionContext;

  return {
    ctx,
    setStale() {
      stale = true;
    },
    setStatus,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("usage-status extension lifecycle", () => {
  it("ignores interval refreshes for stale session contexts", async () => {
    vi.useFakeTimers();
    const { pi, emitExtensionEvent } = createFakePi();
    const { ctx, setStale } = createContext("unsupported-provider");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);

    setStale();

    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    await vi.runOnlyPendingTimersAsync();
  });

  it("does not throw when event-bus callbacks see a stale session context", async () => {
    const { pi, emitExtensionEvent, emitBusEvent } = createFakePi();
    const { ctx, setStale } = createContext("synthetic");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);

    setStale();

    expect(() => {
      emitBusEvent("synthetic:extensions:register", { feature: "usageStatus" });
      emitBusEvent("quotas:config:updated", {
        config: { usageStatus: true, deferToSynthetic: true },
      });
    }).not.toThrow();
  });

  it("unsubscribes event-bus listeners during session shutdown", async () => {
    const { pi, emitExtensionEvent, listenerCount } = createFakePi();
    const { ctx } = createContext("unsupported-provider");

    await usageStatusExtension(pi);
    expect(listenerCount("quotas:config:updated")).toBe(1);
    expect(listenerCount("synthetic:extensions:register")).toBe(1);
    expect(listenerCount("quotas:extensions:request")).toBe(1);

    await emitExtensionEvent("session_shutdown", ctx);

    expect(listenerCount("quotas:config:updated")).toBe(0);
    expect(listenerCount("synthetic:extensions:register")).toBe(0);
    expect(listenerCount("quotas:extensions:request")).toBe(0);
  });

  it("clears the footer silently for not_applicable credentials instead of warning", async () => {
    vi.useFakeTimers();
    vi.mocked(fetchProviderQuotas).mockResolvedValueOnce({
      success: false,
      error: { kind: "not_applicable", message: "Direct API key" },
    } as any);

    const { pi, emitExtensionEvent } = createFakePi();
    const { ctx, setStatus } = createContext("anthropic");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(0);

    const calls = setStatus.mock.calls as unknown as Array<[string, string | undefined]>;
    const last = calls[calls.length - 1]?.[1];
    expect(last).toBeUndefined();
    expect(calls.some((c) => c[1] === "usage unavailable")).toBe(false);
  });
});

// [local patch] The structured feed on the event bus, so a consumer can draw
// this data instead of parsing the footer text back out of it.
describe("usage feed", () => {
  const HOUR = 60 * 60;
  const DAY = 24 * HOUR;

  function quotaWindow(label: string, usedPercent: number, windowSeconds: number) {
    return {
      provider: "anthropic" as const,
      label,
      usedPercent,
      // A past reset makes the pace projection deterministic: the window reads
      // as fully elapsed, so severity depends only on the percentage.
      resetsAt: new Date("2026-05-06T07:47:37Z"),
      windowSeconds,
      usedValue: usedPercent,
      limitValue: 100,
    };
  }

  function collect(pi: ExtensionAPI): QuotasUsagePayload[] {
    const payloads: QuotasUsagePayload[] = [];
    pi.events.on(QUOTAS_USAGE_UPDATED_EVENT, (data) => {
      payloads.push(data as QuotasUsagePayload);
    });
    return payloads;
  }

  it("publishes the footer's data in structured form", async () => {
    const windows = [
      quotaWindow("5h", 66, 5 * HOUR),
      quotaWindow("7d Fable", 7, 7 * DAY),
    ];
    vi.mocked(fetchProviderQuotas).mockResolvedValueOnce({
      success: true,
      data: { provider: "anthropic", windows },
    } as any);

    const { pi, emitExtensionEvent } = createFakePi();
    const payloads = collect(pi);
    const { ctx } = createContext("anthropic");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);

    const payload = payloads.at(-1)!;
    expect(payload.provider).toBe("anthropic");
    // Named so a consumer can suppress the raw status this supersedes.
    expect(payload.statusKey).toBe("pi-quotas-usage");
    expect(
      payload.windows.map((w) => [w.shortLabel, w.kind, w.valueText, w.barPercent]),
    ).toEqual([
      ["5h", "hours", "34%", 34],
      ["fable", "week", "93%", 93],
    ]);
    // The feed carries assessWindow's verdict rather than re-deriving it, which
    // is the whole reason a consumer cannot work from the rendered text.
    expect(payload.windows.map((w) => w.severity)).toEqual(
      windows.map((w) => assessWindow(w).severity),
    );
  });

  it("clears the feed when the provider has nothing to report", async () => {
    vi.mocked(fetchProviderQuotas).mockResolvedValueOnce({
      success: false,
      error: { kind: "not_applicable", message: "Direct API key" },
    } as any);

    const { pi, emitExtensionEvent } = createFakePi();
    const payloads = collect(pi);
    const { ctx } = createContext("anthropic");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);

    expect(payloads.at(-1)!.windows).toEqual([]);
  });

  it("clears the feed when the provider is unsupported", async () => {
    const { pi, emitExtensionEvent } = createFakePi();
    const payloads = collect(pi);
    const { ctx } = createContext("unsupported-provider");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);

    expect(payloads.at(-1)).toMatchObject({ provider: null, windows: [] });
  });

  it("clears the feed on session shutdown", async () => {
    const { pi, emitExtensionEvent } = createFakePi();
    const payloads = collect(pi);
    const { ctx } = createContext("anthropic");

    await usageStatusExtension(pi);
    await emitExtensionEvent("session_start", ctx);
    await emitExtensionEvent("session_shutdown", ctx);

    expect(payloads.at(-1)!.windows).toEqual([]);
  });
});
