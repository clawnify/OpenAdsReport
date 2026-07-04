// JSON API. This is the surface the dashboard renders from AND the surface
// Clawnify exposes to agents (via MCP/API) and to Claude Code. Every number is
// computed server-side here so all consumers see identical results.

import { Hono } from "hono";
import type { AccountSummary, Issue, Platform, PortfolioReport } from "./providers/types";
import { connectedProviders, getProvider } from "./providers";
import { deriveIssues, resolveRange, sumMetrics } from "./metrics";
import { describe, secret } from "@clawnify/connections";
import { aiHints } from "./ai";
import { REQUIRES } from "./requires";
import type { Bindings } from "./env";
import { sampleAccountRefs, sampleAccountReport, samplePortfolio, samplePreviewReport, sampleRecipeData } from "./sample";
import { gaConnected, gaLandingPages } from "./providers/ga";
import { RECIPES, generateReport } from "./report";

const api = new Hono<{ Bindings: Bindings }>();

/** Upgrade an account's issues to AI-generated hints when OpenRouter is configured. */
async function hintsFor(
  env: Bindings,
  acc: AccountSummary,
  fallback: Issue[],
  days: number,
): Promise<Issue[]> {
  const key = secret("OPENROUTER_API_KEY", env);
  if (!key) return fallback;
  const ai = await aiHints(key, {
    accountName: acc.name,
    platform: acc.platform,
    currency: acc.currency,
    current: acc.metrics,
    previous: acc.prev,
    days,
  });
  return ai ?? fallback;
}

const rangeFromQuery = (c: any) =>
  resolveRange({
    since: c.req.query("since") || undefined,
    until: c.req.query("until") || undefined,
    days: c.req.query("days") ? parseInt(c.req.query("days"), 10) : undefined,
  });

/** Which platforms are connected, and whether we're in sample/preview mode. */
api.get("/api/state", async (c) => {
  const providers = await connectedProviders(c.env);
  return c.json({
    providers: providers.map((p) => ({ id: p.id, connected: true })),
    preview: providers.length === 0,
    platforms: ["meta", "google"] as Platform[],
    aiHints: !!secret("OPENROUTER_API_KEY", c.env),
    // Agent-legible readiness for everything this app declares in requires.ts:
    // what's connected, how to access it, and the dashboard step for any gaps.
    requirements: await describe(c.env, undefined, REQUIRES),
  });
});

