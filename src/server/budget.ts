// The read budget: every live platform call in this app goes through here.
//
// The dashboard reads the warehouse, so it costs nothing. Report recipes still
// read the platform live, because they need per-entity grains `ad_daily` does
// not hold. This module is what stops "live" from meaning "as many times as
// anyone asks".
//
// Three limits, in the order they are checked:
//
//   1. Back-off  — recent failures on a platform mean stop calling it. Both
//                  platforms bill failed requests and Meta is explicit that
//                  continuing to call while limited lengthens the limit, so a
//                  failure is a reason to wait, never a reason to retry.
//   2. Daily cap — a ceiling on operations per platform per UTC day, so no
//                  caller can drain a shared daily quota in an afternoon.
//   3. Cooldown  — one live read per account per recipe per hour. A repeat
//                  inside the window is answered from the cached payload
//                  instead of the platform.
//
// The back-off deserves a note on why it exists in this form. Platforms publish
// their rate-limit state in response headers, but a connection resolves to
// `{ data, error, successful }` with the headers dropped, so the app cannot
// read the gauge directly. Our own recent failures are the only signal left.

import { get, query, run } from "@clawnify/db";

/** One live read per account per recipe per hour; repeats inside it are served from `payload`. */
const COOLDOWN_MINUTES = 60;

/** How long a platform is left alone after it starts failing. */
const BACKOFF_MINUTES = 30;

/** Consecutive failures that trigger the back-off. */
const BACKOFF_AFTER_FAILURES = 3;

/**
 * Operations per platform per UTC day.
 *
 * Ceiling: deliberately conservative, because the daily quota it protects is
 * not necessarily this app's alone to spend. Raise it only alongside a
 * confirmed quota headroom.
 */
const DAILY_CALL_CAP = 500;

/** Largest cached payload. Above this the read still counts, it just is not reusable. */
const MAX_PAYLOAD_BYTES = 256 * 1024;

export type ReadOutcome = "ok" | "failed";

export interface ReadKey {
  platform: string;
  /** '' for reads that are not account-scoped. */
  accountId?: string;
  /** 'sync', or the recipe id. */
  kind: string;
}

export type BudgetVerdict =
  /** Go ahead and call the platform. */
  | { allow: true; cached: null }
  /** Do not call: an equivalent read is recent enough to reuse. */
  | { allow: false; cached: unknown; reason: string; retryAfterSeconds: number }
  /** Do not call, and nothing to serve instead. */
  | { allow: false; cached: null; reason: string; retryAfterSeconds: number };

const minutesAgo = (n: number) => `-${n} minutes`;

/**
 * Whether a live read may happen, and what to serve instead when it may not.
 *
 * Callers that get `allow: false` with a `cached` value should return it as a
 * normal success — the point of the cooldown is to answer the question without
 * spending the quota, not to fail.
 */
export type PlatformGate = { ok: true } | { ok: false; reason: string; retryAfterSeconds: number };

/**
 * The two limits that apply to *every* read of a platform, scheduled or not:
 * is it currently rejecting us, and is its daily allowance spent.
 *
 * The sync uses this on its own. It deliberately excludes the per-account
 * cooldown, which is a recipe concept — a sync legitimately reads every account
 * once per run.
 */
export async function platformAllowed(platform: string): Promise<PlatformGate> {
  // Is this platform currently failing? A recent run of failures is the only
  // throttle signal available, since response headers do not reach the app.
  const recent = await get<{ failures: number }>(
    `SELECT SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failures
       FROM platform_reads
      WHERE platform = ? AND at >= datetime('now', ?)`,
    [platform, minutesAgo(BACKOFF_MINUTES)],
  );
  if (Number(recent?.failures ?? 0) >= BACKOFF_AFTER_FAILURES) {
    return {
      ok: false,
      reason:
        `${platform} has rejected the last several requests, so reads are paused for ` +
        `${BACKOFF_MINUTES} minutes. Calling a limited platform makes the limit last longer.`,
      retryAfterSeconds: BACKOFF_MINUTES * 60,
    };
  }

  // Has this platform's daily allowance already been spent?
  const today = await get<{ calls: number }>(
    `SELECT COALESCE(SUM(calls), 0) AS calls FROM platform_reads
      WHERE platform = ? AND date(at) = date('now')`,
    [platform],
  );
  if (Number(today?.calls ?? 0) >= DAILY_CALL_CAP) {
    return {
      ok: false,
      reason: `The daily ${platform} read allowance is spent. It resets at 00:00 UTC.`,
      retryAfterSeconds: secondsUntilUtcMidnight(),
    };
  }

  return { ok: true };
}

