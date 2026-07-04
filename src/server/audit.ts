// The audit scoring engine. Turns raw provider recipe data (GoogleAudit /
// MetaAudit) into a scored account audit: per-category 0-100 scores with
// Good→Critical ratings, a weighted overall score, and priority fixes ranked by
// the dollars at stake. All math is deterministic and lives here — the AI layer
// only writes prose around numbers this file computed.

import type { AccountReport, AdFatigueRow, AuditData, GoogleAudit, MetaAudit, SearchTermRow } from "./providers/types";

export type Rating = "Good" | "Fair" | "Needs work" | "Poor" | "Critical";

export interface AuditCategory {
  id: string;
  name: string;
  /** 0..100; null when the platform/account produced no data for this category. */
  score: number | null;
  rating: Rating | null;
  /** Relative weight in the overall score (categories with null score are excluded). */
  weight: number;
  /** One line: the numbers behind the rating. */
  detail: string;
  /** Dollars at stake over the analyzed range, when computable. */
  atStake: number | null;
  /** The specific fix to advise, when the category is short of Good. */
  fix: string | null;
}

export interface PriorityFix {
  text: string;
  tag: "HIGH" | "MED";
  atStake: number | null;
}

export interface ScoredAudit {
  /** Weighted overall score, 0..100. */
  score: number;
  rating: Rating;
  categories: AuditCategory[];
  /** Worst-rated category id — "start here". */
  worst: string | null;
  fixes: PriorityFix[];
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export function ratingOf(score: number): Rating {
  if (score >= 85) return "Good";
  if (score >= 70) return "Fair";
  if (score >= 50) return "Needs work";
  if (score >= 30) return "Poor";
  return "Critical";
}

const money = (n: number, cur: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(n);

// ── Fatigue flags (shared with the Creative Fatigue recipe) ──────────────────

export interface FatigueFlag {
  ad: AdFatigueRow;
  /** CTR change vs prior window, percent (negative = declining). */
  ctrChangePct: number | null;
  cpmChangePct: number | null;
  cpaChangePct: number | null;
  fatigued: boolean;
  reasons: string[];
}

const FREQUENCY_CAP = 2.5;
const CTR_DROP_PCT = 15;

export function flagFatigue(ads: AdFatigueRow[]): FatigueFlag[] {
  return ads.map((ad) => {
    const change = (cur: number, prev: number | undefined | null) =>
      prev && prev > 0 ? ((cur - prev) / prev) * 100 : null;
    const ctrChange = change(ad.current.ctr, ad.prev?.ctr);
    const cpmChange = change(ad.current.cpm, ad.prev?.cpm);
    const cpaChange = ad.current.conversions > 0 || (ad.prev?.conversions ?? 0) > 0
      ? change(ad.current.cpa, ad.prev?.cpa)
      : null;
    const reasons: string[] = [];
    if ((ad.current.frequency ?? 0) > FREQUENCY_CAP) reasons.push(`frequency ${ad.current.frequency!.toFixed(1)}`);
    if (ctrChange !== null && ctrChange < -CTR_DROP_PCT) reasons.push(`CTR down ${Math.abs(ctrChange).toFixed(0)}%`);
    // Both signals must fire: high frequency alone can be a healthy retargeting ad.
    const fatigued = reasons.length >= 2;
    return { ad, ctrChangePct: ctrChange, cpmChangePct: cpmChange, cpaChangePct: cpaChange, fatigued, reasons };
  });
}

/** Winners safe to scale: meaningful spend, healthy frequency, stable-or-rising CTR. */
export function scaleCandidates(flags: FatigueFlag[]): FatigueFlag[] {
  const spendTotal = flags.reduce((a, f) => a + f.ad.current.spend, 0);
  return flags
    .filter(
      (f) =>
        !f.fatigued &&
        f.ad.current.spend >= Math.max(50, spendTotal * 0.05) &&
        (f.ad.current.frequency ?? 0) <= 2 &&
        (f.ctrChangePct === null || f.ctrChangePct >= -5) &&
        f.ad.current.conversions > 0,
    )
    .sort((a, b) => b.ad.current.conversions / Math.max(1, b.ad.current.spend) - a.ad.current.conversions / Math.max(1, a.ad.current.spend))
    .slice(0, 5);
}

// ── Search-term waste (shared with the Search Terms recipe) ──────────────────

export interface WasteSummary {
  /** Spend on analyzed terms with zero conversions. */
  wasted: number;
  /** Total spend across analyzed terms. */
  analyzed: number;
  terms: SearchTermRow[];
  /** Zero-conversion terms ranked by spend — the negative-keyword candidates. */
  wastedTerms: SearchTermRow[];
}

export function summarizeWaste(terms: SearchTermRow[]): WasteSummary {
  const wastedTerms = terms.filter((t) => t.conversions === 0 && t.spend > 0).sort((a, b) => b.spend - a.spend);
  return {
    wasted: wastedTerms.reduce((a, t) => a + t.spend, 0),
    analyzed: terms.reduce((a, t) => a + t.spend, 0),
    terms,
    wastedTerms,
  };
}

// ── Google categories ────────────────────────────────────────────────────────

function googleCategories(report: AccountReport, audit: GoogleAudit): AuditCategory[] {
  const cur = report.account.currency;
  const spend = report.kpis.cost.value;
  const clicks = report.kpis.clicks.value;
  const conversions = report.kpis.conversions.value;

  // Conversion tracking — is anything measuring results at all?
  const active = audit.conversionActions.filter((a) => a.status === "ENABLED");
  const primary = active.filter((a) => a.primary || a.countsInConversions);
  let trackingScore: number | null;
  let trackingDetail: string;
  let trackingFix: string | null = null;
  if (audit.conversionActions.length === 0) {
    trackingScore = null;
    trackingDetail = "Conversion action data unavailable for this account.";
  } else if (primary.length === 0) {
    trackingScore = 5;
    trackingDetail = "No enabled conversion action counts toward the conversions column — bidding is flying blind.";
    trackingFix = "Create (or re-enable) a primary conversion action and verify it fires with a test conversion.";
  } else if (clicks > 200 && conversions === 0) {
    trackingScore = 15;
    trackingDetail = `${Math.round(clicks)} clicks recorded zero conversions — the tag is likely broken.`;
    trackingFix = "Fire a test conversion and check the tag on the checkout/thank-you page.";
  } else {
    trackingScore = clamp(70 + primary.length * 10);
    trackingDetail = `${primary.length} primary conversion action${primary.length === 1 ? "" : "s"} active, ${Math.round(conversions)} conversions recorded.`;
  }

  // Wasted spend — zero-conversion search terms.
  const waste = summarizeWaste(audit.searchTerms);
  const wasteRatio = waste.analyzed > 0 ? waste.wasted / waste.analyzed : 0;
  const wasteScore = audit.searchTerms.length === 0 ? null : clamp(100 - wasteRatio * 200); // 50% waste → 0
  const wasteFix = waste.wastedTerms.length
    ? `Add the top ${Math.min(20, waste.wastedTerms.length)} zero-conversion search terms as exact negatives.`
    : null;

  // Ad creative quality — ad strength distribution.
  const s = audit.adStrength;
  const rated = s.excellent + s.good + s.average + s.poor;
  const creativeScore = rated === 0 ? null : clamp((s.excellent * 100 + s.good * 75 + s.average * 45 + s.poor * 15) / rated);
  const creativeFix = s.poor + s.average > 0
    ? `Rewrite the ${s.poor + s.average} ad${s.poor + s.average === 1 ? "" : "s"} rated Average or Poor — add more unique headlines and pin fewer assets.`
    : null;

  // Impression coverage — spend-weighted search IS + budget losses.
  const withIS = audit.campaigns.filter((c) => c.searchImpressionShare !== null && c.spend > 0);
  const isSpend = withIS.reduce((a, c) => a + c.spend, 0);
  const wAvg = (f: (c: (typeof withIS)[number]) => number) =>
    isSpend > 0 ? withIS.reduce((a, c) => a + f(c) * c.spend, 0) / isSpend : 0;
  const avgIS = wAvg((c) => c.searchImpressionShare!);
  const avgLostBudget = wAvg((c) => c.lostBudgetShare ?? 0);
  const coverageScore = withIS.length === 0 ? null : clamp(avgIS * 100 - avgLostBudget * 50);
  // Dollars at stake: extra spend the current results support if budget wasn't capping delivery.
  const coverageAtStake = avgLostBudget > 0.05 && avgIS > 0 ? isSpend * (avgLostBudget / Math.max(0.2, avgIS)) : null;
  const coverageFix = avgLostBudget > 0.1
    ? `Raise budgets on the campaigns losing ${(avgLostBudget * 100).toFixed(0)}% of impressions to budget caps.`
    : null;

  // Quality Score — spend-weighted across scored keywords.
  const scored = audit.keywords.filter((k) => k.qualityScore !== null && k.spend > 0);
  const qsSpend = scored.reduce((a, k) => a + k.spend, 0);
  const avgQS = qsSpend > 0 ? scored.reduce((a, k) => a + k.qualityScore! * k.spend, 0) / qsSpend : 0;
  const lowQSSpend = scored.filter((k) => k.qualityScore! <= 4).reduce((a, k) => a + k.spend, 0);
  const qsScore = scored.length === 0 ? null : clamp(avgQS * 10);
  const qsFix = lowQSSpend > 0
    ? `Rework ads + landing pages for the QS ≤ 4 keywords carrying ${money(lowQSSpend, cur)} of spend (or pause them).`
    : null;

  // Bidding strategy — budget-capped delivery and manual bidding with enough signal.
  const manual = audit.campaigns.filter((c) => c.biddingStrategy === "MANUAL_CPC");
  const manualReady = manual.filter((c) => c.conversions >= 15);
  let biddingScore: number | null = audit.campaigns.length === 0 ? null : 90;
  let biddingDetail = "Bidding strategies look reasonable for the volume.";
  let biddingFix: string | null = null;
  if (biddingScore !== null) {
    if (manualReady.length > 0) {
      biddingScore -= 30;
      biddingDetail = `${manualReady.length} campaign${manualReady.length === 1 ? "" : "s"} on Manual CPC despite enough conversions for smart bidding.`;
      biddingFix = "Move the converting Manual CPC campaigns to Target CPA / Maximize conversions.";
    }
    if (avgLostBudget > 0.15) {
      biddingScore -= 20;
      biddingDetail += ` Budget caps are costing ${(avgLostBudget * 100).toFixed(0)}% of eligible impressions.`;
    }
    biddingScore = clamp(biddingScore);
  }

  return [
    { id: "tracking", name: "Conversion tracking", weight: 25, score: trackingScore, rating: trackingScore === null ? null : ratingOf(trackingScore), detail: trackingDetail, atStake: trackingScore !== null && trackingScore < 50 ? spend : null, fix: trackingFix },
    { id: "waste", name: "Wasted spend", weight: 20, score: wasteScore, rating: wasteScore === null ? null : ratingOf(wasteScore), detail: audit.searchTerms.length ? `${money(waste.wasted, cur)} of the ${money(waste.analyzed, cur)} on the top ${audit.searchTerms.length} search terms converted nothing.` : "No search-term data in range.", atStake: waste.wasted > 0 ? waste.wasted : null, fix: wasteFix },
    { id: "coverage", name: "Impression coverage", weight: 15, score: coverageScore, rating: coverageScore === null ? null : ratingOf(coverageScore), detail: withIS.length ? `Search impression share ${(avgIS * 100).toFixed(0)}%, ${(avgLostBudget * 100).toFixed(0)}% lost to budget.` : "No impression-share data (non-search campaigns).", atStake: coverageAtStake, fix: coverageFix },
    { id: "creative", name: "Ad creative quality", weight: 15, score: creativeScore, rating: creativeScore === null ? null : ratingOf(creativeScore), detail: rated ? `${s.excellent} excellent / ${s.good} good / ${s.average} average / ${s.poor} poor ad strength.` : "No ad-strength data.", atStake: null, fix: creativeFix },
    { id: "qs", name: "Quality Score", weight: 15, score: qsScore, rating: qsScore === null ? null : ratingOf(qsScore), detail: scored.length ? `Spend-weighted QS ${avgQS.toFixed(1)}; ${money(lowQSSpend, cur)} riding on QS ≤ 4 keywords.` : "No scored keywords in range.", atStake: lowQSSpend > 0 ? lowQSSpend : null, fix: qsFix },
    { id: "bidding", name: "Bidding strategy", weight: 10, score: biddingScore, rating: biddingScore === null ? null : ratingOf(biddingScore), detail: biddingDetail, atStake: null, fix: biddingFix },
  ];
}

// ── Meta categories ──────────────────────────────────────────────────────────

function metaCategories(report: AccountReport, audit: MetaAudit): AuditCategory[] {
  const cur = report.account.currency;
  const spend = report.kpis.cost.value;
  const roas = report.kpis.roas.value;

  // Tracking — purchases and purchase values arriving at all.
  let trackingScore = 100;
  let trackingDetail = "Purchase events and values are tracking.";
  let trackingFix: string | null = null;
  if (!audit.hasPurchaseTracking) {
    trackingScore = 15;
    trackingDetail = "No purchase events recorded — the pixel/CAPI is not reporting results.";
    trackingFix = "Verify the pixel + Conversions API events in Events Manager with a test purchase.";
  } else if (!audit.hasValueTracking) {
    trackingScore = 60;
    trackingDetail = "Purchases track but carry no value — ROAS can't be measured.";
    trackingFix = "Send the value parameter with purchase events so value-based bidding works.";
  }

  // Efficiency — ROAS level + CPA direction.
  const cpaDelta = report.kpis.cost.deltaPct !== null && report.kpis.conversions.deltaPct !== null
    ? report.kpis.cost.deltaPct - report.kpis.conversions.deltaPct
    : null;
  let efficiencyScore = clamp(roas * 33); // 3x ROAS → ~100
  if (cpaDelta !== null && cpaDelta > 15) efficiencyScore = clamp(efficiencyScore - 15);
  const efficiencyFix = roas < 2
    ? "Consolidate budget into the best ROAS ad sets and cut the bottom 20%."
    : cpaDelta !== null && cpaDelta > 15
      ? "CPA is drifting up — refresh creative before scaling further."
      : null;

  // Creative fatigue — share of spend inside fatigued ads.
  const flags = flagFatigue(audit.ads);
  const fatigued = flags.filter((f) => f.fatigued);
  const fatiguedSpend = fatigued.reduce((a, f) => a + f.ad.current.spend, 0);
  const flagSpend = flags.reduce((a, f) => a + f.ad.current.spend, 0);
  const fatigueRatio = flagSpend > 0 ? fatiguedSpend / flagSpend : 0;
  const fatigueScore = audit.ads.length === 0 ? null : clamp(100 - fatigueRatio * 180);
  const fatigueFix = fatigued.length
    ? `Pause or refresh the ${fatigued.length} fatigued ad${fatigued.length === 1 ? "" : "s"} carrying ${money(fatiguedSpend, cur)} of recent spend.`
    : null;

  // Delivery trend — clicks + impressions direction.
  const impDelta = report.kpis.clicks.deltaPct;
  const ctrDelta = report.kpis.ctr.deltaPct;
  let deliveryScore = 85;
  let deliveryDetail = "Delivery is stable vs the prior period.";
  if (ctrDelta !== null && ctrDelta < -15) {
    deliveryScore = 50;
    deliveryDetail = `CTR fell ${Math.abs(ctrDelta).toFixed(0)}% vs the prior period — audiences are tuning out.`;
  } else if (impDelta !== null && impDelta < -25) {
    deliveryScore = 60;
    deliveryDetail = `Clicks fell ${Math.abs(impDelta).toFixed(0)}% vs the prior period.`;
  }

  return [
    { id: "tracking", name: "Conversion tracking", weight: 30, score: trackingScore, rating: ratingOf(trackingScore), detail: trackingDetail, atStake: trackingScore < 50 ? spend : null, fix: trackingFix },
    { id: "efficiency", name: "Spend efficiency", weight: 30, score: efficiencyScore, rating: ratingOf(efficiencyScore), detail: `${roas.toFixed(1)}x ROAS on ${money(spend, cur)}${cpaDelta !== null && cpaDelta > 15 ? ", CPA drifting up" : ""}.`, atStake: roas < 1 ? spend * (1 - roas) : null, fix: efficiencyFix },
    { id: "fatigue", name: "Creative fatigue", weight: 25, score: fatigueScore, rating: fatigueScore === null ? null : ratingOf(fatigueScore), detail: audit.ads.length ? `${fatigued.length} of ${flags.length} analyzed ads fatigued (${(fatigueRatio * 100).toFixed(0)}% of their spend).` : "No ad-level data in range.", atStake: fatiguedSpend > 0 ? fatiguedSpend : null, fix: fatigueFix },
    { id: "delivery", name: "Delivery trend", weight: 15, score: deliveryScore, rating: ratingOf(deliveryScore), detail: deliveryDetail, atStake: null, fix: null },
  ];
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export function scoreAudit(report: AccountReport, audit: AuditData): ScoredAudit {
  const categories = audit.platform === "google" ? googleCategories(report, audit) : metaCategories(report, audit);
  const scored = categories.filter((c) => c.score !== null);
  const weightSum = scored.reduce((a, c) => a + c.weight, 0);
  const score = weightSum > 0 ? Math.round(scored.reduce((a, c) => a + c.score! * c.weight, 0) / weightSum) : 0;

  const worst = scored.length
    ? scored.reduce((min, c) => (c.score! < min.score! ? c : min), scored[0]).id
    : null;

  const spend = report.kpis.cost.value;
  const fixes: PriorityFix[] = categories
    .filter((c) => c.fix !== null)
    .sort((a, b) => (b.atStake ?? 0) - (a.atStake ?? 0))
    .map((c) => ({
      text: c.fix!,
      tag: (c.atStake ?? 0) >= spend * 0.1 || (c.score !== null && c.score < 30) ? "HIGH" : "MED",
      atStake: c.atStake,
    }));

  return { score, rating: ratingOf(score), categories, worst, fixes };
}
