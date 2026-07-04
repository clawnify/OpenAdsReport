// Sample/preview data. Served when no ad platform is connected so the dashboard
// looks alive inside the Clawnify iframe before credentials are wired. Numbers
// mirror the design mocks; everything routes through the same metric helpers so
// the shapes are identical to live data.

import type {
  AccountRef, AccountReport, AccountSummary, AdFatigueRow, DailyPoint, DateRange, GoogleAudit,
  Issue, MetaAudit, Platform, SearchTermRow,
} from "./providers/types";
import type { RecipeData } from "./report";
import { buildKpis, metrics, sumMetrics } from "./metrics";

interface Seed {
  id: string;
  name: string;
  platform: Platform;
  spend: number;
  roas: number;
  conversions: number;
  ctr: number; // percent
  clicks: number;
}

// Sorted worst-to-best ROAS, as the portfolio table renders.
const SEEDS: Seed[] = [
  { id: "act_910100001", name: "Cinder Gaming", platform: "meta", spend: 4150.8, roas: 0.6, conversions: 14, ctr: 0.9, clicks: 1450 },
  { id: "100200300", name: "Drift Apparel", platform: "google", spend: 2980.5, roas: 0.9, conversions: 15, ctr: 1.1, clicks: 1300 },
  { id: "100200301", name: "Acme E-commerce", platform: "google", spend: 4220.1, roas: 1.2, conversions: 27, ctr: 2.1, clicks: 1280 },
  { id: "act_910100002", name: "Pulse Retail", platform: "meta", spend: 6720.8, roas: 1.4, conversions: 68, ctr: 1.9, clicks: 6200 },
  { id: "100200302", name: "Orbit Travel", platform: "google", spend: 3410.3, roas: 1.6, conversions: 30, ctr: 1.7, clicks: 1700 },
  { id: "act_910100003", name: "Zenith Tech", platform: "meta", spend: 5210.6, roas: 1.8, conversions: 60, ctr: 2.2, clicks: 2700 },
  { id: "100200303", name: "Nova SaaS", platform: "google", spend: 8910.2, roas: 2.1, conversions: 63, ctr: 1.4, clicks: 4400 },
  { id: "100200304", name: "Flux Media", platform: "google", spend: 2810.9, roas: 3.2, conversions: 48, ctr: 2.4, clicks: 2400 },
  { id: "482910384", name: "Vertex Finance", platform: "google", spend: 12420.6, roas: 3.8, conversions: 295, ctr: 2.8, clicks: 6390 },
  { id: "act_910100004", name: "Peak Healthcare", platform: "meta", spend: 3120.4, roas: 4.2, conversions: 89, ctr: 1.8, clicks: 2166 },
];

function seedMetrics(s: Seed) {
  const impressions = Math.round(s.clicks / (s.ctr / 100));
  return metrics({
    spend: s.spend,
    revenue: s.spend * s.roas,
    conversions: s.conversions,
    clicks: s.clicks,
    impressions,
  });
}

function summary(s: Seed): AccountSummary {
  const cur = seedMetrics(s);
  // Prior period: nudge down ~6% so deltas read as gentle growth.
  const prev = metrics({
    spend: cur.spend * 0.94,
    revenue: cur.revenue * 0.9,
    conversions: cur.conversions * 0.95,
    clicks: cur.clicks * 0.96,
    impressions: cur.impressions * 0.95,
  });
  return { id: s.id, name: s.name, platform: s.platform, currency: "USD", metrics: cur, prev };
}

export const sampleAccountRefs = (): AccountRef[] =>
  SEEDS.map((s) => ({ id: s.id, name: s.name, platform: s.platform, currency: "USD" }));

