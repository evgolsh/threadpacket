-- Page views of the control center's public pages, counted per day: no row per visit, and no cookie, IP
-- address or identifier. source is the referring site's host, a ?ref= tag, "self" (this site) or "" (none).
CREATE TABLE IF NOT EXISTS page_views (
  day     TEXT NOT NULL,
  path    TEXT NOT NULL,
  source  TEXT NOT NULL,
  country TEXT NOT NULL,
  n       INTEGER NOT NULL,
  PRIMARY KEY (day, path, source, country)
);

-- Daily totals of outside teams' activity, kept after the 30-day activity records are deleted. Counts only.
CREATE TABLE IF NOT EXISTS daily_totals (
  day    TEXT NOT NULL,
  metric TEXT NOT NULL,
  n      INTEGER NOT NULL,
  PRIMARY KEY (day, metric)
);

-- A team the operator marks internal is left out of the outside counts.
ALTER TABLE tenants ADD COLUMN internal INTEGER NOT NULL DEFAULT 0;
