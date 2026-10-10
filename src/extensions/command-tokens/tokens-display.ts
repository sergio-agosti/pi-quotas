import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Loader, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import pkg from "../../../package.json" with { type: "json" };
import type {
  AggregateResult,
} from "../../lib/session-tokens.js";
import {
  formatCost,
  formatNumber,
  formatTokenSummary,
} from "../../lib/session-tokens.js";

type TokensState =
  | { type: "loading" }
  | { type: "loaded"; result: AggregateResult };

type TabId = "overview" | "models" | "sessions";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "models", label: "Models" },
  { id: "sessions", label: "Sessions" },
];

function renderProgressBar(
  value: number,
  max: number,
  width: number,
  theme: Theme,
): string {
  if (max <= 0 || value <= 0) return theme.fg("dim", "░".repeat(width));
  const ratio = Math.min(1, value / max);
  const filled = Math.round(ratio * width);
  const parts: string[] = [];
  for (let i = 0; i < width; i++) {
    parts.push(i < filled ? theme.fg("accent", "█") : theme.fg("dim", "░"));
  }
  return parts.join("");
}

export class TokensComponent implements Component {
  private state: TokensState = { type: "loading" };
  private loader: Loader | null = null;
  private activeTab: TabId = "overview";
  private scrollOffset = 0;

  constructor(
    private theme: Theme,
    private tui: any,
    private onClose: () => void,
    private onRefetch: () => void,
    private cwd?: string,
  ) {
    this.startLoader();
  }

  private startLoader(): void {
    this.loader = new Loader(
      this.tui,
      (s: string) => this.theme.fg("accent", s),
      (s: string) => this.theme.fg("muted", s),
      "Scanning sessions...",
    );
  }

  destroy(): void {
    this.loader?.stop();
    this.loader = null;
  }

