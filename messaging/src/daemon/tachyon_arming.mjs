export const UNSUPPORTED_TACHYON_ARMING_REASON = 'unsupported_tachyon_arming';

function positiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

function auditedGenerations(rows) {
  const armed = new Set();
  for (const row of rows) {
    let declaration;
    try {
      declaration = JSON.parse(row.effect_payload ?? '{}').declaration;
    } catch {
      continue;
    }
    if (typeof declaration?.sender_endpoint_id === 'string' && positiveInteger(declaration.process_generation)) {
      armed.add(`${declaration.sender_endpoint_id}\u0000${declaration.process_generation}`);
    }
  }
  return armed;
}

function auditRows(db) {
  return db.prepare(
    `SELECT me.effect_payload
       FROM message_effects me
       JOIN messages m ON m.id = me.message_id
      WHERE m.origin = 'agent'`,
  ).all();
}

export function isTachyonArmedForGeneration(endpoint, processGeneration) {
  return endpoint?.tachyon_armed_process_generation === processGeneration && positiveInteger(processGeneration);
}

export function armTachyonFromCommittedEffect(db, { sendBranch, effect }) {
  if (sendBranch !== 'agent' || typeof effect?.sender_endpoint_id !== 'string' || !positiveInteger(effect.process_generation)) return false;
  return db.prepare(
    `UPDATE endpoints
        SET tachyon_armed_process_generation = ?
      WHERE id = ? AND process_generation = ?`,
  ).run(effect.process_generation, effect.sender_endpoint_id, effect.process_generation).changes === 1;
}

export function reconcileTachyonArmingFromAudit(db, { endpointIds = null } = {}) {
  const armed = auditedGenerations(auditRows(db));
  const endpoints = endpointIds === null
    ? db.prepare('SELECT id, process_generation, tachyon_armed_process_generation FROM endpoints').all()
    : endpointIds.length === 0
      ? []
      : db.prepare(`SELECT id, process_generation, tachyon_armed_process_generation FROM endpoints WHERE id IN (${endpointIds.map(() => '?').join(', ')})`).all(...endpointIds);
  const update = db.prepare('UPDATE endpoints SET tachyon_armed_process_generation = ? WHERE id = ?');
  for (const endpoint of endpoints) {
    const currentKey = `${endpoint.id}\u0000${endpoint.process_generation}`;
    const markerKey = `${endpoint.id}\u0000${endpoint.tachyon_armed_process_generation}`;
    const next = endpoint.tachyon_armed_process_generation === null
      ? (armed.has(currentKey) ? endpoint.process_generation : null)
      : (armed.has(markerKey) ? endpoint.tachyon_armed_process_generation : null);
    if (next !== endpoint.tachyon_armed_process_generation) update.run(next, endpoint.id);
  }
}

export function findInvalidImportedTachyonArming(records) {
  const messages = new Map((records.messages ?? []).map((message) => [message.id, message]));
  const armed = auditedGenerations(
    (records.message_effects ?? []).filter((effect) => messages.get(effect.message_id)?.origin === 'agent'),
  );
  for (const endpoint of records.endpoints ?? []) {
    const marker = endpoint.tachyon_armed_process_generation;
    if (marker === undefined || marker === null) continue;
    if (!positiveInteger(marker) || !positiveInteger(endpoint.process_generation) || marker > endpoint.process_generation || !armed.has(`${endpoint.id}\u0000${marker}`)) {
      return `endpoint "${endpoint.id}" claims unsupported tachyon arming`;
    }
  }
  return null;
}

export function endUnsupportedTachyonListeners(db, { endpointId, processGeneration, now }) {
  const listeners = db.prepare(
    `SELECT id, listener_generation
       FROM listeners
      WHERE endpoint_id = ? AND process_generation = ?
        AND state IN ('parked', 'attached', 'waking')`,
  ).all(endpointId, processGeneration);
  const miss = db.prepare(
    `UPDATE listener_presentations
        SET state = 'missed', missed_at = ?, fallback_reason = ?, updated_at = ?
      WHERE listener_id = ? AND listener_generation = ?
        AND state = 'pending' AND admitted_at IS NULL`,
  );
  const end = db.prepare(
    `UPDATE listeners
        SET state = 'ended', terminal_reason = ?, ended_at = ?, updated_at = ?
      WHERE id = ? AND listener_generation = ?
        AND state IN ('parked', 'attached', 'waking')`,
  );
  let ended = 0;
  for (const listener of listeners) {
    miss.run(now, UNSUPPORTED_TACHYON_ARMING_REASON, now, listener.id, listener.listener_generation);
    ended += end.run(UNSUPPORTED_TACHYON_ARMING_REASON, now, now, listener.id, listener.listener_generation).changes;
  }
  return ended;
}
