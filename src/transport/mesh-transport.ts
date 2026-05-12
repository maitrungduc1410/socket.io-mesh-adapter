import { EventEmitter } from "events";
import WebSocket, { WebSocketServer } from "ws";
import { encode, decode } from "@msgpack/msgpack";
import type { ServerId } from "socket.io-adapter";

import { createLogger } from "../logger";
import { type MetricsRegistry, NoopMetricsRegistry } from "../metrics";
import { FrameKind, HelloPayload } from "../types";

const log = createLogger("transport");

interface PeerConnection {
  uid: ServerId;
  address: string;
  ws: WebSocket;
  direction: "outbound" | "inbound";
}

export interface MeshTransportOptions {
  uid: ServerId;
  wsPort: number;
  serverAddress: string;
  bufferedAmountThreshold?: number;
  authToken?: string;
  metrics?: MetricsRegistry;
}

/**
 * Frame layout on the wire:
 *
 *   [1 byte: FrameKind] [msgpack-encoded payload]
 *
 * For `Hello` the payload is a `HelloPayload`. For `Mesh` the payload is an
 * already-encoded cluster message/response (opaque to the transport).
 */
const HELLO_TIMEOUT_MS = 10_000;
const DEFAULT_BUFFERED_THRESHOLD = 16 * 1024 * 1024;

export class MeshTransport extends EventEmitter {
  readonly uid: ServerId;
  readonly wsPort: number;
  readonly serverAddress: string;
  private readonly bufferedAmountThreshold: number;
  private readonly authToken?: string;
  private readonly metrics: MetricsRegistry;

  private wss: WebSocketServer;
  /** Established peer connections, keyed by remote uid. */
  private peers = new Map<ServerId, PeerConnection>();
  /** Inbound sockets that have not yet sent HELLO. */
  private pendingInbound = new Map<WebSocket, NodeJS.Timeout>();
  /** Outbound reconnect timers, keyed by remote uid. */
  private reconnectTimers = new Map<ServerId, NodeJS.Timeout>();
  /** Outbound connections currently being established (WS created, not yet open). */
  private outboundConnecting = new Set<ServerId>();
  /** Latest known address per uid (from discovery), used for reconnects. */
  private knownAddresses = new Map<ServerId, string>();
  private closed = false;

  constructor(opts: MeshTransportOptions) {
    super();
    this.uid = opts.uid;
    this.wsPort = opts.wsPort;
    this.serverAddress = opts.serverAddress;
    this.bufferedAmountThreshold =
      opts.bufferedAmountThreshold ?? DEFAULT_BUFFERED_THRESHOLD;
    this.authToken = opts.authToken;
    this.metrics = opts.metrics ?? NoopMetricsRegistry;

    this.wss = new WebSocketServer({ port: this.wsPort });
    this.wss.on("connection", (ws) => this.onInbound(ws));
    this.wss.on("error", (err) => log("wss error: %s", err.message));
    log("[%s] listening on port %d", this.uid, this.wsPort);
  }

  /**
   * Apply a fresh peer list from discovery. Initiates outbound connections to
   * peers whose uid is greater than ours (lex-smaller-initiates rule), drops
   * peers that are no longer present.
   */
  applyPeerList(list: Array<{ serverId: ServerId; address: string }>): void {
    if (this.closed) return;

    const seen = new Set<ServerId>();
    for (const { serverId, address } of list) {
      if (serverId === this.uid) continue;
      seen.add(serverId);
      this.knownAddresses.set(serverId, address);

      const existing = this.peers.get(serverId);
      if (existing) {
        if (existing.address !== address) {
          log(
            "[%s] peer %s address changed %s -> %s, reconnecting",
            this.uid,
            serverId,
            existing.address,
            address
          );
          this.dropPeer(serverId, "address-changed");
          this.maybeInitiate(serverId, address);
        }
        continue;
      }
      this.maybeInitiate(serverId, address);
    }

    for (const uid of [...this.peers.keys()]) {
      if (!seen.has(uid)) {
        log("[%s] peer %s removed from discovery", this.uid, uid);
        this.dropPeer(uid, "left-discovery");
      }
    }
    for (const uid of [...this.reconnectTimers.keys()]) {
      if (!seen.has(uid)) {
        clearTimeout(this.reconnectTimers.get(uid)!);
        this.reconnectTimers.delete(uid);
        this.knownAddresses.delete(uid);
      }
    }
  }

