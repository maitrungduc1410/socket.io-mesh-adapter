import { randomBytes } from "crypto";
import { decode } from "@msgpack/msgpack";
import type {
  ClusterMessage,
  ClusterResponse,
  ServerId,
} from "socket.io-adapter";

import { createLogger } from "./logger";
import { DiscoveryClient } from "./discovery/discovery-client";
import { MeshTransport } from "./transport/mesh-transport";
import { startMetricsServer, MetricsHttpServer } from "./metrics-server";
import {
  type MetricsRegistry,
  NoopMetricsRegistry,
  PromMetricsRegistry,
} from "./metrics";
import type { MeshAdapter } from "./mesh-adapter";
import type { MeshAdapterOptions } from "./types";

const log = createLogger("context");

const LOCAL_CLIENTS_SAMPLE_INTERVAL_MS = 5_000;

/**
 * Owns the mesh transport + discovery client for a given `wsPort`, and routes
 * inbound mesh frames to the right namespace's adapter. Multiple namespaces
 * created in the same process share a single context (and thus a single mesh).
 */
export class MeshContext {
  readonly uid: ServerId;
  readonly transport: MeshTransport;
  readonly discovery: DiscoveryClient;
  readonly metrics: MetricsRegistry;
  private readonly adapters = new Map<string, MeshAdapter>();
  private metricsServer?: MetricsHttpServer;
  private localClientsTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(opts: MeshAdapterOptions) {
    this.uid = randomBytes(8).toString("hex");
    const wsPort = opts.wsPort ?? 4000;
    const serverAddress =
      opts.serverAddress ??
      process.env.MESH_SERVER_WS_ADDRESS ??
      `ws://localhost:${wsPort}`;

    this.metrics = this.buildMetrics(opts);

    this.transport = new MeshTransport({
      uid: this.uid,
      wsPort,
      serverAddress,
      bufferedAmountThreshold: opts.bufferedAmountThreshold,
      authToken: opts.authToken,
      metrics: this.metrics,
    });
    this.discovery = new DiscoveryClient({
      url: opts.discoveryServiceAddress,
      uid: this.uid,
      address: serverAddress,
      token: opts.authToken,
    });

    this.discovery.on("peer-list", (peers) => {
      this.transport.applyPeerList(peers);
      // -1 because the roster includes self.
      this.metrics.expectedPeersChanged(Math.max(0, peers.length - 1));
    });

    this.transport.on(
      "mesh-frame",
      (payload: Buffer, fromUid: ServerId, frameBytes: number) => {
        this.dispatch(payload, fromUid, frameBytes);
      }
    );

    if (opts.metrics) this.startMetricsServerIfNeeded(opts);
    this.startLocalClientsSampler();
    this.discovery.connect();
    log("[%s] context initialized on wsPort=%d", this.uid, wsPort);
  }

  private buildMetrics(opts: MeshAdapterOptions): MetricsRegistry {
    if (!opts.metrics) return NoopMetricsRegistry;
    if (opts.metrics.registry) return opts.metrics.registry;
    return new PromMetricsRegistry({ defaultLabels: opts.metrics.defaultLabels });
  }

  private startMetricsServerIfNeeded(opts: MeshAdapterOptions): void {
    const m = opts.metrics;
    if (!m || m.handlerOnly || m.port === undefined) return;
    startMetricsServer(m.port, this.metrics.handler(), m.host)
      .then((server) => {
        this.metricsServer = server;
      })
      .catch((err: Error) => {
        // Make this visible without DEBUG=*: a metrics endpoint that never
        // came up is the kind of misconfiguration users want to know about
        // immediately, not when Prometheus' "target down" alert fires.
        // eslint-disable-next-line no-console
        console.warn(
          `socket.io-mesh-adapter: metrics server failed to start on port ${m.port}: ${err.message}`
        );
        log("[%s] metrics server failed to start: %s", this.uid, err.message);
      });
  }

  private startLocalClientsSampler(): void {
    this.localClientsTimer = setInterval(() => {
      let total = 0;
      for (const adapter of this.adapters.values()) {
        const sids = (adapter as unknown as { sids?: Map<string, unknown> }).sids;
        if (sids) total += sids.size;
      }
      this.metrics.localClientsChanged(total);
    }, LOCAL_CLIENTS_SAMPLE_INTERVAL_MS);
    if (typeof this.localClientsTimer.unref === "function") {
      this.localClientsTimer.unref();
    }
  }

  registerAdapter(nspName: string, adapter: MeshAdapter): void {
    this.adapters.set(nspName, adapter);
    this.metrics.namespacesChanged(this.adapters.size);
    log("[%s] registered adapter for %s", this.uid, nspName);
  }

  unregisterAdapter(nspName: string): void {
    this.adapters.delete(nspName);
    this.metrics.namespacesChanged(this.adapters.size);
    log("[%s] unregistered adapter for %s", this.uid, nspName);
  }

  private dispatch(payload: Buffer, fromUid: ServerId, frameBytes: number): void {
    let message: ClusterMessage | ClusterResponse;
    try {
      message = decode(payload) as ClusterMessage | ClusterResponse;
    } catch (err) {
      log("[%s] decode failed from %s: %s", this.uid, fromUid, (err as Error).message);
      return;
    }
    if (!message || typeof message.nsp !== "string") {
      log("[%s] dropping frame with no nsp from %s", this.uid, fromUid);
      return;
    }
    if (message.uid === this.uid) {
      return;
    }
    this.metrics.messageReceived(message.type, frameBytes);
    const adapter = this.adapters.get(message.nsp);
    if (!adapter) {
      log("[%s] no adapter for namespace %s (from %s)", this.uid, message.nsp, fromUid);
      return;
    }
    adapter.handleInbound(message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    log("[%s] closing context", this.uid);
    if (this.localClientsTimer) {
      clearInterval(this.localClientsTimer);
      this.localClientsTimer = undefined;
    }
    if (this.metricsServer) {
      try {
        await this.metricsServer.close();
      } catch (err) {
        log("[%s] metrics server close failed: %s", this.uid, (err as Error).message);
      }
      this.metricsServer = undefined;
    }
    await this.discovery.close();
    await this.transport.close();
    this.adapters.clear();
  }
}
