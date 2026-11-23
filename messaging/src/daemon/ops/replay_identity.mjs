// `provider_received_at` is a bridge's arrival hint, not message identity: it stays out of the replay
// hash so a retry with or without it (old and new bridge versions across a restart) replays the
// original, which keeps whatever it stored.
export function withoutProviderReceivedAt(providerMetadata) {
  if (
    !providerMetadata ||
    typeof providerMetadata !== "object" ||
    !("provider_received_at" in providerMetadata)
  )
    return providerMetadata;
  const { provider_received_at: _hint, ...rest } = providerMetadata;
  return rest;
}

// message.commit metadata as the hash sees it; null when only the hint was there.
export function identityMetadata(metadata) {
  const providerMetadata = withoutProviderReceivedAt(
    metadata?.provider_metadata,
  );
  if (providerMetadata === metadata?.provider_metadata) return metadata ?? null;
  const { provider_metadata: _all, ...rest } = metadata;
  const next = Object.keys(providerMetadata).length
    ? { ...rest, provider_metadata: providerMetadata }
    : rest;
  return Object.keys(next).length ? next : null;
}

// Every hash a stored payload_hash may equal and still be a replay: the current rule (the hint is
// not identity) and the legacy rule (raw metadata, hint included), which a daemon from before
// that rule wrote. A bridge that sent the hint to such a daemon retries it unchanged after an
// upgrade, and must replay rather than collide. New writes always store the current hash.
export function replayHashes(hashOf, { current, raw }) {
  return [...new Set([hashOf(current), hashOf(raw)])];
}
