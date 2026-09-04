// The warehouse reader — where every dashboard answer comes from.
//
// Reads are SUMs over `ad_daily`; metrics.ts recomputes the derived fields from
// the summed totals, so a range read here is arithmetically identical to the
// one the platform API would return for the same window. No provider call
// happens on the request path, which is the entire point: platform reads happen
// on the sync schedule (sync.ts), never per page view or per agent question.
//
// Everything downstream — metrics.ts, audit.ts, report.ts, the client — is
// unchanged, because this module returns the same normalized shapes the live
// providers do.

import { get, query } from "@clawnify/db";
import type {
  AccountRef, AccountReport, AccountSummary, DailyPoint, DateRange, Metrics, Platform,
} from "./providers/types";
import { buildKpis, deriveIssues, metrics } from "./metrics";

/** The five raw totals every metric is derived from. */
interface RawTotals {
  spend: number;
  revenue: number;
  conversions: number;
  clicks: number;
  impressions: number;
}

const SUMS = `COALESCE(SUM(spend), 0) AS spend,
              COALESCE(SUM(revenue), 0) AS revenue,
              COALESCE(SUM(conversions), 0) AS conversions,
              COALESCE(SUM(clicks), 0) AS clicks,
              COALESCE(SUM(impressions), 0) AS impressions`;

const toMetrics = (r: Partial<RawTotals> | undefined): Metrics =>
  metrics({
    spend: Number(r?.spend ?? 0),
    revenue: Number(r?.revenue ?? 0),
    conversions: Number(r?.conversions ?? 0),
    clicks: Number(r?.clicks ?? 0),
    impressions: Number(r?.impressions ?? 0),
  });

/** True once a sync has landed any rows — the dashboard falls back to preview until then. */
export async function hasWarehouseData(): Promise<boolean> {
  const row = await get<{ n: number }>("SELECT COUNT(*) AS n FROM ad_daily");
  return Number(row?.n ?? 0) > 0;
}

/** Every account a sync has seen, for the account picker. */
export async function warehouseAccounts(): Promise<AccountRef[]> {
  const rows = await query<{ id: string; platform: string; name: string; currency: string }>(
    "SELECT id, platform, name, currency FROM ad_accounts ORDER BY name",
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name || r.id,
    platform: r.platform as Platform,
    currency: r.currency || "USD",
  }));
}

/**
 * Portfolio table: current and prior-period metrics for every account.
 *
 * Two grouped queries for the whole portfolio, whatever the account count —
 * where the live path issued 1 + 2N platform calls for N accounts.
 */
export async function warehouseSummaries(range: DateRange): Promise<AccountSummary[]> {
  const accounts = await warehouseAccounts();
  if (accounts.length === 0) return [];

  const totalsBy = async (since: string, until: string) => {
    const rows = await query<RawTotals & { platform: string; account_id: string }>(
      `SELECT platform, account_id, ${SUMS}
         FROM ad_daily WHERE date BETWEEN ? AND ?
        GROUP BY platform, account_id`,
      [since, until],
    );
    return new Map(rows.map((r) => [`${r.platform}:${r.account_id}`, r]));
  };

  const [cur, prev] = await Promise.all([
    totalsBy(range.since, range.until),
    totalsBy(range.prevSince, range.prevUntil),
  ]);

  return accounts.map((acc) => {
    const key = `${acc.platform}:${acc.id}`;
    const prevRow = prev.get(key);
    return {
      ...acc,
      metrics: toMetrics(cur.get(key)),
      // No prior rows at all means the window predates the backfill, which is
      // not the same as "the account spent nothing" — leave the delta unknown.
      prev: prevRow ? toMetrics(prevRow) : null,
    };
  });
}

/** Account View: KPIs, the daily series behind the charts, and heuristic issues. */
export async function warehouseAccountReport(
  accountId: string,
  platform: Platform | undefined,
  range: DateRange,
): Promise<AccountReport | null> {
  const account = (await warehouseAccounts()).find(
    (a) => a.id === accountId && (!platform || a.platform === platform),
  );
  if (!account) return null;

  const args = [account.platform, account.id];
  const [curRow, prevRow, dailyRows] = await Promise.all([
    get<RawTotals>(
      `SELECT ${SUMS} FROM ad_daily WHERE platform = ? AND account_id = ? AND date BETWEEN ? AND ?`,
      [...args, range.since, range.until],
    ),
    get<RawTotals & { n: number }>(
      `SELECT ${SUMS}, COUNT(*) AS n FROM ad_daily
        WHERE platform = ? AND account_id = ? AND date BETWEEN ? AND ?`,
      [...args, range.prevSince, range.prevUntil],
    ),
    query<RawTotals & { date: string }>(
      `SELECT date, ${SUMS} FROM ad_daily
        WHERE platform = ? AND account_id = ? AND date BETWEEN ? AND ?
        GROUP BY date ORDER BY date`,
      [...args, range.since, range.until],
    ),
  ]);

  const cur = toMetrics(curRow);
  const prev = Number(prevRow?.n ?? 0) > 0 ? toMetrics(prevRow) : null;

  const daily: DailyPoint[] = dailyRows.map((row) => {
    const m = toMetrics(row);
    return {
      date: row.date,
      spend: m.spend, revenue: m.revenue, conversions: m.conversions,
      clicks: m.clicks, impressions: m.impressions,
      roas: m.roas, convRate: m.convRate, ctr: m.ctr,
    };
  });

  return {
    account,
    range: { since: range.since, until: range.until, days: range.days },
    kpis: buildKpis(cur, prev),
    daily,
    channels: [{ platform: account.platform, metrics: cur }],
    issues: deriveIssues(cur, prev, daily, account.currency),
    generatedAt: new Date().toISOString(),
    preview: false,
  };
}

/** What /api/state reports so consumers can see how fresh the numbers are. */
export interface Freshness {
  lastSyncAt: string | null;
  status: string | null;
  accounts: number;
  /** Most recent day with any data, across all accounts. */
  throughDate: string | null;
  /** Days between today (UTC) and throughDate; null with no data. */
  daysBehind: number | null;
  /**
   * The numbers have stopped moving. A healthy chain lands yesterday's rows
   * every morning, so more than a day behind means a sync has not run or has
   * not written anything — the failure mode a warehouse trades a quota failure
   * for, and the one the reader has to be told about.
   */
  stale: boolean;
  /** When the next sync is booked to run, if one is. */
  nextSyncAt: string | null;
  error: string | null;
}

export async function warehouseFreshness(): Promise<Freshness> {
  const [run, coverage, booking] = await Promise.all([
    get<{ finished_at: string | null; status: string; error: string | null }>(
      "SELECT finished_at, status, error FROM sync_runs ORDER BY started_at DESC LIMIT 1",
    ),
    get<{ n: number; through: string | null }>(
      "SELECT COUNT(DISTINCT platform || account_id) AS n, MAX(date) AS through FROM ad_daily",
    ),
    get<{ run_at: string }>("SELECT run_at FROM sync_schedule WHERE id = 1"),
  ]);
  const through = coverage?.through ?? null;
  const daysBehind = through
    ? Math.max(0, Math.round((Date.now() - Date.parse(through + "T00:00:00Z")) / 86_400_000))
    : null;
  return {
    lastSyncAt: run?.finished_at ?? null,
    status: run?.status ?? null,
    accounts: Number(coverage?.n ?? 0),
    throughDate: through,
    daysBehind,
    stale: daysBehind !== null && daysBehind > 1,
    nextSyncAt: booking?.run_at ?? null,
    error: run?.error ?? null,
  };
}
