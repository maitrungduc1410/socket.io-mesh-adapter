import { MeshAdapter } from "./mesh-adapter";
import { MeshContext } from "./mesh-context";
import type { MeshAdapterOptions } from "./types";

/**
 * Per-process registry of mesh contexts, keyed by `wsPort`. Sharing one
 * transport across all namespaces created in the same process keeps the
 * connection count low (one peer connection per pair, regardless of how many
 * namespaces a user creates).
 */
const contexts = new Map<number, MeshContext>();

function getOrCreateContext(opts: MeshAdapterOptions): MeshContext {
  const wsPort = opts.wsPort ?? 4000;
  let ctx = contexts.get(wsPort);
  if (!ctx) {
    ctx = new MeshContext(opts);
    contexts.set(wsPort, ctx);
  }
  return ctx;
}

/**
 * Returns a Socket.IO adapter factory that uses a peer-to-peer WebSocket mesh
 * for cross-server messaging.
 *
 * @example
 * ```ts
 * import { Server } from "socket.io";
 * import { createAdapter } from "socket.io-mesh-adapter";
 *
 * const io = new Server(httpServer);
 * io.adapter(createAdapter({
 *   wsPort: 4000,
 *   serverAddress: "ws://10.0.0.1:4000",
 *   discoveryServiceAddress: "ws://discovery:8000",
 * }));
 * ```
 */
export function createAdapter(opts: MeshAdapterOptions) {
  const ctx = getOrCreateContext(opts);
  // Only forward heartbeat options when the caller explicitly set them.
  // `socket.io-adapter`'s ClusterAdapterWithHeartbeat merges defaults via
  // `Object.assign({hbInt: 5000, ...}, opts)`, which overwrites the defaults
  // when `opts.hbInt` is `undefined`, leaving `setTimeout(fn, undefined)` —
  // i.e. a heartbeat storm at ~1ms intervals.
  const heartbeatOpts: { heartbeatInterval?: number; heartbeatTimeout?: number } = {};
  if (opts.heartbeatInterval !== undefined) {
    heartbeatOpts.heartbeatInterval = opts.heartbeatInterval;
  }
  if (opts.heartbeatTimeout !== undefined) {
    heartbeatOpts.heartbeatTimeout = opts.heartbeatTimeout;
  }
  return function adapterFactory(nsp: any) {
    return new MeshAdapter(nsp, ctx, heartbeatOpts);
  };
}

/**
 * Tear down all mesh contexts in this process. Intended for tests and
 * controlled shutdowns; production code should let process exit handle it.
 */
export async function shutdownAdapter(): Promise<void> {
  const tasks = [...contexts.values()].map((c) => c.close());
  contexts.clear();
  await Promise.all(tasks);
}

export { MeshAdapter } from "./mesh-adapter";
export { MeshContext } from "./mesh-context";
export { MeshTransport } from "./transport/mesh-transport";
export { DiscoveryClient } from "./discovery/discovery-client";
export { startDiscoveryServer } from "./discovery/discovery-server";
export type { MeshAdapterOptions } from "./types";
export type { PeerEntry } from "./discovery/protocol";
