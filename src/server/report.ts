// Phase 2 — the analyst report engine. A report is a typed document (sections of
// blocks) the app assembles from REAL numbers (KPIs, charts, tables computed
// server-side) plus an AI-authored analysis layer (executive summary, findings,
// recommendations). The app owns the math; the model writes the prose. When no
// OPENROUTER_API_KEY is present it falls back to deterministic heuristics, so the
// report always renders. Analyst, not manager: findings + advice only, no actions.

import type { AccountReport, AdFatigueRow, AuditData, DailyPoint, Issue, Metrics, Platform, SearchTermRow } from "./providers/types";
import { deriveIssues } from "./metrics";
import { flagFatigue, scaleCandidates, scoreAudit, summarizeWaste, type Rating, type ScoredAudit } from "./audit";

// ── Document schema (mirrored client-side in report.tsx) ─────────────────────

export type Severity = "high" | "medium" | "low";
export type Tone = "good" | "warn" | "bad" | "info";

export interface Cell {
  text: string;
  align?: "left" | "right";
  tone?: Tone;
  /** 0..1 — draws a small inline bar behind the value (perf cells). */
  bar?: number;
}

export type Block =
  | { kind: "prose"; text: string }
  | { kind: "kpis"; items: { label: string; value: string; deltaPct?: number | null; higherIsBetter?: boolean }[] }
  | { kind: "chart"; chart: "spend-roas" | "conv-rate" | "clicks-ctr"; barLabel: string; lineLabel: string }
  | { kind: "table"; columns: { label: string; align?: "left" | "right" }[]; rows: Cell[][] }
  | { kind: "findings"; items: { title: string; detail: string; severity: Severity; recommendation?: string }[] }
  | { kind: "recommendations"; items: { text: string; priority: "P0" | "P1" | "P2"; impact?: string }[] }
  | { kind: "callout"; tone: Tone; text: string }
  | {
      kind: "scorecard";
      score: number;
      rating: Rating;
      categories: { name: string; rating: Rating | null; tone: Tone; score: number | null; detail: string; atStake?: string; worst?: boolean }[];
    };

export interface Section {
  /** Uppercase zone label (the design-system eyebrow). */
  eyebrow: string;
  /** Optional right-aligned count/meta shown next to the eyebrow. */
  note?: string;
  blocks: Block[];
}

export interface ReportDoc {
  recipe: string;
  title: string;
  subtitle: string;
  account: { name: string; platform: Platform; currency: string };
  range: { since: string; until: string; days: number };
  health: { label: "Healthy" | "Watch" | "At risk"; tone: Tone; line: string };
  sections: Section[];
  /** Backs the chart blocks (kept once, not per-block). */
  daily: DailyPoint[];
  ai: boolean;
  preview: boolean;
  generatedAt: string;
}

// ── Recipe registry (the "AI analyst" gallery) ───────────────────────────────

export interface RecipeMeta {
  id: string;
  name: string;
  blurb: string;
  /** false → shown in the gallery as "coming soon", not yet generatable. */
  available: boolean;
  /** Platforms the recipe can run against (both when omitted-equivalent full list). */
  platforms: Platform[];
}

export const RECIPES: RecipeMeta[] = [
  { id: "account-audit", name: "Account Audit", blurb: "Scored health check — /100 across tracking, waste, coverage and creative, with dollar-ranked fixes.", available: true, platforms: ["meta", "google"] },
  { id: "search-terms", name: "Search Terms", blurb: "Wasted-spend and negative-keyword opportunities.", available: true, platforms: ["google"] },
  { id: "creative-fatigue", name: "Creative Fatigue", blurb: "Declining creatives — what to pause, refresh, and scale.", available: true, platforms: ["meta"] },
  { id: "landing-page", name: "Landing Page Analysis", blurb: "Where conversions leak after the click.", available: false, platforms: ["meta", "google"] },
];

/** Data the routes pre-fetch for a recipe; only the field the recipe needs is set. */
export interface RecipeData {
  audit?: AuditData | null;
  terms?: SearchTermRow[];
  ads?: AdFatigueRow[];
}

// ── Formatters (server-side → report carries display strings) ─────────────────

