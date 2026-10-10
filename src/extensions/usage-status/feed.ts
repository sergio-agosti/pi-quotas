import type { SupportedQuotaProvider } from "../../types/quotas.js";
import type { RiskSeverity } from "../../utils/quotas-severity.js";
import {
  formatFooterResetTime,
  formatWindowValue,
  windowShortLabel,
  type WindowStatus,
} from "./format-status.js";
import { windowKind, type QuotaWindowKind } from "./window-kind.js";

/**
 * Event-bus channel carrying the structured form of the usage footer.
 *
 * The footer status is a rendered string, so any consumer that wants to draw
 * this data rather than print it — a bar, an icon, a different order — would
 * otherwise have to parse percentages back out of the text. That loses the
 * pace-aware `severity` from assessWindow(), which depends on how far through
 * the window we are and not only on the percentage, so a parsed value is not
 * merely less precise but frequently wrong: the same 85% is `warning` early in
 * a window and `none` late in one.
 *
 * This payload is the same data the footer renders, unrendered. The text
 * status remains the source of truth for consumers that only print it.
 */
export const QUOTAS_USAGE_UPDATED_EVENT = "quotas:usage:updated";

export interface QuotasUsageWindowPayload {
  /** The provider's own label, e.g. "5h Rolling", "7d Fable", "Monthly". */
  label: string;
  /** Footer tag, e.g. "5h", "fable", "mo". */
  shortLabel: string;
  /** Window shape, derived from `windowSeconds` rather than the label. */
  kind: QuotaWindowKind;
  /** The value exactly as the footer prints it, without colour. */
  valueText: string;
  /**
   * Remaining percent, when a bar is a meaningful representation of this
   * window. Null for balances, spend caps, and used/limit pairs, where a bar
   * drawn beside a number it does not measure reads as a contradiction.
   */
  barPercent: number | null;
  severity: RiskSeverity;
  /** ISO timestamp, or null when the window does not reset. */
  resetsAt: string | null;
  /**
   * The reset suffix exactly as the footer appends it, e.g. " ↺ 2h·19m". Null
   * when the window does not reset. Carried pre-formatted so a consumer does
   * not re-derive the duration format and drift from the footer.
   */
  resetText: string | null;
  limited: boolean;
  windowSeconds: number;
}

export interface QuotasUsagePayload {
  /**
   * The status key this feed is the structured form of. A consumer uses it to
   * suppress the raw text the feed supersedes without hardcoding our
   * extension id.
   */
  statusKey: string;
  /** Null when the feed is being cleared, e.g. no supported provider. */
  provider: SupportedQuotaProvider | null;
  /** Empty when there is nothing to show. */
  windows: QuotasUsageWindowPayload[];
  fetchedAt: string;
}

export interface UsageFeedInput {
  statusKey: string;
  provider: SupportedQuotaProvider | null;
  windows: WindowStatus[];
  fetchedAt: Date;
}

export function buildUsageFeed(input: UsageFeedInput): QuotasUsagePayload {
  return {
    statusKey: input.statusKey,
    provider: input.provider,
    fetchedAt: input.fetchedAt.toISOString(),
    windows: input.windows.map((w) => {
      const value = formatWindowValue(w);
      return {
        label: w.label,
        shortLabel: windowShortLabel(w.label),
        kind: windowKind(w),
        valueText: value.text,
        barPercent: value.barPercent,
        severity: w.severity,
        resetsAt: w.resetsAt,
        resetText: w.resetsAt ? formatFooterResetTime(w.resetsAt) : null,
        limited: w.limited,
        windowSeconds: w.windowSeconds,
      };
    }),
  };
}