  setState(state: TokensState): void {
    if (state.type === "loading") {
      this.loader?.stop();
      this.startLoader();
      this.scrollOffset = 0;
    } else if (this.state.type === "loading") {
      this.loader?.stop();
      this.loader = null;
    }
    this.state = state;
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, "escape") || data === "q") {
      this.onClose();
      return true;
    }
    if (data === "r") {
      this.onRefetch();
      return true;
    }
    if (data === "\t" || data === "right") {
      const idx = TABS.findIndex((t) => t.id === this.activeTab);
      this.activeTab = TABS[(idx + 1) % TABS.length].id;
      this.scrollOffset = 0;
      this.tui.requestRender();
      return true;
    }
    if (data === "left") {
      const idx = TABS.findIndex((t) => t.id === this.activeTab);
      this.activeTab = TABS[(idx - 1 + TABS.length) % TABS.length].id;
      this.scrollOffset = 0;
      this.tui.requestRender();
      return true;
    }
    if (data === "1") {
      this.activeTab = "overview";
      this.scrollOffset = 0;
      this.tui.requestRender();
      return true;
    }
    if (data === "2") {
      this.activeTab = "models";
      this.scrollOffset = 0;
      this.tui.requestRender();
      return true;
    }
    if (data === "3") {
      this.activeTab = "sessions";
      this.scrollOffset = 0;
      this.tui.requestRender();
      return true;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.scrollOffset++;
      this.tui.requestRender();
      return true;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
      return true;
    }
    return false;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const border = new DynamicBorder((s: string) => this.theme.fg("border", s));
    lines.push(...border.render(width));
    lines.push(
      truncateToWidth(
        ` ${this.theme.fg("accent", this.theme.bold("Token Usage"))}`,
        width,
      ),
    );

    // Tab bar
    const tabParts = TABS.map((tab) => {
      if (tab.id === this.activeTab) {
        return this.theme.fg("accent", this.theme.bold(`[${tab.label}]`));
      }
      return this.theme.fg("dim", ` ${tab.label} `);
    });
    lines.push(truncateToWidth(`  ${tabParts.join("  ")}`, width));
    lines.push("");

    if (this.state.type === "loading") {
      lines.push(
        ...(this.loader
          ? this.loader.render(width)
          : [this.theme.fg("muted", "  Scanning sessions...")]),
      );
    } else {
      const contentLines = this.renderTab(width);
      // Apply scroll
      const maxVisible = Math.max(1, 20); // approximate visible lines
      const visible = contentLines.slice(
        this.scrollOffset,
        this.scrollOffset + maxVisible,
      );
      lines.push(...visible);
    }

    lines.push("");
    lines.push(
      this.theme.fg(
        "dim",
        `  pi-quotas v${pkg.version}  ·  1/2/3 switch tab  r refresh  q/Esc close`,
      ),
    );
    lines.push(...border.render(width));
    return lines;
  }

  private renderTab(width: number): string[] {
    if (this.state.type !== "loaded") return [];
    const { result } = this.state;

    switch (this.activeTab) {
      case "overview":
        return this.renderOverview(result, width);
      case "models":
        return this.renderModels(result, width);
      case "sessions":
        return this.renderSessions(result, width);
    }
  }

  private renderOverview(result: AggregateResult, width: number): string[] {
    const lines: string[] = [];
    const { totals } = result;

    lines.push(
      truncateToWidth(
        `  ${this.theme.fg("accent", this.theme.bold("Summary"))}`,
        width,
      ),
    );
    lines.push("");

    const statRows = [
      ["Sessions", String(result.sessionCount)],
      ["Messages", String(result.messageCount)],
      ["Input tokens", formatNumber(totals.input)],
      ["Output tokens", formatNumber(totals.output)],
      ["Cache read", formatNumber(totals.cacheRead)],
      ["Cache write", formatNumber(totals.cacheWrite)],
      ["Total tokens", formatNumber(totals.totalTokens)],
      ["Total cost", formatCost(totals.costTotal)],
    ];

    const labelWidth = Math.max(...statRows.map(([l]) => l.length));
    for (const [label, value] of statRows) {
      lines.push(
        truncateToWidth(
          `  ${this.theme.fg("dim", label.padEnd(labelWidth))}  ${this.theme.fg("accent", value)}`,
          width,
        ),
      );
    }

    // Provider breakdown
    if (result.byProvider.length > 0) {
      lines.push("");
      lines.push(
        truncateToWidth(
          `  ${this.theme.fg("accent", this.theme.bold("By Provider"))}`,
          width,
        ),
      );
      lines.push("");
      const maxCost = Math.max(
        ...result.byProvider.map((p) => p.tokens.costTotal),
      );
      for (const provider of result.byProvider) {
        const barWidth = Math.min(20, Math.max(8, width - 40));
        const bar = renderProgressBar(
          provider.tokens.costTotal,
          maxCost,
          barWidth,
          this.theme,
        );
        const cost = formatCost(provider.tokens.costTotal);
        const msgs = `${provider.messageCount} msgs`;
        lines.push(
          truncateToWidth(
            `  ${this.theme.fg("accent", provider.provider.padEnd(20))} ${bar} ${this.theme.fg("accent", cost)} ${this.theme.fg("dim", msgs)}`,
            width,
          ),
        );
      }
    }

    return lines;
  }

  private renderModels(result: AggregateResult, width: number): string[] {
    const lines: string[] = [];

    if (result.byModel.length === 0) {
      lines.push(this.theme.fg("dim", "  No assistant messages found"));
      return lines;
    }

    const maxCost = Math.max(...result.byModel.map((m) => m.tokens.costTotal));

    for (const model of result.byModel) {
      const barWidth = Math.min(16, Math.max(8, width - 50));
      const bar = renderProgressBar(
        model.tokens.costTotal,
        maxCost,
        barWidth,
        this.theme,
      );
      const cost = formatCost(model.tokens.costTotal);
      const label =
        model.provider === model.model
          ? model.model
          : `${model.provider}/${model.model}`;
      const shortLabel = label.length > 30 ? label.slice(0, 27) + "..." : label;

      lines.push(
        truncateToWidth(`  ${this.theme.fg("accent", shortLabel)}`, width),
      );
      lines.push(
        truncateToWidth(
          `    ${bar} ${this.theme.fg("accent", cost)}  ${this.theme.fg("dim", formatTokenSummary(model.tokens))}`,
          width,
        ),
      );
    }

    return lines;
  }

  private renderSessions(result: AggregateResult, width: number): string[] {
    const lines: string[] = [];

    if (result.bySession.length === 0) {
      lines.push(this.theme.fg("dim", "  No sessions found"));
      return lines;
    }

    const maxCost = Math.max(
      ...result.bySession.map((s) => s.tokens.costTotal),
    );

    for (const session of result.bySession) {
      const dateStr = session.created.toISOString().slice(0, 10);
      const name = session.name ?? session.sessionId.slice(0, 8);
      const cost = formatCost(session.tokens.costTotal);
      const msgs = `${session.messageCount} msgs`;

      const barWidth = Math.min(12, Math.max(6, width - 50));
      const bar = renderProgressBar(
        session.tokens.costTotal,
        maxCost,
        barWidth,
        this.theme,
      );

      lines.push(
        truncateToWidth(
          `  ${this.theme.fg("dim", dateStr)} ${this.theme.fg("accent", name)} ${bar} ${this.theme.fg("accent", cost)} ${this.theme.fg("dim", msgs)}`,
          width,
        ),
      );
    }

    if (result.sessionCount > result.bySession.length) {
      lines.push("");
      lines.push(
        this.theme.fg(
          "dim",
          `  Showing ${result.bySession.length} of ${result.sessionCount} sessions`,
        ),
      );
    }

    return lines;
  }

  invalidate(): void {}
}
