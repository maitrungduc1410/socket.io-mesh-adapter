import { EventEmitter } from "events";
import WebSocket from "ws";
import { encode, decode } from "@msgpack/msgpack";
import type { ServerId } from "socket.io-adapter";

import { createLogger } from "../logger";
import {
  DiscoveryClientMessage,
  DiscoveryServerMessage,
  PeerEntry,
} from "./protocol";

const log = createLogger("discovery-client");

export interface DiscoveryClientOptions {
  url: string;
  uid: ServerId;
  address: string;
  token?: string;
  /** Initial reconnect delay in ms. Doubles on every failure up to `maxBackoffMs`. */
  initialBackoffMs?: number;
  /** Maximum reconnect delay in ms. */
  maxBackoffMs?: number;
}

/**
 * Connects to the discovery service and emits `peer-list` events whenever the
 * server pushes an updated roster. Reconnects with exponential backoff on
 * disconnect.
 */
export class DiscoveryClient extends EventEmitter {
  private readonly url: string;
  private readonly uid: ServerId;
  private readonly address: string;
  private readonly token?: string;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs: number;
  private closed = false;

  constructor(opts: DiscoveryClientOptions) {
    super();
    this.url = opts.url;
    this.uid = opts.uid;
    this.address = opts.address;
    this.token = opts.token;
    this.initialBackoffMs = opts.initialBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.backoffMs = this.initialBackoffMs;
  }

  connect(): void {
    if (this.closed || this.ws) return;
    log("[%s] connecting to %s", this.uid, this.url);

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      log("[%s] new WebSocket() threw: %s", this.uid, (err as Error).message);
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "nodebuffer";
    this.ws = ws;

    ws.on("open", () => {
      log("[%s] discovery connected", this.uid);
      this.backoffMs = this.initialBackoffMs;
      this.emit("connected");
      const msg: DiscoveryClientMessage = {
        type: "register",
        serverId: this.uid,
        address: this.address,
      };
      if (this.token) msg.token = this.token;
      try {
        ws.send(encode(msg), { binary: true });
      } catch (err) {
        log("[%s] register send failed: %s", this.uid, (err as Error).message);
      }
    });

    ws.on("message", (data) => {
      try {
        const msg = decode(data as Buffer) as DiscoveryServerMessage;
        if (msg.type === "update") {
          this.emit("peer-list", msg.servers as PeerEntry[]);
        }
      } catch (err) {
        log("[%s] decode failed: %s", this.uid, (err as Error).message);
      }
    });

    ws.on("error", (err) => {
      log("[%s] discovery ws error: %s", this.uid, err.message);
    });

    ws.on("close", (code) => {
      log("[%s] discovery ws closed (code=%d)", this.uid, code);
      this.ws = null;
      this.emit("disconnected");
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const jitter = Math.floor(Math.random() * 250);
    const delay = Math.min(this.backoffMs, this.maxBackoffMs) + jitter;
    log("[%s] reconnecting to discovery in %dms", this.uid, delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "client-closing");
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
