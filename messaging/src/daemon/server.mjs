// UDS server at <root>/tightbeam.sock, mode 0600. Per-connection state
// machine: first frame must be protocol.handshake; NDJSON framing with the
// 1 MiB cap; every other malformed/unauthenticated/permission failure
// returns a structured error and keeps the connection open for a retry
// (docs/protocol.md "Handshake"). Only a frame-level parse failure or an
// oversized line closes the connection (the architecture contract §1).

import fs from 'node:fs';
import net from 'node:net';

import {
  FrameDecoder,
  encodeFrame,
  validateRequestEnvelope,
  successEnvelope,
  errorEnvelope,
  eventEnvelope,
  isMajorVersionCompatible,
  TightbeamError,
} from '../protocol/envelope.mjs';
import { dispatch, createConnectionState } from './ops/index.mjs';

const silentLogger = { info() {}, warn() {}, error() {} };

/**
 * F1 (#8): an encodeFrame failure (typically a result too large for
 * MAX_FRAME_BYTES) used to destroy the connection with nothing logged and
 * nothing sent — a silent, hard-to-diagnose disconnect for the client.
 * Now: log the failure, then try to write a small structured
 * malformed_request envelope in its place (its own size is bounded and
 * always encodable); only destroy the connection if even that write
 * throws.
 */
function safeWrite(socket, envelope, { op, appId, logger, requestId } = {}) {
  if (!socket.writable) return;
  try {
    socket.write(encodeFrame(envelope));
  } catch (err) {
    logger?.error({ event: 'frame_write_failed', op: op ?? null, app_id: appId ?? null, message: err.message });
    try {
      socket.write(
        encodeFrame(
          errorEnvelope({
            requestId: requestId ?? envelope.request_id ?? null,
            code: 'malformed_request',
            message: 'result exceeds frame limit',
          }),
        ),
      );
    } catch {
      socket.destroy();
    }
  }
}

function handleValidatedFrame(socket, envelope, connection, { opTable, context, logger }) {
  if (!isMajorVersionCompatible(envelope.protocol_version)) {
    safeWrite(
      socket,
      errorEnvelope({
        requestId: envelope.request_id,
        code: 'protocol_incompatible',
        message: `unsupported protocol major version: ${envelope.protocol_version}`,
      }),
    );
    logger.info({ event: 'request', op: envelope.op, app_id: connection.appId, ok: false, error_code: 'protocol_incompatible' });
    return;
  }

  if (connection.authenticated && envelope.app_id !== connection.appId) {
    safeWrite(
      socket,
      errorEnvelope({
        requestId: envelope.request_id,
        code: 'malformed_request',
        message: "app_id does not match this connection's authenticated identity",
        details: { field: 'app_id' },
      }),
    );
    logger.info({ event: 'request', op: envelope.op, app_id: connection.appId, ok: false, error_code: 'malformed_request' });
    return;
  }

  const startedAt = Date.now();
  const writeMeta = { op: envelope.op, appId: connection.appId, logger, requestId: envelope.request_id };
  try {
    const outcome = dispatch(opTable, { envelope, connection, context });
    safeWrite(
      socket,
      successEnvelope({ requestId: envelope.request_id, result: outcome.result, capabilities: outcome.capabilities }),
      writeMeta,
    );
    logger.info({
      event: 'request',
      op: envelope.op,
      app_id: connection.appId,
      ok: true,
      latency_ms: Date.now() - startedAt,
    });
  } catch (err) {
    if (err instanceof TightbeamError) {
      safeWrite(
        socket,
        errorEnvelope({ requestId: envelope.request_id, code: err.code, message: err.message, details: err.details }),
        writeMeta,
      );
      logger.info({
        event: 'request',
        op: envelope.op,
        app_id: connection.appId,
        ok: false,
        error_code: err.code,
        latency_ms: Date.now() - startedAt,
      });
    } else {
      logger.error({ event: 'request_failed', op: envelope.op, app_id: connection.appId, message: err.message, stack: err.stack });
      safeWrite(
        socket,
        errorEnvelope({ requestId: envelope.request_id, code: 'malformed_request', message: 'internal error' }),
        writeMeta,
      );
    }
  }
}

