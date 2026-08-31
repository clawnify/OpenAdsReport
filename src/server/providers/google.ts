// Google Ads provider. All the backend complexity — managed-action vs direct
// REST, the developer token, GAQL response parsing — now lives inside the
// connect("googleads") client. This provider just runs GAQL and shapes the rows
// into types.ts. `client.singleCustomer` tells us whether the connection targets
// one managed account or we can enumerate accessible accounts.

import type {
  AccountRef, AccountReport, AccountSummary, AdProvider, AdStrengthCounts, CampaignPerfRow,
  ConversionActionRow, DailyPoint, DateRange, GoogleAudit, KeywordQSRow, Metrics, SearchTermRow,
} from "./types";
import { connect, isConnected, type ConnectionsEnv, type GoogleAdsClient, type GoogleAdsRow } from "@clawnify/connections";
import { buildKpis, deriveIssues, emptyMetrics, metrics } from "../metrics";

const N = (v: unknown) => Number(v ?? 0);
const pick = (o: any, ...keys: string[]) => {
  for (const k of keys) if (o?.[k] != null) return o[k];
  return undefined;
};

function pretty(id: string) {
  const d = id.replace(/\D/g, "");
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : id;
}

function rowMetrics(row: GoogleAdsRow): Metrics {
  const m = (row.metrics ?? {}) as any;
  return metrics({
    spend: N(pick(m, "costMicros", "cost_micros")) / 1_000_000,
    revenue: N(pick(m, "conversionsValue", "conversions_value")),
    conversions: N(pick(m, "conversions")),
    clicks: N(pick(m, "clicks")),
    impressions: N(pick(m, "impressions")),
  });
}

const customerName = (row?: GoogleAdsRow, fallbackId = "") =>
  pick(row?.customer ?? {}, "descriptiveName", "descriptive_name") || pretty(fallbackId);
const customerCurrency = (row?: GoogleAdsRow) =>
  pick(row?.customer ?? {}, "currencyCode", "currency_code") || "USD";

const QUERIES = {
  customer: "SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer",
  totals: (since: string, until: string) =>
    `SELECT metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.clicks, metrics.impressions
     FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`,
  daily: (since: string, until: string) =>
    `SELECT segments.date, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.clicks, metrics.impressions
     FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}' ORDER BY segments.date`,
  // Phase 2 recipe data. Each query is one broker call; auditData runs them in parallel.
  searchTerms: (since: string, until: string) =>
    `SELECT search_term_view.search_term, segments.search_term_match_type, campaign.name,
            metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value
     FROM search_term_view WHERE segments.date BETWEEN '${since}' AND '${until}'
     ORDER BY metrics.cost_micros DESC LIMIT 50`,
  keywords: (since: string, until: string) =>
    `SELECT ad_group_criterion.keyword.text, ad_group_criterion.quality_info.quality_score, campaign.name,
            metrics.cost_micros, metrics.clicks
     FROM keyword_view WHERE segments.date BETWEEN '${since}' AND '${until}'
     ORDER BY metrics.cost_micros DESC LIMIT 200`,
  campaigns: (since: string, until: string) =>
    `SELECT campaign.id, campaign.name, campaign.bidding_strategy_type,
            metrics.cost_micros, metrics.conversions, metrics.search_impression_share,
            metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share
     FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}' AND campaign.status = 'ENABLED'`,
  adStrength: `SELECT ad_group_ad.ad_strength FROM ad_group_ad WHERE ad_group_ad.status = 'ENABLED'`,
  conversionActions: `SELECT conversion_action.name, conversion_action.status, conversion_action.primary_for_goal,
            conversion_action.include_in_conversions_metric FROM conversion_action`,
};

// GAQL rows for resources beyond `customer` — the SDK type only names the common
// ones, extra resources arrive as camelCase/snake_case props alongside them.
type Row = GoogleAdsRow & Record<string, any>;

/** Impression-share fraction (0..1) or null when the campaign type doesn't report it. */
const share = (m: any, camel: string, snake: string): number | null => {
  const v = pick(m ?? {}, camel, snake);
  return v == null ? null : Number(v);
};

