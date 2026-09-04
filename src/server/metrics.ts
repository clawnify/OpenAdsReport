// Shared metric math + issue derivation. The app owns every calculation here so
// Meta and Google numbers are computed identically and the JSON API is the single
// source of truth for agents.

import type { Metrics, MetricDelta, DailyPoint, Issue, DateRange } from "./providers/types";

export function roas(spend: number, revenue: number) {
  return spend > 0 ? revenue / spend : 0;
}
export function cpa(spend: number, conversions: number) {
  return conversions > 0 ? spend / conversions : 0;
}
export function ctr(clicks: number, impressions: number) {
  return impressions > 0 ? (clicks / impressions) * 100 : 0;
}
export function convRate(conversions: number, clicks: number) {
  return clicks > 0 ? (conversions / clicks) * 100 : 0;
}

/** Build a Metrics object from the four raw totals, recomputing all derived fields. */
export function metrics(raw: {
  spend: number;
  revenue: number;
  conversions: number;
  clicks: number;
  impressions: number;
}): Metrics {
  return {
    ...raw,
    roas: roas(raw.spend, raw.revenue),
    cpa: cpa(raw.spend, raw.conversions),
    ctr: ctr(raw.clicks, raw.impressions),
    convRate: convRate(raw.conversions, raw.clicks),
  };
}

export const emptyMetrics = (): Metrics =>
  metrics({ spend: 0, revenue: 0, conversions: 0, clicks: 0, impressions: 0 });

/** Sum a list of Metrics into one aggregate (derived fields recomputed from totals). */
export function sumMetrics(list: Metrics[]): Metrics {
  const raw = list.reduce(
    (a, m) => ({
      spend: a.spend + m.spend,
      revenue: a.revenue + m.revenue,
      conversions: a.conversions + m.conversions,
      clicks: a.clicks + m.clicks,
      impressions: a.impressions + m.impressions,
    }),
    { spend: 0, revenue: 0, conversions: 0, clicks: 0, impressions: 0 },
  );
  return metrics(raw);
}

function pctChange(value: number, prev: number | null): number | null {
  if (prev === null || prev === 0) return null;
  return ((value - prev) / prev) * 100;
}

export function delta(value: number, prev: number | null, higherIsBetter = true): MetricDelta {
  return { value, prev, deltaPct: pctChange(value, prev), higherIsBetter };
}

/** The six KPIs rendered as cards in the Account View, with prior-period deltas. */
export function buildKpis(cur: Metrics, prev: Metrics | null) {
  const p = prev;
  return {
    cost: delta(cur.spend, p?.spend ?? null, true),
    roas: delta(cur.roas, p?.roas ?? null, true),
    conversions: delta(cur.conversions, p?.conversions ?? null, true),
    convRate: delta(cur.convRate, p?.convRate ?? null, true),
    clicks: delta(cur.clicks, p?.clicks ?? null, true),
    ctr: delta(cur.ctr, p?.ctr ?? null, true),
  };
}

// ── Date helpers ─────────────────────────────────────────────────────────────

const iso = (d: Date) => d.toISOString().split("T")[0];

/** Resolve a date range from optional since/until, defaulting to the last `days`. */
export function resolveRange(opts: { since?: string; until?: string; days?: number }): DateRange {
  const today = new Date();
  let until = opts.until ? new Date(opts.until + "T00:00:00Z") : today;
  let since: Date;
  if (opts.since) {
    since = new Date(opts.since + "T00:00:00Z");
  } else {
    const days = opts.days && opts.days > 0 ? opts.days : 30;
    since = new Date(until);
    since.setUTCDate(since.getUTCDate() - (days - 1));
  }
  const days = Math.max(1, Math.round((+until - +since) / 86_400_000) + 1);
  // Prior period: same length, immediately before `since`.
  const prevUntil = new Date(since);
  prevUntil.setUTCDate(prevUntil.getUTCDate() - 1);
  const prevSince = new Date(prevUntil);
  prevSince.setUTCDate(prevSince.getUTCDate() - (days - 1));
  return { since: iso(since), until: iso(until), prevSince: iso(prevSince), prevUntil: iso(prevUntil), days };
}

