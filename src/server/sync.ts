// The only place this app reads an ad platform.
//
// Every dashboard number is served from `ad_daily` (see warehouse.ts); this
// module is what puts rows there. It runs on a schedule rather than on the
// request path, which is the whole architecture in one sentence: reads come
// from the warehouse, writes go straight to the platform API.
//
// Why a trailing window instead of re-reading everything: Meta documents that
// insights refresh roughly every 15 minutes and "do not change after 28 days of
// being reported". Re-reading a settled window spends quota to rewrite numbers
// that cannot have changed. That waste is the mechanism behind ads-API access
// getting throttled or pulled, and avoiding it is the point of this file.
//
// The quota being spent is not ours alone, either: both integrations execute
// through the credentials broker's maintainer, so the rate-limit pool is shared
// and the platform's own utilization headers never reach us. We cannot watch
// the gauge, so we keep the call count structurally low instead.

import { get, run } from "@clawnify/db";
import type { AdProvider, DailyPoint } from "./providers/types";
import { connectedProviders } from "./providers";
import type { Bindings } from "./env";
import { platformAllowed, recordRead } from "./budget";

/** Days after which platform data is settled and never re-read. */
const SETTLE_DAYS = 28;

/** How far back the first sync reaches, to give charts history on day one. */
const BACKFILL_DAYS = 90;

/**
 * Days per platform call. A daily series comes back as one page of rows, and a
 * page can be smaller than the window asked for, silently truncating a long
 * range. Chunking well under any page size keeps the series complete; two calls
 * per account per *day* is still far below the per-*request* fan-out this
 * replaces.
 */
const CHUNK_DAYS = 14;

/** Rows per INSERT. D1 caps bound parameters per statement; 8 columns x 10 rows stays clear of it. */
const ROWS_PER_INSERT = 10;

const iso = (d: Date) => d.toISOString().split("T")[0];

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return iso(d);
}

/** Inclusive [since, until] windows of at most CHUNK_DAYS days, oldest first. */
function windows(since: string, until: string): { since: string; until: string }[] {
  const out: { since: string; until: string }[] = [];
  const end = new Date(until + "T00:00:00Z");
  let cursor = new Date(since + "T00:00:00Z");
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + CHUNK_DAYS - 1);
    out.push({ since: iso(cursor), until: iso(chunkEnd > end ? end : chunkEnd) });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Run one platform read, book it against the budget, and never retry it.
 *
 * Not retrying is the deliberate part. We cannot tell a rate-limit rejection
 * from any other failure — a connection resolves to `{ data, error, successful }`
 * with the response headers dropped — and both platforms treat a rejected
 * request as spent quota, while Meta is explicit that continuing to call a
 * limited endpoint lengthens the limit. So a failure is recorded and left
 * alone.
 *
 * Nothing is lost by that. Every run re-reads the whole trailing window
 * (SETTLE_DAYS), so a window missed today is picked up by tomorrow's run at no
 * extra cost. The trailing window is the retry, and it waits hours rather than
 * seconds.
 */
async function read<T>(
  label: string,
  key: { platform: string; accountId?: string },
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const data = await fn();
    await recordRead({ ...key, kind: "sync" }, { calls: 1, outcome: "ok" });
    return data;
  } catch (err: any) {
    await recordRead({ ...key, kind: "sync" }, {
      calls: 1,
      outcome: "failed",
      detail: err?.message ?? String(err),
    });
    throw new Error(`${label}: ${err?.message ?? String(err)}`);
  }
}

/**
 * How long a run may sit in `running` before it is presumed dead.
 *
 * A worker that dies mid-sync never writes its finishing row, so without an
 * upper bound one crash would block every future sync permanently. A run that
 * has outlived this is treated as gone, not as in progress.
 */
const STALE_RUN_MINUTES = 30;

/**
 * A sync already running, or one started within the last few minutes.
 *
 * Repeated "Sync now" clicks must not each start their own pull: that puts read
 * volume back on the user's click rate, which is what syncing on a schedule
 * exists to prevent.
 */
export async function syncInFlight(minIntervalMinutes = 5): Promise<{ id: string; startedAt: string } | null> {
  const row = await get<{ id: string; started_at: string; status: string }>(
    `SELECT id, started_at, status FROM sync_runs
      WHERE (status = 'running' AND started_at >= datetime('now', ?))
         OR started_at >= datetime('now', ?)
      ORDER BY started_at DESC LIMIT 1`,
    [`-${STALE_RUN_MINUTES} minutes`, `-${minIntervalMinutes} minutes`],
  );
  return row ? { id: row.id, startedAt: row.started_at } : null;
}

