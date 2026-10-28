import { assert, describe, expect, it } from "vitest";
import {
  assessWindow,
  formatTimeRemaining,
  getPacePercent,
  getProjectedPercent,
  getSeverityColor,
  type QuotaWindow,
  safePercent,
} from "./quotas-severity.js";

function makeWindow(
  overrides: Partial<QuotaWindow> & Pick<QuotaWindow, "usedPercent">,
): QuotaWindow {
  const windowSeconds = overrides.windowSeconds ?? 3600;
  const resetsAt =
    overrides.resetsAt ?? new Date(Date.now() + windowSeconds * 500);
  return {
    provider: "anthropic",
    label: "Test Window",
    resetsAt,
    windowSeconds,
    usedValue: 0,
    limitValue: 100,
    ...overrides,
  };
}

describe("safePercent", () => {
  it("returns 0 for zero/invalid limit", () => {
    expect(safePercent(50, 0)).toBe(0);
    expect(safePercent(50, -1)).toBe(0);
    expect(safePercent(50, NaN)).toBe(0);
    expect(safePercent(NaN, 100)).toBe(0);
  });

  it("computes correct percentage", () => {
    expect(safePercent(50, 100)).toBe(50);
    expect(safePercent(75, 100)).toBe(75);
    expect(safePercent(1, 3)).toBeCloseTo(33.33);
  });
});

describe("getPacePercent", () => {
  it("returns null for zero window", () => {
    const w = makeWindow({ usedPercent: 50, windowSeconds: 0 });
    expect(getPacePercent(w)).toBeNull();
  });

  it("returns ~50 for a window 50% elapsed", () => {
    const w = makeWindow({
      usedPercent: 50,
      windowSeconds: 3600,
      resetsAt: new Date(Date.now() + 1800 * 1000),
    });
    const pace = getPacePercent(w);
    assert(pace, "pace should not be null");
    expect(pace).toBeCloseTo(50, 0);
  });
});

describe("getProjectedPercent", () => {
  it("returns usedPercent when no pace", () => {
    expect(getProjectedPercent(42, null)).toBe(42);
  });

  it("projects based on pace", () => {
    expect(getProjectedPercent(50, 25)).toBe(200);
  });
});

describe("assessWindow", () => {
  it("returns critical for limited window regardless of usage", () => {
    const w = makeWindow({ usedPercent: 5, showPace: false, limited: true });
    expect(assessWindow(w).severity).toBe("critical");
  });

  it("returns critical once the allowance is spent, even at a safe pace", () => {
    const w = makeWindow({
      usedPercent: 100,
      showPace: true,
      windowSeconds: 3600,
      resetsAt: new Date(Date.now() + 3300 * 1000),
    });
    expect(assessWindow(w).severity).toBe("critical");
  });

  it("colours by pace, so high usage on pace is not red", () => {
    const w = makeWindow({
      usedPercent: 50,
      showPace: true,
      windowSeconds: 3600,
      resetsAt: new Date(Date.now() + 1800 * 1000),
    });

    const assessment = assessWindow(w);
    expect(assessment.projectedPercent).toBeCloseTo(100, 0);
    expect(assessment.severity).toBe("warning");

    const onPace = makeWindow({
      usedPercent: 50,
      showPace: true,
      windowSeconds: 3600,
      resetsAt: new Date(Date.now() + 1620 * 1000),
    });
    expect(assessWindow(onPace).severity).toBe("none");
  });

  it("goes red for high usage that is also over pace", () => {
    const now = Date.now();
    const monthSeconds = 31 * 24 * 3600;
    const w = makeWindow({
      provider: "github-copilot",
      label: "Premium / month",
      usedPercent: 83,
      usedValue: 249,
      limitValue: 300,
      showPace: true,
      windowSeconds: monthSeconds,
      // 249/300 used 42% of the way through a monthly window: projects to ~196%,
      // so the budget runs out roughly halfway to the reset.
      resetsAt: new Date(now + ((428 * 60 + 35) * 60 * 1000)),
    });

    const assessment = assessWindow(w);
    expect(assessment.projectedPercent).toBeGreaterThan(175);
    expect(assessment.severity).toBe("critical");
  });

  it("escalates to high and critical on steep projection", () => {
    const high = makeWindow({
      usedPercent: 70,
      showPace: true,
      windowSeconds: 3600,
      resetsAt: new Date(Date.now() + 1800 * 1000),
    });
    expect(assessWindow(high).severity).toBe("high");

    const critical = makeWindow({
      usedPercent: 95,
      showPace: true,
      windowSeconds: 3600,
      resetsAt: new Date(Date.now() + 1800 * 1000),
    });
    expect(assessWindow(critical).severity).toBe("critical");
  });

  it("ignores projection below the floor so an early burst is not red", () => {
    // 6% used after 6% of the window: projects to 100%, but both the elapsed and
    // used amounts are under the floor, where pace is mostly noise.
    const w = makeWindow({
      usedPercent: 6,
      showPace: true,
      windowSeconds: 3600,
      resetsAt: new Date(Date.now() + 3384 * 1000),
    });

    const assessment = assessWindow(w);
    expect(assessment.projectedPercent).toBeGreaterThanOrEqual(100);
    expect(assessment.severity).toBe("none");
  });

  it("falls back to absolute usage when the window has no pace", () => {
    expect(
      assessWindow(makeWindow({ usedPercent: 85, showPace: false })).severity,
    ).toBe("warning");
    expect(
      assessWindow(makeWindow({ usedPercent: 95, showPace: false })).severity,
    ).toBe("high");
  });

  it("uses paceScale to normalize pace", () => {
    const w = makeWindow({
      usedPercent: 95,
      showPace: true,
      paceScale: 1 / 7,
      windowSeconds: 7 * 24 * 3600,
      resetsAt: new Date(Date.now() + 6 * 24 * 3600 * 1000),
    });
    const result = assessWindow(w);
    assert(result.pacePercent, "pacePercent should not be null");
    expect(result.pacePercent).toBeLessThan(15);
    expect(result.projectedPercent).toBeGreaterThan(500);
    expect(result.severity).toBe("critical");
  });
});

describe("formatTimeRemaining", () => {
  it("separates adjacent time units", () => {
    expect(formatTimeRemaining(new Date(Date.now() + (2 * 60 + 19) * 60_000))).toBe("2h 19m");
    expect(formatTimeRemaining(new Date(Date.now() + (26 * 60 + 19) * 60_000))).toBe("1d 2h 19m");
  });
});

describe("getSeverityColor", () => {
  it("maps severity levels to display colors", () => {
    expect(getSeverityColor("none")).toBe("success");
    expect(getSeverityColor("warning")).toBe("warning");
    expect(getSeverityColor("high")).toBe("error");
    expect(getSeverityColor("critical")).toBe("error");
  });
});
