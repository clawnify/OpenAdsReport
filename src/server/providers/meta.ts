// Meta Ads provider. All data comes through the connections SDK's semantic
// methods — connect("metaads").adAccounts() / insights() / object() — which route
// through whatever maintainer holds the credential (Composio execute today). The
// app carries NO Graph API URLs, version, or token plumbing: the broker is hidden
// and a future maintainer swap changes the descriptor, not this file.

import type {
  AccountRef, AccountReport, AccountSummary, AdFatigueRow, AdProvider, AdWindowMetrics,
  DailyPoint, DateRange, MetaAudit, Metrics,
} from "./types";
import { connect, isConnected, type ConnectionsEnv, type MetaAdsClient, type MetaInsightRow } from "@clawnify/connections";
import { buildKpis, cpa as cpaOf, ctr as ctrOf, deriveIssues, emptyMetrics, metrics } from "../metrics";

type MetaAction = { action_type: string; value: string };

function pickAction(arr: MetaAction[] | undefined, type: string): number {
  const omni = arr?.find((a) => a.action_type === `omni_${type}`);
  const direct = arr?.find((a) => a.action_type === type);
  return +((omni ?? direct)?.value ?? 0);
}

function rowMetrics(row: MetaInsightRow): Metrics {
  return metrics({
    spend: +(row.spend ?? 0),
    revenue: pickAction(row.action_values, "purchase"),
    conversions: pickAction(row.actions, "purchase"),
    clicks: +(row.clicks ?? 0),
    impressions: +(row.impressions ?? 0),
  });
}

const first = (rows: MetaInsightRow[]): Metrics => (rows[0] ? rowMetrics(rows[0]) : emptyMetrics());

// Ad-level rows carry extra Graph fields the SDK type doesn't name.
type AdRow = MetaInsightRow & Record<string, any>;

const AD_FIELDS = [
  "ad_id", "ad_name", "adset_name", "campaign_name",
  "spend", "impressions", "clicks", "frequency", "cpm", "actions", "action_values",
];

function adWindow(row: AdRow): AdWindowMetrics {
  const spend = +(row.spend ?? 0);
  const clicks = +(row.clicks ?? 0);
  const impressions = +(row.impressions ?? 0);
  const conversions = pickAction(row.actions, "purchase");
  return {
    spend,
    impressions,
    clicks,
    conversions,
    frequency: row.frequency != null ? +row.frequency : null,
    ctr: ctrOf(clicks, impressions),
    cpm: row.cpm != null ? +row.cpm : impressions > 0 ? (spend / impressions) * 1000 : 0,
    cpa: cpaOf(spend, conversions),
  };
}

export class MetaProvider implements AdProvider {
  readonly id = "meta" as const;
  constructor(private client: MetaAdsClient) {}

  static async create(env: ConnectionsEnv): Promise<MetaProvider | null> {
    if (!(await isConnected("metaads", env))) return null;
    return new MetaProvider(connect("metaads", env));
  }

  isConnected() {
    return true;
  }

  async listAccounts(): Promise<AccountRef[]> {
    const accounts = await this.client.adAccounts("name,currency,account_status");
    return accounts
      .filter((a) => a.account_status === 1)
      .map((a) => ({ id: a.id, name: a.name ?? a.id, platform: "meta" as const, currency: a.currency ?? "USD" }));
  }

  async accountSummaries(range: DateRange): Promise<AccountSummary[]> {
    const accounts = await this.listAccounts();
    return Promise.all(
      accounts.map(async (acc) => {
        const [cur, prev] = await Promise.all([
          this.client.insights(acc.id, { level: "account", since: range.since, until: range.until }),
          this.client.insights(acc.id, { level: "account", since: range.prevSince, until: range.prevUntil }),
        ]);
        return { ...acc, metrics: first(cur), prev: prev[0] ? rowMetrics(prev[0]) : null };
      }),
    );
  }

