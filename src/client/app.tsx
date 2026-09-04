import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Calendar, ChevronDown, RefreshCw, Download, Sparkles } from "lucide-react";

// ── Types (mirror src/server/providers/types.ts) ─────────────────────────────

type Platform = "meta" | "google";
type Metrics = {
  spend: number; revenue: number; conversions: number; clicks: number; impressions: number;
  roas: number; cpa: number; ctr: number; convRate: number;
};
type MetricDelta = { value: number; prev: number | null; deltaPct: number | null; higherIsBetter: boolean };
type DailyPoint = {
  date: string; spend: number; revenue: number; conversions: number; clicks: number;
  impressions: number; roas: number; convRate: number; ctr: number;
};
type Issue = { id: string; title: string; detail: string; action: string; severity: "high" | "medium" | "low" };
type AccountRef = { id: string; name: string; platform: Platform; currency: string };
type AccountSummary = AccountRef & { metrics: Metrics; prev: Metrics | null };
type AccountReport = {
  account: AccountRef;
  range: { since: string; until: string; days: number };
  kpis: { cost: MetricDelta; roas: MetricDelta; conversions: MetricDelta; convRate: MetricDelta; clicks: MetricDelta; ctr: MetricDelta };
  daily: DailyPoint[];
  channels: { platform: Platform; metrics: Metrics }[];
  issues: Issue[];
  generatedAt: string;
  preview: boolean;
};
type PortfolioReport = {
  range: { since: string; until: string; days: number };
  totals: Metrics;
  accounts: AccountSummary[];
  topIssues: { account: AccountSummary; issues: Issue[] }[];
  generatedAt: string;
  preview: boolean;
};

// Phase 2 report document (mirrors src/server/report.ts).
type Tone = "good" | "warn" | "bad" | "info";
type Severity = "high" | "medium" | "low";
type Rating = "Good" | "Fair" | "Needs work" | "Poor" | "Critical";
type Cell = { text: string; align?: "left" | "right"; tone?: Tone; bar?: number };
type Block =
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
type ReportSection = { eyebrow: string; note?: string; blocks: Block[] };
type ReportDoc = {
  recipe: string; title: string; subtitle: string;
  account: { name: string; platform: Platform; currency: string };
  range: { since: string; until: string; days: number };
  health: { label: "Healthy" | "Watch" | "At risk"; tone: Tone; line: string };
  sections: ReportSection[]; daily: DailyPoint[]; ai: boolean; preview: boolean; generatedAt: string;
  /** Set when the recipe's dataset was reused from a recent pull rather than fetched fresh. */
  reusedData?: boolean; dataNote?: string;
};
type RecipeMeta = { id: string; name: string; blurb: string; available: boolean; platforms: Platform[]; locked?: string };

// ── Theme (Clawnify Apps palette: white canvas, slate ink, coral accent) ──────

const C = {
  card: "bg-white border border-[#E2E8F0]",
  shadow: "shadow-[0_1px_2px_rgba(0,0,0,0.03)]",
  text: "text-[#1A202C]",
  sub: "text-[#475569]",
  faint: "text-[#94A3B8]",
  label: "text-[11px] font-semibold text-[#1A202C] tracking-[0.14em] uppercase",
};
const BAR = "#64748B";
const LINE = "#DD5164";
const GOOD = "#047857";
const BAD = "#B91C1C";

// ── Formatters ───────────────────────────────────────────────────────────────

const money = (n: number, cur = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
const moneyK = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${n.toFixed(1)}`);
const num = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n));
const pct = (n: number) => `${n.toFixed(1)}%`;
const x = (n: number) => `${n.toFixed(1)}x`;

function fmtDay(d: string) {
  const dt = new Date(d + "T00:00:00");
  return `${String(dt.getMonth() + 1).padStart(2, "0")}/${String(dt.getDate()).padStart(2, "0")}`;
}
function fmtRange(since: string, until: string) {
  const o: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  return `${new Date(since + "T00:00:00").toLocaleDateString("en-US", o)} - ${new Date(until + "T00:00:00").toLocaleDateString("en-US", o)}`;
}
function perfColor(roas: number) {
  return roas >= 2.5 ? GOOD : roas >= 1 ? "#B45309" : BAD;
}
function ctrColor(ctr: number) {
  return ctr >= 2 ? GOOD : ctr >= 1.2 ? "#B45309" : BAD;
}

// ── Small UI atoms ───────────────────────────────────────────────────────────

function Delta({ d }: { d: MetricDelta }) {
  if (d.deltaPct === null) return null;
  const up = d.deltaPct >= 0;
  const good = d.higherIsBetter ? up : !up;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span className="text-[11px] font-medium inline-flex items-center gap-0.5" style={{ color: good ? GOOD : BAD }}>
      <Icon className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
      {Math.abs(d.deltaPct).toFixed(1)}%
    </span>
  );
}

const LOGOS: Record<Platform, string> = {
  meta: "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/meta/default.svg",
  google: "https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/google-ads/default.svg",
};

function PlatformLogo({ platform, size = 14 }: { platform: Platform; size?: number }) {
  return (
    <img src={LOGOS[platform]} alt={platform === "meta" ? "Meta" : "Google Ads"} width={size} height={size} className="object-contain shrink-0" />
  );
}

function PlatformBadge({ platform }: { platform: Platform }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] ${C.sub} uppercase tracking-[0.14em] whitespace-nowrap`}>
      <PlatformLogo platform={platform} size={14} />
      {platform === "meta" ? "Meta" : "Google"}
    </span>
  );
}

