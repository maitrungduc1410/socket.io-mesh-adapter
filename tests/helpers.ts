/**
 * Shared helpers for booting one or many Socket.IO servers backed by the mesh
 * adapter against a real discovery service, on dynamically-allocated ports.
 */
import { createServer, type Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { Server } from "socket.io";
import { io as ioc, type Socket as ClientSocket } from "socket.io-client";

import {
  createAdapter,
  shutdownAdapter,
  startDiscoveryServer,
} from "../src";

export { shutdownAdapter } from "../src";

export interface TestNode {
  io: Server;
  httpServer: HttpServer;
  httpPort: number;
  meshPort: number;
  close: () => Promise<void>;
}

// Use a randomized starting offset per test-file load so concurrent runs (or
// the same port being held in TIME_WAIT) are very unlikely to collide.
let portCursor = 19000 + Math.floor(Math.random() * 5_000);
function nextPort(): number {
  return portCursor++;
}

export async function bootDiscovery(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const port = nextPort();
  const handle = startDiscoveryServer({ port });
  // Give the OS a moment to bind
  await sleep(50);
  return { port, close: handle.close };
}

export interface BootNodeOpts {
  discoveryPort: number;
  heartbeatInterval?: number;
  heartbeatTimeout?: number;
  /**
   * If true, skip the test-friendly fast heartbeat defaults (500ms/1500ms)
   * and let the library use its own defaults (5s/10s). Useful for regression
   * tests that exercise the "user did not pass heartbeat options" path.
   */
  useLibraryHeartbeatDefaults?: boolean;
  /** If set, also start an HTTP /metrics server on this port (use 0 for random). */
  metricsPort?: number;
}

export interface TestNodeWithMetrics extends TestNode {
  metricsPort?: number;
}

export async function bootNode(opts: BootNodeOpts): Promise<TestNodeWithMetrics> {
  const meshPort = nextPort();
  const httpServer = createServer();
  const io = new Server(httpServer);
  const metricsPort = opts.metricsPort === 0 ? nextPort() : opts.metricsPort;
  const heartbeatOverrides = opts.useLibraryHeartbeatDefaults
    ? {}
    : {
        heartbeatInterval: opts.heartbeatInterval ?? 500,
        heartbeatTimeout: opts.heartbeatTimeout ?? 1_500,
      };
  io.adapter(
    createAdapter({
      wsPort: meshPort,
      serverAddress: `ws://localhost:${meshPort}`,
      discoveryServiceAddress: `ws://localhost:${opts.discoveryPort}`,
      ...heartbeatOverrides,
      metrics: metricsPort !== undefined ? { port: metricsPort, host: "127.0.0.1" } : undefined,
    })
  );

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const httpPort = (httpServer.address() as AddressInfo).port;

  return {
    io,
    httpServer,
    httpPort,
    meshPort,
    metricsPort,
    close: async () => {
      await io.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

export async function bootCluster(n: number): Promise<{
  discovery: { close: () => Promise<void> };
  nodes: TestNode[];
  cleanup: () => Promise<void>;
}> {
  const discovery = await bootDiscovery();
  const nodes: TestNode[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push(await bootNode({ discoveryPort: discovery.port }));
  }
  // Wait for mesh-up + a few heartbeats so serverCount() converges.
  await waitFor(
    async () => {
      for (const node of nodes) {
        const sc = await node.io.of("/").adapter.serverCount();
        if (sc !== n) return false;
      }
      return true;
    },
    { timeoutMs: 8_000, label: `mesh-of-${n}` }
  );
  return {
    discovery,
    nodes,
    cleanup: async () => {
      for (const node of nodes) {
        try {
          await node.close();
        } catch {
          // ignore
        }
      }
      await shutdownAdapter();
      await discovery.close();
      await sleep(50);
    },
  };
}

export async function clientFor(node: TestNode): Promise<ClientSocket> {
  const c = ioc(`http://localhost:${node.httpPort}`, {
    transports: ["websocket"],
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("client connect timeout")), 5_000);
    c.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    c.once("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return c;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  opts: { timeoutMs?: number; pollMs?: number; label?: string } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const pollMs = opts.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(pollMs);
  }
  throw new Error(`waitFor timeout: ${opts.label ?? "predicate"}`);
}
