import { outsideWhere } from "../domain/tenant";

/**
 * Daily totals of outside teams' activity (src/domain/tenant.ts outsideWhere), kept after the 30-day activity
 * records are deleted: teams created, packets sent, packets read, and users_7d, the distinct identities that
 * read a packet in the 7 days ending that day.
 */
export type Metric = "joins" | "sends" | "reads" | "users_7d";

const DAY = 86_400_000;
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Writes the totals the activity records still allow. Each run recomputes the last 3 days and fills any day of
 * the last 30 that has no total yet; users_7d only for days whose 7 days of reads are all still kept. Returns
 * the number of totals written.
 */
export async function rollUpDailyTotals(db: D1Database, now: number = Date.now()): Promise<number> {
  const days = Array.from({ length: 30 }, (_, i) => dayOf(now - (29 - i) * DAY));
  const first = days[0]!;
  const recent = new Set(days.slice(-3));
  const out = outsideWhere("subject");
  const perDay = async (what: string): Promise<Map<string, number>> =>
    new Map(
      (
        await db
          .prepare(`SELECT substr(ts, 1, 10) AS d, COUNT(*) AS n FROM events WHERE ${what} AND ts >= ? AND ${out} GROUP BY d`)
          .bind(first)
          .all<{ d: string; n: number }>()
      ).results.map((r) => [r.d, r.n]),
    );
  const joins = await perDay("kind = 'console' AND name = 'join' AND outcome = 'ok'");
  const sends = await perDay("kind = 'tool' AND name = 'threadpacket_send' AND outcome = 'ok'");
  const reads = await perDay("kind = 'tool' AND name = 'threadpacket_read' AND outcome = 'ok'");
  const readers = (
    await db
      .prepare(`SELECT DISTINCT substr(ts, 1, 10) AS d, subject FROM events WHERE kind = 'tool' AND name = 'threadpacket_read' AND outcome = 'ok' AND ts >= ? AND ${out}`)
      .bind(first)
      .all<{ d: string; subject: string }>()
  ).results;
  const have = new Set(
    (await db.prepare("SELECT day, metric FROM daily_totals WHERE day >= ?").bind(first).all<{ day: string; metric: string }>()).results.map((r) => `${r.day} ${r.metric}`),
  );

  const upsert = db.prepare("INSERT INTO daily_totals (day, metric, n) VALUES (?, ?, ?) ON CONFLICT(day, metric) DO UPDATE SET n = excluded.n");
  const writes: D1PreparedStatement[] = [];
  const put = (day: string, metric: Metric, n: number) => {
    if (recent.has(day) || !have.has(`${day} ${metric}`)) writes.push(upsert.bind(day, metric, n));
  };
  days.forEach((day, i) => {
    put(day, "joins", joins.get(day) ?? 0);
    put(day, "sends", sends.get(day) ?? 0);
    put(day, "reads", reads.get(day) ?? 0);
    if (i >= 6) {
      const from = days[i - 6]!;
      put(day, "users_7d", new Set(readers.filter((r) => r.d >= from && r.d <= day).map((r) => r.subject)).size);
    }
  });
  if (writes.length) await db.batch(writes);
  return writes.length;
}
