// The notice lanes' consumer (ac-jfv.74.1): claim, and send each claimed notice in its own task.
// `runOne({ onClaimed, onSettling })` claims one delivery and sends it. It calls `onClaimed()` the
// moment its claim is in hand, which starts the next claim while this send runs, and `onSettling()`
// when the post is done and only the settle call (complete or release) is left. So claims chain,
// sends overlap, and an idle lane costs one claim (a handshake on the Tightbeam daemon).
// `limit` bounds the tasks that claim or post. A claim can take seconds under load (4.2 s measured)
// and decides at its start, so a notice that falls due just after a claim began is claimed only by
// a claim that begins after it. The pump therefore watches the stamp the whole tick (every
// `watchMs`) and, when it moves, starts one more claim beside the one in flight: at most
// MAX_CLAIMS (2) claims started by one tick, never more however often the stamp moves (every
// user-route insert moves it, answers included). A tick that ends at its deadline leaves its claims
// running (`onLate`), so up to 4 may be in flight while the next tick starts its own 2. The Tightbeam lease keeps each delivery to one claimant, so
// no delivery is posted twice.
// A task in its settle stage holds no slot: a settle call can run to the lease end (~30 s,
// ac-jfv.81) and must not hold back a newly due notice.
// A failed or released send does not end the claiming: an earlier failure never holds a newer
// notice (review r5 #1).
// The claiming pauses when the last claim in flight ends with no claim in hand (nothing due, a
// failed claim, a backoff, a throw), or at once when a delivery id comes back within the tick (a
// re-offered row). With a `stamp` (a cheap local read, here the user-route watermark's mtime) it
// resumes when the stamp has moved since the last claim began: a notice that falls due while a
// send is in flight is claimed then, not when the tick ends. A re-offered row or a failing claim
// does not move the stamp, so it cannot spin the tick. Without a `stamp` a pause lasts to the end
// of the tick.
// `stopped()` (a shutdown) stops every claim; sends in flight finish and the tick waits for them.
// `deadlineAt` (an absolute ms time) ends the tick: it resolves then, whatever is in flight. The
// tasks in flight run on and hand their result to `onLate`; the lane's next tick takes over the
// claiming (the Tightbeam lease keeps a claimed delivery to its task, and a re-offer is completed
// from its receipt). A task that throws is a failed result, logged with its stack (`onThrow`). Resolves with every
// result.
// Why 250 ms: the wait for a due notice is at most this on top of its claim, and a stat is local.
export const NOTICE_WATCH_MS = 250;
const MAX_CLAIMS = 2;

// How a finished task affects the claiming: "go" (a send ended, claim on) or "idle" (no claim in
// hand, or a delivery id that came back: pause until the stamp moves).
function claimingAfter({ result, handedOff, seen }) {
  const id = result?.delivery_id;
  if (id) return seen.has(id) ? "idle" : "go";
  return handedOff ? "go" : "idle";
}

// The pump's state `st`: `live` tasks, `active` of them claiming or posting (the `limit` counts
// these), `claims` (tasks whose claim is not yet in hand), `halted` (no new claim until the stamp
// moves), `mark` (the stamp when the pump began, then when a claim was added for a move), the watch timer and the ids seen.
function moved(st) {
  return st.stamp !== null && st.stamp() !== st.mark;
}

const room = (st) => !st.done && !st.stopped() && st.active < st.limit;

// The chain: one claim when none is in flight.
function pump(st) {
  if (!st.halted && st.claims === 0 && room(st)) launch(st);
}

// The stamp moved: one more claim beside the one in flight (at most MAX_CLAIMS).
function moveClaim(st) {
  st.halted = false;
  if (st.claims >= MAX_CLAIMS || !room(st)) return; // the move stays pending
  st.mark = st.stamp(); // only a claim added for a move serves it: a chain successor does not
  launch(st);
}

// Look at the stamp now, and again in `watchMs` for as long as the tick runs.
function look(st) {
  if (st.done || st.live === 0 || !st.stamp || st.timer) return;
  if (moved(st) && !st.stopped()) moveClaim(st);
  if (st.timer) return; // a claim launched by the move armed it
  st.timer = setTimeout(() => {
    st.timer = null;
    look(st);
  }, st.watchMs);
}

// A task's own throw is a failed result; it is logged with its stack, never swallowed.
function logThrow(thrown) {
  process.stderr.write(
    `tldr notice pump task threw: ${thrown?.stack || thrown?.message || thrown}\n`,
  );
}

function end(st) {
  st.done = true;
  clearTimeout(st.timer);
  clearTimeout(st.deadline);
  st.timer = null;
  st.resolve(st.results);
}

// A task's slot is held while it claims or posts.
function freeSlot(st, task) {
  if (!task.slot) return;
  task.slot = false;
  st.active -= 1;
}

function finish(st, task, result) {
  freeSlot(st, task);
  st.live -= 1;
  if (st.done) {
    st.onLate?.(result); // the tick resolved at its deadline
    return;
  }
  st.results.push(result);
  if (!task.handedOff) st.claims -= 1; // ended without a claim in hand
  const id = result?.delivery_id;
  const again = Boolean(id) && st.seen.has(id);
  const next = claimingAfter({
    result,
    handedOff: task.handedOff,
    seen: st.seen,
  });
  if (id) st.seen.add(id);
  // Idle halts when no other claim is in flight to find a notice, or at once for a re-offered id.
  if (next === "idle" && (again || st.claims === 0)) st.halted = true;
  look(st);
  pump(st);
  if (st.live === 0) end(st);
}

function launch(st) {
  st.live += 1;
  st.active += 1;
  st.claims += 1;
  const task = { slot: true, handedOff: false };
  const onClaimed = () => {
    if (task.handedOff || st.done) return;
    task.handedOff = true;
    st.claims -= 1;
    if (!st.halted && room(st)) launch(st); // the successor, beside any claim in flight
  };
  const onSettling = () => {
    freeSlot(st, task);
    pump(st);
  };
  look(st);
  Promise.resolve()
    .then(() => st.runOne({ onClaimed, onSettling }))
    .catch((thrown) => {
      st.onThrow(thrown);
      return { ok: false, thrown };
    })
    .then((result) => finish(st, task, result));
}

export function pumpNotices({
  runOne,
  limit = 4,
  stopped = () => false,
  stamp = null,
  watchMs = NOTICE_WATCH_MS,
  deadlineAt = null,
  onLate = null,
  onThrow = logThrow,
}) {
  return new Promise((resolve) => {
    const st = {
      runOne,
      limit,
      stopped,
      stamp,
      watchMs,
      onLate,
      onThrow,
      resolve,
      results: [],
      seen: new Set(),
      live: 0,
      active: 0,
      claims: 0,
      halted: false,
      done: false,
      mark: stamp?.(),
      timer: null,
      deadline: null,
    };
    if (deadlineAt !== null)
      st.deadline = setTimeout(
        () => end(st),
        Math.max(0, deadlineAt - Date.now()),
      );
    pump(st);
    if (st.live === 0) end(st); // told to stop before the first claim
  });
}
