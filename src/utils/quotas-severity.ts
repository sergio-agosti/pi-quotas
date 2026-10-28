import type { QuotaWindow } from "../types/quotas.js";
export type { QuotaWindow } from "../types/quotas.js";

export type RiskSeverity = "none" | "warning" | "high" | "critical";

export interface WindowProjection {
  pacePercent: number | null;
  projectedPercent: number;
  usedPercent: number;
}

export interface RiskAssessment extends WindowProjection {
  severity: RiskSeverity;
}

const MIN_PACE_PERCENT = 5;

/**
 * Projection thresholds, in projected end-of-window usage percent. Fixed, so the
 * colour can be read off the numbers: amber means "at this pace this window runs
 * out before it resets", red that it runs out well before.
 */
export const PROJECTION_THRESHOLDS = {
  warning: 100,
  high: 130,
  critical: 175,
};

/**
 * Projection is ignored until the window has both elapsed and consumed this much,
 * so a burst in the first minutes of a window does not paint the footer red.
 */
export const PROJECTION_FLOOR_PERCENT = 10;

/** Used-usage thresholds for windows with no pace to project from. */
export const ABSOLUTE_THRESHOLDS = {
  warning: 80,
  high: 90,
  critical: 100,
};

export function safePercent(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

export function getPacePercent(window: QuotaWindow): number | null {
  const totalMs = window.windowSeconds * 1000;
  if (totalMs <= 0) return null;
  const remainingMs = window.resetsAt.getTime() - Date.now();
  const elapsedMs = totalMs - remainingMs;
  return Math.max(0, Math.min(100, (elapsedMs / totalMs) * 100));
}

export function getProjectedPercent(
  usedPercent: number,
  pacePercent: number | null,
): number {
  if (pacePercent === null) return usedPercent;
  const effectivePace = Math.max(MIN_PACE_PERCENT, pacePercent);
  return Math.max(0, (usedPercent / effectivePace) * 100);
}

function absoluteUsageSeverity(
  window: QuotaWindow,
  percent: number,
): RiskSeverity {
  if (window.limited || percent >= ABSOLUTE_THRESHOLDS.critical) return "critical";
  if (percent >= ABSOLUTE_THRESHOLDS.high) return "high";
  if (percent >= ABSOLUTE_THRESHOLDS.warning) return "warning";
  return "none";
}

function projectedSeverity(projectedPercent: number): RiskSeverity {
  if (projectedPercent >= PROJECTION_THRESHOLDS.critical) return "critical";
  if (projectedPercent >= PROJECTION_THRESHOLDS.high) return "high";
  if (projectedPercent >= PROJECTION_THRESHOLDS.warning) return "warning";
  return "none";
}

export function assessWindow(window: QuotaWindow): RiskAssessment {
  const rawPace = window.showPace ? getPacePercent(window) : null;
  const pacePercent =
    rawPace !== null ? rawPace * (window.paceScale ?? 1) : null;
  const projectedPercent = getProjectedPercent(window.usedPercent, pacePercent);

  const base: WindowProjection = {
    pacePercent,
    projectedPercent,
    usedPercent: window.usedPercent,
  };

  // Being out of budget is the one state the projection can miss: it assumes
  // steady spend, so it stays green while a burst could eat the last few percent.
  if (window.limited || window.usedPercent >= 100) {
    return { ...base, severity: "critical" };
  }

  // No pace to project from (e.g. a window that shows no reset time): the colour
  // can only describe what has already been used.
  if (pacePercent === null) {
    return { ...base, severity: absoluteUsageSeverity(window, projectedPercent) };
  }

  const pastFloor =
    window.usedPercent >= PROJECTION_FLOOR_PERCENT &&
    (rawPace ?? 0) >= PROJECTION_FLOOR_PERCENT;

  return {
    ...base,
    severity: pastFloor ? projectedSeverity(projectedPercent) : "none",
  };
}

export function formatTimeRemaining(date: Date): string {
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return "now";
  const totalMins = Math.ceil(ms / (1000 * 60));
  const totalHours = Math.floor(totalMins / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const mins = totalMins % 60;

  if (days >= 1) {
    const parts: string[] = [`${days}d`];
    if (hours > 0) parts.push(`${hours}h`);
    if (mins > 0) parts.push(`${mins}m`);
    return parts.join(" ");
  }
  if (hours >= 1) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const totalSecs = Math.ceil(ms / 1000);
  return totalMins >= 1 ? `${totalMins}m` : `${totalSecs}s`;
}

export function getSeverityColor(
  severity: RiskSeverity,
): "success" | "warning" | "error" {
  switch (severity) {
    case "critical":
    case "high":
      return "error";
    case "warning":
      return "warning";
    default:
      return "success";
  }
}
