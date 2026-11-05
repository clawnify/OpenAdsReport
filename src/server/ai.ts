// AI-generated hints via OpenRouter. When OPENROUTER_API_KEY is injected (declared
// in clawnify.json `env`), the dashboard upgrades its heuristic issues to sharp,
// money-focused recommendations written by a small fast model. Falls back to the
// deterministic heuristics in metrics.ts whenever the key is absent or the call fails.

import type { Issue, Metrics, Platform } from "./providers/types";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "google/gemini-3.1-flash-lite";

export interface HintContext {
  accountName: string;
  platform: Platform;
  currency: string;
  current: Metrics;
  previous: Metrics | null;
  days: number;
}

const fmtMoney = (n: number, cur: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(n);

function snapshot(c: HintContext): string {
  const { current: m, previous: p, currency } = c;
  const line = (label: string, cur: string, prev?: string) =>
    `${label}: ${cur}${prev ? ` (prev ${prev})` : ""}`;
  return [
    `Account "${c.accountName}" on ${c.platform === "meta" ? "Meta Ads" : "Google Ads"}, last ${c.days} days.`,
    line("Spend", fmtMoney(m.spend, currency), p ? fmtMoney(p.spend, currency) : undefined),
    line("Revenue", fmtMoney(m.revenue, currency), p ? fmtMoney(p.revenue, currency) : undefined),
    line("ROAS", `${m.roas.toFixed(2)}x`, p ? `${p.roas.toFixed(2)}x` : undefined),
    line("Conversions", String(Math.round(m.conversions)), p ? String(Math.round(p.conversions)) : undefined),
    line("CPA", fmtMoney(m.cpa, currency), p ? fmtMoney(p.cpa, currency) : undefined),
    line("CTR", `${m.ctr.toFixed(2)}%`, p ? `${p.ctr.toFixed(2)}%` : undefined),
    line("Conv. rate", `${m.convRate.toFixed(2)}%`, p ? `${p.convRate.toFixed(2)}%` : undefined),
  ].join("\n");
}

const SYSTEM = `You are a senior paid-media consultant auditing an ad account from its top-line metrics.
Return 1-3 of the most important issues, each tied to money (ROAS, CPA, revenue, or wasted spend).
Be decisive and specific — no hedging, no theory. Respond ONLY with JSON:
{"issues":[{"title":"short headline","detail":"what's wrong and why it hurts, with the numbers","action":"the exact fix to apply","severity":"high|medium|low"}]}
If the account looks healthy, return fewer issues (even an empty array).`;

export async function aiHints(apiKey: string, ctx: HintContext): Promise<Issue[] | null> {
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 700,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: snapshot(ctx) },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { issues?: any[] };
    const raw = Array.isArray(parsed.issues) ? parsed.issues : [];
    return raw.slice(0, 3).map((it, i) => ({
      id: `ai-${i}`,
      title: String(it.title ?? "Issue"),
      detail: String(it.detail ?? ""),
      action: String(it.action ?? ""),
      severity: it.severity === "high" || it.severity === "low" ? it.severity : "medium",
    }));
  } catch {
    return null;
  }
}
