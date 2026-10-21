// Where a message stands on the delivery ladder (committed, delivered,
// received, acknowledged, or the terminal failed / timed_out), computed one way
// for every reader: the daemon's thread views and the CLI's `agent status
// --work`. Pure functions over delivery rows; no I/O.
//
// The step a requester sees for tracked work is the step at the endpoint that
// holds the work now. A work that moved to a replacement keeps its
// predecessor's rows (a failed duplicate, a retired recovery route), and a
// list of rows is ordered by id, which is random: only a row's own timestamps
// say which is newest.

const LADDER = ['committed', 'delivered', 'received', 'acknowledged'];

/** The step one delivery row has reached. */
export function rowDeliveryStep(row) {
  if (row.state === 'failed') return 'failed';
  if (row.state === 'expired') return 'timed_out';
  if (row.acknowledged_at) return 'acknowledged';
  if (row.read_at) return 'received';
  return row.state === 'delivered' ? 'delivered' : 'committed';
}

// Oldest first. Rows without timestamps keep their listed order.
function oldestFirst(rows) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = a.row.created_at ?? '';
      const right = b.row.created_at ?? '';
      if (left !== right) return left < right ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

// A row's recipient is its channel route or its endpoint; callers either pass
// `recipient` (COALESCE of the two) or `channel_route_id` itself.
const recipientOf = (row) => row.recipient ?? row.channel_route_id ?? row.endpoint_id;
const isEndpointRow = (row) => recipientOf(row) === row.endpoint_id && !row.channel_route_id;

/**
 * @param {Array<{delivery_id?: string, endpoint_id: string, recipient?: string, channel_route_id?: string|null, state: string, read_at?: string|null, acknowledged_at?: string|null, created_at?: string, replacement_delivery_id?: string|null}>} rows every delivery row of one message
 * @param {{holderEndpointId?: string|null}} [options] the endpoint that holds the work now, when it is known
 * @returns {'committed'|'delivered'|'received'|'acknowledged'|'failed'|'timed_out'}
 */
export function deliveryStepFor(rows, { holderEndpointId = null } = {}) {
  const ordered = oldestFirst(rows);
  const byId = new Map(ordered.filter((row) => row.delivery_id).map((row) => [row.delivery_id, row]));
  // A duplicate that a replacement row made good stands as that row.
  const resolved = (row) => (row.replacement_delivery_id ? byId.get(row.replacement_delivery_id) ?? row : row);

  const held = holderEndpointId ? ordered.filter((row) => row.endpoint_id === holderEndpointId && isEndpointRow(row)) : [];
  if (held.length > 0) return rowDeliveryStep(resolved(held.at(-1)));

  const newestByRecipient = new Map();
  for (const row of ordered) newestByRecipient.set(recipientOf(row), row);
  const live = [...newestByRecipient.values()].filter((row) => !row.replacement_delivery_id);
  if (live.some((row) => row.state === 'failed')) return 'failed';
  if (live.some((row) => row.state === 'expired')) return 'timed_out';
  const rank = (row) => LADDER.indexOf(rowDeliveryStep(row));
  return LADDER[live.length === 0 ? 0 : Math.min(...live.map(rank))];
}
