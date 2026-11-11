import { PROCESSED_EVENT_LIMIT, readOne, write } from "./slack_channel_map.mjs";

// What a delivery's sends leave behind, so a retry (or a daemon that died mid-post) knows an
// earlier try may already be in Slack, and where. `targets` lists every place a try posted or
// may have posted: { channelId, threadTs (or null), note? }. A retry looks in each of them for
// its post before it sends, and a resume splits the text the first try split, note and all
// (ac-jfv.59).
function ensure(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS outbound_attempt (seq INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL UNIQUE, started_at REAL NOT NULL)",
  );
  const have = db.prepare("PRAGMA table_info(outbound_attempt)").all();
  if (!have.some((column) => column.name === "targets"))
    db.exec("ALTER TABLE outbound_attempt ADD COLUMN targets TEXT");
}

const NOT_YET = /no such (table|column)/;

// A plain read, no write lock. A table or column that is not there yet means no attempt was
// noted; only noteOutboundAttempt creates or migrates it.
function select(home, deliveryId) {
  for (const columns of [", targets", ""]) {
    try {
      return readOne(
        home,
        `SELECT started_at AS startedAt${columns} FROM outbound_attempt WHERE delivery_id = ?`,
        deliveryId,
      );
    } catch (error) {
      if (!NOT_YET.test(String(error?.message))) throw error;
    }
  }
  return null;
}

// The earlier try of this delivery, or null: { startedAt (s), targets }.
export function priorOutboundAttempt(home, deliveryId) {
  const row = select(home, deliveryId);
  return row
    ? { startedAt: row.startedAt, targets: JSON.parse(row.targets ?? "[]") }
    : null;
}

const sameTarget = (a, b) =>
  a.channelId === b.channelId && (a.threadTs ?? null) === (b.threadTs ?? null);

// Noted before a send leaves; the first note wins its start time, and a target is kept once.
export function noteOutboundAttempt(
  home,
  deliveryId,
  { channelId, threadTs, note, startedAt = Date.now() / 1000 },
) {
  write(home, (db) => {
    ensure(db);
    db.prepare(
      "INSERT OR IGNORE INTO outbound_attempt (delivery_id, started_at) VALUES (?, ?)",
    ).run(deliveryId, startedAt);
    const row = db
      .prepare("SELECT targets FROM outbound_attempt WHERE delivery_id = ?")
      .get(deliveryId);
    const targets = JSON.parse(row.targets ?? "[]");
    const target = { channelId, threadTs: threadTs ?? null };
    if (!targets.some((t) => sameTarget(t, target))) {
      targets.push(note ? { ...target, note } : target);
      db.prepare(
        "UPDATE outbound_attempt SET targets = ? WHERE delivery_id = ?",
      ).run(JSON.stringify(targets), deliveryId);
    }
    db.prepare(
      `DELETE FROM outbound_attempt WHERE seq NOT IN
         (SELECT seq FROM outbound_attempt ORDER BY seq DESC LIMIT ?)`,
    ).run(PROCESSED_EVENT_LIMIT);
  });
}

// The note a try put before its text at this place ("" for none).
export const noteAt = (attempt, place) =>
  attempt?.targets.find((t) => sameTarget(t, place))?.note ?? "";

// Overflow progress of a receipt: parts sent so far, or null when all are out.
export function setPartsSent(home, deliveryId, sent) {
  write(home, (db) =>
    db
      .prepare("UPDATE outbound_post SET parts_sent = ? WHERE delivery_id = ?")
      .run(sent, deliveryId),
  );
}