export class GoogleProvider implements AdProvider {
  readonly id = "google" as const;
  constructor(private client: GoogleAdsClient) {}

  static async create(env: ConnectionsEnv): Promise<GoogleProvider | null> {
    if (!(await isConnected("googleads", env))) return null;
    return new GoogleProvider(connect("googleads", env));
  }

  isConnected() {
    return true;
  }

  // In single-customer (managed) mode the connection targets its configured
  // customer, so customerId is only meaningful when enumerating directly.
  private gaql(customerId: string, query: string): Promise<GoogleAdsRow[]> {
    return this.client.query(query, { customerId });
  }

  async listAccounts(): Promise<AccountRef[]> {
    if (this.client.singleCustomer) {
      // Surface the single managed customer the connection targets.
      const rows = await this.gaql("", QUERIES.customer);
      const row = rows[0];
      const id = String(pick(row?.customer ?? {}, "id") ?? "");
      if (!id) return [];
      return [{ id, name: customerName(row, id), platform: "google", currency: customerCurrency(row) }];
    }
    // Enumerate accessible non-manager customers.
    const ids = await this.client.listCustomerIds();
    const refs = await Promise.all(
      ids.map(async (id) => {
        try {
          const rows = await this.gaql(
            id,
            "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer",
          );
          if (pick(rows[0]?.customer ?? {}, "manager")) return null;
          return { id, name: customerName(rows[0], id), platform: "google" as const, currency: customerCurrency(rows[0]) };
        } catch {
          return null;
        }
      }),
    );
    return refs.filter((r): r is NonNullable<typeof r> => r !== null);
  }

  private async totals(customerId: string, since: string, until: string): Promise<Metrics> {
    const rows = await this.gaql(customerId, QUERIES.totals(since, until));
    return rows[0] ? rowMetrics(rows[0]) : emptyMetrics();
  }

  async accountSummaries(range: DateRange): Promise<AccountSummary[]> {
    const accounts = await this.listAccounts();
    return Promise.all(
      accounts.map(async (acc) => {
        const [cur, prev] = await Promise.all([
          this.totals(acc.id, range.since, range.until),
          this.totals(acc.id, range.prevSince, range.prevUntil),
        ]);
        return { ...acc, metrics: cur, prev };
      }),
    );
  }

  async accountReport(accountId: string, range: DateRange): Promise<AccountReport> {
    const [info, cur, prev, daily] = await Promise.all([
      this.gaql(accountId, QUERIES.customer),
      this.totals(accountId, range.since, range.until),
      this.totals(accountId, range.prevSince, range.prevUntil),
      this.dailySeries(accountId, range.since, range.until),
    ]);

    const account: AccountRef = {
      id: String(pick(info[0]?.customer ?? {}, "id") ?? accountId).replace(/\D/g, ""),
      name: customerName(info[0], accountId),
      platform: "google",
      currency: customerCurrency(info[0]),
    };

    return {
      account,
      range: { since: range.since, until: range.until, days: range.days },
      kpis: buildKpis(cur, prev),
      daily,
      channels: [{ platform: "google", metrics: cur }],
      issues: deriveIssues(cur, prev, daily),
      generatedAt: new Date().toISOString(),
      preview: false,
    };
  }

  async dailySeries(accountId: string, since: string, until: string): Promise<DailyPoint[]> {
    const rows = await this.gaql(accountId, QUERIES.daily(since, until));
    return rows
      .map((row) => {
        const m = rowMetrics(row);
        return {
          date: String(pick(row.segments ?? {}, "date") ?? ""),
          spend: m.spend, revenue: m.revenue, conversions: m.conversions, clicks: m.clicks,
          impressions: m.impressions, roas: m.roas, convRate: m.convRate, ctr: m.ctr,
        };
      })
      .filter((d) => d.date);
  }

