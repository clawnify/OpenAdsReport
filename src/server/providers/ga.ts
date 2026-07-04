// Google Analytics 4 source for the Landing Page Analysis recipe. Not an ad
// platform (no AdProvider) — GA4 is a property-wide analytics source reached
// through the managed integration's actions via @clawnify/connections. As with
// the ad providers, this module only fetches and normalizes; all judgment
// (drop ranking, flags, recoverable revenue) lives in the report engine.

import { connect, isConnected, type ConnectionsEnv } from "@clawnify/connections";
import type { DateRange } from "./types";

export const GA_SERVICE = "google_analytics";

export interface LandingPageWindow {
  sessions: number;
  bounceRatePct: number; // percent
  keyEvents: number;
  convRatePct: number; // keyEvents / sessions, percent
  revenue: number;
  revenuePerSession: number;
  transactions: number;
  aov: number;
}

export interface LandingPageRow {
  page: string;
  /** Dominant paid source/medium for the page (by sessions). */
  sourceMedium: string;
  current: LandingPageWindow;
  prev: LandingPageWindow | null;
}

export interface LandingPagesResult {
  /** GA4 property the report ran against, e.g. "properties/123456". */
  property: string;
  propertyName: string;
  rows: LandingPageRow[];
}

export const gaConnected = (env: ConnectionsEnv) => isConnected(GA_SERVICE, env);

const N = (v: unknown) => Number(v ?? 0);

/**
 * First GA4 property the connection can see.
 * Ceiling: multi-property accounts get their first listed property; the report
 * names which one so a wrong pick is visible, not silent.
 */
async function resolveProperty(client: ReturnType<typeof connect>): Promise<{ property: string; name: string } | null> {
  const d = (await client.run("GOOGLE_ANALYTICS_LIST_ACCOUNT_SUMMARIES", { pageSize: 50 })) as any;
  const summaries = d?.accountSummaries ?? d?.account_summaries ?? [];
  for (const acc of summaries) {
    const props = acc?.propertySummaries ?? acc?.property_summaries ?? [];
    if (props[0]?.property) {
      return { property: String(props[0].property), name: String(props[0].displayName ?? props[0].display_name ?? props[0].property) };
    }
  }
  return null;
}

interface RawPageRow {
  page: string;
  sourceMedium: string;
  sessions: number;
  bounceRate: number; // fraction 0..1
  keyEvents: number;
  revenue: number;
  transactions: number;
}

async function runWindow(client: ReturnType<typeof connect>, property: string, since: string, until: string): Promise<RawPageRow[]> {
  const d = (await client.run("GOOGLE_ANALYTICS_RUN_REPORT", {
    property,
    dateRanges: [{ startDate: since, endDate: until }],
    dimensions: [{ name: "landingPagePlusQueryString" }, { name: "sessionSourceMedium" }],
    metrics: [
      { name: "sessions" },
      { name: "bounceRate" },
      { name: "keyEvents" },
      { name: "totalRevenue" },
      { name: "transactions" },
    ],
    // Paid channel groups only ("Paid Search", "Paid Social", …) — this recipe
    // diagnoses pages that ad money lands on.
    dimensionFilter: {
      filter: {
        fieldName: "sessionDefaultChannelGroup",
        stringFilter: { matchType: "CONTAINS", value: "Paid", caseSensitive: false },
      },
    },
    limit: 250,
  })) as any;

  const rows = d?.rows ?? [];
  return rows.map((r: any) => {
    const dim = (i: number) => String(r.dimensionValues?.[i]?.value ?? "");
    const met = (i: number) => N(r.metricValues?.[i]?.value);
    return {
      page: dim(0),
      sourceMedium: dim(1),
      sessions: met(0),
      bounceRate: met(1),
      keyEvents: met(2),
      revenue: met(3),
      transactions: met(4),
    };
  }).filter((r: RawPageRow) => r.page && r.sessions > 0);
}

/** Collapse (page, sourceMedium) rows into one row per page; bounce is session-weighted. */
function perPage(rows: RawPageRow[]): Map<string, { agg: RawPageRow; topSource: string }> {
  const map = new Map<string, { agg: RawPageRow; bySource: Map<string, number> }>();
  for (const r of rows) {
    let e = map.get(r.page);
    if (!e) {
      e = { agg: { ...r, bounceRate: 0 }, bySource: new Map() };
      e.agg.sessions = 0; e.agg.keyEvents = 0; e.agg.revenue = 0; e.agg.transactions = 0;
      map.set(r.page, e);
    }
    e.agg.sessions += r.sessions;
    e.agg.keyEvents += r.keyEvents;
    e.agg.revenue += r.revenue;
    e.agg.transactions += r.transactions;
    e.agg.bounceRate += r.bounceRate * r.sessions; // weighted sum, divided below
    e.bySource.set(r.sourceMedium, (e.bySource.get(r.sourceMedium) ?? 0) + r.sessions);
  }
  const out = new Map<string, { agg: RawPageRow; topSource: string }>();
  for (const [page, e] of map) {
    e.agg.bounceRate = e.agg.sessions > 0 ? e.agg.bounceRate / e.agg.sessions : 0;
    const topSource = [...e.bySource.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    out.set(page, { agg: e.agg, topSource });
  }
  return out;
}

const toWindow = (r: RawPageRow): LandingPageWindow => ({
  sessions: r.sessions,
  bounceRatePct: r.bounceRate * 100,
  keyEvents: r.keyEvents,
  convRatePct: r.sessions > 0 ? (r.keyEvents / r.sessions) * 100 : 0,
  revenue: r.revenue,
  revenuePerSession: r.sessions > 0 ? r.revenue / r.sessions : 0,
  transactions: r.transactions,
  aov: r.transactions > 0 ? r.revenue / r.transactions : 0,
});

/** Paid-traffic landing pages, current period vs the equal prior period. */
export async function gaLandingPages(env: ConnectionsEnv, range: DateRange): Promise<LandingPagesResult> {
  const client = connect(GA_SERVICE, env);
  const prop = await resolveProperty(client);
  if (!prop) throw new Error("No Google Analytics property visible to this connection");

  const [cur, prev] = await Promise.all([
    runWindow(client, prop.property, range.since, range.until),
    runWindow(client, prop.property, range.prevSince, range.prevUntil),
  ]);
  const curPages = perPage(cur);
  const prevPages = perPage(prev);

  const rows: LandingPageRow[] = [...curPages.entries()]
    .map(([page, { agg, topSource }]) => ({
      page,
      sourceMedium: topSource,
      current: toWindow(agg),
      prev: prevPages.has(page) ? toWindow(prevPages.get(page)!.agg) : null,
    }))
    .sort((a, b) => b.current.sessions - a.current.sessions)
    .slice(0, 50);

  return { property: prop.property, propertyName: prop.name, rows };
}