  /**
   * Initiate an outbound connection iff our uid is lex-smaller than the peer's.
   * Otherwise, do nothing and let the peer connect to us.
   */
  private maybeInitiate(peerUid: ServerId, address: string): void {
    if (this.uid >= peerUid) {
      log("[%s] waiting for peer %s to initiate (we are lex-larger)", this.uid, peerUid);
      return;
    }
    this.openOutbound(peerUid, address);
  }

  private openOutbound(peerUid: ServerId, address: string, delay = 0): void {
    if (this.closed) return;
    if (this.peers.has(peerUid)) return;
    if (this.outboundConnecting.has(peerUid)) return;
    const existingTimer = this.reconnectTimers.get(peerUid);
    if (existingTimer) clearTimeout(existingTimer);

    const start = () => {
      this.reconnectTimers.delete(peerUid);
      if (
        this.closed ||
        this.peers.has(peerUid) ||
        this.outboundConnecting.has(peerUid)
      ) {
        return;
      }

      log("[%s] opening outbound to %s @ %s", this.uid, peerUid, address);
      let ws: WebSocket;
      try {
        ws = new WebSocket(address);
      } catch (err) {
        log("[%s] new WebSocket() threw: %s", this.uid, (err as Error).message);
        this.scheduleReconnect(peerUid);
        return;
      }

      ws.binaryType = "nodebuffer";
      this.outboundConnecting.add(peerUid);

      ws.on("open", () => {
        this.outboundConnecting.delete(peerUid);
        // If, while we were connecting, an inbound from the same peer was
        // accepted, prefer that one and drop this outbound.
        if (this.peers.has(peerUid)) {
          log(
            "[%s] outbound to %s open but already connected, closing duplicate",
            this.uid,
            peerUid
          );
          try {
            ws.close(1000, "duplicate");
          } catch {
            // ignore
          }
          return;
        }
        log("[%s] outbound to %s open, sending HELLO", this.uid, peerUid);
        if (!this.sendHello(ws)) {
          ws.close(1011, "hello-send-failed");
          return;
        }
        const peer: PeerConnection = {
          uid: peerUid,
          address,
          ws,
          direction: "outbound",
        };
        this.peers.set(peerUid, peer);
        this.metrics.peerUp(peerUid);
        this.emit("peer-up", peerUid);
        this.wirePeer(peer);
      });

      ws.on("error", (err) => {
        log("[%s] outbound to %s error: %s", this.uid, peerUid, err.message);
      });

      ws.on("close", () => {
        this.outboundConnecting.delete(peerUid);
        const existing = this.peers.get(peerUid);
        if (existing && existing.ws === ws) {
          log("[%s] outbound to %s closed", this.uid, peerUid);
          this.peers.delete(peerUid);
          this.metrics.peerDown(peerUid, "outbound-closed");
          this.emit("peer-down", peerUid);
        }
        if (!this.closed && this.knownAddresses.has(peerUid)) {
          this.scheduleReconnect(peerUid);
        }
      });
    };

    if (delay <= 0) start();
    else this.reconnectTimers.set(peerUid, setTimeout(start, delay));
  }

  private scheduleReconnect(peerUid: ServerId): void {
    if (this.closed) return;
    if (this.peers.has(peerUid)) return;
    if (this.outboundConnecting.has(peerUid)) return;
    if (this.reconnectTimers.has(peerUid)) return;
    const address = this.knownAddresses.get(peerUid);
    if (!address) return;
    // Re-evaluate the lex rule: don't auto-reconnect if we're the lex-larger
    // side (we wait for the peer to reconnect to us instead).
    if (this.uid >= peerUid) return;

    const delay = 1_000 + Math.floor(Math.random() * 1_000);
    log("[%s] scheduling reconnect to %s in %dms", this.uid, peerUid, delay);
    this.openOutbound(peerUid, address, delay);
  }