  async accountReport(accountId: string, range: DateRange): Promise<AccountReport> {
    const id = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
    const [obj, cur, prev, daily] = await Promise.all([
      this.client.object(id, ["name", "currency"]),
      this.client.insights(id, { level: "account", since: range.since, until: range.until }),
      this.client.insights(id, { level: "account", since: range.prevSince, until: range.prevUntil }),
      // Per-day series for the charts (Graph time_increment=1).
      this.client.insights(id, { level: "account", since: range.since, until: range.until, timeIncrement: 1 }),
    ]);

    const curM = first(cur);
    const prevM = prev[0] ? rowMetrics(prev[0]) : null;
    const account: AccountRef = { id, name: obj.name ?? id, platform: "meta", currency: obj.currency ?? "USD" };

    const series: DailyPoint[] = daily
      .filter((row) => row.date_start)
      .map((row) => {
        const m = rowMetrics(row);
        return {
          date: row.date_start!,
          spend: m.spend, revenue: m.revenue, conversions: m.conversions, clicks: m.clicks,
          impressions: m.impressions, roas: m.roas, convRate: m.convRate, ctr: m.ctr,
        };
      });

    return {
      account,
      range: { since: range.since, until: range.until, days: range.days },
      kpis: buildKpis(curM, prevM),
      daily: series,
      channels: [{ platform: "meta", metrics: curM }],
      issues: deriveIssues(curM, prevM, series),
      generatedAt: new Date().toISOString(),
      preview: false,
    };
  }

  /**
   * Per-ad metrics for the current vs prior half of the range (a 14-day range
   * compares week over week). Rows join on ad_id; ads with no prior-window
   * delivery keep prev: null.
   * Ceiling: the insights action returns one Graph page (~25 ads per window) —
   * enough for most accounts; large accounts see their top delivering ads.
   */
  async adFatigue(accountId: string, range: DateRange): Promise<AdFatigueRow[]> {
    const id = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
    // Split [since..until] into two equal halves.
    const start = new Date(range.since + "T00:00:00Z");
    const end = new Date(range.until + "T00:00:00Z");
    const mid = new Date(start.getTime() + Math.floor((end.getTime() - start.getTime()) / 2));
    const midNext = new Date(mid);
    midNext.setUTCDate(midNext.getUTCDate() + 1);
    const iso = (d: Date) => d.toISOString().split("T")[0];

    const [curRows, prevRows] = await Promise.all([
      this.client.insights(id, { level: "ad", fields: AD_FIELDS, since: iso(midNext), until: range.until }) as Promise<AdRow[]>,
      this.client.insights(id, { level: "ad", fields: AD_FIELDS, since: range.since, until: iso(mid) }) as Promise<AdRow[]>,
    ]);

    const prevById = new Map(prevRows.filter((r) => r.ad_id).map((r) => [String(r.ad_id), r]));
    return curRows
      .filter((r) => r.ad_id)
      .map((r) => {
        const prev = prevById.get(String(r.ad_id));
        return {
          adId: String(r.ad_id),
          adName: String(r.ad_name ?? r.ad_id),
          adsetName: String(r.adset_name ?? ""),
          campaignName: String(r.campaign_name ?? ""),
          current: adWindow(r),
          prev: prev ? adWindow(prev) : null,
        };
      })
      .sort((a, b) => b.current.spend - a.current.spend);
  }

  async auditData(accountId: string, range: DateRange): Promise<MetaAudit> {
    const id = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
    const [ads, totals] = await Promise.all([
      this.adFatigue(accountId, range).catch(() => [] as AdFatigueRow[]),
      this.client.insights(id, { level: "account", since: range.since, until: range.until }),
    ]);
    const row = totals[0];
    return {
      platform: "meta",
      ads,
      hasPurchaseTracking: pickAction(row?.actions, "purchase") > 0,
      hasValueTracking: pickAction(row?.action_values, "purchase") > 0,
    };
  }
}
