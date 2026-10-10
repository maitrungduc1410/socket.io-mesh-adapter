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

/** Default discovery-server ping interval is 15s; allow two misses + slack. */
const DEFAULT_PING_WATCHDOG_MS = 45_000;

export interface DiscoveryClientOptions {
  url: string;
  uid: ServerId;
  address: string;
  token?: string;
  /** Initial reconnect delay in ms. Doubles on every failure up to `maxBackoffMs`. */
  initialBackoffMs?: number;
  /** Maximum reconnect delay in ms. */
  maxBackoffMs?: number;
  /**
   * How long without a WebSocket ping from the discovery server before the
   * client treats the link as half-open and terminates it. Must be greater
   * than ~2× the server's ping interval. Defaults to 45s.
   */
  pingWatchdogMs?: number;
}

/**
 * Connects to the discovery service and emits `peer-list` events whenever the
 * server pushes an updated roster. Reconnects with exponential backoff on
 * disconnect. Detects half-open sockets (idle proxies / NAT drops that send
 * no FIN) by watching for the server's periodic WebSocket pings.
 */
export class DiscoveryClient extends EventEmitter {
  private readonly url: string;
  private readonly uid: ServerId;
  private readonly address: string;
  private readonly token?: string;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly pingWatchdogMs: number;

  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastPingAt = 0;
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
    this.pingWatchdogMs = opts.pingWatchdogMs ?? DEFAULT_PING_WATCHDOG_MS;
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
      this.lastPingAt = Date.now();
      this.startWatchdog(ws);
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

    // Server-side `ws.ping()` is what keeps idle proxies from killing the
    // link; receiving one also proves the path is still bidirectional.
    ws.on("ping", () => {
      this.lastPingAt = Date.now();
    });

    ws.on("error", (err) => {
      log("[%s] discovery ws error: %s", this.uid, err.message);
    });

    ws.on("close", (code) => {
      log("[%s] discovery ws closed (code=%d)", this.uid, code);
      this.stopWatchdog();
      this.ws = null;
      this.emit("disconnected");
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private startWatchdog(ws: WebSocket): void {
    this.stopWatchdog();
    // Poll at ~1/3 of the budget so we react soon after the deadline.
    const interval = Math.max(250, Math.floor(this.pingWatchdogMs / 3));
    this.watchdogTimer = setInterval(() => {
      if (this.closed || this.ws !== ws) return;
      if (Date.now() - this.lastPingAt <= this.pingWatchdogMs) return;
      log(
        "[%s] no discovery ping for %dms, terminating half-open socket",
        this.uid,
        this.pingWatchdogMs
      );
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }, interval);
    if (typeof this.watchdogTimer.unref === "function") {
      this.watchdogTimer.unref();
    }
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
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
    this.stopWatchdog();
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
