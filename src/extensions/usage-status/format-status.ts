import type { RiskSeverity } from "../../utils/quotas-severity.js";
import { getSeverityColor } from "../../utils/quotas-severity.js";

export type WindowStatus = {
  label: string;
  usedPercent: number;
  severity: RiskSeverity;
  resetsAt: string | null;
  limited: boolean;
  isCurrency?: boolean;
  usedValue?: number;
  limitValue?: number;
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

  // Synthetic windows always use compact "remaining%" format
  // to match the pi-synthetic extension display
  const SYNTHETIC_LABELS = new Set([
    "Credits / week", "Requests / 5h", "Search / hour", "Free Tool Calls / day",
  ]);
  const isSynthetic = SYNTHETIC_LABELS.has(w.label);

  let valueText: string;
  if (isSynthetic) {
    // Compact format matching pi-synthetic: just remaining%
    valueText = theme.fg(color, `${remainingPercent(w)}%`);
  } else if (w.label === "Spend cap") {
    valueText = theme.fg(color, w.limited ? "REACHED" : "OK");
  } else if (w.isCurrency && w.usedValue != null && w.limitValue != null) {
    // Tracking-only windows have limitValue=0, show just usage
    if (w.limitValue === 0) {
      valueText = theme.fg(color, `$${w.usedValue.toFixed(2)} used`);
    } else {
      valueText = theme.fg(color, `$${w.usedValue.toFixed(2)}/$${w.limitValue.toFixed(2)}`);
    }
  } else if (hasRealCounts(w)) {
    const remaining = Math.max(0, Math.round(w.limitValue! - w.usedValue!));
    valueText = theme.fg(color, `${remaining}/${w.limitValue}`);
  } else {
    valueText = theme.fg(color, `${remainingPercent(w)}%`);
  }

  const limitTag = w.limited ? theme.fg("error", " !") : "";
  return `${labelText}${valueText}${limitTag}`;
}