const SAMPLE_ISSUES: Record<string, Issue[]> = {
  "Acme E-commerce": [
    {
      id: "conv-tracking",
      title: "Conversion tracking broken",
      detail: "No conversions recorded in 72 hours despite 1,240 clicks. The GTM tag is misfiring on the checkout success page.",
      action: "Verify the conversion tag in GTM and fire a manual test purchase to confirm it records in Google Ads.",
      severity: "high",
    },
    {
      id: "feed-disapprovals",
      title: "Shopping feed disapprovals climbing",
      detail: "142 products disapproved over the last 7 days — missing GTIN and incorrect availability flags.",
      action: "Re-sync the Merchant Center feed and add GTINs from the product database for the disapproved SKUs.",
      severity: "high",
    },
  ],
  "Cinder Gaming": [
    {
      id: "roas-collapse",
      title: "Campaigns are deep underwater",
      detail: "ROAS of 0.6x means $4.2K of spend returned about $2.5K — the account is losing money every day it runs.",
      action: "Pause the bottom three ad sets immediately and consolidate budget into the single best-performing audience.",
      severity: "high",
    },
  ],
  "Drift Apparel": [
    {
      id: "broad-waste",
      title: "Broad match is draining budget",
      detail: "Broad-match keywords are capturing irrelevant queries with a 1.1% CTR and almost no conversions.",
      action: "Add 20+ exact negatives and switch the worst broad terms to phrase match.",
      severity: "medium",
    },
  ],
  "Vertex Finance": [
    {
      id: "qs-drop",
      title: "Quality Scores dropping",
      detail: "Average Quality Score is down from 7.2 to 5.1 over the last 30 days, hurting ad rank and inflating CPCs.",
      action: "Group keywords by intent and rewrite ad copy + landing-page headlines to match top-funnel queries.",
      severity: "medium",
    },
  ],
};

function dailySeries(range: DateRange, totals: { spend: number; revenue: number; conversions: number; clicks: number; impressions: number }): DailyPoint[] {
  const days = range.days;
  // Deterministic weekday-ish weights so the chart has texture but is stable.
  const weights = Array.from({ length: days }, (_, i) => 0.7 + 0.6 * Math.abs(Math.sin(i * 1.3)) + (i % 7 === 5 || i % 7 === 6 ? -0.15 : 0));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const start = new Date(range.since + "T00:00:00Z");
  return weights.map((w, i) => {
    const f = w / wsum;
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const m = metrics({
      spend: totals.spend * f,
      revenue: totals.revenue * f,
      conversions: totals.conversions * f,
      clicks: totals.clicks * f,
      impressions: totals.impressions * f,
    });
    return {
      date: d.toISOString().split("T")[0],
      spend: m.spend,
      revenue: m.revenue,
      conversions: m.conversions,
      clicks: m.clicks,
      impressions: m.impressions,
      roas: m.roas,
      convRate: m.convRate,
      ctr: m.ctr,
    };
  });
}

export function samplePortfolio(range: DateRange): import("./providers/types").PortfolioReport {
  const accounts = SEEDS.map(summary);
  const totals = sumMetrics(accounts.map((a) => a.metrics));
  const topIssues = accounts
    .slice(0, 3)
    .map((account) => ({ account, issues: SAMPLE_ISSUES[account.name] ?? [] }))
    .filter((t) => t.issues.length > 0);
  return {
    range: { since: range.since, until: range.until, days: range.days },
    totals,
    accounts,
    topIssues,
    generatedAt: new Date().toISOString(),
    preview: true,
  };
}

/**
 * Preview report for the reports view: honor the requested account when its
 * platform fits the recipe, otherwise fall back to a platform-matching sample so
 * platform-specific recipes (Search Terms, Creative Fatigue) always render.
 */
export function samplePreviewReport(range: DateRange, accountId: string | undefined, platforms: Platform[]): AccountReport {
  const requested = SEEDS.find((s) => s.id === accountId);
  const seed =
    requested && platforms.includes(requested.platform)
      ? requested
      : SEEDS.filter((s) => platforms.includes(s.platform)).sort((a, b) => b.spend - a.spend)[0];
  return sampleAccountReport(range, seed?.id);
}

// ── Sample recipe data (Phase 2) ─────────────────────────────────────────────

