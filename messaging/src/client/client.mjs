// Thin promise-based Tightbeam client. No local state writes, no business
// logic beyond validating obvious input errors before sending a request
// (the product plan Technical Approach §3: "Clients can validate obvious
// input errors. Only the daemon can create canonical messages...").
// Imports only from src/protocol/ (the architecture contract §5 import boundary
// rule: src/client/ never imports from src/daemon/).

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import {
  CHANNEL_REPLY_PUBLISH_OPERATION,
  FrameDecoder,
  LISTENER_ACK_OPERATION,
  LISTENER_ATTACH_OPERATION,
  LISTENER_END_OPERATION,
  LISTENER_HEARTBEAT_OPERATION,
  encodeFrame,
  PROTOCOL_VERSION,
  TightbeamError,
} from '../protocol/envelope.mjs';

function socketPathFor(stateRoot) {
  return path.join(stateRoot, 'tightbeam.sock');
}

/**
 * Writes a fresh single-use admin bootstrap nonce at the documented fixed
 * path <state-root>/admin/bootstrap.nonce (the architecture contract §4,
 * the state ownership contract "State root layout"). This is a filesystem
 * operation, not a protocol call: it is the client's proof that it has
 * OS-level write access to the 0700 admin/ directory. Does not import
 * src/daemon/ — the fixed path is duplicated here deliberately to respect
 * the client/daemon import boundary (the architecture contract §5).
 */
export function writeAdminNonce(stateRoot) {
  const noncePath = path.join(stateRoot, 'admin', 'bootstrap.nonce');
  const nonce = randomBytes(32).toString('hex');
  fs.writeFileSync(noncePath, nonce, { mode: 0o600 });
  fs.chmodSync(noncePath, 0o600);
  return nonce;
}

