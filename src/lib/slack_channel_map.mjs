import "./node_sqlite_warning.mjs";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const PROCESSED_EVENT_LIMIT = 10000;
const BUSY_TIMEOUT_MS = 5000;

function mapPath(home) {
  return join(home, "slack-channel-map.sqlite");
}

function mapFiles(home) {
  const path = mapPath(home);
  return [path, `${path}-wal`, `${path}-shm`];
}

function secureFiles(home) {
  for (const file of mapFiles(home)) {
    if (existsSync(file)) chmodSync(file, 0o600);
  }
}

// Dogfood DBs were created before launch info existed.
function addLaunchColumns(db) {
  const have = db.prepare("PRAGMA table_info(agent_channel)").all();
  for (const column of ["launch_cwd", "launch_runtime", "launch_command"]) {
    if (!have.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE agent_channel ADD COLUMN ${column} TEXT`);
    }
  }
}

function openWritable(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(mapPath(home), { timeout: BUSY_TIMEOUT_MS });
  try {
    secureFiles(home);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`CREATE TABLE IF NOT EXISTS sender_channel (sender_principal TEXT PRIMARY KEY, channel_id TEXT NOT NULL UNIQUE, channel_name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_channel (agent_name TEXT PRIMARY KEY, channel_id TEXT NOT NULL UNIQUE, channel_name TEXT NOT NULL, welcome_ts TEXT, launch_cwd TEXT, launch_runtime TEXT, launch_command TEXT);
    CREATE TABLE IF NOT EXISTS sender_agent (sender_principal TEXT PRIMARY KEY, agent_name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS thread_root (channel_id TEXT NOT NULL, root_ts TEXT NOT NULL, reply_binding TEXT, message_id TEXT, conversation_id TEXT, delivery_id TEXT, PRIMARY KEY (channel_id, root_ts));
    CREATE TABLE IF NOT EXISTS inbound_thread (message_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS standing_conversation (channel_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS processed_event (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS thread_launch (channel_id TEXT NOT NULL, root_ts TEXT NOT NULL, session_key TEXT NOT NULL, runtime TEXT NOT NULL, launched_at TEXT NOT NULL, PRIMARY KEY (channel_id, root_ts));
    CREATE TABLE IF NOT EXISTS outbound_post (seq INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL, ts TEXT NOT NULL, thread_ts TEXT);`);
    addLaunchColumns(db);
    secureFiles(home);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// Runs fn(db) in one immediate transaction, then tightens file modes.
function write(home, fn) {
  const db = openWritable(home);
  try {
    db.exec("BEGIN IMMEDIATE");
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
    secureFiles(home);
  }
}

// Returns null when the db file is absent; sql columns are aliased to camelCase.
function readOne(home, sql, ...params) {
  if (!existsSync(mapPath(home))) return null;
  const db = new DatabaseSync(mapPath(home), {
    readOnly: true,
    timeout: BUSY_TIMEOUT_MS,
  });
  try {
    const row = db.prepare(sql).get(...params);
    return row ? { ...row } : null;
  } finally {
    db.close();
  }
}

function replaceRow(home, sql, ...params) {
  write(home, (db) => db.prepare(sql).run(...params));
}

const SENDER_COLUMNS =
  "sender_principal AS senderPrincipal, channel_id AS channelId, channel_name AS channelName";

export function recordSenderChannel(home, record) {
  replaceRow(
    home,
    "INSERT OR REPLACE INTO sender_channel VALUES (?, ?, ?)",
    record.senderPrincipal,
    record.channelId,
    record.channelName,
  );
}

export function lookupSenderChannel(home, senderPrincipal) {
  return readOne(
    home,
    `SELECT ${SENDER_COLUMNS} FROM sender_channel WHERE sender_principal = ?`,
    senderPrincipal,
  );
}

export function lookupChannelSender(home, channelId) {
  return readOne(
    home,
    `SELECT ${SENDER_COLUMNS} FROM sender_channel WHERE channel_id = ?`,
    channelId,
  );
}

// Named (Academy) agents: one channel per agent name, shared by all its sessions.
// SELECT * because a read-only open cannot migrate an old table: missing launch columns read as null.
function agentRow(row) {
  if (!row) return null;
  const launch = row.launch_cwd
    ? {
        cwd: row.launch_cwd,
        runtime: row.launch_runtime,
        command: JSON.parse(row.launch_command),
      }
    : null;
  return {
    agentName: row.agent_name,
    channelId: row.channel_id,
    channelName: row.channel_name,
    welcomeTs: row.welcome_ts,
    launch,
  };
}

// Upsert by name; a re-pointed channel loses its welcome unless one is passed (launch info stays).
export function recordAgentChannel(home, record) {
  write(home, (db) => {
    const old = db
      .prepare("SELECT * FROM agent_channel WHERE agent_name = ?")
      .get(record.agentName);
    db.prepare(
      `INSERT OR REPLACE INTO agent_channel
         (agent_name, channel_id, channel_name, welcome_ts,
          launch_cwd, launch_runtime, launch_command)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.agentName,
      record.channelId,
      record.channelName,
      record.welcomeTs ?? null,
      old?.launch_cwd ?? null,
      old?.launch_runtime ?? null,
      old?.launch_command ?? null,
    );
  });
}

export function recordAgentLaunch(home, { agentName, launch }) {
  replaceRow(
    home,
    `UPDATE agent_channel SET launch_cwd = ?, launch_runtime = ?, launch_command = ?
       WHERE agent_name = ?`,
    launch.cwd,
    launch.runtime,
    JSON.stringify(launch.command),
    agentName,
  );
}

export function markAgentChannelWelcomed(home, { agentName, welcomeTs }) {
  replaceRow(
    home,
    "UPDATE agent_channel SET welcome_ts = ? WHERE agent_name = ?",
    welcomeTs,
    agentName,
  );
}

export function lookupAgentChannel(home, agentName) {
  return agentRow(
    readOne(
      home,
      "SELECT * FROM agent_channel WHERE agent_name = ?",
      agentName,
    ),
  );
}

export function lookupChannelAgent(home, channelId) {
  return agentRow(
    readOne(
      home,
      "SELECT * FROM agent_channel WHERE channel_id = ?",
      channelId,
    ),
  );
}

// A post root's launch uuid, recorded before the spawn so a retry reuses it.
// INSERT OR IGNORE: returns true only for the call that inserted.
export function recordThreadLaunch(home, record) {
  return write(home, (db) => {
    const { changes } = db
      .prepare("INSERT OR IGNORE INTO thread_launch VALUES (?, ?, ?, ?, ?)")
      .run(
        record.channelId,
        record.rootTs,
        record.sessionKey,
        record.runtime,
        record.launchedAt,
      );
    return changes > 0;
  });
}

export function lookupThreadLaunch(home, { channelId, rootTs }) {
  return readOne(
    home,
    `SELECT channel_id AS channelId, root_ts AS rootTs, session_key AS sessionKey,
            runtime, launched_at AS launchedAt
       FROM thread_launch WHERE channel_id = ? AND root_ts = ?`,
    channelId,
    rootTs,
  );
}

// Durable principal -> agent name, so the endpoint lookup runs once per principal.
// agent_name '' means looked up and not a named agent.
export function recordSenderAgent(home, record) {
  replaceRow(
    home,
    "INSERT OR REPLACE INTO sender_agent VALUES (?, ?)",
    record.senderPrincipal,
    record.agentName,
  );
}

export function lookupSenderAgent(home, senderPrincipal) {
  return readOne(
    home,
    `SELECT sender_principal AS senderPrincipal, agent_name AS agentName
       FROM sender_agent WHERE sender_principal = ?`,
    senderPrincipal,
  );
}

export function recordThreadRoot(home, record) {
  replaceRow(
    home,
    "INSERT OR REPLACE INTO thread_root VALUES (?, ?, ?, ?, ?, ?)",
    record.channelId,
    record.rootTs,
    record.replyBinding ?? null,
    record.messageId ?? null,
    record.conversationId ?? null,
    record.deliveryId ?? null,
  );
}

export function lookupThreadRoot(home, { channelId, rootTs }) {
  return readOne(
    home,
    `SELECT channel_id AS channelId, root_ts AS rootTs,
            reply_binding AS replyBinding, message_id AS messageId,
            conversation_id AS conversationId, delivery_id AS deliveryId
       FROM thread_root WHERE channel_id = ? AND root_ts = ?`,
    channelId,
    rootTs,
  );
}

// INSERT OR REPLACE gives a replaced row a fresh rowid, so max(rowid) is the latest outbound post.
export function lookupLatestReplyBinding(home, channelId) {
  return readOne(
    home,
    `SELECT reply_binding AS replyBinding FROM thread_root
       WHERE channel_id = ? AND reply_binding IS NOT NULL
       ORDER BY rowid DESC LIMIT 1`,
    channelId,
  );
}

export function recordInboundThread(home, record) {
  replaceRow(
    home,
    "INSERT OR REPLACE INTO inbound_thread VALUES (?, ?, ?)",
    record.messageId,
    record.channelId,
    record.threadTs,
  );
}

export function lookupInboundThread(home, messageId) {
  return readOne(
    home,
    `SELECT message_id AS messageId, channel_id AS channelId, thread_ts AS threadTs
       FROM inbound_thread WHERE message_id = ?`,
    messageId,
  );
}

export function recordStandingConversation(home, record) {
  replaceRow(
    home,
    "INSERT OR REPLACE INTO standing_conversation VALUES (?, ?)",
    record.channelId,
    record.conversationId,
  );
}

// One receipt per delivered Slack post, so a re-offered delivery is never posted twice.
export function recordOutboundPost(
  home,
  record,
  limit = PROCESSED_EVENT_LIMIT,
) {
  write(home, (db) => {
    db.prepare(
      `INSERT OR IGNORE INTO outbound_post (delivery_id, channel_id, ts, thread_ts)
         VALUES (?, ?, ?, ?)`,
    ).run(
      record.deliveryId,
      record.channelId,
      record.ts,
      record.threadTs ?? null,
    );
    db.prepare(
      `DELETE FROM outbound_post WHERE seq NOT IN
         (SELECT seq FROM outbound_post ORDER BY seq DESC LIMIT ?)`,
    ).run(limit);
  });
}

export function lookupOutboundPost(home, deliveryId) {
  return readOne(
    home,
    `SELECT channel_id AS channelId, ts, thread_ts AS threadTs
       FROM outbound_post WHERE delivery_id = ?`,
    deliveryId,
  );
}

// limit is injectable for tests; production callers use the default.
export function markEventProcessed(
  home,
  eventId,
  limit = PROCESSED_EVENT_LIMIT,
) {
  return write(home, (db) => {
    const { changes } = db
      .prepare("INSERT OR IGNORE INTO processed_event (event_id) VALUES (?)")
      .run(eventId);
    if (changes === 0) return false;
    db.prepare(
      `DELETE FROM processed_event WHERE seq NOT IN
         (SELECT seq FROM processed_event ORDER BY seq DESC LIMIT ?)`,
    ).run(limit);
    return true;
  });
}

export function hasProcessedEvent(home, eventId) {
  return (
    readOne(
      home,
      "SELECT 1 AS seen FROM processed_event WHERE event_id = ?",
      eventId,
    ) !== null
  );
}

export function deleteSlackChannelMap(home) {
  let removed = false;
  for (const file of mapFiles(home)) {
    if (existsSync(file)) {
      rmSync(file, { force: true });
      removed = true;
    }
  }
  return removed;
}
