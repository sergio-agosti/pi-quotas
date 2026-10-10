import type { RiskSeverity } from "../../utils/quotas-severity.js";
import {
  formatTimeRemaining,
  getSeverityColor,
} from "../../utils/quotas-severity.js";

export type WindowStatus = {
  label: string;
  usedPercent: number;
  severity: RiskSeverity;
  resetsAt: string | null;
  limited: boolean;
  isCurrency?: boolean;
  usedValue?: number;
  limitValue?: number;
  /**
   * Window duration. 0 for windows that are not time-based (balances, spend
   * caps), which is the signal windowKind() uses to tell them apart.
   */
  windowSeconds: number;
};

export interface ThemeLike {
  fg(color: string, text: string): string;
}

/**
 * [local patch] Short footer tag per provider window, in the same style as the
 * token-cost footer ("5h:", "wk:", "mo:"). Upstream's table mixed conventions
 * ("5h Rolling", "7d-son", "budget", "premium") so the same window read
 * differently depending on which provider was active.
 *
 * Unknown labels fall through to the raw label, so a new provider is never
 * worse than before.
 */
const SHORT_LABELS: Record<string, string> = {
  // Rolling / session windows
  "5h": "5h",
  "5h Rolling": "5h",
  "Requests / 5h": "5h",
  "Search / hour": "hr",
  "Daily": "day",
  "Free Tool Calls / day": "day",
  // Weekly windows
  "7d": "wk",
  "Weekly": "wk",
  "Week (credits)": "wk",
  "Credits / week": "wk",
  "7d Sonnet": "wk-son",
  "7d Opus": "wk-opus",
  "7d Opus (legacy)": "wk-opus",
  // [local patch] Anthropic reports per-model weekly limits as "7d <Model>"
  // (from limits[].scope.model.display_name); they are tagged with the model
  // name itself via windowShortLabel(), so there is no abbreviation table entry
  // to keep in sync here.
  // Monthly windows
  "Monthly": "mo",
  "Monthly Budget": "mo",
  "Web / month": "mo",
  // GitHub Copilot grants three separate monthly allowances, so keep them
  // distinct rather than printing "mo:" three times.
  "Premium / month": "premium",
  "Chat / month": "chat",
  "Completions / month": "comp",
  // Balances, caps, and top-ups
  "Credits": "bal",
  "Credits Remaining": "bal",
  "Spend cap": "cap",
  "On-demand": "ondemand",
  "Extra (AUD)": "extra",
  "Extra (USD)": "extra",
  "Extra (EUR)": "extra",
  "Extra (GBP)": "extra",
};

/**
 * Synthetic windows always use the compact "remaining%" format to match the
 * pi-synthetic extension display, rather than the count/currency forms.
 */
const SYNTHETIC_LABELS = new Set([
  "Credits / week",
  "Requests / 5h",
  "Search / hour",
  "Free Tool Calls / day",
]);

/**
 * [local patch] Resolve a window label to its footer tag. Anthropic's
 * model-scoped weekly windows ("7d Fable") are tagged with the model's own
 * name rather than an abbreviation, so there is nothing to decode; unknown
 * labels fall through to the raw label.
 */
export function windowShortLabel(label: string): string {
  const known = SHORT_LABELS[label];
  if (known) return known;
  const scoped = /^7d (.+)$/.exec(label);
  if (scoped) return scoped[1].toLowerCase();
  return label;
}

/**
 * [local patch] Remaining percentage for percentage-only windows, shared by
 * formatWindowStatus and the inline model-scoped suffix.
 */
export function remainingPercent(w: WindowStatus): number {
  return Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));
}

// [local patch] Footer reset tag: " ↺ 2d·1h·7m" rather than
// " (↺in 2d 1h 7m)". The "↺" is set off with a space on both sides so it does
// not weld onto the value, and the " · " between windows still separates
// them. `formatTimeRemaining` is left alone because the /quotas overlay uses
// it for its roomier "Resets in 2d 1h 7m" subtitle.
//
// Exported so the event-bus feed can publish the same suffix the footer
// appends, rather than a consumer re-deriving the duration format and
// drifting from it.
export function formatFooterResetTime(resetsAt: string): string {
  const remaining = formatTimeRemaining(new Date(resetsAt));
  return ` ↺ ${remaining.replaceAll(" ", "·")}`;
}

/**
 * Returns true when a window has a real used/limit pair
 * (e.g. 293/300 premium requests) rather than just a percentage.
 */
function hasRealCounts(w: WindowStatus): boolean {
  if (w.limitValue == null || w.usedValue == null) return false;
  // Percentage-only windows store limitValue=100 and usedValue=usedPercent
  if (w.limitValue === 100 && Math.abs(w.usedValue - w.usedPercent) < 0.01) return false;
  return w.limitValue > 0;
}

export interface WindowValue {
  /** The value exactly as the footer prints it, without colour. */
  text: string;
  /**
   * Remaining percent, when a bar is a meaningful representation of this
   * window. Null where the printed value is not a percentage of an allowance —
   * balances, spend caps, and used/limit pairs — because a bar drawn beside a
   * number it does not measure reads as a contradiction.
   */
  barPercent: number | null;
}

/**
 * The value half of a window's footer text, and whether it can be drawn as a
 * bar.
 *
 * Split out from formatWindowStatus so the event-bus feed can publish the same
 * value the footer shows without duplicating this branch structure or
 * re-parsing rendered ANSI. A count pair prints remaining/limit while a
 * currency pair prints used/limit, so "bar length equals the number shown"
 * cannot hold for both; only the percentage forms get a bar.
 */
export function formatWindowValue(w: WindowStatus): WindowValue {
  if (SYNTHETIC_LABELS.has(w.label)) {
    const remaining = remainingPercent(w);
    return { text: `${remaining}%`, barPercent: remaining };
  }
  if (w.label === "Spend cap") {
    return { text: w.limited ? "REACHED" : "OK", barPercent: null };
  }
  if (w.isCurrency && w.usedValue != null && w.limitValue != null) {
    // Tracking-only windows have limitValue=0, show just usage
    return {
      text:
        w.limitValue === 0
          ? `$${w.usedValue.toFixed(2)} used`
          : `$${w.usedValue.toFixed(2)}/$${w.limitValue.toFixed(2)}`,
      barPercent: null,
    };
  }
  if (hasRealCounts(w)) {
    const remaining = Math.max(0, Math.round(w.limitValue! - w.usedValue!));
    return { text: `${remaining}/${w.limitValue}`, barPercent: null };
  }
  const remaining = remainingPercent(w);
  return { text: `${remaining}%`, barPercent: remaining };
}

/**
 * Format a single window for the footer status bar.
 *
 * - Prefixes the value with a short window tag ("5h:", "wk:")
 * - Colors both the tag and value based on severity
 * - Uses "N/M" for real counts (e.g. "7/300")
 * - Uses "$X/$Y" for currency windows
 * - Uses "N%" (remaining) for windows with no real counts
 * - Uses "REACHED" / "OK" for spend cap
 */
export function formatWindowStatus(theme: ThemeLike, w: WindowStatus): string {
  const short = windowShortLabel(w.label);
  const color = getSeverityColor(w.severity);

  // Color the label based on severity: dim when safe, colored when at risk
  const isAtRisk = w.severity !== "none";
  const labelColor = isAtRisk ? color : "dim";
  const labelText = theme.fg(labelColor, `${short}:`);
  const valueText = theme.fg(color, formatWindowValue(w).text);

  const limitTag = w.limited ? theme.fg("error", " !") : "";
  return `${labelText}${valueText}${limitTag}`;
}