class TightbeamClient {
  constructor(socket, { protocolVersion = PROTOCOL_VERSION, onEvent } = {}) {
    this._socket = socket;
    this._protocolVersion = protocolVersion;
    this._decoder = new FrameDecoder();
    this._pending = new Map();
    this._appId = null;
    this._scope = null;
    this.capabilities = null;
    this._closed = false;
    this._closeError = null;
    // Unsolicited event frames (docs/protocol.md "Live notification and
    // event frames"): request_id null paired with an `event` field. No
    // durable state kept here beyond this single callback reference —
    // matches the thin-client contract.
    this._onEvent = typeof onEvent === 'function' ? onEvent : null;

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onSocketClosed());
    socket.on('error', (err) => this._onSocketError(err));
  }

  _onData(chunk) {
    const frames = this._decoder.push(chunk);
    for (const frame of frames) {
      if (!frame.ok) {
        this._failAllPending(new TightbeamError('malformed_request', 'received an unparseable frame from the daemon'));
        this._socket.destroy();
        return;
      }
      this._handleResponse(frame.value);
    }
  }

  _handleResponse(response) {
    if (response.request_id === null && typeof response.event === 'string') {
      this._onEvent?.(response.event, response.payload);
      return;
    }

    const requestId = response.request_id;
    const pending = requestId !== null && this._pending.get(requestId);
    if (!pending) return; // no matching in-flight request; drop silently
    this._pending.delete(requestId);
    if (response.ok) {
      pending.resolve({ result: response.result, capabilities: response.capabilities });
    } else {
      pending.reject(new TightbeamError(response.error?.code, response.error?.message, response.error?.details));
    }
  }

  _onSocketClosed() {
    this._closed = true;
    this._failAllPending(this._closeError ?? new Error('connection closed'));
  }

  _onSocketError(err) {
    this._closeError = err;
  }

  _failAllPending(err) {
    for (const pending of this._pending.values()) pending.reject(err);
    this._pending.clear();
  }

  _send(op, payload, appId) {
    if (typeof op !== 'string' || op.length === 0) {
      return Promise.reject(new Error('op is required and must be a non-empty string'));
    }
    if (payload !== undefined && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) {
      return Promise.reject(new Error('payload must be a plain object when provided'));
    }
    if (this._closed || !this._socket.writable) {
      return Promise.reject(this._closeError ?? new Error('client is not connected'));
    }

    const requestId = randomUUID();
    const envelope = {
      protocol_version: this._protocolVersion,
      request_id: requestId,
      app_id: appId ?? this._appId,
      op,
      payload: payload ?? {},
    };

    return new Promise((resolve, reject) => {
      this._pending.set(requestId, { resolve, reject });
      try {
        this._socket.write(encodeFrame(envelope));
      } catch (err) {
        this._pending.delete(requestId);
        reject(err);
      }
    });
  }

  /**
   * protocol.handshake must be the first call on a fresh connection.
   * credential: { kind: 'app', app_secret } (with appId) or
   * { kind: 'admin', nonce } (appId omitted/null).
   */
  async handshake({ appId = null, credential, client } = {}) {
    if (typeof credential !== 'object' || credential === null || typeof credential.kind !== 'string') {
      throw new Error('handshake requires a credential with a kind');
    }
    const payload = client ? { credential, client } : { credential };
    const { result, capabilities } = await this._send('protocol.handshake', payload, appId);
    this._appId = result.app_id ?? null;
    this._scope = result.scope;
    this.capabilities = capabilities ?? null;
    return result;
  }

  /**
   * Sends one request and resolves with the operation's result object, or
   * rejects with a TightbeamError carrying the daemon's structured error
   * code/message/details.
   */
  async request(op, payload = {}) {
    const { result } = await this._send(op, payload);
    return result;
  }

  // Typed methods for the app-facing message-plane operations
  // (the product plan Technical Approach §6). Each one names its operation
  // and passes the caller's payload through untouched: reshaping,
  // defaulting, or validating here would make the client a second source
  // of truth and drift from the daemon, which owns validation. Payload and
  // result shapes are docs/protocol.md "Conversations and messages" and
  // "inbox.subscribe" verbatim — note `message.read` takes `principal_id`
  // (with an optional `endpoint_id` that scopes which delivery rows are
  // marked) while `message.acknowledge` takes `endpoint_id`. The forward
  // lifecycle cutover retired `message.send`/`message.reply`; their typed
  // methods stay as pass-throughs so a pre-cutover caller hears the
  // daemon's precise operation_disabled instead of a client-side guess.
  // Bootstrap operations (`principal.register`, `endpoint.register`),
  // session, liveness, and resume operations deliberately stay on request().

  /** `conversation.create` — resolves with `{ conversation_id }`. */
  createConversation(payload) {
    return this.request('conversation.create', payload);
  }

  /** `message.send` — retired by the forward lifecycle cutover; the daemon answers operation_disabled. */
  send(payload) {
    return this.request('message.send', payload);
  }

  /**
   * `message.commit` — the sole forward application-authored message
   * operation. Resolves with `{ message_id, conversation_id, effect,
   * idempotent_replay }` plus the created root/attempt/delegation/watch
   * IDs an open or handoff.offer effect produced. The payload passes
   * through untouched: the effect object is required and only the daemon
   * can validate it.
   */
  commit(payload) {
    return this.request('message.commit', payload);
  }

  /** `principal.resolve` — exact caller-owned stable agent identity. */
  resolvePrincipal(payload) {
    return this.request('principal.resolve', payload);
  }

  /** `channel.route.register` — registers this application's non-secret route descriptor. */
  registerChannelRoute(payload) {
    return this.request('channel.route.register', payload);
  }

  /** `channel.reply.publish` — submits the opaque four-field channel ingress contract. */
  publishChannelReply(payload) {
    return this.request(CHANNEL_REPLY_PUBLISH_OPERATION, payload);
  }

  /** `listener.attach` — binds this connection to its fenced listener. */
  attachListener(payload) {
    return this.request(LISTENER_ATTACH_OPERATION, payload);
  }

  /** `listener.heartbeat` — renews the exact listener lease. */
  heartbeatListener(payload) {
    return this.request(LISTENER_HEARTBEAT_OPERATION, payload);
  }

  /** `listener.ack` — acknowledges one durably staged presentation. */
  acknowledgeListener(payload) {
    return this.request(LISTENER_ACK_OPERATION, payload);
  }

  /** `listener.end` — idempotently ends this exact listener generation. */
  endListener(payload) {
    return this.request(LISTENER_END_OPERATION, payload);
  }

  /** `channel.route.list` — lists non-secret channel descriptors. */
  listChannelRoutes(payload = {}) {
    return this.request('channel.route.list', payload);
  }

  /** `message.delivery.list` — lists the exact channel delivery state for one message. */
  listMessageDeliveries(payload) {
    return this.request('message.delivery.list', payload);
  }

  /**
   * `recovery.retry` — admits a replacement attempt under an open root whose
   * current attempt has already lost custody. Resolves with
   * `{ root_obligation_id, root_generation, attempt_id, attempt_generation,
   * endpoint_id, idempotent_replay }`; the payload passes through untouched
   * (the daemon owns every fence and the ledger identity).
   */
  recoveryRetry(payload) {
    return this.request('recovery.retry', payload);
  }

  /**
   * `recovery.switch` — explicitly supersedes the root's prior open attempt
   * and its stale subtree, then admits the replacement. Same result shape as
   * recovery.retry.
   */
  recoverySwitch(payload) {
    return this.request('recovery.switch', payload);
  }

  /**
   * `lifecycle.view` — the forward derived projection over canonical
   * obligation/watch/delivery/endpoint/attention records. Resolves with
   * `{ chains: [...] }` whose `status` labels (working, awaiting_acceptance,
   * delegated, needs_attention, done) are computed at read time only; the
   * payload passes through untouched.
   */
  lifecycleView(payload) {
    return this.request('lifecycle.view', payload);
  }

  /** `message.reply` — resolves with `{ message_id, conversation_id, idempotent_replay }`. */
  reply(payload) {
    return this.request('message.reply', payload);
  }

  /** `inbox.list` — resolves with `{ messages, truncated? }`. */
  inbox(payload) {
    return this.request('inbox.list', payload);
  }

  /** `inbox.subscribe` — resolves with `{ subscribed, principal_id }`; events arrive via on('event'). */
  subscribe(payload) {
    return this.request('inbox.subscribe', payload);
  }

  /** `message.read` — resolves with the message; marks it read. */
  read(payload) {
    return this.request('message.read', payload);
  }

  /** `message.acknowledge` — resolves with `{ message_id, endpoint_id, delivery_state }`. */
  acknowledge(payload) {
    return this.request('message.acknowledge', payload);
  }

  /**
   * Alternate registration surface for event frames alongside the
   * constructor's `onEvent` option, e.g. `client.on('event', fn)`. Only
   * the 'event' name is meaningful; anything else is a no-op.
   */
  on(eventName, handler) {
    if (eventName === 'event') this._onEvent = typeof handler === 'function' ? handler : null;
    return this;
  }

  close() {
    if (this._closed) return Promise.resolve();
    this._closed = true;
    return new Promise((resolve) => {
      this._socket.end(() => resolve());
    });
  }
}

/**
 * Connects to the daemon's Unix domain socket at <stateRoot>/tightbeam.sock.
 * Does not perform the handshake — call client.handshake(...) next.
 */
export function connect(stateRoot, { protocolVersion = PROTOCOL_VERSION, onEvent } = {}) {
  const socketPath = socketPathFor(stateRoot);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    const onError = (err) => {
      socket.removeListener('connect', onConnect);
      reject(err);
    };
    const onConnect = () => {
      socket.removeListener('error', onError);
      resolve(new TightbeamClient(socket, { protocolVersion, onEvent }));
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}