/** KPI card with two metrics side by side (left + right), optional deltas. */
function KpiCard({
  left, right,
}: {
  left: { label: string; value: string; delta?: MetricDelta };
  right: { label: string; value: string; delta?: MetricDelta };
}) {
  const Cell = ({ m, align }: { m: { label: string; value: string; delta?: MetricDelta }; align: "left" | "right" }) => (
    <div className={align === "right" ? "text-right" : ""}>
      <span className={C.label}>{m.label}</span>
      <div className={`flex items-baseline gap-1.5 mt-0.5 ${align === "right" ? "justify-end" : ""}`}>
        <span className="text-[18px] sm:text-[19px] font-semibold text-[#1A202C] leading-tight tracking-[-0.01em] tnum">{m.value}</span>
        {m.delta && <Delta d={m.delta} />}
      </div>
    </div>
  );
  return (
    <div className={`${C.card} ${C.shadow} rounded-[6px] p-4 flex-1 h-full`}>
      <div className="flex justify-between">
        <Cell m={left} align="left" />
        <Cell m={right} align="right" />
      </div>
    </div>
  );
}

/**
 * How current the numbers are.
 *
 * The dashboard reads synced rows rather than calling the ad platforms on every
 * page view, so it owes the reader an explicit answer to "when was this last
 * true?" — a live-looking number with no timestamp is the dishonest version.
 */
type Freshness = {
  lastSyncAt: string | null; status: string | null; accounts: number;
  throughDate: string | null; daysBehind: number | null; stale: boolean;
  nextSyncAt: string | null; error: string | null;
};

