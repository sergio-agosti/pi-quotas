import { describe, expect, it, vi } from "vitest";
import pkg from "../../../../package.json" with { type: "json" };
import { QuotasComponent } from "./quotas-display.js";

const ansi = {
  accent: "\x1b[32m",
  border: "\x1b[36m",
  dim: "\x1b[2m",
  error: "\x1b[31m",
  muted: "\x1b[90m",
  success: "\x1b[32m",
  warning: "\x1b[33m",
} as const;

function fakeTheme() {
  return {
    bold: (text: string) => text,
    fg: (color: keyof typeof ansi, text: string) => `${ansi[color] ?? ""}${text}\x1b[0m`,
    getFgAnsi: (color: keyof typeof ansi) => ansi[color] ?? "",
  };
}

function makeComponent(): QuotasComponent {
  return new QuotasComponent(
    fakeTheme() as any,
    { requestRender: () => {} } as any,
    "Quotas",
    () => {},
    () => {},
  );
}

describe("QuotasComponent", () => {
  it("renders the pi-quotas package version in the dashboard footer", () => {
    const component = makeComponent();
    component.setState({ type: "loaded", snapshots: [] });

    expect(component.render(70).join("\n")).toContain(`pi-quotas v${pkg.version}`);
  });

  it("explains when no active quota subscriptions are detected", () => {
    const component = makeComponent();
    component.setState({ type: "loaded", snapshots: [] });

    expect(component.render(70).join("\n")).toContain(
      "No active quota subscriptions detected",
    );
  });

  it("does not render an accent-colored pace marker inside filled warning bars", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T13:42:11Z"));

    const component = makeComponent();
    component.setState({
      type: "loaded",
      snapshots: [
        {
          provider: "github-copilot",
          result: {
            success: true,
            data: {
              provider: "github-copilot",
              windows: [
                {
                  provider: "github-copilot",
                  label: "Premium / month",
                  usedPercent: 83,
                  resetsAt: new Date("2026-06-01T10:00:00Z"),
                  windowSeconds: 31 * 24 * 3600,
                  usedValue: 249,
                  limitValue: 300,
                  showPace: true,
                  nextLabel: "Resets",
                  nextAmount: "overage allowed",
                },
              ],
            },
          },
        },
      ],
    });

    const output = component.render(70).join("\n");

    // [local patch] the " left" suffix was dropped from the overlay
    expect(output).toContain("51/300");
    expect(output).not.toContain("left");
    expect(output).not.toContain(`${ansi.accent}|`);

    vi.useRealTimers();
  });

  it("does not render a pace marker for zero-usage windows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T13:49:29Z"));

    const component = makeComponent();
    component.setState({
      type: "loaded",
      snapshots: [
        {
          provider: "synthetic",
          result: {
            success: true,
            data: {
              provider: "synthetic",
              windows: [
                {
                  provider: "synthetic",
                  label: "Credits / week",
                  usedPercent: 0,
                  resetsAt: new Date("2026-05-14T16:40:29Z"),
                  windowSeconds: 7 * 24 * 3600,
                  usedValue: 0,
                  limitValue: 24,
                  isCurrency: true,
                  showPace: true,
                  nextLabel: "Next regen",
                  nextAmount: "+$0.48",
                },
              ],
            },
          },
        },
      ],
    });

    const output = component.render(70).join("\n");

    expect(output).toContain("$0.00 / $24.00");
    expect(output).not.toContain("|");

    vi.useRealTimers();
  });

  it("renders a not_applicable provider silently with a dim note, not a warning", () => {
    const component = makeComponent();
    component.setState({
      type: "loaded",
      snapshots: [
        {
          provider: "anthropic",
          result: {
            success: false,
            error: {
              kind: "not_applicable",
              message: "Direct API key — no subscription usage to report",
            },
          },
        },
      ],
    });

    const output = component.render(70).join("\n");

    expect(output).toContain("Anthropic");
    expect(output).toContain("Direct API key");
    // Rendered as a dim informational note, not a warning.
    expect(output).toContain("\x1b[2m");
    expect(output).not.toContain("\x1b[33m");
    expect(output).not.toContain("usage unavailable");
    expect(output).not.toContain("{");
  });
});