// ── Issue derivation ─────────────────────────────────────────────────────────
//
// Heuristic, metric-driven issues. These are intentionally generic and honest —
// the deep audits (keywords, search terms, feed health, creative fatigue) belong
// to the Phase 2 agent-generated report engine, not to live API math.

/**
 * `currency` is the account's own (ISO 4217, as the platform reports it) so a
 * EUR or GBP account is never told what it spent in dollars. Defaults to USD
 * only for the sample data, which is minted in USD.
 */
export function deriveIssues(cur: Metrics, prev: Metrics | null, daily: DailyPoint[], currency = "USD"): Issue[] {
  const issues: Issue[] = [];
  const money = (n: number) => formatMoney(n, currency);
  const drop = (a: number, b: number | undefined) => (b && b > 0 ? ((a - b) / b) * 100 : null);

  if (cur.spend > 0 && cur.roas < 1) {
    issues.push({
      id: "roas-below-1",
      title: "Account is losing money",
      detail: `ROAS is ${cur.roas.toFixed(2)}x — every unit of the ${money(cur.spend)} spent is returning less than it cost.`,
      action: "Pause the lowest-ROAS campaigns and shift budget to your top performers before scaling anything.",
      severity: "high",
    });
  } else if (cur.spend > 0 && cur.roas < 2) {
    issues.push({
      id: "roas-thin",
      title: "ROAS below a healthy target",
      detail: `ROAS is ${cur.roas.toFixed(2)}x, under the 2.0x most accounts need to stay profitable after fees and COGS.`,
      action: "Tighten targeting and cut the bottom 20% of ad sets by ROAS to lift the blended return.",
      severity: "medium",
    });
  }

  const cpaChange = drop(cur.cpa, prev?.cpa);
  if (prev && cpaChange !== null && cpaChange > 15 && cur.spend > 0) {
    issues.push({
      id: "cpa-rising",
      title: "CPA is climbing",
      detail: `Cost per acquisition rose ${cpaChange.toFixed(0)}% vs the prior period (now ${money(cur.cpa)}).`,
      action: "Refresh fatigued creative and re-check audience overlap — rising CPA usually means saturation.",
      severity: cpaChange > 30 ? "high" : "medium",
    });
  }

  const ctrChange = drop(cur.ctr, prev?.ctr);
  if (prev && ctrChange !== null && ctrChange < -10) {
    issues.push({
      id: "ctr-falling",
      title: "CTR is declining — creative fatigue",
      detail: `Click-through rate fell ${Math.abs(ctrChange).toFixed(0)}% vs the prior period (now ${cur.ctr.toFixed(2)}%).`,
      action: "Rotate in 3 fresh creative variations on your top ad sets and retire the worst performers.",
      severity: "medium",
    });
  }

  if (cur.clicks > 100 && cur.convRate < 1) {
    issues.push({
      id: "low-conv-rate",
      title: "Low conversion rate",
      detail: `Only ${cur.convRate.toFixed(2)}% of ${formatNum(cur.clicks)} clicks converted — the leak is after the click.`,
      action: "Audit landing-page speed and message match, and confirm conversion tracking is firing once (not twice).",
      severity: "medium",
    });
  }

  // Spend up while conversions down — a classic efficiency warning.
  const spendUp = drop(cur.spend, prev?.spend);
  const convDown = drop(cur.conversions, prev?.conversions);
  if (prev && spendUp !== null && convDown !== null && spendUp > 5 && convDown < -5) {
    issues.push({
      id: "spend-up-conv-down",
      title: "Spending more, converting less",
      detail: `Spend is up ${spendUp.toFixed(0)}% but conversions are down ${Math.abs(convDown).toFixed(0)}% vs the prior period.`,
      action: "Cap budgets on the campaigns driving the extra spend until their conversion volume recovers.",
      severity: "high",
    });
  }

  return issues;
}

const formatMoney = (n: number, currency: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: n < 100 ? 2 : 0 }).format(n);

const formatNum = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n));

/** Map an account's ROAS to a severity used for the portfolio "Top Issues" ranking. */
export function roasSeverity(roasValue: number): "high" | "medium" | "low" {
  if (roasValue < 1) return "high";
  if (roasValue < 2.5) return "medium";
  return "low";
}
