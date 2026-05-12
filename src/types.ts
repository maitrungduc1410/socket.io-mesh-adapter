import type { ClusterAdapterOptions, ServerId } from "socket.io-adapter";

import type { MetricsRegistry } from "./metrics";

export interface MetricsOptions {
  /**
   * If set, an HTTP `/metrics` server is started on this port. Use `0` to
   * grab a random port (useful for tests).
   */
  port?: number;

  /**
   * Host/interface to bind the metrics HTTP server to. When omitted, Node's
   * default is used (`::` on dual-stack systems, falling back to `0.0.0.0`),
   * so `localhost` works whether the runtime resolves it to IPv4 or IPv6.
   */
  host?: string;

  /**
   * If `true`, no HTTP server is created and `prom-client` is still loaded.
   * Use this when you want to mount the metrics handler on an existing
   * HTTP server via `ctx.metrics.handler()`.
   */
  handlerOnly?: boolean;

  /**
   * Advanced: bring your own registry implementation. When provided, all
   * options above are ignored and `prom-client` is NOT loaded by this
   * adapter (the caller is responsible for whatever backend they wired up).
   */
  registry?: MetricsRegistry;

  /**
   * Optional labels added to every Prometheus metric emitted by the default
   * registry (e.g. `{ pod: "app-1", region: "us-east-1" }`).
   */
  defaultLabels?: Record<string, string>;
}

export interface MeshAdapterOptions extends ClusterAdapterOptions {
  /**
   * WebSocket port for peer-to-peer mesh communication.
   * @default 4000
   */
  wsPort?: number;

  /**
   * The address other peers should use to reach this server.
   * @default ws://localhost:<wsPort>
   */
  serverAddress?: string;

  /**
   * WebSocket URL of the discovery service.
   */
  discoveryServiceAddress: string;

  /**
   * Drop a peer when its outbound WebSocket buffer exceeds this many bytes.
   * Acts as a slow-consumer cut-off and prevents unbounded memory growth.
   * @default 16 * 1024 * 1024 (16 MB)
   */
  bufferedAmountThreshold?: number;

  /**
   * Optional shared secret. If set, peers and the discovery server must use
   * the same value (`MESH_AUTH_TOKEN` env var on the discovery server).
   */
  authToken?: string;

  /**
   * Enable Prometheus-style metrics. When omitted, no metrics are collected
   * and `prom-client` is never loaded.
   */
  metrics?: MetricsOptions;
}

/** Wire framing on the peer WebSocket. */
export const enum FrameKind {
  /** First message on every peer connection: identifies the sender. */
  Hello = 0x00,
  /** Cluster adapter message/response, msgpack-encoded after the tag. */
  Mesh = 0x01,
}

export interface HelloPayload {
  uid: ServerId;
  /** The advertised address of the sender; helps the receiver de-duplicate. */
  address: string;
  /** Optional auth token. */
  token?: string;
}