const money = (n: number, cur: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: n < 100 ? 2 : 0 }).format(n);
const moneyK = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${n.toFixed(0)}`);
const num = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n));
const pct = (n: number) => `${n.toFixed(1)}%`;
const xroas = (n: number) => `${n.toFixed(1)}x`;
const roasTone = (r: number): Tone => (r >= 2.5 ? "good" : r >= 1 ? "warn" : "bad");

// ── AI analysis layer ────────────────────────────────────────────────────────

interface Analysis {
  summary: string;
  findings: { title: string; detail: string; severity: Severity; recommendation?: string }[];
  recommendations: { text: string; priority: "P0" | "P1" | "P2" }[];
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash-lite";

const SYSTEM = (reportName: string) => `You are a senior paid-media analyst writing a ${reportName} report for a client.
You DIAGNOSE and ADVISE — you never execute changes. Ground every claim in the numbers given.
Be decisive and specific; no hedging, no theory, no filler.
Respond ONLY with JSON of this exact shape:
{
  "summary": "2-3 sentences: the account's overall health and the single most important thing to address, with numbers.",
  "findings": [{"title":"short headline","detail":"what's wrong/right and why it matters, with the numbers","severity":"high|medium|low","recommendation":"the specific fix to advise"}],
  "recommendations": [{"text":"one concrete next step the client should take","priority":"P0|P1|P2"}]
}
Give 2-4 findings (most important first) and 2-4 recommendations. If the account is healthy, say so and keep findings light.`;

function snapshot(report: AccountReport): string {
  const k = report.kpis;
  const cur = report.channels[0]?.metrics;
  const d = (m: { value: number; deltaPct: number | null }, unit = "") =>
    `${m.value.toFixed(2)}${unit}${m.deltaPct !== null ? ` (${m.deltaPct >= 0 ? "+" : ""}${m.deltaPct.toFixed(0)}% vs prior)` : ""}`;
  const lines = [
    `Account "${report.account.name}" on ${report.account.platform === "meta" ? "Meta Ads" : "Google Ads"}, last ${report.range.days} days. Currency ${report.account.currency}.`,
    `Spend: ${d(k.cost)}`,
    `ROAS: ${d(k.roas, "x")}`,
    `Conversions: ${d(k.conversions)}`,
    `Conversion rate: ${d(k.convRate, "%")}`,
    `Clicks: ${d(k.clicks)}`,
    `CTR: ${d(k.ctr, "%")}`,
  ];
  if (cur) lines.push(`Revenue: ${cur.revenue.toFixed(0)}, CPA: ${cur.cpa.toFixed(2)}`);
  return lines.join("\n");
}

async function aiAnalysis(apiKey: string, reportName: string, user: string): Promise<Analysis | null> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 1100,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM(reportName) },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    const p = JSON.parse(content);
    const sev = (s: any): Severity => (s === "high" || s === "low" ? s : "medium");
    const prio = (s: any): "P0" | "P1" | "P2" => (s === "P0" || s === "P2" ? s : "P1");
    return {
      summary: String(p.summary ?? ""),
      findings: (Array.isArray(p.findings) ? p.findings : []).slice(0, 4).map((f: any) => ({
        title: String(f.title ?? "Finding"),
        detail: String(f.detail ?? ""),
        severity: sev(f.severity),
        recommendation: f.recommendation ? String(f.recommendation) : undefined,
      })),
      recommendations: (Array.isArray(p.recommendations) ? p.recommendations : []).slice(0, 4).map((r: any) => ({
        text: String(r.text ?? ""),
        priority: prio(r.priority),
      })),
    };
  } catch {
    return null;
  }
}

/** Deterministic analysis when no AI key — derived from the same heuristics as the dashboard. */
function heuristicAnalysis(report: AccountReport, scored?: ScoredAudit | null): Analysis {
  if (scored) {
    const short = scored.categories.filter((c) => c.score !== null && c.rating !== "Good").sort((a, b) => a.score! - b.score!);
    const worst = short[0];
    return {
      summary: `The account scores ${scored.score}/100 (${scored.rating}).${worst ? ` ${worst.name} is the weakest category — ${worst.detail}` : " Every category rates Good; focus on scaling what works."}`,
      findings: short.slice(0, 4).map((c) => ({
        title: `${c.name}: ${c.rating}`,
        detail: c.detail,
        severity: c.score! < 30 ? ("high" as const) : c.score! < 60 ? ("medium" as const) : ("low" as const),
        recommendation: c.fix ?? undefined,
      })),
      recommendations: scored.fixes.slice(0, 4).map((f) => ({
        text: f.text,
        priority: f.tag === "HIGH" ? ("P0" as const) : ("P1" as const),
      })),
    };
  }
  return legacyHeuristic(report);
}

function legacyHeuristic(report: AccountReport): Analysis {
  const cur = report.channels[0]?.metrics ?? ({} as Metrics);
  const prev = report.kpis.cost.prev !== null
    ? ({ spend: report.kpis.cost.prev, roas: report.kpis.roas.prev, conversions: report.kpis.conversions.prev,
         convRate: report.kpis.convRate.prev, clicks: report.kpis.clicks.prev, ctr: report.kpis.ctr.prev } as any)
    : null;
  const issues: Issue[] = deriveIssues(cur, prev, report.daily);
  const roas = report.kpis.roas.value;
  const summary =
    roas >= 2.5
      ? `The account is healthy at ${xroas(roas)} ROAS over ${report.range.days} days. Focus on scaling the top performers without diluting return.`
      : roas >= 1
        ? `The account is profitable but thin at ${xroas(roas)} ROAS. The priority is lifting return before adding spend.`
        : `The account is losing money at ${xroas(roas)} ROAS — every dollar spent returns less than a dollar. Cut waste before anything else.`;
  return {
    summary,
    findings: issues.map((i) => ({ title: i.title, detail: i.detail, severity: i.severity, recommendation: i.action })),
    recommendations: issues.slice(0, 3).map((i, idx) => ({
      text: i.action,
      priority: i.severity === "high" ? "P0" : i.severity === "medium" ? "P1" : "P2",
    })) as Analysis["recommendations"],
  };
}

// ── Report assembly ──────────────────────────────────────────────────────────

function kpiBlock(report: AccountReport, currency: string): Block {
  const k = report.kpis;
  return {
    kind: "kpis",
    items: [
      { label: "Cost", value: money(k.cost.value, currency), deltaPct: k.cost.deltaPct, higherIsBetter: true },
      { label: "ROAS", value: xroas(k.roas.value), deltaPct: k.roas.deltaPct, higherIsBetter: true },
      { label: "Conversions", value: num(k.conversions.value), deltaPct: k.conversions.deltaPct, higherIsBetter: true },
      { label: "Conv. Rate", value: pct(k.convRate.value), deltaPct: k.convRate.deltaPct, higherIsBetter: true },
      { label: "Clicks", value: num(k.clicks.value), deltaPct: k.clicks.deltaPct, higherIsBetter: true },
      { label: "CTR", value: pct(k.ctr.value), deltaPct: k.ctr.deltaPct, higherIsBetter: true },
    ],
  };
}

function channelTable(report: AccountReport, currency: string): Block {
  return {
    kind: "table",
    columns: [
      { label: "Channel", align: "left" },
      { label: "Spend", align: "right" },
      { label: "ROAS", align: "right" },
      { label: "Conv. Rate", align: "right" },
      { label: "Conversions", align: "right" },
    ],
    rows: report.channels.map((c) => [
      { text: c.platform === "meta" ? "Meta" : "Google Ads", align: "left" },
      { text: money(c.metrics.spend, currency), align: "right" },
      { text: xroas(c.metrics.roas), align: "right", tone: roasTone(c.metrics.roas), bar: Math.min(1, c.metrics.roas / 5) },
      { text: pct(c.metrics.convRate), align: "right" },
      { text: num(c.metrics.conversions), align: "right" },
    ]),
  };
}

const HEALTH = (roas: number): ReportDoc["health"] =>
  roas >= 2.5
    ? { label: "Healthy", tone: "good", line: `${xroas(roas)} ROAS — returning strongly on spend.` }
    : roas >= 1
      ? { label: "Watch", tone: "warn", line: `${xroas(roas)} ROAS — profitable but below a 2.5x target.` }
      : { label: "At risk", tone: "bad", line: `${xroas(roas)} ROAS — spending more than it returns.` };

const fmtRange = (since: string, until: string) => {
  const o: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  return `${new Date(since + "T00:00:00").toLocaleDateString("en-US", o)} – ${new Date(until + "T00:00:00").toLocaleDateString("en-US", o)}`;
};

const ratingTone = (r: Rating | null): Tone =>
  r === "Good" ? "good" : r === "Fair" ? "warn" : r === null ? "info" : r === "Needs work" ? "warn" : "bad";

/** Doc shell shared by every recipe builder. */
function doc(recipe: string, title: string, report: AccountReport, health: ReportDoc["health"], sections: Section[], usedAi: boolean): ReportDoc {
  return {
    recipe,
    title,
    subtitle: `${report.account.name} · ${fmtRange(report.range.since, report.range.until)}`,
    account: { name: report.account.name, platform: report.account.platform, currency: report.account.currency },
    range: report.range,
    health,
    sections,
    daily: report.daily,
    ai: usedAi,
    preview: report.preview,
    generatedAt: new Date().toISOString(),
  };
}

const finish = (analysis: Analysis, sections: Section[], fixes?: Block) => {
  if (analysis.findings.length) {
    sections.push({ eyebrow: "Key Findings", note: `${analysis.findings.length}`, blocks: [{ kind: "findings", items: analysis.findings }] });
  }
  const recs: Block | undefined =
    fixes ?? (analysis.recommendations.length ? { kind: "recommendations", items: analysis.recommendations } : undefined);
  if (recs && recs.kind === "recommendations" && recs.items.length) {
    sections.push({ eyebrow: fixes ? "Priority Fixes" : "Recommendations", note: `${recs.items.length}`, blocks: [recs] });
  }
};

// ── Account Audit (scored when audit data is available) ──────────────────────

async function buildAccountAudit(report: AccountReport, apiKey: string | null, audit: AuditData | null): Promise<ReportDoc> {
  const currency = report.account.currency;
  const scored: ScoredAudit | null = audit ? scoreAudit(report, audit) : null;

  let user = snapshot(report);
  if (scored) {
    user += `\n\nAudit categories (deterministic scores, 0-100):\n` + scored.categories
      .map((c) => `- ${c.name}: ${c.score === null ? "no data" : `${Math.round(c.score)} (${c.rating})`} — ${c.detail}`)
      .join("\n") + `\nOverall score: ${scored.score}/100 (${scored.rating}).`;
  }
  const aiResult = apiKey ? await aiAnalysis(apiKey, "Account Audit", user) : null;
  const analysis = aiResult ?? heuristicAnalysis(report, scored);

  // Health from the audit score when we have one, else the ROAS bands.
  const health: ReportDoc["health"] = scored
    ? scored.score >= 70
      ? { label: "Healthy", tone: "good", line: `${scored.score}/100 audit score — ${scored.rating.toLowerCase()} across ${scored.categories.filter((c) => c.score !== null).length} categories.` }
      : scored.score >= 50
        ? { label: "Watch", tone: "warn", line: `${scored.score}/100 audit score — start with the worst category below.` }
        : { label: "At risk", tone: "bad", line: `${scored.score}/100 audit score — structural problems need fixing before scaling.` }
    : HEALTH(report.kpis.roas.value);

  const sections: Section[] = [];
  if (scored) {
    sections.push({
      eyebrow: "Audit Score",
      note: `${scored.categories.filter((c) => c.score !== null).length} categories`,
      blocks: [{
        kind: "scorecard",
        score: scored.score,
        rating: scored.rating,
        categories: scored.categories.map((c) => ({
          name: c.name,
          rating: c.rating,
          tone: ratingTone(c.rating),
          score: c.score === null ? null : Math.round(c.score),
          detail: c.detail,
          atStake: c.atStake !== null ? money(c.atStake, currency) : undefined,
          worst: c.id === scored.worst,
        })),
      }],
    });
  }
  sections.push(
    {
      eyebrow: "Executive Summary",
      blocks: [
        { kind: "callout", tone: health.tone, text: `${health.label} · ${health.line}` },
        { kind: "prose", text: analysis.summary },
      ],
    },
    { eyebrow: "Headline Metrics", note: `${report.range.days} days`, blocks: [kpiBlock(report, currency)] },
    {
      eyebrow: "Performance Trends",
      blocks: [
        { kind: "chart", chart: "spend-roas", barLabel: "Cost", lineLabel: "ROAS" },
        { kind: "chart", chart: "conv-rate", barLabel: "Conversions", lineLabel: "Conv. Rate" },
        { kind: "chart", chart: "clicks-ctr", barLabel: "Clicks", lineLabel: "CTR" },
      ],
    },
    { eyebrow: "Channel Breakdown", blocks: [channelTable(report, currency)] },
  );

  // Priority fixes come from the deterministic audit engine — dollar amounts are
  // never AI-authored. Fall back to AI/heuristic recommendations without one.
  const fixes: Block | undefined = scored?.fixes.length
    ? {
        kind: "recommendations",
        items: scored.fixes.map((f) => ({
          text: f.text,
          priority: f.tag === "HIGH" ? "P0" : "P1",
          impact: f.atStake !== null ? `${money(f.atStake, currency)} at stake` : undefined,
        })),
      }
    : undefined;
  finish(analysis, sections, fixes);
  return doc("account-audit", "Account Audit", report, health, sections, aiResult !== null);
}

// ── Search Terms (Google) ────────────────────────────────────────────────────

async function buildSearchTerms(report: AccountReport, apiKey: string | null, terms: SearchTermRow[]): Promise<ReportDoc> {
  const currency = report.account.currency;
  const waste = summarizeWaste(terms);
  const wastePct = waste.analyzed > 0 ? (waste.wasted / waste.analyzed) * 100 : 0;

  const user = [
    snapshot(report),
    ``,
    `Top search terms by cost (${terms.length} analyzed, ${money(waste.wasted, currency)} of ${money(waste.analyzed, currency)} spent on zero-conversion terms):`,
    ...terms.slice(0, 25).map((t) => `- "${t.term}" [${t.matchType.toLowerCase()}] ${money(t.spend, currency)}, ${Math.round(t.clicks)} clicks, ${t.conversions.toFixed(1)} conv (${t.campaign})`),
  ].join("\n");
  const aiResult = apiKey ? await aiAnalysis(apiKey, "Search Term Waste Audit", user) : null;

  const negatives = waste.wastedTerms.slice(0, 20);
  const analysis: Analysis = aiResult ?? {
    summary:
      wastePct >= 20
        ? `${money(waste.wasted, currency)} — ${wastePct.toFixed(0)}% of the spend on your top ${terms.length} search terms — converted nothing. Negatives are the fastest saving available in this account.`
        : `Search-term hygiene is decent: ${wastePct.toFixed(0)}% of top-term spend (${money(waste.wasted, currency)}) went to zero-conversion queries.`,
    findings: negatives.slice(0, 3).map((t, i) => ({
      title: `"${t.term}" is pure waste`,
      detail: `${money(t.spend, currency)} and ${Math.round(t.clicks)} clicks in ${report.range.days} days with zero conversions (campaign: ${t.campaign}).`,
      severity: i === 0 ? ("high" as const) : ("medium" as const),
      recommendation: "Add as an exact-match negative.",
    })),
    recommendations: negatives.length
      ? [{ text: `Add the ${negatives.length} zero-conversion terms below as exact negatives — ${money(waste.wasted, currency)} of spend at stake.`, priority: "P0" as const }]
      : [{ text: "No zero-conversion spenders in the top terms — re-run on a longer range for the tail.", priority: "P2" as const }],
  };

  const tone: Tone = wastePct >= 30 ? "bad" : wastePct >= 15 ? "warn" : "good";
  const health: ReportDoc["health"] =
    tone === "bad"
      ? { label: "At risk", tone, line: `${wastePct.toFixed(0)}% of top-term spend converts nothing.` }
      : tone === "warn"
        ? { label: "Watch", tone, line: `${wastePct.toFixed(0)}% of top-term spend is wasted — trim the negatives.` }
        : { label: "Healthy", tone, line: `Only ${wastePct.toFixed(0)}% of top-term spend shows no conversions.` };

  const termRow = (t: SearchTermRow): Cell[] => [
    { text: t.term, align: "left" },
    { text: t.campaign, align: "left" },
    { text: t.matchType.toLowerCase().replace(/_/g, " "), align: "left" },
    { text: money(t.spend, currency), align: "right", bar: waste.analyzed > 0 ? Math.min(1, t.spend / (terms[0]?.spend || 1)) : 0 },
    { text: num(t.clicks), align: "right" },
    { text: t.conversions.toFixed(1), align: "right", tone: t.conversions === 0 ? "bad" : t.revenue > t.spend ? "good" : undefined },
  ];
  const termColumns = [
    { label: "Search Term", align: "left" as const },
    { label: "Campaign", align: "left" as const },
    { label: "Match", align: "left" as const },
    { label: "Spend", align: "right" as const },
    { label: "Clicks", align: "right" as const },
    { label: "Conv", align: "right" as const },
  ];

  const sections: Section[] = [
    {
      eyebrow: "Executive Summary",
      blocks: [
        { kind: "callout", tone: health.tone, text: `${health.label} · ${health.line}` },
        { kind: "prose", text: analysis.summary },
      ],
    },
    {
      eyebrow: "Waste Overview",
      note: `top ${terms.length} terms`,
      blocks: [{
        kind: "kpis",
        items: [
          { label: "Term Spend", value: money(waste.analyzed, currency) },
          { label: "Wasted", value: money(waste.wasted, currency) },
          { label: "Waste Rate", value: pct(wastePct) },
          { label: "Zero-Conv Terms", value: num(waste.wastedTerms.length) },
          { label: "Terms Analyzed", value: num(terms.length) },
          { label: "Range", value: `${report.range.days}d` },
        ],
      }],
    },
  ];
  if (negatives.length) {
    sections.push({
      eyebrow: "Suggested Negatives",
      note: `${negatives.length} terms · ${money(waste.wasted, currency)}`,
      blocks: [{ kind: "table", columns: termColumns, rows: negatives.map(termRow) }],
    });
  }
  sections.push({
    eyebrow: "Top Terms by Cost",
    note: `${Math.min(20, terms.length)} of ${terms.length}`,
    blocks: [{ kind: "table", columns: termColumns, rows: terms.slice(0, 20).map(termRow) }],
  });

  finish(analysis, sections);
  return doc("search-terms", "Search Term Waste Audit", report, health, sections, aiResult !== null);
}

// ── Creative Fatigue (Meta) ──────────────────────────────────────────────────

const chg = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`);