  private onInbound(ws: WebSocket): void {
    if (this.closed) {
      ws.close(1001, "transport-closed");
      return;
    }
    ws.binaryType = "nodebuffer";
    log("[%s] inbound connection received, awaiting HELLO", this.uid);

    const timer = setTimeout(() => {
      log("[%s] inbound HELLO timeout, closing", this.uid);
      this.pendingInbound.delete(ws);
      ws.close(1002, "hello-timeout");
    }, HELLO_TIMEOUT_MS);
    this.pendingInbound.set(ws, timer);

    ws.on("error", (err) => {
      log("[%s] inbound ws error: %s", this.uid, err.message);
    });

    ws.once("message", (data) => {
      if (!this.handleHello(ws, data as Buffer)) {
        ws.close(1002, "hello-invalid");
      }
    });

    ws.on("close", () => {
      const t = this.pendingInbound.get(ws);
      if (t) {
        clearTimeout(t);
        this.pendingInbound.delete(ws);
      }
    });
  }

  private handleHello(ws: WebSocket, frame: Buffer): boolean {
    const timer = this.pendingInbound.get(ws);
    if (timer) {
      clearTimeout(timer);
      this.pendingInbound.delete(ws);
    }

    if (!frame || frame.length < 2) {
      log("[%s] hello frame too small", this.uid);
      return false;
    }
    if (frame[0] !== FrameKind.Hello) {
      log("[%s] expected HELLO frame, got kind=%d", this.uid, frame[0]);
      return false;
    }

    let payload: HelloPayload;
    try {
      payload = decode(frame.subarray(1)) as HelloPayload;
    } catch (err) {
      log("[%s] hello decode failed: %s", this.uid, (err as Error).message);
      return false;
    }

    if (!payload?.uid) {
      log("[%s] hello missing uid", this.uid);
      return false;
    }
    if (this.authToken && payload.token !== this.authToken) {
      log("[%s] hello auth failed for %s", this.uid, payload.uid);
      return false;
    }
    if (payload.uid === this.uid) {
      log("[%s] rejecting hello from self", this.uid);
      return false;
    }

    if (this.peers.has(payload.uid)) {
      log(
        "[%s] already connected to %s, closing duplicate inbound",
        this.uid,
        payload.uid
      );
      return false;
    }

    log("[%s] inbound peer identified as %s", this.uid, payload.uid);
    if (payload.address) this.knownAddresses.set(payload.uid, payload.address);

    const peer: PeerConnection = {
      uid: payload.uid,
      address: payload.address ?? "",
      ws,
      direction: "inbound",
    };
    this.peers.set(payload.uid, peer);
    this.metrics.peerUp(payload.uid);
    this.emit("peer-up", payload.uid);
    this.wirePeer(peer);
    return true;
  }

  private wirePeer(peer: PeerConnection): void {
    peer.ws.on("message", (data) => {
      const buf = data as Buffer;
      if (!buf || buf.length < 1) return;
      const kind = buf[0];
      if (kind === FrameKind.Mesh) {
        this.emit("mesh-frame", buf.subarray(1), peer.uid, buf.byteLength);
      } else if (kind === FrameKind.Hello) {
        log("[%s] unexpected HELLO from established peer %s", this.uid, peer.uid);
      } else {
        log("[%s] unknown frame kind %d from %s", this.uid, kind, peer.uid);
      }
    });

    peer.ws.on("close", () => {
      const current = this.peers.get(peer.uid);
      if (current && current.ws === peer.ws) {
        log("[%s] peer %s connection closed (%s)", this.uid, peer.uid, peer.direction);
        this.peers.delete(peer.uid);
        this.metrics.peerDown(peer.uid, `${peer.direction}-closed`);
        this.emit("peer-down", peer.uid);
      }
    });
  }