const SAMPLE_SEARCH_TERMS: Array<[string, string, string, number, number, number, number]> = [
  // term, campaign, match, spend, clicks, conversions, revenue
  ["running shoes", "Search - Core", "phrase", 1840.2, 920, 61, 7960],
  ["best running shoes for flat feet", "Search - Core", "broad", 1211.4, 540, 34, 4470],
  ["free running shoes", "Search - Core", "broad", 684.1, 410, 0, 0],
  ["running shoes sale", "Search - Promo", "phrase", 610.9, 350, 22, 2350],
  ["how to clean running shoes", "Search - Core", "broad", 402.7, 260, 0, 0],
  ["trail running shoes", "Search - Core", "exact", 391.5, 190, 14, 1810],
  ["running shoes repair near me", "Search - Core", "broad", 288.3, 170, 0, 0],
  ["marathon training plan", "Search - Blog", "broad", 246.8, 200, 0, 0],
  ["running shoes for kids", "Search - Core", "phrase", 201.2, 120, 6, 540],
  ["nursing shoes", "Search - Core", "broad", 174.6, 110, 0, 0],
  ["cheap sneakers bulk", "Search - Promo", "broad", 131.9, 90, 0, 0],
  ["waterproof running shoes", "Search - Core", "exact", 122.4, 60, 5, 620],
];

const sampleGoogleAudit = (): GoogleAudit => ({
  platform: "google",
  searchTerms: SAMPLE_SEARCH_TERMS.map(([term, campaign, matchType, spend, clicks, conversions, revenue]) => ({
    term, campaign, matchType, spend, clicks, conversions, revenue,
    impressions: clicks * 40,
  })),
  keywords: [
    { keyword: "running shoes", campaign: "Search - Core", qualityScore: 8, spend: 2100, clicks: 1040 },
    { keyword: "trail running shoes", campaign: "Search - Core", qualityScore: 7, spend: 640, clicks: 300 },
    { keyword: "buy sneakers online", campaign: "Search - Promo", qualityScore: 4, spend: 590, clicks: 310 },
    { keyword: "shoes", campaign: "Search - Promo", qualityScore: 3, spend: 470, clicks: 260 },
    { keyword: "waterproof running shoes", campaign: "Search - Core", qualityScore: 9, spend: 260, clicks: 120 },
    { keyword: "running gear", campaign: "Search - Blog", qualityScore: 5, spend: 210, clicks: 140 },
  ],
  campaigns: [
    { id: "1", name: "Search - Core", biddingStrategy: "TARGET_ROAS", spend: 6200, conversions: 210, searchImpressionShare: 0.62, lostBudgetShare: 0.21, lostRankShare: 0.17 },
    { id: "2", name: "Search - Promo", biddingStrategy: "MANUAL_CPC", spend: 3100, conversions: 48, searchImpressionShare: 0.41, lostBudgetShare: 0.08, lostRankShare: 0.51 },
    { id: "3", name: "Search - Blog", biddingStrategy: "MAXIMIZE_CLICKS", spend: 890, conversions: 2, searchImpressionShare: 0.55, lostBudgetShare: 0.02, lostRankShare: 0.43 },
  ],
  adStrength: { excellent: 4, good: 11, average: 9, poor: 3, pending: 1 },
  conversionActions: [
    { name: "Purchase", status: "ENABLED", primary: true, countsInConversions: true },
    { name: "Add to cart", status: "ENABLED", primary: false, countsInConversions: false },
    { name: "Newsletter signup", status: "REMOVED", primary: false, countsInConversions: false },
  ],
});

const SAMPLE_ADS: Array<[string, string, string, number, number, number, number, number, number, number, number]> = [
  // name, adset, campaign, curSpend, curFreq, curCtr, curConv, prevSpend, prevFreq, prevCtr, prevConv
  ["UGC - Sarah unboxing", "Prospecting - Broad", "Evergreen", 2140, 1.6, 2.31, 42, 1980, 1.5, 2.24, 40],
  ["Founder story v2", "Prospecting - Lookalike", "Evergreen", 1730, 2.9, 1.12, 14, 1590, 2.2, 1.58, 21],
  ["Spring drop carousel", "Retargeting - 30d", "Promo", 1410, 3.4, 0.96, 18, 1360, 2.7, 1.31, 24],
  ["Review mashup 15s", "Prospecting - Broad", "Evergreen", 980, 1.9, 1.87, 19, 870, 1.8, 1.79, 16],
  ["Static - price anchor", "Retargeting - 7d", "Promo", 640, 2.2, 1.41, 11, 700, 2.1, 1.44, 12],
  ["Podcast clip B", "Prospecting - Interests", "Evergreen", 410, 1.3, 1.66, 6, 280, 1.2, 1.52, 4],
];

