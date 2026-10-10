/**
 * Regression tests for GitHub issue #1 (ws reconnection / half-open links):
 * - Discovery client must detect a half-open discovery socket and reconnect.
 * - Peer mesh links must detect half-open sockets via WebSocket ping/pong.
 * - A peer disappearing from the discovery roster must NOT tear down a live
 *   mesh link (discovery blips / proxy idle cuts used to flap the mesh).
 */
import { createServer, connect, type Socket } from "net";
import { afterEach, describe, expect, it } from "vitest";

import { DiscoveryClient } from "../src/discovery/discovery-client";
import { startDiscoveryServer } from "../src/discovery/discovery-server";
import { MeshTransport } from "../src/transport/mesh-transport";
import { sleep, waitFor } from "./helpers";

let portCursor = 24000 + Math.floor(Math.random() * 3_000);
const nextPort = () => portCursor++;

/**
 * TCP proxy that can blackhole an established connection without sending FIN
 * to the client side — the classic half-open failure mode idle proxies /
 * middleboxes produce.
 */
function startHalfOpenProxy(listenPort: number, targetPort: number): {
  blackhole: () => void;
  close: () => void;
} {
  // Bumping `epoch` freezes every pair born under the previous value (stop
  // forwarding, and do not propagate upstream close → client stays half-open).
  // Connections accepted after the bump work normally again, so reconnects
  // can heal.
  let epoch = 0;
  const pairs = new Set<{ client: Socket; upstream: Socket }>();
  const srv = createServer((client) => {
    const born = epoch;
    const upstream = connect(targetPort, "127.0.0.1");
    const pair = { client, upstream };
    pairs.add(pair);
    const live = () => born === epoch;
    client.on("data", (d) => {
      if (live()) upstream.write(d);
    });
    upstream.on("data", (d) => {
      if (live()) client.write(d);
    });
    upstream.on("close", () => {
      if (live()) client.destroy();
      pairs.delete(pair);
    });
    client.on("close", () => {
      upstream.destroy();
      pairs.delete(pair);
    });
    client.on("error", () => {});
    upstream.on("error", () => {});
  });
  srv.listen(listenPort, "127.0.0.1");

  return {
    blackhole: () => {
      epoch++;
    },
    close: () => {
      for (const { client, upstream } of pairs) {
        client.destroy();
        upstream.destroy();
      }
      pairs.clear();
      srv.close();
    },
  };
}

