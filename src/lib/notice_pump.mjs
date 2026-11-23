// The notice lanes' consumer (ac-jfv.74.1): claim until claim_held, and send each claimed notice
// in its own task, at most `limit` at once. `runOne({ onClaimed })` claims one delivery and sends
// it; it calls `onClaimed()` the moment its claim is in hand, which starts the next claim while
// this send runs. So claims chain one after another, sends overlap, and an idle lane costs one
// claim (a claim request is a handshake on the Tightbeam daemon). A failed or released send does
// not end the claiming: an earlier failure never holds a newer notice (review r5 #1). The claiming
// ends on a task that ends with no claim in hand (claim_held, a failed claim, a backoff, a throw
// before a claim) and when a delivery id comes back within the tick (one re-offered row cannot make the
// tick spin); sends already in flight finish and the tick waits for them. A task that throws is a
// failed result. Resolves with every result.
// No claim in hand, or a delivery id that came back within the tick.
const endsClaiming = (id, handedOff, seen) =>
  (!id && !handedOff) || seen.has(id);

export function pumpNotices({ runOne, limit = 4, stopped = () => false }) {
  return new Promise((resolve) => {
    const results = [];
    let live = 0;
    let claiming = false; // a task whose claim is not yet in hand
    let halted = false;
    const seen = new Set();
    const launch = () => {
      live += 1;
      claiming = true;
      let handedOff = false;
      const onClaimed = () => {
        if (handedOff) return;
        handedOff = true;
        claiming = false;
        pump();
      };
      Promise.resolve()
        .then(() => runOne({ onClaimed }))
        .catch((thrown) => ({ ok: false, thrown }))
        .then((result) => {
          results.push(result);
          if (!handedOff) claiming = false; // ended without a claim in hand
          const id = result?.delivery_id;
          if (endsClaiming(id, handedOff, seen)) halted = true;
          if (id) seen.add(id);
          live -= 1;
          pump();
          if (live === 0) resolve(results);
        });
    };
    const pump = () => {
      if (!halted && !claiming && live < limit && !stopped()) launch();
    };
    pump();
    if (live === 0) resolve(results); // told to stop before the first claim
  });
}
