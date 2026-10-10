import { describe, expect, it } from "vitest";
import { windowKind, type WindowKindInput } from "./window-kind.js";

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

function window(overrides: Partial<WindowKindInput>): WindowKindInput {
  return { label: "5h", windowSeconds: 0, ...overrides };
}

describe("windowKind", () => {
  it("classifies rolling windows by duration, not label", () => {
    // OpenAI Codex generates its labels from the duration, so a label table
    // would misclassify every one of these.
    expect(windowKind(window({ label: "90s", windowSeconds: 90 }))).toBe("hours");
    expect(windowKind(window({ label: "30m", windowSeconds: 30 * 60 }))).toBe("hours");
    expect(windowKind(window({ label: "5h", windowSeconds: 5 * HOUR }))).toBe("hours");
    expect(windowKind(window({ label: "1d", windowSeconds: DAY }))).toBe("day");
    expect(windowKind(window({ label: "7d", windowSeconds: 7 * DAY }))).toBe("week");
    expect(windowKind(window({ label: "30d", windowSeconds: 30 * DAY }))).toBe("month");
  });

  it("puts each duration bucket on its boundary", () => {
    expect(windowKind(window({ windowSeconds: 12 * HOUR }))).toBe("hours");
    expect(windowKind(window({ windowSeconds: 12 * HOUR + 1 }))).toBe("day");
    expect(windowKind(window({ windowSeconds: 2 * DAY }))).toBe("day");
    expect(windowKind(window({ windowSeconds: 2 * DAY + 1 }))).toBe("week");
    expect(windowKind(window({ windowSeconds: 10 * DAY }))).toBe("week");
    expect(windowKind(window({ windowSeconds: 10 * DAY + 1 }))).toBe("month");
  });

  it("classifies a model-scoped weekly window as a week", () => {
    // Anthropic's "7d Fable" is short-labelled with the model name, so nothing
    // in the label says "week".
    expect(
      windowKind(window({ label: "7d Fable", windowSeconds: 7 * DAY })),
    ).toBe("week");
  });

  it("classifies a currency window that has a duration by its duration", () => {
    expect(
      windowKind(
        window({
          label: "Monthly Budget",
          windowSeconds: 30 * DAY,
          isCurrency: true,
        }),
      ),
    ).toBe("month");
  });

  it("falls back to the label only for windows with no duration", () => {
    expect(windowKind(window({ label: "Spend cap", windowSeconds: 0 }))).toBe("cap");
    expect(windowKind(window({ label: "On-demand", windowSeconds: 0 }))).toBe("cap");
    expect(
      windowKind(window({ label: "Credits", windowSeconds: 0, isCurrency: true })),
    ).toBe("balance");
    expect(
      windowKind(
        window({ label: "Credits Remaining", windowSeconds: 0, isCurrency: true }),
      ),
    ).toBe("balance");
  });

  it("reports an unrecognised unit as other rather than guessing", () => {
    // Z.ai emits a bare "Tokens" window when it cannot identify the unit.
    expect(windowKind(window({ label: "Tokens", windowSeconds: 0 }))).toBe("other");
  });
});