const sampleAdFatigue = (): AdFatigueRow[] =>
  SAMPLE_ADS.map(([adName, adsetName, campaignName, s, f, c, conv, ps, pf, pc, pconv], i) => {
    const win = (spend: number, freq: number, ctrPct: number, conversions: number) => {
      const clicks = Math.round(spend / 1.4);
      const impressions = Math.round(clicks / (ctrPct / 100));
      return {
        spend, impressions, clicks, conversions,
        frequency: freq,
        ctr: ctrPct,
        cpm: (spend / impressions) * 1000,
        cpa: conversions > 0 ? spend / conversions : 0,
      };
    };
    return {
      adId: `ad_${i + 1}`,
      adName, adsetName, campaignName,
      current: win(s, f, c, conv),
      prev: win(ps, pf, pc, pconv),
    };
  });

const sampleMetaAudit = (): MetaAudit => ({
  platform: "meta",
  ads: sampleAdFatigue(),
  hasPurchaseTracking: true,
  hasValueTracking: true,
});

const SAMPLE_PAGES: Array<[string, string, number, number, number, number, number, number, number, number, number, number]> = [
  // page, source/medium, curSessions, curBouncePct, curConv, curRevenue, curTx, prevSessions, prevBouncePct, prevConv, prevRevenue, prevTx
  ["/products/trail-x2", "google / cpc", 4180, 38, 176, 21400, 168, 3950, 36, 182, 22100, 174],
  ["/landing/spring-sale", "facebook / paid", 3620, 61, 74, 8100, 71, 3410, 44, 132, 15300, 128],
  ["/products/road-one", "google / cpc", 2890, 41, 98, 11900, 95, 2760, 42, 91, 11000, 88],
  ["/collections/womens", "instagram / paid", 2140, 48, 51, 5400, 49, 2300, 47, 58, 6300, 55],
  ["/landing/free-trial", "google / cpc", 1760, 71, 12, 900, 9, 1690, 52, 38, 3200, 31],
  ["/blog/best-running-shoes", "google / cpc", 980, 66, 4, 380, 4, 1020, 64, 5, 420, 5],
];

const sampleLandingPages = (): import("./providers/ga").LandingPagesResult => ({
  property: "properties/000000000",
  propertyName: "Sample Store — GA4",
  rows: SAMPLE_PAGES.map(([page, sourceMedium, s, b, k, rev, tx, ps, pb, pk, prev, ptx]) => {
    const win = (sessions: number, bouncePct: number, keyEvents: number, revenue: number, transactions: number) => ({
      sessions, keyEvents, revenue, transactions,
      bounceRatePct: bouncePct,
      convRatePct: sessions > 0 ? (keyEvents / sessions) * 100 : 0,
      revenuePerSession: sessions > 0 ? revenue / sessions : 0,
      aov: transactions > 0 ? revenue / transactions : 0,
    });
    return { page, sourceMedium, current: win(s, b, k, rev, tx), prev: win(ps, pb, pk, prev, ptx) };
  }),
});

/** Recipe data for preview mode, matched to the sample report's platform. */
export function sampleRecipeData(recipe: string, report: AccountReport, _range: DateRange): RecipeData {
  if (recipe === "search-terms") return { terms: sampleGoogleAudit().searchTerms };
  if (recipe === "creative-fatigue") return { ads: sampleAdFatigue() };
  if (recipe === "landing-page") return { pages: sampleLandingPages() };
  return { audit: report.account.platform === "google" ? sampleGoogleAudit() : sampleMetaAudit() };
}

export function sampleAccountReport(range: DateRange, accountId?: string): AccountReport {
  const seed = SEEDS.find((s) => s.id === accountId) ?? SEEDS.find((s) => s.name === "Vertex Finance")!;
  const sum = summary(seed);
  const cur = sum.metrics;
  const daily = dailySeries(range, {
    spend: cur.spend,
    revenue: cur.revenue,
    conversions: cur.conversions,
    clicks: cur.clicks,
    impressions: cur.impressions,
  });
  return {
    account: { id: seed.id, name: seed.name, platform: seed.platform, currency: "USD" },
    range: { since: range.since, until: range.until, days: range.days },
    kpis: buildKpis(cur, sum.prev),
    daily,
    channels: [{ platform: seed.platform, metrics: cur }],
    issues: SAMPLE_ISSUES[seed.name] ?? [],
    generatedAt: new Date().toISOString(),
    preview: true,
  };
}