export async function checkBudget(key: ReadKey): Promise<BudgetVerdict> {
  const accountId = key.accountId ?? "";

  const gate = await platformAllowed(key.platform);
  if (!gate.ok) {
    return { allow: false, cached: null, reason: gate.reason, retryAfterSeconds: gate.retryAfterSeconds };
  }

  // Did we already ask this exact question recently?
  const last = await get<{ at: string; payload: string | null; age: number }>(
    `SELECT at, payload,
            (julianday('now') - julianday(at)) * 1440 AS age
       FROM platform_reads
      WHERE platform = ? AND account_id = ? AND kind = ? AND outcome = 'ok'
        AND at >= datetime('now', ?)
      ORDER BY at DESC LIMIT 1`,
    [key.platform, accountId, key.kind, minutesAgo(COOLDOWN_MINUTES)],
  );
  if (last) {
    const retryAfterSeconds = Math.max(
      60,
      Math.ceil((COOLDOWN_MINUTES - Number(last.age ?? 0)) * 60),
    );
    let cached: unknown = null;
    if (last.payload) {
      try {
        cached = JSON.parse(last.payload);
      } catch {
        cached = null;
      }
    }
    return {
      allow: false,
      cached,
      reason: cached
        ? `Reusing the data pulled at ${last.at} UTC. Live reads are limited to one per hour per account.`
        : `This was pulled at ${last.at} UTC. Live reads are limited to one per hour per account.`,
      retryAfterSeconds,
    } as BudgetVerdict;
  }

  return { allow: true, cached: null };
}

/**
 * Book a completed read against the budget.
 *
 * Always record, including failures — a failure that goes unrecorded is a
 * failure the back-off cannot see.
 */
export async function recordRead(
  key: ReadKey,
  opts: { calls: number; outcome: ReadOutcome; detail?: string; payload?: unknown },
): Promise<void> {
  let payload: string | null = null;
  if (opts.outcome === "ok" && opts.payload !== undefined) {
    try {
      const json = JSON.stringify(opts.payload);
      if (json && json.length <= MAX_PAYLOAD_BYTES) payload = json;
    } catch {
      payload = null;
    }
  }
  await run(
    `INSERT INTO platform_reads (id, platform, account_id, kind, calls, outcome, detail, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      key.platform,
      key.accountId ?? "",
      key.kind,
      opts.calls,
      opts.outcome,
      opts.detail?.slice(0, 500) ?? null,
      payload,
    ],
  );
}

/**
 * Run a live platform read under the budget: check, call, record.
 *
 * `calls` is how many platform operations `fn` costs, which the caller knows
 * and this module cannot infer.
 */
export async function guardedRead<T>(
  key: ReadKey,
  calls: number,
  fn: () => Promise<T>,
): Promise<{ data: T; fresh: boolean; note?: string }> {
  const verdict = await checkBudget(key);
  if (!verdict.allow) {
    if (verdict.cached !== null) {
      return { data: verdict.cached as T, fresh: false, note: verdict.reason };
    }
    throw new BudgetExceeded(verdict.reason, verdict.retryAfterSeconds);
  }

  try {
    const data = await fn();
    await recordRead(key, { calls, outcome: "ok", payload: data });
    return { data, fresh: true };
  } catch (err: any) {
    // Recorded, not retried. The platforms bill rejected requests, and calling
    // one that is already limiting us extends the limit.
    await recordRead(key, { calls, outcome: "failed", detail: err?.message ?? String(err) });
    throw err;
  }
}

export class BudgetExceeded extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "BudgetExceeded";
  }
}

function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.ceil((midnight.getTime() - now.getTime()) / 1000);
}

/** What /api/state reports about the budget, so the UI can explain a refusal before it happens. */
export async function budgetStatus(): Promise<
  { platform: string; callsToday: number; dailyCap: number; pausedUntilMinutes: number | null }[]
> {
  const rows = await query<{ platform: string; calls: number; failures: number }>(
    `SELECT platform,
            COALESCE(SUM(CASE WHEN date(at) = date('now') THEN calls ELSE 0 END), 0) AS calls,
            SUM(CASE WHEN outcome = 'failed' AND at >= datetime('now', ?) THEN 1 ELSE 0 END) AS failures
       FROM platform_reads
      GROUP BY platform`,
    [minutesAgo(BACKOFF_MINUTES)],
  );
  return rows.map((r) => ({
    platform: r.platform,
    callsToday: Number(r.calls ?? 0),
    dailyCap: DAILY_CALL_CAP,
    pausedUntilMinutes:
      Number(r.failures ?? 0) >= BACKOFF_AFTER_FAILURES ? BACKOFF_MINUTES : null,
  }));
}