/** Account list for the picker, across all connected providers. */
api.get("/api/accounts", async (c) => {
  const providers = await connectedProviders(c.env);
  if (providers.length === 0) return c.json({ preview: true, accounts: sampleAccountRefs() });
  try {
    const lists = await Promise.all(providers.map((p) => p.listAccounts().catch(() => [])));
    return c.json({ preview: false, accounts: lists.flat() });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

/** Portfolio View: every account across every platform, plus top issues. */
api.get("/api/portfolio", async (c) => {
  const range = rangeFromQuery(c);
  const providers = await connectedProviders(c.env);
  if (providers.length === 0) return c.json(samplePortfolio(range));

  try {
    const all = (await Promise.all(providers.map((p) => p.accountSummaries(range).catch(() => [])))).flat();
    const accounts = all.sort((a, b) => a.metrics.roas - b.metrics.roas);
    const totals = sumMetrics(accounts.map((a) => a.metrics));
    const topIssues = (
      await Promise.all(
        accounts.slice(0, 3).map(async (account) => ({
          account,
          issues: await hintsFor(c.env, account, deriveIssues(account.metrics, account.prev, []), range.days),
        })),
      )
    ).filter((t) => t.issues.length > 0);
    const report: PortfolioReport = {
      range: { since: range.since, until: range.until, days: range.days },
      totals,
      accounts,
      topIssues,
      generatedAt: new Date().toISOString(),
      preview: false,
    };
    return c.json(report);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

/** Account View: full report (KPIs, daily series, channel, issues) for one account. */
api.get("/api/account", async (c) => {
  const range = rangeFromQuery(c);
  const accountId = c.req.query("account_id");
  const platform = c.req.query("platform") as Platform | undefined;
  const providers = await connectedProviders(c.env);

  if (providers.length === 0) return c.json(sampleAccountReport(range, accountId || undefined));
  if (!accountId) return c.json({ error: "account_id required" }, 400);

  try {
    const provider = platform ? await getProvider(c.env, platform) : providers[0];
    if (!provider) return c.json({ error: `Platform ${platform} not connected` }, 400);
    const report = await provider.accountReport(accountId, range);

    if (secret("OPENROUTER_API_KEY", c.env)) {
      const cur = report.channels[0]?.metrics;
      const k = report.kpis;
      const prev = k.cost.prev !== null
        ? {
            spend: k.cost.prev ?? 0, revenue: 0, conversions: k.conversions.prev ?? 0,
            clicks: k.clicks.prev ?? 0, impressions: 0,
            roas: k.roas.prev ?? 0, cpa: 0, ctr: k.ctr.prev ?? 0, convRate: k.convRate.prev ?? 0,
          }
        : null;
      if (cur) {
        const acc: AccountSummary = { ...report.account, metrics: cur, prev };
        report.issues = await hintsFor(c.env, acc, report.issues, range.days);
      }
    }
    return c.json(report);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

/** The analyst report gallery — which recipes exist and which are generatable. */
api.get("/api/reports", async (c) => {
  const providers = await connectedProviders(c.env);
  const preview = providers.length === 0;
  // Landing Page rides on the Google Analytics integration, not an ad platform;
  // preview mode always renders it from sample data.
  const ga = preview || (await gaConnected(c.env).catch(() => false));
  const recipes = RECIPES.map((r) =>
    r.id === "landing-page" && !ga
      ? { ...r, available: false, locked: "Connect Google Analytics" }
      : r,
  );
  return c.json({ recipes });
});

/**
 * Generate an analyst report (Phase 2). Same data path as /api/account, then the
 * report engine assembles a typed document (KPIs/charts/tables from real numbers
 * + AI-authored analysis, heuristic fallback). The surface agents call to get a
 * full audit, and what the Reports view renders.
 */
api.get("/api/report", async (c) => {
  const recipe = RECIPES.find((r) => r.id === (c.req.query("recipe") || "account-audit"));
  if (!recipe || !recipe.available) {
    return c.json({ error: `Unknown or unavailable report: ${c.req.query("recipe")}` }, 400);
  }
  const range = rangeFromQuery(c);
  const accountId = c.req.query("account_id");
  const platform = c.req.query("platform") as Platform | undefined;
  const apiKey = secret("OPENROUTER_API_KEY", c.env);
  const providers = await connectedProviders(c.env);

  try {
    if (providers.length === 0) {
      // Preview mode: the sample account's platform must match the recipe.
      const report = samplePreviewReport(range, accountId || undefined, recipe.platforms);
      return c.json(await generateReport(recipe.id, report, apiKey, sampleRecipeData(recipe.id, report, range)));
    }

    if (!accountId) throw new Error("account_id required");
    const provider = platform ? await getProvider(c.env, platform) : providers[0];
    if (!provider) throw new Error(`Platform ${platform} not connected`);
    if (!recipe.platforms.includes(provider.id)) {
      const wanted = recipe.platforms.map((p) => (p === "meta" ? "Meta" : "Google Ads")).join(" / ");
      return c.json({ error: `${recipe.name} runs on ${wanted} accounts — pick one in the account selector.` }, 400);
    }

    if (recipe.id === "landing-page" && !(await gaConnected(c.env).catch(() => false))) {
      return c.json({ error: "Landing Page Analysis needs Google Analytics — connect it in the Clawnify dashboard." }, 400);
    }

    const report = await provider.accountReport(accountId, range);
    // Fetch only what this recipe scores — the audit runs the full pass, the
    // focused recipes fetch their single dataset.
    const data =
      recipe.id === "search-terms"
        ? { terms: await provider.searchTerms!(accountId, range) }
        : recipe.id === "creative-fatigue"
          ? { ads: await provider.adFatigue!(accountId, range) }
          : recipe.id === "landing-page"
            ? { pages: await gaLandingPages(c.env, range) }
            : { audit: await provider.auditData(accountId, range).catch(() => null) };
    return c.json(await generateReport(recipe.id, report, apiKey, data));
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default api;
