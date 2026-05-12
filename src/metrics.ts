import type { IncomingMessage, ServerResponse } from "http";
import { MessageType } from "socket.io-adapter";

/**
 * Stable string label per `MessageType` numeric enum value. Used so that
 * Prometheus labels stay human-readable across socket.io-adapter versions.
 */
export const MESSAGE_TYPE_NAMES: Readonly<Record<number, string>> = {
  [MessageType.INITIAL_HEARTBEAT]: "initial_heartbeat",
  [MessageType.HEARTBEAT]: "heartbeat",
  [MessageType.BROADCAST]: "broadcast",
  [MessageType.SOCKETS_JOIN]: "sockets_join",
  [MessageType.SOCKETS_LEAVE]: "sockets_leave",
  [MessageType.DISCONNECT_SOCKETS]: "disconnect_sockets",
  [MessageType.FETCH_SOCKETS]: "fetch_sockets",
  [MessageType.FETCH_SOCKETS_RESPONSE]: "fetch_sockets_response",
  [MessageType.SERVER_SIDE_EMIT]: "server_side_emit",
  [MessageType.SERVER_SIDE_EMIT_RESPONSE]: "server_side_emit_response",
  [MessageType.BROADCAST_CLIENT_COUNT]: "broadcast_client_count",
  [MessageType.BROADCAST_ACK]: "broadcast_ack",
  [MessageType.ADAPTER_CLOSE]: "adapter_close",
};

export function messageTypeName(type: number | undefined): string {
  if (type === undefined) return "unknown";
  return MESSAGE_TYPE_NAMES[type] ?? `unknown_${type}`;
}

export type RequestKind = "fetchSockets" | "broadcastWithAck" | "serverSideEmit";

/**
 * Thin abstraction over the metrics backend so the hot paths never directly
 * import `prom-client`. Implementations must be no-throw and ideally
 * zero-allocation on the no-op path.
 */
export interface MetricsRegistry {
  peerUp(uid: string): void;
  peerDown(uid: string, reason: string): void;
  expectedPeersChanged(n: number): void;
  messageSent(type: number, bytes: number): void;
  messageReceived(type: number, bytes: number): void;
  /** Start a request timer; returns a stop function (must be called exactly once). */
  requestStarted(kind: RequestKind): () => void;
  localClientsChanged(n: number): void;
  namespacesChanged(n: number): void;
  /** Build a Node http.RequestListener that serves Prometheus text format. */
  handler(): (req: IncomingMessage, res: ServerResponse) => void;
}

/**
 * Zero-cost registry used when the user does not opt into Prometheus. Methods
 * are bound to the singleton so closures and hot paths can use them safely.
 */
export const NoopMetricsRegistry: MetricsRegistry = {
  peerUp() {},
  peerDown() {},
  expectedPeersChanged() {},
  messageSent() {},
  messageReceived() {},
  requestStarted() {
    return () => {};
  },
  localClientsChanged() {},
  namespacesChanged() {},
  handler() {
    return (_req, res) => {
      res.statusCode = 503;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("metrics not enabled\n");
    };
  },
};

/**
 * Prometheus-backed registry. Constructing this class lazily imports
 * `prom-client`, so users who omit the `metrics` option never load it.
 */
export class PromMetricsRegistry implements MetricsRegistry {
  // Loaded via require() in the constructor so the symbol type stays opaque
  // to consumers (and the package isn't imported until needed).
  private readonly registry: any;
  private readonly client: any;

  private readonly gPeersConnected: any;
  private readonly gPeersExpected: any;
  private readonly cMessagesSent: any;
  private readonly cMessagesReceived: any;
  private readonly hMessageBytes: any;
  private readonly hRequestDuration: any;
  private readonly cPeerDrops: any;
  private readonly gNamespaces: any;
  private readonly gIoClients: any;

  constructor(opts: { defaultLabels?: Record<string, string> } = {}) {
    // Use require() to keep prom-client out of the load graph for users that
    // never opt into metrics. The dep is a regular runtime dep, but the
    // import side-effects (default metrics collectors, etc.) are not free.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const client = require("prom-client") as typeof import("prom-client");
    this.client = client;
    this.registry = new client.Registry();
    if (opts.defaultLabels) this.registry.setDefaultLabels(opts.defaultLabels);
    client.collectDefaultMetrics({ register: this.registry });

    this.gPeersConnected = new client.Gauge({
      name: "socketio_mesh_peers_connected",
      help: "Number of currently connected mesh peers",
      registers: [this.registry],
    });
    this.gPeersExpected = new client.Gauge({
      name: "socketio_mesh_peers_expected",
      help: "Number of peers the discovery server reports (excluding self)",
      registers: [this.registry],
    });
    this.cMessagesSent = new client.Counter({
      name: "socketio_mesh_messages_sent_total",
      help: "Mesh frames sent to peers, labelled by message type",
      labelNames: ["type"],
      registers: [this.registry],
    });
    this.cMessagesReceived = new client.Counter({
      name: "socketio_mesh_messages_received_total",
      help: "Mesh frames received from peers, labelled by message type",
      labelNames: ["type"],
      registers: [this.registry],
    });
    this.hMessageBytes = new client.Histogram({
      name: "socketio_mesh_message_bytes",
      help: "Size of mesh frames in bytes",
      labelNames: ["direction"],
      buckets: [64, 256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576],
      registers: [this.registry],
    });
    this.hRequestDuration = new client.Histogram({
      name: "socketio_mesh_request_duration_seconds",
      help: "Duration of cluster requests issued by this server",
      labelNames: ["kind"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.cPeerDrops = new client.Counter({
      name: "socketio_mesh_peer_drops_total",
      help: "Peer disconnects/drops, labelled by reason",
      labelNames: ["reason"],
      registers: [this.registry],
    });
    this.gNamespaces = new client.Gauge({
      name: "socketio_mesh_namespaces",
      help: "Number of Socket.IO namespaces served by this process",
      registers: [this.registry],
    });
    this.gIoClients = new client.Gauge({
      name: "socketio_mesh_io_clients",
      help: "Number of local Socket.IO clients connected to this server",
      registers: [this.registry],
    });
  }

  peerUp(_uid: string): void {
    this.gPeersConnected.inc();
  }

  peerDown(_uid: string, reason: string): void {
    this.gPeersConnected.dec();
    this.cPeerDrops.labels(reason).inc();
  }

  expectedPeersChanged(n: number): void {
    this.gPeersExpected.set(n);
  }

  messageSent(type: number, bytes: number): void {
    const label = messageTypeName(type);
    this.cMessagesSent.labels(label).inc();
    this.hMessageBytes.labels("sent").observe(bytes);
  }

  messageReceived(type: number, bytes: number): void {
    const label = messageTypeName(type);
    this.cMessagesReceived.labels(label).inc();
    this.hMessageBytes.labels("received").observe(bytes);
  }

  requestStarted(kind: RequestKind): () => void {
    const end = this.hRequestDuration.startTimer({ kind });
    return () => end();
  }

  localClientsChanged(n: number): void {
    this.gIoClients.set(n);
  }

  namespacesChanged(n: number): void {
    this.gNamespaces.set(n);
  }

  handler(): (req: IncomingMessage, res: ServerResponse) => void {
    return async (_req, res) => {
      try {
        const body = await this.registry.metrics();
        res.statusCode = 200;
        res.setHeader("content-type", this.registry.contentType);
        res.end(body);
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(`error: ${(err as Error).message}\n`);
      }
    };
  }
}
