import type { QuotaWindow } from "../../types/quotas.js";

/**
 * What shape a quota window is, for consumers that draw it rather than print
 * it.
 *
 * Providers disagree about labels, so this is derived from the duration
 * wherever there is one. OpenAI Codex *generates* its labels from the duration
 * (`codexWindowLabel()` -> "7d", "90s", "30m"), so a label-driven table would
 * misclassify every Codex window; Anthropic scopes a weekly window to a single
 * model ("7d Fable"), whose short label is the model name; and Z.ai falls back
 * to a bare "Tokens" when it cannot identify the unit. Only the windows with no
 * duration at all fall back to their label, and there are three of those:
 * provider balances, spend caps, and unrecognised units.
 */
export type QuotaWindowKind =
  | "hours"
  | "day"
  | "week"
  | "month"
  | "balance"
  | "cap"
  | "other";

/**
 * The fields windowKind needs. Satisfied by both QuotaWindow and WindowStatus,
 * so callers can classify a window without converting between the two.
 */
export type WindowKindInput = Pick<
  QuotaWindow,
  "label" | "windowSeconds" | "isCurrency"
>;

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * HOUR_SECONDS;

/**
 * Windows with no duration whose value is not a fraction of a rolling
 * allowance. Everything else with no duration is a balance when the provider
 * reports it as currency.
 */
const CAP_LABELS = new Set(["Spend cap", "On-demand"]);

export function windowKind(window: WindowKindInput): QuotaWindowKind {
  const seconds = window.windowSeconds;
  if (seconds > 0) {
    if (seconds <= 12 * HOUR_SECONDS) return "hours";
    if (seconds <= 2 * DAY_SECONDS) return "day";
    if (seconds <= 10 * DAY_SECONDS) return "week";
    return "month";
  }
  if (CAP_LABELS.has(window.label)) return "cap";
  if (window.isCurrency) return "balance";
  return "other";
}
