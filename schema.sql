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
