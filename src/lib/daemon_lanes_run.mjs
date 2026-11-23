// Runs the daemon's lanes (ac-jfv.74.1). The daemon runs them all at once. --once runs them at
// once too, so a slow ordinary send cannot hold a due notice, except that inbound still runs before
// outbound: they must not share the admin nonce file (ac-jfv.4). A short run waits for every lane,
// then fails with the first lane error.
export async function runLanes({ once, inboundLane, outboundLane, lanes }) {
  const mail = once
    ? [
        async () => {
          try {
            await inboundLane();
          } finally {
            await outboundLane();
          }
        },
      ]
    : [inboundLane, outboundLane];
  const running = [...mail, ...lanes].map((lane) => lane());
  if (!once) {
    await Promise.all(running);
    return;
  }
  const settled = await Promise.allSettled(running);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