async function upsertDaily(platform: string, accountId: string, points: DailyPoint[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < points.length; i += ROWS_PER_INSERT) {
    const batch = points.slice(i, i + ROWS_PER_INSERT);
    const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))").join(", ");
    const params = batch.flatMap((p) => [
      platform, accountId, p.date, p.spend, p.revenue, p.conversions, p.clicks, p.impressions,
    ]);
    await run(
      `INSERT INTO ad_daily
         (platform, account_id, date, spend, revenue, conversions, clicks, impressions, synced_at)
       VALUES ${values}
       ON CONFLICT (platform, account_id, date) DO UPDATE SET
         spend = excluded.spend,
         revenue = excluded.revenue,
         conversions = excluded.conversions,
         clicks = excluded.clicks,
         impressions = excluded.impressions,
         synced_at = excluded.synced_at`,
      params,
    );
    written += batch.length;
  }
  return written;
}

export interface SyncResult {
  id: string;
  status: "ok" | "partial" | "failed";
  accounts: number;
  rowsWritten: number;
  apiCalls: number;
  since: string;
  until: string;
  errors: string[];
}

/**
 * Pull the trailing window for every account on every connected platform.
 *
 * Cost is O(accounts) platform calls per run, independent of how many people or
 * agents look at the dashboard in between — which is the property the live read
 * path did not have.
 */
export async function runSync(env: Bindings, opts: { full?: boolean } = {}): Promise<SyncResult> {
  const id = crypto.randomUUID();
  const until = iso(new Date());
  const since = daysAgo(opts.full ? BACKFILL_DAYS : SETTLE_DAYS);
  const errors: string[] = [];
  let accounts = 0;
  let rowsWritten = 0;
  let apiCalls = 0;

  await run("INSERT INTO sync_runs (id, status) VALUES (?, 'running')", [id]);

  try {
    const providers = await connectedProviders(env);
    if (providers.length === 0) throw new Error("No ad platform is connected.");

    for (const provider of providers) {
      // Skip a platform that is rate-limiting us or out of daily allowance,
      // rather than spending calls discovering that one at a time.
      const gate = await platformAllowed(provider.id);
      if (!gate.ok) {
        errors.push(`${provider.id}: ${gate.reason}`);
        continue;
      }

      let refs;
      try {
        refs = await read(`${provider.id}.listAccounts`, { platform: provider.id }, () =>
          provider.listAccounts(),
        );
        apiCalls++;
      } catch (err: any) {
        errors.push(err.message);
        continue;
      }

      // Set when the platform starts rejecting us mid-run: stop the whole
      // platform, not just the account we happened to be on.
      let halted = false;

      for (const ref of refs) {
        if (halted) break;
        accounts++;
        await run(
          `INSERT INTO ad_accounts (id, platform, name, currency, first_seen, last_seen)
           VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT (platform, id) DO UPDATE SET
             name = excluded.name, currency = excluded.currency, last_seen = excluded.last_seen`,
          [ref.id, ref.platform, ref.name, ref.currency],
        );

        for (const w of windows(since, until)) {
          try {
            const points = await read(
              `${provider.id}.dailySeries(${ref.id} ${w.since}..${w.until})`,
              { platform: provider.id, accountId: ref.id },
              () => (provider as AdProvider).dailySeries(ref.id, w.since, w.until),
            );
            apiCalls++;
            rowsWritten += await upsertDaily(ref.platform, ref.id, points);
          } catch (err: any) {
            errors.push(err.message);
            // A platform that just started rejecting us is left alone for the
            // rest of the run, rather than being asked once per remaining
            // window and once per remaining account.
            if (!(await platformAllowed(provider.id)).ok) {
              halted = true;
              break;
            }
          }
        }
      }
    }

    // The budget only ever looks at today's calls and the last half hour of
    // failures, so older rows are dead weight. Pruned here rather than left to
    // grow: this table is written on every platform call.
    await run("DELETE FROM platform_reads WHERE at < datetime('now', '-30 days')");

    const status: SyncResult["status"] =
      errors.length === 0 ? "ok" : rowsWritten > 0 ? "partial" : "failed";
    await run(
      `UPDATE sync_runs SET finished_at = datetime('now'), status = ?, accounts = ?,
              rows_written = ?, api_calls = ?, error = ? WHERE id = ?`,
      [status, accounts, rowsWritten, apiCalls, errors.length ? errors.slice(0, 5).join(" | ") : null, id],
    );
    return { id, status, accounts, rowsWritten, apiCalls, since, until, errors };
  } catch (err: any) {
    await run(
      `UPDATE sync_runs SET finished_at = datetime('now'), status = 'failed', error = ? WHERE id = ?`,
      [err.message, id],
    );
    return { id, status: "failed", accounts, rowsWritten, apiCalls, since, until, errors: [err.message] };
  }
}