  private sendHello(ws: WebSocket): boolean {
    const payload: HelloPayload = {
      uid: this.uid,
      address: this.serverAddress,
    };
    if (this.authToken) payload.token = this.authToken;
    const body = encode(payload);
    const frame = Buffer.alloc(1 + body.byteLength);
    frame[0] = FrameKind.Hello;
    Buffer.from(body.buffer, body.byteOffset, body.byteLength).copy(frame, 1);
    try {
      ws.send(frame, { binary: true });
      return true;
    } catch (err) {
      log("[%s] hello send failed: %s", this.uid, (err as Error).message);
      return false;
    }
  }

  /**
   * Send an already-encoded mesh payload to every connected peer. Drops peers
   * whose buffered amount exceeds the threshold. The `messageType` is used
   * purely for metrics labelling.
   */
  sendMeshToAll(payload: Buffer, messageType: number): void {
    if (this.closed || this.peers.size === 0) return;
    const frame = this.wrapMesh(payload);
    let sent = 0;
    for (const [uid, peer] of this.peers) {
      if (this.unicast(uid, peer, frame)) sent++;
    }
    if (sent > 0) this.metrics.messageSent(messageType, frame.byteLength);
  }

  /**
   * Send an already-encoded mesh payload to one peer. The `messageType` is
   * used purely for metrics labelling.
   */
  sendMeshToPeer(targetUid: ServerId, payload: Buffer, messageType: number): void {
    if (this.closed) return;
    const peer = this.peers.get(targetUid);
    if (!peer) {
      log("[%s] no connection to %s, dropping mesh frame", this.uid, targetUid);
      return;
    }
    const frame = this.wrapMesh(payload);
    if (this.unicast(targetUid, peer, frame)) {
      this.metrics.messageSent(messageType, frame.byteLength);
    }
  }

  private wrapMesh(payload: Buffer): Buffer {
    const frame = Buffer.alloc(1 + payload.byteLength);
    frame[0] = FrameKind.Mesh;
    payload.copy(frame, 1);
    return frame;
  }

  /** @returns true if the frame was handed to the socket without error. */
  private unicast(uid: ServerId, peer: PeerConnection, frame: Buffer): boolean {
    if (peer.ws.readyState !== WebSocket.OPEN) {
      log("[%s] skipping send to %s: not open (state=%d)", this.uid, uid, peer.ws.readyState);
      return false;
    }
    if (peer.ws.bufferedAmount > this.bufferedAmountThreshold) {
      log(
        "[%s] dropping slow peer %s (bufferedAmount=%d > %d)",
        this.uid,
        uid,
        peer.ws.bufferedAmount,
        this.bufferedAmountThreshold
      );
      this.dropPeer(uid, "slow-consumer");
      return false;
    }
    try {
      peer.ws.send(frame, { binary: true });
      return true;
    } catch (err) {
      log("[%s] send to %s threw: %s", this.uid, uid, (err as Error).message);
      this.dropPeer(uid, "send-error");
      return false;
    }
  }

  private dropPeer(uid: ServerId, reason: string): void {
    const peer = this.peers.get(uid);
    if (!peer) return;
    this.peers.delete(uid);
    try {
      peer.ws.close(1000, reason);
    } catch {
      // ignore
    }
    this.metrics.peerDown(uid, reason);
    this.emit("peer-down", uid);
  }

  /** Number of currently-connected peers (excludes self). */
  peerCount(): number {
    return this.peers.size;
  }

  /** Snapshot of connected peers, for monitoring/tests. */
  listPeers(): Array<{ uid: ServerId; address: string; direction: "inbound" | "outbound" }> {
    return [...this.peers.values()].map((p) => ({
      uid: p.uid,
      address: p.address,
      direction: p.direction,
    }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    log("[%s] closing transport", this.uid);

    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.outboundConnecting.clear();

    for (const [ws, timer] of this.pendingInbound) {
      clearTimeout(timer);
      try {
        ws.close(1001, "transport-closed");
      } catch {
        // ignore
      }
    }
    this.pendingInbound.clear();

    for (const [, peer] of this.peers) {
      try {
        peer.ws.close(1000, "transport-closed");
      } catch {
        // ignore
      }
    }
    this.peers.clear();

    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}
