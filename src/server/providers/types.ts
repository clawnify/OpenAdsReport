// Normalized, platform-agnostic shapes. Every provider (Meta, Google) maps its
// raw API response into these so the dashboard and the JSON API never have to
// care which ad platform the numbers came from.

export type Platform = "meta" | "google";

export interface AccountRef {
  /** Platform account id, as the platform expects it (e.g. "act_123" / "1234567890"). */
  id: string;
  name: string;
  platform: Platform;
  currency: string;
}

/** Core metrics for a period. Derived fields are always recomputed, never trusted from the API. */
export interface Metrics {
  spend: number;
  revenue: number;
  conversions: number;
  clicks: number;
  impressions: number;
  roas: number; // revenue / spend
  cpa: number; // spend / conversions
  ctr: number; // clicks / impressions, percent
  convRate: number; // conversions / clicks, percent
}

/** A single KPI with its prior-period value and percentage change. */
export interface MetricDelta {
  value: number;
  prev: number | null;
  /** Percentage change vs prior period; null when prior is unknown or zero. */
  deltaPct: number | null;
  /** Whether an increase is good for this metric (cost/cpa up is bad). */
  higherIsBetter: boolean;
}

export interface DailyPoint {
  date: string; // YYYY-MM-DD
  spend: number;
  revenue: number;
  conversions: number;
  clicks: number;
  impressions: number;
  roas: number;
  convRate: number; // percent
  ctr: number; // percent
}

export interface Issue {
  id: string;
  title: string;
  /** What's wrong + why it hurts. */
  detail: string;
  /** Exactly what to do about it. */
  action: string;
  severity: "high" | "medium" | "low";
}

/** Portfolio-table row: one account with current (and optionally prior) metrics. */
export interface AccountSummary extends AccountRef {
  metrics: Metrics;
  prev: Metrics | null;
}

export interface DateRange {
  since: string; // YYYY-MM-DD inclusive
  until: string; // YYYY-MM-DD inclusive
  prevSince: string;
  prevUntil: string;
  days: number;
}

/** Account View payload. */
export interface AccountReport {
  account: AccountRef;
  range: { since: string; until: string; days: number };
  kpis: {
    cost: MetricDelta;
    roas: MetricDelta;
    conversions: MetricDelta;
    convRate: MetricDelta;
    clicks: MetricDelta;
    ctr: MetricDelta;
  };
  daily: DailyPoint[];
  /** Per-platform channel breakdown (one row for a single-platform account). */
  channels: { platform: Platform; metrics: Metrics }[];
  issues: Issue[];
  generatedAt: string;
  preview: boolean;
}

/** Portfolio View payload. */
export interface PortfolioReport {
  range: { since: string; until: string; days: number };
  totals: Metrics;
  /** All accounts across connected providers, sorted by ROAS ascending (worst first). */
  accounts: AccountSummary[];
  /** Lowest-ROAS accounts with their issues, for "Top Issues to Fix". */
  topIssues: { account: AccountSummary; issues: Issue[] }[];
  generatedAt: string;
  preview: boolean;
}

// ── Recipe data (Phase 2) ────────────────────────────────────────────────────
// Raw, platform-specific signals the report engine scores. Providers only fetch
// and normalize; every judgment (scores, ratings, dollar impact) lives in
// audit.ts so both platforms are graded by identical math.

/** One search term from Google's search_term_view, ranked by cost. */
export interface SearchTermRow {
  term: string;
  campaign: string;
  matchType: string;
  spend: number;
  clicks: number;
  impressions: number;
  conversions: number;
  revenue: number;
}

/** One keyword with its Quality Score (null when Google hasn't scored it). */
export interface KeywordQSRow {
  keyword: string;
  campaign: string;
  qualityScore: number | null;
  spend: number;
  clicks: number;
}

/** Per-campaign performance + auction coverage + bidding setup. */
export interface CampaignPerfRow {
  id: string;
  name: string;
  biddingStrategy: string;
  spend: number;
  conversions: number;
  /** Fractions 0..1 from the API; null when the campaign type doesn't report them. */
  searchImpressionShare: number | null;
  lostBudgetShare: number | null;
  lostRankShare: number | null;
}

/** Distribution of ad strength across enabled ads. */
export interface AdStrengthCounts {
  excellent: number;
  good: number;
  average: number;
  poor: number;
  pending: number;
}

export interface ConversionActionRow {
  name: string;
  status: string;
  primary: boolean;
  countsInConversions: boolean;
}

export interface GoogleAudit {
  platform: "google";
  searchTerms: SearchTermRow[];
  keywords: KeywordQSRow[];
  campaigns: CampaignPerfRow[];
  adStrength: AdStrengthCounts;
  conversionActions: ConversionActionRow[];
}

/** One ad's window metrics for fatigue analysis (current vs prior half of the range). */
export interface AdWindowMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  frequency: number | null;
  ctr: number; // percent
  cpm: number;
  cpa: number;
}

export interface AdFatigueRow {
  adId: string;
  adName: string;
  adsetName: string;
  campaignName: string;
  current: AdWindowMetrics;
  prev: AdWindowMetrics | null;
}

export interface MetaAudit {
  platform: "meta";
  ads: AdFatigueRow[];
  hasPurchaseTracking: boolean;
  hasValueTracking: boolean;
}

export type AuditData = GoogleAudit | MetaAudit;

export interface AdProvider {
  id: Platform;
  /** Whether the integrations broker / env supplied usable credentials. */
  isConnected(): boolean;
  /** Lightweight account list for the account picker. */
  listAccounts(): Promise<AccountRef[]>;
  /** Per-account current + prior metrics for the portfolio table. */
  accountSummaries(range: DateRange): Promise<AccountSummary[]>;
  /** Full Account View report for one account. */
  accountReport(accountId: string, range: DateRange): Promise<AccountReport>;
  /** Everything the scored Account Audit needs, fetched in one parallel pass. */
  auditData(accountId: string, range: DateRange): Promise<AuditData>;
  /** Google only — search terms ranked by cost for the waste audit. */
  searchTerms?(accountId: string, range: DateRange): Promise<SearchTermRow[]>;
  /** Meta only — per-ad windows for the creative fatigue report. */
  adFatigue?(accountId: string, range: DateRange): Promise<AdFatigueRow[]>;
}