// ── Scheduling ──────────────────────────────────────────────────────────────
//
// The platform queue is the scheduler: each run books the next one, so the
// cadence survives redeploys without any cron config in the template. That
// chain has two ways to break — nothing ever starts it on a fresh deployment,
// and anything that stops a run reaching its booking (a worker exception, a
// delivery that exhausted its attempts, a queue outage) ends it silently. Both
// are covered by keeping the booking in `sync_schedule` and letting the request
// path act as the watchdog: /api/state re-books whenever the booking is overdue
// and its job is no longer alive, and books the very first run the moment a
// platform is connected.

/** Hour (UTC) the daily sync runs. Early enough for most of yesterday to be settled. */
const SYNC_HOUR_UTC = 6;

/**
 * How late a booking may run before the watchdog asks the queue whether the
 * job is still alive. The queue sweeps every minute and a job that is being
 * retried is still "pending" with its run time pushed out by back-off, so
 * anything later than this is worth one round-trip to check.
 */
const OVERDUE_GRACE_MS = 15 * 60 * 1000;

interface Booking {
  jobId: string;
  runAt: string;
}

export async function currentBooking(): Promise<Booking | null> {
  const row = await get<{ job_id: string; run_at: string }>(
    "SELECT job_id, run_at FROM sync_schedule WHERE id = 1",
  );
  return row ? { jobId: row.job_id, runAt: row.run_at } : null;
}

/** The next daily slot: tomorrow at SYNC_HOUR_UTC. */
function nextSlot(): Date {
  const next = new Date();
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(SYNC_HOUR_UTC, 0, 0, 0);
  return next;
}

/**
 * Book a sync at `runAt` and record it.
 *
 * The idempotency key is this app's host plus the target minute, so two
 * requests that both notice the same gap (two tabs loading at once, a retried
 * delivery) collapse to one job rather than doubling the platform reads, while
 * a recovery booked later gets a new key and is not swallowed by a job that
 * already ran or failed. The host is in the key because the queue dedupes per
 * org: two instances of this app in one org must not share a booking.
 *
 * `origin` is the app's own base URL, taken from the incoming request so the
 * template carries no hardcoded slug.
 */
async function bookSync(env: Bindings, origin: string, runAt: Date): Promise<Booking | null> {
  try {
    const { enqueueJob } = await import("@clawnify/queue");
    const job = await enqueueJob(env, {
      targetUrl: `${origin}/api/sync`,
      runAt,
      idempotencyKey: `ads-sync-${new URL(origin).host}-${runAt.toISOString().slice(0, 16)}`,
      maxAttempts: 3,
    });
    const booking = { jobId: job.id, runAt: runAt.toISOString() };
    await run(
      `INSERT INTO sync_schedule (id, job_id, run_at, booked_at) VALUES (1, ?, ?, datetime('now'))
       ON CONFLICT (id) DO UPDATE SET job_id = excluded.job_id, run_at = excluded.run_at, booked_at = excluded.booked_at`,
      [booking.jobId, booking.runAt],
    );
    return booking;
  } catch {
    // A missing or unavailable queue must not fail the request that noticed
    // the gap; the next request will try again.
    return null;
  }
}

/** Whether the queue still intends to deliver a job. Unknown counts as no. */
async function jobAlive(env: Bindings, jobId: string): Promise<boolean> {
  try {
    const { getJob } = await import("@clawnify/queue");
    const job = await getJob(env, jobId);
    return job.status === "pending" || job.status === "queued";
  } catch {
    return false;
  }
}

/**
 * Make sure a sync is booked, and book one if not.
 *
 *   afterRun   — called at the end of every sync, whatever its outcome. The
 *                booking that has just come due is the run we are in (or a
 *                dead one), so the next daily slot is booked. Independent of
 *                the sync succeeding: a failed run still books its successor.
 *   watchdog   — called from the request path once a platform is connected.
 *                Nothing booked means the chain never started (a fresh
 *                deployment), so the first run is booked immediately; a
 *                booking overdue by more than the grace whose job the queue no
 *                longer holds means the chain broke, and a run is booked
 *                immediately to close the gap.
 *
 * Costs one D1 read on the healthy path; the queue is only asked when
 * something looks wrong.
 */
export async function ensureScheduled(
  env: Bindings,
  origin: string,
  opts: { afterRun?: boolean } = {},
): Promise<Booking | null> {
  if (!env.CLAWNIFY_TOKEN) return null;
  const booking = await currentBooking();
  const now = Date.now();

  if (booking && Date.parse(booking.runAt) > now) return booking;
  if (opts.afterRun) return bookSync(env, origin, nextSlot());

  if (booking) {
    const overdueBy = now - Date.parse(booking.runAt);
    if (overdueBy < OVERDUE_GRACE_MS) return booking;
    if (await jobAlive(env, booking.jobId)) return booking;
  }
  return bookSync(env, origin, new Date());
}
