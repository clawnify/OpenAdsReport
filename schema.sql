-- OpenAdsReport — canonical schema. The warehouse.
--
-- Ad platforms are read on a schedule into `ad_daily`, and every dashboard
-- answer is computed from those rows rather than from a live API call. Writes
-- (pausing a campaign, changing a budget) still go straight to the platform
-- API — it is only reads that come from here.
--
-- The grain is one row per account per day, which is the grain both platforms
-- report natively (Meta `time_increment=1`, Google `segments.date`). Any range
-- the UI or an agent asks for is a SUM over these rows, and metrics.ts
-- recomputes every derived field (ROAS, CPA, CTR, conversion rate) from the
-- summed totals — so a range total read from the warehouse is arithmetically
-- identical to the one the API would have returned for that window.
--
-- Only the trailing window is ever re-fetched. Meta documents that insights
-- refresh every ~15 minutes and "do not change after 28 days of being
-- reported", so rows older than that are settled and re-reading them spends
-- quota to rewrite identical numbers.
--
-- Nothing here grows without bound. Each sync prunes `ad_daily` past the
-- retention window (two years by default, ADS_RETENTION_DAYS to change it),
-- trims `sync_runs` to the last 90 days, and drops every row belonging to a
-- platform that has stayed disconnected for three consecutive daily runs —
-- disconnecting an integration takes the data pulled under it with it.

CREATE TABLE IF NOT EXISTS ad_accounts (
  id         TEXT NOT NULL,                        -- platform account id, in the platform's own form
  platform   TEXT NOT NULL,                        -- 'meta' | 'google'
  name       TEXT NOT NULL DEFAULT '',
  currency   TEXT NOT NULL DEFAULT 'USD',
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, id)
);

CREATE TABLE IF NOT EXISTS ad_daily (
  platform    TEXT    NOT NULL,
  account_id  TEXT    NOT NULL,
  date        TEXT    NOT NULL,                    -- YYYY-MM-DD
  spend       REAL    NOT NULL DEFAULT 0,
  revenue     REAL    NOT NULL DEFAULT 0,
  conversions REAL    NOT NULL DEFAULT 0,          -- fractional: platforms report partial conversions
  clicks      INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  synced_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, account_id, date)
);

CREATE INDEX IF NOT EXISTS idx_ad_daily_date ON ad_daily (date);

-- Append-only log of sync attempts. This is what lets /api/state answer "how
-- fresh is this?" honestly instead of implying the numbers are live.
CREATE TABLE IF NOT EXISTS sync_runs (
  id           TEXT PRIMARY KEY,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running',    -- running | ok | partial | failed
  accounts     INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  api_calls    INTEGER NOT NULL DEFAULT 0,         -- platform reads this run actually spent
  error        TEXT
);

-- The one booked sync.
--
-- Each run books its successor on the platform queue, and that chain is the
-- whole scheduler. This row is what lets the request path see the chain: a
-- booking whose time has passed with no fresh run behind it means the chain
-- broke (a worker exception before the booking, a delivery that exhausted its
-- attempts, a queue outage), and /api/state re-books it. Without the row the
-- app could not tell "scheduled for tomorrow" from "nothing will ever run".
CREATE TABLE IF NOT EXISTS sync_schedule (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  job_id    TEXT NOT NULL,
  run_at    TEXT NOT NULL,                         -- ISO-8601 UTC
  booked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every live read of an ad platform, and what it returned.
--
-- The dashboard is served entirely from `ad_daily`, but report recipes still
-- need per-entity grains the daily table does not hold (search terms, per-ad
-- fatigue, account configuration), so those are fetched live. This table is
-- what keeps "live" from meaning "unbounded": it is a budget, a cooldown, and
-- the throttle signal we cannot otherwise see.
--
-- That last part matters. Ad platforms publish their rate-limit state in
-- response headers, but a connection resolves to `{ data, error, successful }`
-- with no headers attached, so the app cannot read the gauge. Recent failures
-- recorded here are the substitute: they are the only evidence available that a
-- platform is unhappy, and both platforms are explicit that the correct
-- response to being limited is to stop calling rather than to retry.
--
-- `payload` caches what a read returned, so a repeat within the cooldown is
-- answered from here rather than by spending the quota again.
CREATE TABLE IF NOT EXISTS platform_reads (
  id         TEXT    PRIMARY KEY,
  platform   TEXT    NOT NULL,                     -- 'meta' | 'google' | 'google_analytics'
  account_id TEXT    NOT NULL DEFAULT '',          -- '' for account-independent reads
  kind       TEXT    NOT NULL,                     -- 'sync' | a recipe id
  at         TEXT    NOT NULL DEFAULT (datetime('now')),
  calls      INTEGER NOT NULL DEFAULT 0,           -- platform operations this read spent
  outcome    TEXT    NOT NULL,                     -- 'ok' | 'failed'
  detail     TEXT,
  payload    TEXT                                  -- JSON result, when small enough to reuse
);

CREATE INDEX IF NOT EXISTS idx_platform_reads_lookup ON platform_reads (platform, account_id, kind, at);
CREATE INDEX IF NOT EXISTS idx_platform_reads_platform ON platform_reads (platform, at);
