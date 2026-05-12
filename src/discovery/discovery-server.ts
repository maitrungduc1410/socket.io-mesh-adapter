#!/usr/bin/env node
import WebSocket, { WebSocketServer } from "ws";
import { encode, decode } from "@msgpack/msgpack";

import { createLogger } from "../logger";
import { startMetricsServer, type MetricsHttpServer } from "../metrics-server";
import {
  DiscoveryClientMessage,
  DiscoveryServerMessage,
  PeerEntry,
} from "./protocol";

const log = createLogger("discovery-server");

const PING_INTERVAL_MS = 15_000;

export interface DiscoveryServerOptions {
  port: number;
  /** Optional shared secret; clients must echo this in their register message. */
  authToken?: string;
  /**
   * If set, an HTTP `/metrics` server is started on this port exposing a
   * Prometheus exposition of the discovery server's roster + counters.
   */
  metricsPort?: number;
  /**
   * Host/interface to bind the metrics HTTP server to. Ignored when
   * `metricsPort` is unset. When omitted, Node's default is used (`::` on
   * dual-stack systems, falling back to `0.0.0.0`).
   */
  metricsHost?: string;
}

interface ServerEntry {
  address: string;
  ws: WebSocket;
  isAlive: boolean;
}

interface DiscoveryMetrics {
  registry: any;
  gRoster: any;
  cRegistrations: any;
  cDisconnects: any;
  cBroadcasts: any;
}

function createDiscoveryMetrics(): DiscoveryMetrics {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const client = require("prom-client") as typeof import("prom-client");
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const gRoster = new client.Gauge({
    name: "socketio_mesh_discovery_servers_registered",
    help: "Number of mesh servers currently registered with the discovery service",
    registers: [registry],
  });
  const cRegistrations = new client.Counter({
    name: "socketio_mesh_discovery_registrations_total",
    help: "Total number of register messages processed",
    registers: [registry],
  });
  const cDisconnects = new client.Counter({
    name: "socketio_mesh_discovery_disconnects_total",
    help: "Total number of registered clients that disconnected",
    registers: [registry],
  });
  const cBroadcasts = new client.Counter({
    name: "socketio_mesh_discovery_roster_broadcasts_total",
    help: "Total number of roster updates broadcast to clients",
    registers: [registry],
  });

  return { registry, gRoster, cRegistrations, cDisconnects, cBroadcasts };
}

export function startDiscoveryServer(opts: DiscoveryServerOptions): {
  close: () => Promise<void>;
} {
  const servers = new Map<string, ServerEntry>();
  const wss = new WebSocketServer({ port: opts.port });

  let metrics: DiscoveryMetrics | undefined;
  let metricsServer: MetricsHttpServer | undefined;
  if (opts.metricsPort !== undefined) {
    metrics = createDiscoveryMetrics();
    startMetricsServer(
      opts.metricsPort,
      async (_req, res) => {
        try {
          const body = await metrics!.registry.metrics();
          res.statusCode = 200;
          res.setHeader("content-type", metrics!.registry.contentType);
          res.end(body);
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end(`error: ${(err as Error).message}\n`);
        }
      },
      opts.metricsHost
    )
      .then((server) => {
        metricsServer = server;
      })
      .catch((err: Error) => {
        // eslint-disable-next-line no-console
        console.warn(
          `socket.io-mesh-adapter discovery: metrics server failed to start on port ${opts.metricsPort}: ${err.message}`
        );
        log("metrics server failed to start: %s", err.message);
      });
  }

  wss.on("connection", (ws) => {
    log("client connected");
    let serverId: string | null = null;
    let isAlive = true;

    ws.on("pong", () => {
      isAlive = true;
      if (serverId) {
        const entry = servers.get(serverId);
        if (entry) entry.isAlive = true;
      }
    });

    ws.on("message", (data) => {
      let msg: DiscoveryClientMessage;
      try {
        msg = decode(data as Buffer) as DiscoveryClientMessage;
      } catch (err) {
        log("decode failed: %s", (err as Error).message);
        return;
      }

      if (msg.type !== "register") {
        log("ignoring message of type %s", (msg as { type?: string }).type);
        return;
      }

      if (opts.authToken && msg.token !== opts.authToken) {
        log("auth failed for serverId=%s", msg.serverId);
        ws.close(4401, "unauthorized");
        return;
      }

      serverId = msg.serverId;
      servers.set(serverId, { address: msg.address, ws, isAlive: true });
      log("registered %s @ %s", serverId, msg.address);
      if (metrics) {
        metrics.cRegistrations.inc();
        metrics.gRoster.set(servers.size);
      }
      broadcastServerList();
    });

    ws.on("close", () => {
      if (serverId && servers.get(serverId)?.ws === ws) {
        servers.delete(serverId);
        log("unregistered %s", serverId);
        if (metrics) {
          metrics.cDisconnects.inc();
          metrics.gRoster.set(servers.size);
        }
        broadcastServerList();
      }
    });

    ws.on("error", (err) => {
      log("ws error: %s", err.message);
    });

    // Keep-alive ping
    const pingTimer = setInterval(() => {
      if (!isAlive) {
        log("client failed heartbeat, terminating");
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        clearInterval(pingTimer);
        return;
      }
      isAlive = false;
      try {
        ws.ping();
      } catch {
        // ignore
      }
    }, PING_INTERVAL_MS);
    ws.on("close", () => clearInterval(pingTimer));
  });

  function broadcastServerList(): void {
    const peers: PeerEntry[] = [];
    for (const [serverId, entry] of servers) {
      peers.push({ serverId, address: entry.address });
    }
    const message: DiscoveryServerMessage = { type: "update", servers: peers };
    const buf = encode(message);
    log("broadcasting roster: %d server(s)", peers.length);
    if (metrics) metrics.cBroadcasts.inc();
    for (const { ws } of servers.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(buf, { binary: true });
        } catch (err) {
          log("send failed: %s", (err as Error).message);
        }
      }
    }
  }

  return {
    close: async () => {
      if (metricsServer) {
        try {
          await metricsServer.close();
        } catch (err) {
          log("metrics server close failed: %s", (err as Error).message);
        }
        metricsServer = undefined;
      }
      await new Promise<void>((resolve) => {
        for (const { ws } of servers.values()) {
          try {
            ws.close(1001, "discovery-shutdown");
          } catch {
            // ignore
          }
        }
        servers.clear();
        wss.close(() => resolve());
      });
    },
  };
}

// CLI entrypoint when run directly via `npx socket.io-mesh-adapter` or
// `node dist/discovery/discovery-server.js`.
if (require.main === module) {
  const port = parseInt(process.env.PORT || "8000", 10);
  const authToken = process.env.MESH_AUTH_TOKEN;
  const metricsPort = process.env.METRICS_PORT
    ? parseInt(process.env.METRICS_PORT, 10)
    : undefined;
  const { close } = startDiscoveryServer({ port, authToken, metricsPort });
  // eslint-disable-next-line no-console
  console.log(`socket.io-mesh-adapter discovery server listening on ws://0.0.0.0:${port}`);
  if (metricsPort !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`discovery /metrics listening on http://0.0.0.0:${metricsPort}/metrics`);
  }

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down...`);
    await close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