function handleFrameResult(socket, frame, connection, deps) {
  if (!frame.ok) {
    // Frame-level failure: unparseable JSON or oversized line. The daemon
    // never learns a request_id here because the line did not parse.
    safeWrite(socket, errorEnvelope({ requestId: null, code: frame.code, message: 'unparseable or oversized frame' }));
    deps.logger.info({ event: 'request', op: null, app_id: connection.appId, ok: false, error_code: frame.code });
    socket.end();
    return false; // stop processing further buffered frames; connection is closing
  }

  const validated = validateRequestEnvelope(frame.value);
  if (!validated.ok) {
    safeWrite(
      socket,
      errorEnvelope({
        requestId: validated.requestId ?? null,
        code: validated.code,
        message: validated.message,
        details: validated.field ? { field: validated.field } : undefined,
      }),
    );
    deps.logger.info({ event: 'request', op: null, app_id: connection.appId, ok: false, error_code: validated.code });
    return true;
  }

  handleValidatedFrame(socket, validated.value, connection, deps);
  return true;
}

function handleConnection(socket, deps) {
  const decoder = new FrameDecoder();
  const connection = createConnectionState();
  // Surgical extension for ws-9's inbox.subscribe (docs/protocol.md "Live
  // notification and event frames"): the only way an op handler can push
  // an unsolicited frame is through the connection it was called on, so
  // the connection carries a bound push function. The op-table contract
  // (context, payload, connection, envelope) itself does not change.
  connection.pushEvent = (eventName, payload) => safeWrite(socket, eventEnvelope({ event: eventName, payload }));

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    const frames = decoder.push(chunk);
    for (const frame of frames) {
      const keepGoing = handleFrameResult(socket, frame, connection, deps);
      if (!keepGoing) return;
    }
  });
  socket.on('error', (err) => {
    deps.logger.warn({ event: 'connection_error', app_id: connection.appId, message: err.message });
  });
  socket.on('close', () => {
    deps.context.eventBus?.unsubscribeConnection?.(connection);
  });
}

export function createServer({ opTable, context, logger = silentLogger }) {
  const connections = new Set();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    handleConnection(socket, { opTable, context, logger });
  });

  server.on('error', (err) => {
    logger.error({ event: 'server_error', message: err.message, code: err.code });
  });

  return {
    server,
    listen(socketPath) {
      return new Promise((resolve, reject) => {
        const bind = () => {
          try {
            fs.unlinkSync(socketPath);
          } catch (err) {
            if (err.code !== 'ENOENT') {
              reject(err);
              return;
            }
          }
          const onError = (err) => {
            server.removeListener('listening', onListening);
            reject(err);
          };
          const onListening = () => {
            server.removeListener('error', onError);
            fs.chmodSync(socketPath, 0o600);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen({ path: socketPath });
        };

        // F7: an existing socket file at this path might be a stale leftover
        // from a crashed daemon (safe to unlink), or it might belong to a
        // live daemon actively serving this state root (must never be
        // silently displaced — the daemon.lock check happens earlier in
        // startDaemon(), but this is a second, independent guard at the
        // exact point of unlink). Probe before unlinking: if something
        // ACCEPTS the connection, fail closed instead.
        const probe = net.connect({ path: socketPath });
        let settled = false;
        probe.once('connect', () => {
          if (settled) return;
          settled = true;
          probe.destroy();
          const err = new Error(`another daemon is already serving state root socket "${socketPath}"`);
          err.code = 'SOCKET_LOCK_HELD';
          reject(err);
        });
        probe.once('error', () => {
          if (settled) return;
          settled = true;
          probe.destroy();
          bind();
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const socket of connections) socket.destroy();
        server.close(() => resolve());
      });
    },
  };
}