  async searchTerms(accountId: string, range: DateRange): Promise<SearchTermRow[]> {
    const rows: Row[] = await this.gaql(accountId, QUERIES.searchTerms(range.since, range.until));
    return rows.map((row) => {
      const m = (row.metrics ?? {}) as any;
      const view = pick(row, "searchTermView", "search_term_view") ?? {};
      return {
        term: String(pick(view, "searchTerm", "search_term") ?? ""),
        campaign: String(row.campaign?.name ?? ""),
        matchType: String(pick(row.segments ?? {}, "searchTermMatchType", "search_term_match_type") ?? ""),
        spend: N(pick(m, "costMicros", "cost_micros")) / 1_000_000,
        clicks: N(m.clicks),
        impressions: N(m.impressions),
        conversions: N(m.conversions),
        revenue: N(pick(m, "conversionsValue", "conversions_value")),
      };
    }).filter((t) => t.term);
  }

  async auditData(accountId: string, range: DateRange): Promise<GoogleAudit> {
    // Attribute-only queries (ad strength, conversion actions) can be rejected on
    // some account setups; degrade that category to "no data" instead of failing
    // the whole audit.
    const soft = <T>(p: Promise<T>, empty: T) => p.catch(() => empty);
    const [searchTerms, keywordRows, campaignRows, strengthRows, actionRows] = await Promise.all([
      soft(this.searchTerms(accountId, range), [] as SearchTermRow[]),
      soft(this.gaql(accountId, QUERIES.keywords(range.since, range.until)), [] as Row[]),
      soft(this.gaql(accountId, QUERIES.campaigns(range.since, range.until)), [] as Row[]),
      soft(this.gaql(accountId, QUERIES.adStrength), [] as Row[]),
      soft(this.gaql(accountId, QUERIES.conversionActions), [] as Row[]),
    ]);

    const keywords: KeywordQSRow[] = (keywordRows as Row[]).map((row) => {
      const crit = pick(row, "adGroupCriterion", "ad_group_criterion") ?? {};
      const qs = pick(pick(crit, "qualityInfo", "quality_info") ?? {}, "qualityScore", "quality_score");
      const m = (row.metrics ?? {}) as any;
      return {
        keyword: String(crit.keyword?.text ?? ""),
        campaign: String(row.campaign?.name ?? ""),
        qualityScore: qs == null ? null : Number(qs),
        spend: N(pick(m, "costMicros", "cost_micros")) / 1_000_000,
        clicks: N(m.clicks),
      };
    }).filter((k) => k.keyword);

    const campaigns: CampaignPerfRow[] = (campaignRows as Row[]).map((row) => {
      const m = (row.metrics ?? {}) as any;
      return {
        id: String(row.campaign?.id ?? ""),
        name: String(row.campaign?.name ?? ""),
        biddingStrategy: String(pick(row.campaign ?? {}, "biddingStrategyType", "bidding_strategy_type") ?? ""),
        spend: N(pick(m, "costMicros", "cost_micros")) / 1_000_000,
        conversions: N(m.conversions),
        searchImpressionShare: share(m, "searchImpressionShare", "search_impression_share"),
        lostBudgetShare: share(m, "searchBudgetLostImpressionShare", "search_budget_lost_impression_share"),
        lostRankShare: share(m, "searchRankLostImpressionShare", "search_rank_lost_impression_share"),
      };
    });

    const adStrength: AdStrengthCounts = { excellent: 0, good: 0, average: 0, poor: 0, pending: 0 };
    for (const row of strengthRows as Row[]) {
      const s = String(pick(pick(row, "adGroupAd", "ad_group_ad") ?? {}, "adStrength", "ad_strength") ?? "").toUpperCase();
      if (s === "EXCELLENT") adStrength.excellent++;
      else if (s === "GOOD") adStrength.good++;
      else if (s === "AVERAGE") adStrength.average++;
      else if (s === "POOR") adStrength.poor++;
      else if (s === "PENDING") adStrength.pending++;
    }

    const conversionActions: ConversionActionRow[] = (actionRows as Row[]).map((row) => {
      const a = pick(row, "conversionAction", "conversion_action") ?? {};
      return {
        name: String(a.name ?? ""),
        status: String(a.status ?? ""),
        primary: Boolean(pick(a, "primaryForGoal", "primary_for_goal")),
        countsInConversions: Boolean(pick(a, "includeInConversionsMetric", "include_in_conversions_metric")),
      };
    }).filter((a) => a.name);

    return { platform: "google", searchTerms, keywords, campaigns, adStrength, conversionActions };
  }
}