function sinceLabel(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z").getTime();
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function SyncBar({ freshness, needsSync, syncing, onSync }: {
  freshness: Freshness | null; needsSync: boolean; syncing: boolean; onSync: () => void;
}) {
  if (needsSync) {
    return (
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 rounded-[6px] ${C.card} text-[13px] ${C.text} mb-4 no-print`}>
        <span><span className="font-semibold">Connected, not yet synced.</span> The first sync is booked and the dashboard fills in when it lands — or pull your history now.</span>
        <button onClick={onSync} disabled={syncing}
          className="ml-auto inline-flex items-center gap-1.5 h-8 px-3 rounded-[6px] text-[13px] font-medium bg-[#DD5164] text-white hover:bg-[#C53A4E] transition-colors disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing…" : "Run first sync"}
        </button>
      </div>
    );
  }
  if (!freshness?.lastSyncAt) return null;
  if (freshness.stale) {
    // The numbers are still rendered — they are real, just old — but a reader
    // must not mistake a stopped sync for a quiet account.
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 rounded-[6px] border border-[#F59E0B]/40 bg-[#FFFBEB] text-[13px] text-[#78350F] mb-4 no-print">
        <span>
          <span className="font-semibold">These numbers have stopped updating.</span>{" "}
          Data runs through {freshness.throughDate}, {freshness.daysBehind} days behind. Last sync {sinceLabel(freshness.lastSyncAt)}
          {freshness.status && freshness.status !== "ok" ? ` (${freshness.status}${freshness.error ? `: ${freshness.error}` : ""})` : ""}.
        </span>
        <button onClick={onSync} disabled={syncing}
          className="ml-auto inline-flex items-center gap-1.5 h-8 px-3 rounded-[6px] text-[13px] font-medium bg-[#DD5164] text-white hover:bg-[#C53A4E] transition-colors disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[#64748B] mb-4 no-print">
      <span className="tnum">
        Synced {sinceLabel(freshness.lastSyncAt)}
        {freshness.throughDate ? ` · data through ${freshness.throughDate}` : ""}
      </span>
      {freshness.status && freshness.status !== "ok" && (
        <span className="text-[#B45309]" title={freshness.error ?? undefined}>· last sync {freshness.status}</span>
      )}
      <button onClick={onSync} disabled={syncing}
        className="underline underline-offset-2 hover:text-[#1A202C] disabled:opacity-50">
        {syncing ? "syncing…" : "sync now"}
      </button>
    </div>
  );
}

function PreviewBanner() {
  return (
    <div className={`px-4 py-3 rounded-[6px] ${C.card} text-[13px] ${C.text}`}>
      <span className="font-semibold">Just a preview.</span> These are sample numbers so you can see how the dashboard works.
      Your real numbers will show up here once you connect an ads account.
    </div>
  );
}

/** Segmented control — sunken track, raised white active pill (never an ink fill). */
function Segmented<T extends string>({ options, value, onChange, size = "md" }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; size?: "sm" | "md";
}) {
  const pad = size === "sm" ? "px-2.5 py-1 text-[12px]" : "px-3.5 py-1.5 text-[13px]";
  return (
    <div className="inline-flex items-center gap-0.5 p-0.5 bg-[#F1F5F9] rounded-[6px]">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} onClick={() => onChange(o.value)}
            className={`${pad} rounded-[4px] font-medium whitespace-nowrap transition-colors border ${
              active ? "bg-white text-[#1A202C] border-[#E2E8F0] shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                     : "text-[#475569] hover:text-[#1A202C] border-transparent"
            }`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Combo chart (bars + line, dual axis), hand-rolled SVG ─────────────────────

function ComboChart({
  data, barKey, lineKey, barLabel, lineLabel,
}: {
  data: DailyPoint[];
  barKey: "spend" | "conversions" | "clicks";
  lineKey: "roas" | "convRate" | "ctr";
  barLabel: string;
  lineLabel: string;
}) {
  const W = 560, H = 190;
  const pad = { t: 12, b: 24, l: 4, r: 4 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;
  if (data.length === 0) return <div className={`${C.card} ${C.shadow} rounded-[6px] p-4 h-44`} />;

  const barMax = Math.max(...data.map((d) => d[barKey]), 1);
  const lineMax = Math.max(...data.map((d) => d[lineKey]), 0.001);
  const n = data.length;
  const slot = cw / n;
  const bw = Math.max(2, Math.min(slot * 0.6, 14));
  const cx = (i: number) => pad.l + slot * i + slot / 2;
  const by = (v: number) => pad.t + ch - (v / barMax) * ch;
  const ly = (v: number) => pad.t + ch - (v / lineMax) * ch;
  const linePts = data.map((d, i) => `${cx(i)},${ly(d[lineKey])}`).join(" ");
  const tickEvery = Math.max(1, Math.round(n / 5));

  return (
    <div className={`${C.card} ${C.shadow} rounded-[6px] p-3 sm:p-4`}>
      <div className="flex items-center gap-4 mb-2">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 inline-block" style={{ background: BAR }} />
          <span className={C.label}>{barLabel}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-5 h-0.5 inline-block" style={{ background: LINE }} />
          <span className={C.label}>{lineLabel}</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 150 }}>
        {data.map((d, i) => (
          <rect key={i} x={cx(i) - bw / 2} y={by(d[barKey])} width={bw} height={pad.t + ch - by(d[barKey])} fill={BAR} rx={1} />
        ))}
        <polyline points={linePts} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) =>
          i % tickEvery === 0 ? (
            <text key={`t${i}`} x={cx(i)} y={H - 6} textAnchor="middle" fontSize={9} fill="#94A3B8">
              {fmtDay(d.date)}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

// ── Channel table (Account View) ─────────────────────────────────────────────

function ChannelTable({ channels }: { channels: { platform: Platform; metrics: Metrics }[] }) {
  const max = Math.max(...channels.map((c) => c.metrics.spend), 1);
  const Bar = ({ w, color, value }: { w: number; color: string; value: string }) => (
    <div className="flex items-center justify-end gap-2">
      <div className="w-12 sm:w-16 md:w-20 h-1.5 bg-[#F1F5F9] overflow-hidden rounded-[6px]">
        <div className="h-full" style={{ width: `${Math.max(4, w * 100)}%`, background: color }} />
      </div>
      <span className="text-[12px] text-[#1A202C] w-12 text-right tnum">{value}</span>
    </div>
  );
  return (
    <div className={`${C.card} ${C.shadow} rounded-[6px] overflow-x-auto`}>
      <div className="px-3 sm:px-4 min-w-[500px]">
        <div className="grid grid-cols-5 gap-2 py-2 border-b border-[#E2E8F0] items-center">
          <div className={C.label}>Channel</div>
          <div className={`${C.label} text-right`}>Ad Spend</div>
          <div className={`${C.label} text-right`}>ROAS</div>
          <div className={`${C.label} text-right`}>Conv. Rate</div>
          <div className={`${C.label} text-right`}>Conversions</div>
        </div>
        {channels.map((c) => (
          <div key={c.platform} className="grid grid-cols-5 gap-2 py-3 border-b border-[#E2E8F0] last:border-b-0 items-center">
            <div><PlatformBadge platform={c.platform} /></div>
            <Bar w={c.metrics.spend / max} color={BAR} value={moneyK(c.metrics.spend)} />
            <Bar w={Math.min(1, c.metrics.roas / 5)} color={perfColor(c.metrics.roas)} value={x(c.metrics.roas)} />
            <Bar w={Math.min(1, c.metrics.convRate / 10)} color={BAR} value={pct(c.metrics.convRate)} />
            <Bar w={1} color={BAR} value={num(c.metrics.conversions)} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Top issues ───────────────────────────────────────────────────────────────

const sevColor = { high: "#B91C1C", medium: "#B45309", low: "#475569" } as const;

function MiniDelta({ label, value, delta }: { label: string; value: string; delta: number | null }) {
  return (
    <span className={C.sub}>
      {label} <span className="text-[#1A202C] font-medium tnum">{value}</span>
      {delta !== null && (
        <span className="ml-1 tnum" style={{ color: delta >= 0 ? GOOD : BAD }}>
          {delta >= 0 ? "+" : ""}
          {delta.toFixed(0)}%
        </span>
      )}
    </span>
  );
}

function IssueRow({ account, issues }: { account: AccountSummary; issues: Issue[] }) {
  const m = account.metrics;
  const p = account.prev;
  const ch = (a: number, b: number | undefined | null) => (b && b > 0 ? ((a - b) / b) * 100 : null);
  return (
    <div className="relative border-b border-[#E2E8F0] last:border-b-0">
      <div className="absolute left-0 top-0 bottom-0 w-1 max-h-10" style={{ background: sevColor[issues[0]?.severity ?? "medium"] }} />
      <div className="pl-4 pr-4 py-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-2">
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
            <span className="text-[12px] font-semibold text-[#1A202C]">{account.name}</span>
            <span className="text-[11px] text-[#475569] uppercase tracking-[0.14em] px-1.5 py-0.5 bg-[#F1F5F9] rounded-[4px]">
              {account.platform === "meta" ? "Meta" : "Google Ads"}
            </span>
            <div className="flex items-center gap-2 sm:gap-3 text-[11px] flex-wrap">
              <MiniDelta label="SPEND" value={moneyK(m.spend)} delta={ch(m.spend, p?.spend)} />
              <MiniDelta label="CONV" value={num(m.conversions)} delta={ch(m.conversions, p?.conversions)} />
              <MiniDelta label="ROAS" value={x(m.roas)} delta={ch(m.roas, p?.roas)} />
            </div>
          </div>
        </div>
        <ul className="space-y-1 ml-1">
          {issues.map((it) => (
            <li key={it.id} className="flex gap-2">
              <span className="text-[#94A3B8] text-[12px] leading-4 shrink-0">•</span>
              <div className="text-[12px] text-[#475569] leading-4">
                <span>
                  <strong className="text-[#1A202C]">{it.title}</strong>: {it.detail}
                </span>
                <div className="text-[#475569] mt-0.5">
                  <strong className="text-[#1A202C]">Action:</strong> {it.action}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function TopIssues({ items, title }: { items: { account: AccountSummary; issues: Issue[] }[]; title: string }) {
  if (items.length === 0) return null;
  return (
    <div className={`${C.card} ${C.shadow} rounded-[6px]`}>
      <div className="px-4 sm:px-6 py-4 border-b border-[#E2E8F0]">
        <h3 className={C.label}>{title}</h3>
      </div>
      <div>
        {items.map((it) => (
          <IssueRow key={it.account.id} account={it.account} issues={it.issues} />
        ))}
      </div>
    </div>
  );
}

// ── Portfolio table ──────────────────────────────────────────────────────────

function PortfolioTable({ accounts }: { accounts: AccountSummary[] }) {
  const maxCtr = Math.max(...accounts.map((a) => a.metrics.ctr), 1);
  const Bar = ({ w, color }: { w: number; color: string }) => (
    <div className="w-12 sm:w-16 h-1.5 bg-[#F1F5F9] rounded-full overflow-hidden flex-shrink-0">
      <div className="h-full rounded-full" style={{ width: `${Math.max(6, Math.min(100, w * 100))}%`, background: color }} />
    </div>
  );
  const th = "text-left px-3 sm:px-4 py-2.5 text-[11px] font-semibold text-[#1A202C] uppercase tracking-[0.14em] whitespace-nowrap";
  return (
    <div className={`${C.card} ${C.shadow} rounded-[6px]`}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="border-b border-[#E2E8F0]">
              <th className={th}>Account</th>
              <th className={th}>Platform</th>
              <th className={th}>ROAS</th>
              <th className={th}>CTR</th>
              <th className={`${th} text-right`}>Cost</th>
              <th className={`${th} text-right`}>CPA</th>
              <th className={`${th} text-right`}>Conv</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => {
              const m = a.metrics;
              const cpaBad = m.roas < 2;
              return (
                <tr key={a.id} className="border-b border-[#E2E8F0] last:border-b-0 hover:bg-[#F1F5F9] transition-colors">
                  <td className="px-3 sm:px-4 py-3"><span className="text-[12px] font-medium text-[#1A202C] whitespace-nowrap">{a.name}</span></td>
                  <td className="px-3 sm:px-4 py-3"><PlatformBadge platform={a.platform} /></td>
                  <td className="px-3 sm:px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium text-[#1A202C] w-8 tnum">{x(m.roas)}</span>
                      <Bar w={m.roas / 7} color={perfColor(m.roas)} />
                    </div>
                  </td>
                  <td className="px-3 sm:px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-[#1A202C] w-8 tnum">{pct(m.ctr)}</span>
                      <Bar w={m.ctr / maxCtr} color={ctrColor(m.ctr)} />
                    </div>
                  </td>
                  <td className="px-3 sm:px-4 py-3 text-right whitespace-nowrap"><span className="text-[12px] text-[#1A202C] tnum">{money(m.spend)}</span></td>
                  <td className="px-3 sm:px-4 py-3 text-right whitespace-nowrap">
                    <span className="text-[12px] font-medium tnum" style={{ color: cpaBad ? BAD : "#1A202C" }}>{money(m.cpa)}</span>
                  </td>
                  <td className="px-3 sm:px-4 py-3 text-right whitespace-nowrap"><span className="text-[12px] text-[#1A202C] tnum">{num(m.conversions)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Phase 2 — analyst report rendering (same component vocabulary) ────────────

const CHART_KEYS = {
  "spend-roas": { barKey: "spend", lineKey: "roas" },
  "conv-rate": { barKey: "conversions", lineKey: "convRate" },
  "clicks-ctr": { barKey: "clicks", lineKey: "ctr" },
} as const;
const toneText: Record<Tone, string> = { good: "text-[#047857]", warn: "text-[#B45309]", bad: "text-[#B91C1C]", info: "text-[#475569]" };
const toneTint: Record<Tone, string> = { good: "bg-[#ECFDF5] text-[#047857]", warn: "bg-[#FFFBEB] text-[#B45309]", bad: "bg-[#FEF2F2] text-[#B91C1C]", info: "bg-[#F1F5F9] text-[#475569]" };

function ReportBlock({ block, daily }: { block: Block; daily: DailyPoint[] }) {
  switch (block.kind) {
    case "prose":
      return <p className="text-[13px] text-[#1A202C] leading-relaxed">{block.text}</p>;
    case "callout":
      return <div className={`rounded-[6px] px-3.5 py-2.5 text-[13px] font-medium ${toneTint[block.tone]}`}>{block.text}</div>;
    case "kpis": {
      const it = block.items;
      const pairs = [[it[0], it[1]], [it[2], it[3]], [it[4], it[5]]].filter((p) => p[0]);
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {pairs.map((p, i) => (
            <KpiCard key={i}
              left={{ label: p[0].label, value: p[0].value, delta: p[0].deltaPct != null ? { value: 0, prev: 0, deltaPct: p[0].deltaPct, higherIsBetter: p[0].higherIsBetter ?? true } : undefined }}
              right={p[1] ? { label: p[1].label, value: p[1].value, delta: p[1].deltaPct != null ? { value: 0, prev: 0, deltaPct: p[1].deltaPct, higherIsBetter: p[1].higherIsBetter ?? true } : undefined } : { label: "", value: "" }}
            />
          ))}
        </div>
      );
    }
    case "chart": {
      const k = CHART_KEYS[block.chart];
      return <ComboChart data={daily} barKey={k.barKey} lineKey={k.lineKey} barLabel={block.barLabel} lineLabel={block.lineLabel} />;
    }
    case "table":
      return (
        <div className={`${C.card} ${C.shadow} rounded-[6px] overflow-x-auto`}>
          <table className="w-full min-w-[460px]">
            <thead>
              <tr className="border-b border-[#E2E8F0]">
                {block.columns.map((col, i) => (
                  <th key={i} className={`px-3 sm:px-4 py-2.5 ${C.label} ${col.align === "right" ? "text-right" : "text-left"}`}>{col.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri} className="border-b border-[#E2E8F0] last:border-b-0">
                  {row.map((cell, ci) => (
                    <td key={ci} className={`px-3 sm:px-4 py-3 text-[12px] tnum ${cell.align === "right" ? "text-right" : "text-left"} ${cell.tone ? toneText[cell.tone] : "text-[#1A202C]"}`}>{cell.text}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "findings":
      return (
        <ul className="space-y-3">
          {block.items.map((f, i) => (
            <li key={i} className="relative pl-4">
              <span className="absolute left-0 top-0.5 bottom-0.5 w-1 rounded-full" style={{ background: sevColor[f.severity] }} />
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] font-semibold text-[#1A202C]">{f.title}</span>
                <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${toneTint[f.severity === "high" ? "bad" : f.severity === "medium" ? "warn" : "info"]}`}>{f.severity}</span>
              </div>
              <p className="text-[12px] text-[#475569] leading-relaxed mt-1">{f.detail}</p>
              {f.recommendation && <p className="text-[12px] text-[#1A202C] leading-relaxed mt-1"><strong>Advise:</strong> {f.recommendation}</p>}
            </li>
          ))}
        </ul>
      );
    case "recommendations":
      return (
        <ul className="space-y-2.5">
          {block.items.map((r, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span className={`text-[11px] font-semibold rounded-[4px] px-1.5 py-0.5 tnum ${r.priority === "P0" ? "bg-[#FEF2F2] text-[#B91C1C] border border-[#FECACA]" : "text-[#475569] bg-[#F1F5F9] border border-[#E2E8F0]"}`}>{r.priority === "P0" ? "HIGH" : r.priority === "P1" ? "MED" : "LOW"}</span>
              <span className="text-[13px] text-[#1A202C] leading-relaxed flex-1">{r.text}</span>
              {r.impact && <span className="text-[11px] font-medium text-[#B45309] bg-[#FFFBEB] rounded-[4px] px-1.5 py-0.5 whitespace-nowrap tnum">{r.impact}</span>}
            </li>
          ))}
        </ul>
      );
    case "scorecard":
      return (
        <div className="flex flex-col sm:flex-row gap-5 sm:gap-8">
          <div className="shrink-0 flex sm:flex-col items-baseline sm:items-start gap-2">
            <div className="flex items-baseline gap-1">
              <span className="text-[44px] font-semibold tracking-[-0.02em] text-[#1A202C] leading-none tnum">{block.score}</span>
              <span className={`text-[15px] ${C.faint} tnum`}>/100</span>
            </div>
            <span className={`text-[12px] font-semibold rounded-full px-2.5 py-1 ${toneTint[block.score >= 70 ? "good" : block.score >= 50 ? "warn" : "bad"]}`}>{block.rating}</span>
          </div>
          <div className="flex-1 min-w-0">
            {block.categories.map((cat, i) => (
              <div key={i} className="flex items-start gap-3 py-2.5 border-b border-[#E2E8F0] last:border-b-0">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-semibold text-[#1A202C]">{cat.name}</span>
                    <span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${toneTint[cat.tone]}`}>{cat.rating ?? "no data"}</span>
                    {cat.worst && <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#B91C1C]">← start here</span>}
                  </div>
                  <p className="text-[12px] text-[#475569] leading-relaxed mt-0.5">{cat.detail}</p>
                </div>
                <div className="text-right shrink-0">
                  <span className="text-[15px] font-semibold text-[#1A202C] tnum">{cat.score ?? "—"}</span>
                  {cat.atStake && <div className="text-[11px] text-[#B45309] tnum whitespace-nowrap">{cat.atStake}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      );
  }
}

function ReportSectionCard({ section, daily }: { section: ReportSection; daily: DailyPoint[] }) {
  const charts = section.blocks.every((b) => b.kind === "chart");
  const bare = section.blocks.every((b) => b.kind === "kpis"); // KPI cards bring their own boxes
  const body = (
    charts ? (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {section.blocks.map((b, i) => <ReportBlock key={i} block={b} daily={daily} />)}
      </div>
    ) : (
      <div className="space-y-3.5">{section.blocks.map((b, i) => <ReportBlock key={i} block={b} daily={daily} />)}</div>
    )
  );
  return (
    <div className="print-block">
      <div className="flex items-center justify-between mb-2.5">
        <h3 className={C.label}>{section.eyebrow}</h3>
        {section.note && <span className={`text-[11px] ${C.faint} uppercase tracking-[0.14em] tnum`}>{section.note}</span>}
      </div>
      {charts || bare ? body : <div className={`${C.card} ${C.shadow} rounded-[6px] p-4 sm:p-5`}>{body}</div>}
    </div>
  );
}

function ReportDocView({ doc }: { doc: ReportDoc }) {
  return (
    <div className="space-y-5">
      <div className={`${C.card} ${C.shadow} rounded-[6px] p-4 sm:p-5 print-block`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className={C.label}>{doc.title}</span>
            <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-[#1A202C] mt-1">{doc.account.name}</h2>
            <div className="flex items-center gap-2 mt-2 flex-wrap text-[11px]">
              <PlatformBadge platform={doc.account.platform} />
              <span className={`${C.sub}`}>{doc.subtitle.split(" · ").slice(-1)[0]}</span>
              <span className="text-[#475569] bg-[#F1F5F9] border border-[#E2E8F0] rounded-[4px] px-1.5 py-0.5">{doc.ai ? "AI analysis" : "rule-based"}</span>
              {doc.preview && <span className="text-[#475569] bg-[#F1F5F9] border border-[#E2E8F0] rounded-[4px] px-1.5 py-0.5">preview</span>}
            </div>
          </div>
          <span className={`text-[12px] font-semibold rounded-full px-2.5 py-1 ${toneTint[doc.health.tone]}`}>{doc.health.label}</span>
        </div>
      </div>
      {doc.sections.map((s, i) => <ReportSectionCard key={i} section={s} daily={doc.daily} />)}
    </div>
  );
}

function ReportGallery({
  recipes, selected, onPick, selectedPlatform, preview,
}: {
  recipes: RecipeMeta[]; selected: string; onPick: (id: string) => void;
  /** Platform of the account picked in the top bar (gates platform-specific recipes on live data). */
  selectedPlatform: Platform | null; preview: boolean;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      {recipes.map((r) => {
        const active = r.id === selected;
        // Preview mode swaps in a matching sample account server-side, so cards stay enabled.
        const mismatch = r.available && !preview && selectedPlatform !== null && !r.platforms.includes(selectedPlatform);
        const enabled = r.available && !mismatch;
        return (
          <button key={r.id} disabled={!enabled} onClick={() => enabled && onPick(r.id)}
            className={`text-left p-5 rounded-[14px] transition-colors ${
              active ? "bg-[#EEF0F3] ring-1 ring-[#DD5164]" : "bg-[#F6F7F9] hover:bg-[#EEF0F3]"
            } ${!enabled ? "opacity-60 cursor-not-allowed hover:bg-[#F6F7F9]" : ""}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[15px] font-bold text-[#1A202C] tracking-[-0.01em]">{r.name}</span>
              <span className="inline-flex items-center gap-1">
                {r.platforms.map((p) => <PlatformLogo key={p} platform={p} size={12} />)}
              </span>
              {!r.available && <span className="text-[10px] text-[#475569] bg-white border border-[#E2E8F0] rounded-full px-1.5 py-0.5 uppercase tracking-[0.1em]">{r.locked ?? "soon"}</span>}
              {mismatch && (
                <span className="text-[10px] text-[#475569] bg-white border border-[#E2E8F0] rounded-full px-1.5 py-0.5 uppercase tracking-[0.1em]">
                  {r.platforms[0] === "meta" ? "Meta only" : "Google only"}
                </span>
              )}
            </div>
            <p className="text-[13px] text-[#475569] leading-snug mt-1.5">{r.blurb}</p>
          </button>
        );
      })}
    </div>
  );
}

