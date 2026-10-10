import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUsageFeed, type QuotasUsagePayload } from "./feed.js";
import type { WindowStatus } from "./format-status.js";

const DAY = 24 * 60 * 60;
const FETCHED_AT = new Date("2026-05-06T05:28:37Z");
const STATUS_KEY = "pi-quotas-usage";

function status(overrides: Partial<WindowStatus>): WindowStatus {
  return {
    label: "5h",
    usedPercent: 66,
    severity: "none",
    resetsAt: null,
    limited: false,
    windowSeconds: 5 * 60 * 60,
    ...overrides,
  };
}

function feed(
  provider: QuotasUsagePayload["provider"],
  windows: WindowStatus[],
): QuotasUsagePayload {
  return buildUsageFeed({ statusKey: STATUS_KEY, provider, windows, fetchedAt: FETCHED_AT });
}

describe("buildUsageFeed", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes the footer's own value text, uncoloured", () => {
    const payload = feed("anthropic", [status({})]);
    expect(payload.windows[0]!.valueText).toBe("34%");
    expect(payload.windows[0]!.valueText).not.toContain("\u001b");
    expect(payload.windows[0]!.barPercent).toBe(34);
  });

  it("names the status key it supersedes", () => {
    // So a consumer can suppress the raw text without hardcoding our id.
    expect(feed("anthropic", [status({})]).statusKey).toBe(STATUS_KEY);
  });

  it("carries the pace-aware severity rather than letting it be re-derived", () => {
    // The same 85% is "warning" early in a window and "none" late in one, so a
    // consumer that parsed the percentage could not recover this.
    const payload = feed("anthropic", [
      status({ label: "7d", usedPercent: 85, severity: "warning", windowSeconds: 7 * DAY }),
    ]);
    expect(payload.windows[0]!.severity).toBe("warning");
    expect(payload.windows[0]!.valueText).toBe("15%");
  });

  it("tags a model-scoped weekly window with the model name", () => {
    const payload = feed("anthropic", [
      status({ label: "7d Fable", usedPercent: 7, windowSeconds: 7 * DAY }),
    ]);
    expect(payload.windows[0]!.shortLabel).toBe("fable");
    expect(payload.windows[0]!.kind).toBe("week");
  });

  it("suppresses the bar where the printed value is not a percentage", () => {
    // A currency pair prints used/limit, so a remaining bar would sit beside a
    // number it does not measure.
    const currency = feed("anthropic", [
      status({
        label: "Extra (AUD)",
        usedPercent: 71.8,
        isCurrency: true,
        usedValue: 215,
        limitValue: 300,
      }),
    ]);
    expect(currency.windows[0]!.valueText).toBe("$215.00/$300.00");
    expect(currency.windows[0]!.barPercent).toBeNull();

    const counts = feed("github-copilot", [
      status({
        label: "Premium / month",
        usedPercent: 2.3,
        usedValue: 7,
        limitValue: 300,
        windowSeconds: 30 * DAY,
      }),
    ]);
    expect(counts.windows[0]!.valueText).toBe("293/300");
    expect(counts.windows[0]!.barPercent).toBeNull();
  });

  it("keeps a spent spend cap legible without a bar", () => {
    const payload = feed("openai-codex", [
      status({
        label: "Spend cap",
        usedPercent: 100,
        severity: "critical",
        limited: true,
        windowSeconds: 0,
      }),
    ]);
    expect(payload.windows[0]!.valueText).toBe("REACHED");
    expect(payload.windows[0]!.barPercent).toBeNull();
    expect(payload.windows[0]!.kind).toBe("cap");
    expect(payload.windows[0]!.limited).toBe(true);
  });

  it("keeps the compact percentage form for synthetic windows", () => {
    const payload = feed("synthetic", [
      status({
        label: "Credits / week",
        usedPercent: 66,
        usedValue: 66,
        limitValue: 100,
        windowSeconds: 7 * DAY,
      }),
    ]);
    expect(payload.windows[0]!.valueText).toBe("34%");
    expect(payload.windows[0]!.barPercent).toBe(34);
  });

  it("publishes the footer's own reset suffix, or null when there is none", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FETCHED_AT);

    const payload = feed("anthropic", [
      status({ label: "5h", resetsAt: "2026-05-06T07:47:37.000Z" }),
      status({ label: "Credits", isCurrency: true, windowSeconds: 0, resetsAt: null }),
    ]);

    expect(payload.windows[0]!.resetText).toBe(" ↺ 2h·19m");
    expect(payload.windows[0]!.resetsAt).toBe("2026-05-06T07:47:37.000Z");
    expect(payload.windows[1]!.resetText).toBeNull();
    expect(payload.windows[1]!.resetsAt).toBeNull();
  });

  it("clears the feed with a null provider and no windows", () => {
    const payload = feed(null, []);
    expect(payload.provider).toBeNull();
    expect(payload.windows).toEqual([]);
  });

  it("stamps the fetch time", () => {
    expect(feed("anthropic", []).fetchedAt).toBe("2026-05-06T05:28:37.000Z");
  });
});