async function buildCreativeFatigue(report: AccountReport, apiKey: string | null, ads: AdFatigueRow[]): Promise<ReportDoc> {
  const currency = report.account.currency;
  const flags = flagFatigue(ads);
  const fatigued = flags.filter((f) => f.fatigued);
  const winners = scaleCandidates(flags);
  const fatiguedSpend = fatigued.reduce((a, f) => a + f.ad.current.spend, 0);
  const halfDays = Math.max(1, Math.floor(report.range.days / 2));

  const user = [
    snapshot(report),
    ``,
    `Per-ad current vs prior ${halfDays}-day window (${flags.length} ads analyzed, ${fatigued.length} fatigued carrying ${money(fatiguedSpend, currency)}):`,
    ...flags.slice(0, 20).map((f) =>
      `- "${f.ad.adName}" (${f.ad.adsetName}): ${money(f.ad.current.spend, currency)}, freq ${f.ad.current.frequency?.toFixed(1) ?? "?"}, CTR ${f.ad.current.ctr.toFixed(2)}% (${chg(f.ctrChangePct)}), CPM ${chg(f.cpmChangePct)}, CPA ${chg(f.cpaChangePct)}${f.fatigued ? " [FATIGUED]" : ""}`,
    ),
  ].join("\n");
  const aiResult = apiKey ? await aiAnalysis(apiKey, "Creative Fatigue", user) : null;

  const analysis: Analysis = aiResult ?? {
    summary: fatigued.length
      ? `${fatigued.length} of ${flags.length} analyzed ads show fatigue (high frequency plus falling CTR), carrying ${money(fatiguedSpend, currency)} of recent spend. Refresh those first; ${winners.length} ads are healthy enough to scale into the freed budget.`
      : `No ads cross the fatigue thresholds (frequency > 2.5 with CTR down > 15%). Creative is holding; keep the refresh cadence and scale the winners gradually.`,
    findings: fatigued.slice(0, 3).map((f, i) => ({
      title: `"${f.ad.adName}" is fatigued`,
      detail: `${f.reasons.join(", ")} on ${money(f.ad.current.spend, currency)} of spend (${f.ad.adsetName}).`,
      severity: i === 0 ? ("high" as const) : ("medium" as const),
      recommendation: "Pause it or ship a refreshed variant into the same ad set.",
    })),
    recommendations: [
      ...(fatigued.length ? [{ text: `Pause or refresh the ${fatigued.length} flagged ads — ${money(fatiguedSpend, currency)} of spend is grinding on tired audiences.`, priority: "P0" as const }] : []),
      ...(winners.length ? [{ text: `Scale the ${winners.length} healthy winners by 20% budget steps while CPA holds.`, priority: "P1" as const }] : []),
    ],
  };

  const tone: Tone = fatigued.length >= 3 ? "bad" : fatigued.length > 0 ? "warn" : "good";
  const health: ReportDoc["health"] =
    tone === "bad"
      ? { label: "At risk", tone, line: `${fatigued.length} ads fatigued, ${money(fatiguedSpend, currency)} of spend affected.` }
      : tone === "warn"
        ? { label: "Watch", tone, line: `${fatigued.length} ad${fatigued.length === 1 ? "" : "s"} showing fatigue — refresh before it spreads.` }
        : { label: "Healthy", tone, line: "No ads cross the fatigue thresholds." };

  const adColumns = [
    { label: "Ad", align: "left" as const },
    { label: "Ad Set", align: "left" as const },
    { label: "Spend", align: "right" as const },
    { label: "Freq", align: "right" as const },
    { label: "CTR", align: "right" as const },
    { label: "CTR Δ", align: "right" as const },
    { label: "CPM Δ", align: "right" as const },
    { label: "CPA Δ", align: "right" as const },
  ];
  const maxSpend = Math.max(...flags.map((f) => f.ad.current.spend), 1);
  const adRow = (f: (typeof flags)[number]): Cell[] => [
    { text: f.ad.adName, align: "left" },
    { text: f.ad.adsetName, align: "left" },
    { text: money(f.ad.current.spend, currency), align: "right", bar: f.ad.current.spend / maxSpend },
    { text: f.ad.current.frequency?.toFixed(1) ?? "—", align: "right", tone: (f.ad.current.frequency ?? 0) > 2.5 ? "bad" : undefined },
    { text: `${f.ad.current.ctr.toFixed(2)}%`, align: "right" },
    { text: chg(f.ctrChangePct), align: "right", tone: f.ctrChangePct !== null ? (f.ctrChangePct < -15 ? "bad" : f.ctrChangePct > 5 ? "good" : undefined) : undefined },
    { text: chg(f.cpmChangePct), align: "right", tone: f.cpmChangePct !== null && f.cpmChangePct > 20 ? "bad" : undefined },
    { text: chg(f.cpaChangePct), align: "right", tone: f.cpaChangePct !== null ? (f.cpaChangePct > 20 ? "bad" : f.cpaChangePct < -10 ? "good" : undefined) : undefined },
  ];

  const sections: Section[] = [
    {
      eyebrow: "Executive Summary",
      blocks: [
        { kind: "callout", tone: health.tone, text: `${health.label} · ${health.line}` },
        { kind: "prose", text: analysis.summary },
      ],
    },
    {
      eyebrow: "Fatigue Overview",
      note: `current vs prior ${halfDays}d`,
      blocks: [{
        kind: "kpis",
        items: [
          { label: "Ads Analyzed", value: num(flags.length) },
          { label: "Fatigued", value: num(fatigued.length) },
          { label: "Spend at Risk", value: money(fatiguedSpend, currency) },
          { label: "Scale-Ready", value: num(winners.length) },
          { label: "Avg Frequency", value: flags.length ? (flags.reduce((a, f) => a + (f.ad.current.frequency ?? 0), 0) / flags.length).toFixed(1) : "—" },
          { label: "Window", value: `${halfDays}d vs ${halfDays}d` },
        ],
      }],
    },
  ];
  if (fatigued.length) {
    sections.push({
      eyebrow: "Fatigued Ads — Pause or Refresh First",
      note: `${fatigued.length} flagged`,
      blocks: [{ kind: "table", columns: adColumns, rows: fatigued.map(adRow) }],
    });
  }
  if (winners.length) {
    sections.push({
      eyebrow: "Safe to Scale",
      note: `${winners.length} winners`,
      blocks: [{ kind: "table", columns: adColumns, rows: winners.map(adRow) }],
    });
  }
  sections.push({
    eyebrow: "All Analyzed Ads",
    note: `${flags.length} by spend`,
    blocks: [{ kind: "table", columns: adColumns, rows: flags.slice(0, 25).map(adRow) }],
  });

  finish(analysis, sections);
  return doc("creative-fatigue", "Creative Fatigue", report, health, sections, aiResult !== null);
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** Build a recipe's report document from a computed AccountReport + pre-fetched recipe data. */
export async function generateReport(
  recipe: string,
  report: AccountReport,
  apiKey: string | null,
  data: RecipeData = {},
): Promise<ReportDoc> {
  switch (recipe) {
    case "search-terms":
      return buildSearchTerms(report, apiKey, data.terms ?? []);
    case "creative-fatigue":
      return buildCreativeFatigue(report, apiKey, data.ads ?? []);
    default:
      return buildAccountAudit(report, apiKey, data.audit ?? null);
  }
}