// ── Top bar ──────────────────────────────────────────────────────────────────

const RANGES = [{ label: "7D", days: 7 }, { label: "30D", days: 30 }, { label: "90D", days: 90 }];
type View = "account" | "portfolio" | "reports";

function TopBar({
  view, setView, accounts, accountId, setAccountId, days, setDays, range, refreshing, onRefresh, onGenerate, generating,
}: {
  view: View; setView: (v: View) => void; accounts: AccountRef[]; accountId: string | null; setAccountId: (id: string) => void;
  days: number; setDays: (d: number) => void; range: { since: string; until: string } | null;
  refreshing: boolean; onRefresh: () => void; onGenerate: () => void; generating: boolean;
}) {
  const selected = accounts.find((a) => a.id === accountId);
  const showPicker = view === "account" || view === "reports";
  return (
    <div className="flex flex-col gap-3 mb-5 sm:mb-6 lg:flex-row lg:items-center lg:justify-between no-print">
      <Segmented value={view} onChange={setView} options={[
        { value: "account", label: "Account View" },
        { value: "portfolio", label: "Portfolio View" },
        { value: "reports", label: "Reports" },
      ]} />

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
        {showPicker && (
          <div className="relative w-fit flex items-center gap-2 pl-3 pr-9 h-9 border border-[#E2E8F0] bg-white hover:bg-[#F1F5F9] transition-colors rounded-[6px]">
            {selected && <PlatformLogo platform={selected.platform} size={16} />}
            <select value={accountId ?? ""} onChange={(e) => setAccountId(e.target.value)}
              className="appearance-none bg-transparent min-w-[160px] text-[13px] font-medium text-[#1A202C] cursor-pointer focus:outline-none">
              {accounts.length === 0 && <option value="">Select Account</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name} · {a.platform === "meta" ? "Meta" : "Google"}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94A3B8] pointer-events-none" />
          </div>
        )}

        <div className="flex items-center gap-2 px-3 sm:px-4 h-9 border border-[#E2E8F0] bg-white rounded-[6px] w-fit">
          <Calendar className="w-4 h-4 text-[#475569] shrink-0" />
          <span className="text-[12px] sm:text-[13px] text-[#1A202C] truncate tnum">{range ? fmtRange(range.since, range.until) : "—"}</span>
        </div>

        <Segmented value={String(days)} onChange={(v) => setDays(Number(v))} size="sm"
          options={RANGES.map((r) => ({ value: String(r.days), label: r.label }))} />

        {view === "reports" ? (
          <button onClick={onGenerate} disabled={generating || (!accountId && accounts.length > 0)}
            className="inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-[6px] text-[13px] font-medium bg-[#DD5164] text-white hover:bg-[#C53A4E] transition-colors disabled:opacity-50 disabled:pointer-events-none">
            <Sparkles className="w-4 h-4" />{generating ? "Generating…" : "Generate"}
          </button>
        ) : (
          <button onClick={onRefresh} className="p-2.5 h-9 border border-[#E2E8F0] bg-white hover:bg-[#F1F5F9] rounded-[6px] flex items-center justify-center" aria-label="Refresh">
            <RefreshCw className={`w-4 h-4 text-[#475569] ${refreshing ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

export function App() {
  const [view, setView] = useState<View>("portfolio");
  const [accounts, setAccounts] = useState<AccountRef[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [portfolio, setPortfolio] = useState<PortfolioReport | null>(null);
  const [account, setAccount] = useState<AccountReport | null>(null);
  const [recipes, setRecipes] = useState<RecipeMeta[]>([]);
  const [recipe, setRecipe] = useState("account-audit");
  const [report, setReport] = useState<ReportDoc | null>(null);
  const [generating, setGenerating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const range = useMemo(() => {
    const until = new Date();
    const since = new Date(until);
    since.setDate(since.getDate() - (days - 1));
    const iso = (d: Date) => d.toISOString().split("T")[0];
    return { since: iso(since), until: iso(until) };
  }, [days]);
  const qs = `since=${range.since}&until=${range.until}`;

  const [previewAccounts, setPreviewAccounts] = useState(false);
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  const [needsSync, setNeedsSync] = useState(false);
  const [syncing, setSyncing] = useState(false);

  function loadState() {
    return fetch("/api/state").then((r) => r.json()).then((d) => {
      setFreshness(d.freshness ?? null);
      setNeedsSync(Boolean(d.needsSync));
    }).catch(() => {});
  }

  useEffect(() => { loadState(); }, []);

  // A sync is the only thing in this app that reads an ad platform, so it is an
  // explicit action rather than something a page view triggers.
  function runSyncNow() {
    setSyncing(true); setError(null);
    fetch("/api/sync", { method: "POST" })
      .then((r) => r.json())
      .then((d) => { if (d.error) setError(d.error); })
      .catch((e) => setError(String(e)))
      .finally(() => {
        setSyncing(false);
        loadState();
        setNonce((n) => n + 1);
      });
  }

  useEffect(() => {
    fetch("/api/accounts").then((r) => r.json()).then((data) => {
      const list: AccountRef[] = data.accounts ?? [];
      setAccounts(list);
      setPreviewAccounts(Boolean(data.preview));
      if (data.needsSync) setNeedsSync(true);
      setAccountId((cur) => cur ?? (list[0]?.id ?? null));
    }).catch(() => {});
    fetch("/api/reports").then((r) => r.json()).then((d) => setRecipes(d.recipes ?? [])).catch(() => {});
  }, []);

  // Switching to an account whose platform can't run the selected recipe falls
  // back to the cross-platform audit (live data only; preview swaps server-side).
  const selectedPlatform = accounts.find((a) => a.id === accountId)?.platform ?? null;
  useEffect(() => {
    if (previewAccounts || !selectedPlatform) return;
    const r = recipes.find((x) => x.id === recipe);
    if (r && !r.platforms.includes(selectedPlatform)) setRecipe("account-audit");
  }, [selectedPlatform, previewAccounts, recipes, recipe]);

  useEffect(() => {
    if (view !== "portfolio") return;
    setRefreshing(true); setError(null);
    fetch(`/api/portfolio?${qs}`).then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setPortfolio(d)))
      .catch((e) => setError(String(e))).finally(() => setRefreshing(false));
  }, [view, qs, nonce]);

  useEffect(() => {
    if (view !== "account" || !accountId) return;
    const acc = accounts.find((a) => a.id === accountId);
    const plat = acc ? `&platform=${acc.platform}` : "";
    setRefreshing(true); setError(null);
    fetch(`/api/account?account_id=${encodeURIComponent(accountId)}${plat}&${qs}`).then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setAccount(d)))
      .catch((e) => setError(String(e))).finally(() => setRefreshing(false));
  }, [view, accountId, qs, nonce, accounts]);

  useEffect(() => { setReport(null); }, [accountId, recipe, days]);

  function generate() {
    const acc = accounts.find((a) => a.id === accountId);
    const plat = acc ? `&platform=${acc.platform}` : "";
    setGenerating(true); setError(null);
    fetch(`/api/report?recipe=${recipe}&account_id=${encodeURIComponent(accountId ?? "")}${plat}&${qs}`).then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setReport(d)))
      .catch((e) => setError(String(e))).finally(() => setGenerating(false));
  }

  const preview = (view === "portfolio" ? portfolio?.preview : view === "account" ? account?.preview : report?.preview) ?? false;
  const currency = account?.account.currency ?? "USD";

  return (
    <div className="min-h-screen bg-white">
      <div className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 py-5 sm:py-6 w-full">
        <TopBar
          view={view} setView={setView} accounts={accounts} accountId={accountId} setAccountId={setAccountId}
          days={days} setDays={setDays} range={range} refreshing={refreshing} onRefresh={() => setNonce((n) => n + 1)}
          onGenerate={generate} generating={generating}
        />

        {!previewAccounts && (
          <SyncBar freshness={freshness} needsSync={needsSync} syncing={syncing} onSync={runSyncNow} />
        )}

        {error && (
          <div className="px-4 py-3 rounded-[6px] border border-[#FECACA] bg-[#FEF2F2] text-[13px] text-[#B91C1C] mb-4 no-print">{error}</div>
        )}

        {/* ── Portfolio View ── */}
        {view === "portfolio" && portfolio && (
          <div className="space-y-4 sm:space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <KpiCard left={{ label: "Total Spend", value: money(portfolio.totals.spend) }} right={{ label: "ROAS", value: x(portfolio.totals.roas) }} />
              <KpiCard left={{ label: "Conversions", value: num(portfolio.totals.conversions) }} right={{ label: "CPA", value: money(portfolio.totals.cpa) }} />
              <KpiCard left={{ label: "Clicks", value: num(portfolio.totals.clicks) }} right={{ label: "CTR", value: pct(portfolio.totals.ctr) }} />
            </div>
            {preview && <PreviewBanner />}
            <PortfolioTable accounts={portfolio.accounts} />
            <TopIssues items={portfolio.topIssues} title="Top Issues to Fix (3 Lowest-ROAS Accounts)" />
          </div>
        )}

        {/* ── Account View ── */}
        {view === "account" && account && (
          <div className="space-y-5 sm:space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <KpiCard left={{ label: "Cost", value: money(account.kpis.cost.value, currency), delta: account.kpis.cost }} right={{ label: "ROAS", value: x(account.kpis.roas.value), delta: account.kpis.roas }} />
              <KpiCard left={{ label: "Conversions", value: num(account.kpis.conversions.value), delta: account.kpis.conversions }} right={{ label: "Conv. Rate", value: pct(account.kpis.convRate.value), delta: account.kpis.convRate }} />
              <KpiCard left={{ label: "Clicks", value: num(account.kpis.clicks.value), delta: account.kpis.clicks }} right={{ label: "CTR", value: pct(account.kpis.ctr.value), delta: account.kpis.ctr }} />
            </div>
            {preview && <PreviewBanner />}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
              <ComboChart data={account.daily} barKey="spend" lineKey="roas" barLabel="Cost" lineLabel="ROAS" />
              <ComboChart data={account.daily} barKey="conversions" lineKey="convRate" barLabel="Conversions" lineLabel="Conv. Rate" />
              <ComboChart data={account.daily} barKey="clicks" lineKey="ctr" barLabel="Clicks" lineLabel="CTR" />
            </div>
            <ChannelTable channels={account.channels} />
            <TopIssues
              items={[{ account: { ...account.account, metrics: account.channels[0]?.metrics ?? ({} as Metrics), prev: null }, issues: account.issues }].filter((i) => i.issues.length > 0)}
              title="Top Issues to Fix"
            />
          </div>
        )}

        {/* ── Reports View (Phase 2) ── */}
        {view === "reports" && (
          <div className="space-y-5 sm:space-y-6">
            <div className="no-print">
              <ReportGallery recipes={recipes} selected={recipe} onPick={setRecipe} selectedPlatform={selectedPlatform} preview={previewAccounts} />
            </div>
            {report ? (
              <>
                <div className="no-print flex items-center justify-between gap-3">
                  <span className="text-[12px] text-[#475569]">
                    {report.ai ? "Analysis by AI" : "Rule-based analysis"}
                    {report.reusedData && (
                      <span className="ml-2 text-[#92400E]" title={report.dataNote}>· reused recent data</span>
                    )}
                  </span>
                  <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-[6px] text-[13px] font-medium bg-white border border-[#E2E8F0] text-[#1A202C] hover:bg-[#F1F5F9] transition-colors">
                    <Download className="w-4 h-4" />Download PDF
                  </button>
                </div>
                <ReportDocView doc={report} />
              </>
            ) : (
              <div className="no-print py-20 text-center text-[13px] text-[#94A3B8]">
                Pick a report and an account, then press Generate.
              </div>
            )}
          </div>
        )}

        {!portfolio && !account && view !== "reports" && !error && <div className="py-24 text-center text-[13px] text-[#94A3B8]">Loading…</div>}

        <footer className="mt-8 sm:mt-12 pt-4 sm:pt-6 border-t border-[#E2E8F0] no-print">
          <div className="flex items-center justify-end gap-6 text-[13px] text-[#475569]">
            <span>OpenAdsReport</span>
            <span className="font-mono text-[11px]">API: /api/portfolio · /api/account · /api/report</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