describe("keepalive / half-open recovery (issue #1)", () => {
  let cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const c of cleanups.reverse()) {
      try {
        await c();
      } catch {
        // ignore
      }
    }
    cleanups = [];
  });

  it("DiscoveryClient reconnects after a half-open discovery link", async () => {
    const discoveryPort = nextPort();
    const proxyPort = nextPort();
    // Short server ping so the client watchdog can fire quickly.
    const discovery = startDiscoveryServer({
      port: discoveryPort,
      pingIntervalMs: 200,
    });
    cleanups.push(() => discovery.close());
    const proxy = startHalfOpenProxy(proxyPort, discoveryPort);
    cleanups.push(() => proxy.close());
    await sleep(50);

    let connectedCount = 0;
    let disconnectedCount = 0;
    const dc = new DiscoveryClient({
      url: `ws://127.0.0.1:${proxyPort}`,
      uid: "half-open-client",
      address: "ws://127.0.0.1:9999",
      initialBackoffMs: 50,
      maxBackoffMs: 200,
      // Must exceed ~2× server pingInterval so a healthy link is never killed,
      // but stay short enough for the test.
      pingWatchdogMs: 600,
    });
    dc.on("connected", () => connectedCount++);
    dc.on("disconnected", () => disconnectedCount++);
    dc.connect();
    cleanups.push(() => dc.close());

    await waitFor(() => connectedCount === 1, {
      timeoutMs: 2_000,
      label: "initial-connect",
    });

    proxy.blackhole();

    await waitFor(() => connectedCount >= 2 && disconnectedCount >= 1, {
      timeoutMs: 5_000,
      label: "reconnected-after-half-open",
    });
    expect(connectedCount).toBeGreaterThanOrEqual(2);
  });

  it("MeshTransport heals a half-open peer link via WebSocket ping", async () => {
    const aPort = nextPort();
    const bPort = nextPort();
    const proxyPort = nextPort();
    const proxy = startHalfOpenProxy(proxyPort, bPort);
    cleanups.push(() => proxy.close());

    // a (lex-smaller) dials b through the proxy.
    const a = new MeshTransport({
      uid: "aaaaaaaaaaaaaaaa",
      wsPort: aPort,
      serverAddress: `ws://127.0.0.1:${aPort}`,
      pingIntervalMs: 200,
      initialReconnectBackoffMs: 50,
      maxReconnectBackoffMs: 200,
    });
    const b = new MeshTransport({
      uid: "bbbbbbbbbbbbbbbb",
      wsPort: bPort,
      serverAddress: `ws://127.0.0.1:${proxyPort}`,
      pingIntervalMs: 200,
      initialReconnectBackoffMs: 50,
      maxReconnectBackoffMs: 200,
    });
    cleanups.push(async () => {
      await a.close();
      await b.close();
    });

    let aDown = 0;
    let aUp = 0;
    a.on("peer-up", () => aUp++);
    a.on("peer-down", () => aDown++);

    a.applyPeerList([
      { serverId: "aaaaaaaaaaaaaaaa", address: `ws://127.0.0.1:${aPort}` },
      { serverId: "bbbbbbbbbbbbbbbb", address: `ws://127.0.0.1:${proxyPort}` },
    ]);
    // b waits for inbound (lex-larger). Still seed knownAddresses so address
    // bookkeeping stays consistent if we later extend the test.
    b.applyPeerList([
      { serverId: "aaaaaaaaaaaaaaaa", address: `ws://127.0.0.1:${aPort}` },
      { serverId: "bbbbbbbbbbbbbbbb", address: `ws://127.0.0.1:${proxyPort}` },
    ]);

    await waitFor(() => a.peerCount() === 1 && b.peerCount() === 1, {
      timeoutMs: 3_000,
      label: "mesh-up",
    });
    expect(aUp).toBe(1);

    let framesAfterHeal = 0;
    b.on("mesh-frame", () => framesAfterHeal++);

    proxy.blackhole();

    // Without ping, a would keep thinking the peer is up forever. With ping
    // (200ms), a terminates after one missed pong (~400ms) and reconnects.
    await waitFor(() => aDown >= 1, {
      timeoutMs: 3_000,
      label: "peer-down-after-half-open",
    });
    await waitFor(() => a.peerCount() === 1 && b.peerCount() === 1, {
      timeoutMs: 5_000,
      label: "mesh-healed",
    });

    a.sendMeshToAll(Buffer.from("after-heal", "utf8"), 0);
    await waitFor(() => framesAfterHeal >= 1, {
      timeoutMs: 2_000,
      label: "frame-after-heal",
    });
  });

  it("keeps a live peer connection when the peer leaves the discovery roster", async () => {
    const discoveryPort = nextPort();
    const discovery = startDiscoveryServer({
      port: discoveryPort,
      pingIntervalMs: 500,
    });
    cleanups.push(() => discovery.close());
    await sleep(50);

    const aPort = nextPort();
    const bPort = nextPort();
    const a = new MeshTransport({
      uid: "aaaaaaaaaaaaaaaa",
      wsPort: aPort,
      serverAddress: `ws://127.0.0.1:${aPort}`,
      pingIntervalMs: 500,
    });
    const b = new MeshTransport({
      uid: "bbbbbbbbbbbbbbbb",
      wsPort: bPort,
      serverAddress: `ws://127.0.0.1:${bPort}`,
      pingIntervalMs: 500,
    });
    const aDc = new DiscoveryClient({
      url: `ws://127.0.0.1:${discoveryPort}`,
      uid: "aaaaaaaaaaaaaaaa",
      address: `ws://127.0.0.1:${aPort}`,
      initialBackoffMs: 50,
      maxBackoffMs: 200,
      pingWatchdogMs: 2_000,
    });
    const bDc = new DiscoveryClient({
      url: `ws://127.0.0.1:${discoveryPort}`,
      uid: "bbbbbbbbbbbbbbbb",
      address: `ws://127.0.0.1:${bPort}`,
      initialBackoffMs: 50,
      maxBackoffMs: 200,
      pingWatchdogMs: 2_000,
    });
    aDc.on("peer-list", (peers) => a.applyPeerList(peers));
    bDc.on("peer-list", (peers) => b.applyPeerList(peers));
    aDc.connect();
    bDc.connect();
    cleanups.push(async () => {
      await aDc.close();
      await bDc.close();
      await a.close();
      await b.close();
    });

    await waitFor(() => a.peerCount() === 1 && b.peerCount() === 1, {
      timeoutMs: 5_000,
      label: "mesh-up-via-discovery",
    });

    let aDown = 0;
    a.on("peer-down", () => aDown++);

    // Simulate discovery forgetting b (e.g. b's discovery socket blipped).
    // Previously this called dropPeer("left-discovery") and flapped the mesh.
    a.applyPeerList([
      { serverId: "aaaaaaaaaaaaaaaa", address: `ws://127.0.0.1:${aPort}` },
    ]);

    await sleep(500);
    expect(a.peerCount()).toBe(1);
    expect(aDown).toBe(0);

    let received = 0;
    b.on("mesh-frame", () => received++);
    a.sendMeshToAll(Buffer.from("still-alive", "utf8"), 0);
    await waitFor(() => received === 1, {
      timeoutMs: 1_000,
      label: "frame-over-kept-link",
    });
  });
});
