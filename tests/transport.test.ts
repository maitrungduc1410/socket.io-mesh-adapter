import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiscoveryClient } from "../src/discovery/discovery-client";
import { MeshTransport } from "../src/transport/mesh-transport";
import { startDiscoveryServer } from "../src/discovery/discovery-server";
import { sleep, waitFor } from "./helpers";

let portCursor = 22000;
const nextPort = () => portCursor++;

describe("MeshTransport", () => {
  let discovery: { close: () => Promise<void> } | null = null;
  let cleanups: Array<() => Promise<void>> = [];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const c of cleanups.reverse()) {
      try {
        await c();
      } catch {
        // ignore
      }
    }
    if (discovery) await discovery.close();
    discovery = null;
  });

  async function spawnNode(uid: string, discoveryPort: number) {
    const wsPort = nextPort();
    const transport = new MeshTransport({
      uid,
      wsPort,
      serverAddress: `ws://localhost:${wsPort}`,
    });
    const dc = new DiscoveryClient({
      url: `ws://localhost:${discoveryPort}`,
      uid,
      address: `ws://localhost:${wsPort}`,
    });
    dc.on("peer-list", (peers) => transport.applyPeerList(peers));
    dc.connect();
    cleanups.push(async () => {
      await dc.close();
      await transport.close();
    });
    return { transport, dc, wsPort };
  }

  it("forms a fully-connected mesh of 3 peers", async () => {
    const discoveryPort = nextPort();
    discovery = startDiscoveryServer({ port: discoveryPort });
    await sleep(50);

    const a = await spawnNode("aaaaaaaaaaaaaaaa", discoveryPort);
    const b = await spawnNode("bbbbbbbbbbbbbbbb", discoveryPort);
    const c = await spawnNode("cccccccccccccccc", discoveryPort);

    await waitFor(
      () =>
        a.transport.peerCount() === 2 &&
        b.transport.peerCount() === 2 &&
        c.transport.peerCount() === 2,
      { timeoutMs: 5_000, label: "all-peers-connected" }
    );

    expect(a.transport.peerCount()).toBe(2);
    expect(b.transport.peerCount()).toBe(2);
    expect(c.transport.peerCount()).toBe(2);
  });

  it("ensures only the lex-smaller uid initiates (one socket per pair)", async () => {
    const discoveryPort = nextPort();
    discovery = startDiscoveryServer({ port: discoveryPort });
    await sleep(50);

    const a = await spawnNode("aaaaaaaaaaaaaaaa", discoveryPort);
    const b = await spawnNode("bbbbbbbbbbbbbbbb", discoveryPort);

    await waitFor(
      () => a.transport.peerCount() === 1 && b.transport.peerCount() === 1,
      { timeoutMs: 5_000 }
    );

    const aPeers = a.transport.listPeers();
    const bPeers = b.transport.listPeers();

    expect(aPeers).toHaveLength(1);
    expect(bPeers).toHaveLength(1);
    // The lex-smaller uid (aaa...) initiated the connection
    expect(aPeers[0].direction).toBe("outbound");
    expect(bPeers[0].direction).toBe("inbound");
  });

  it("delivers mesh frames between peers", async () => {
    const discoveryPort = nextPort();
    discovery = startDiscoveryServer({ port: discoveryPort });
    await sleep(50);

    const a = await spawnNode("aaaaaaaaaaaaaaaa", discoveryPort);
    const b = await spawnNode("bbbbbbbbbbbbbbbb", discoveryPort);

    await waitFor(() => a.transport.peerCount() === 1 && b.transport.peerCount() === 1);

    const received: Array<{ payload: Buffer; fromUid: string }> = [];
    b.transport.on("mesh-frame", (payload, fromUid) => {
      received.push({ payload, fromUid });
    });

    a.transport.sendMeshToAll(Buffer.from("hello-mesh", "utf8"));

    await waitFor(() => received.length === 1, { timeoutMs: 1_000 });
    expect(received[0].payload.toString("utf8")).toBe("hello-mesh");
    expect(received[0].fromUid).toBe("aaaaaaaaaaaaaaaa");
  });

  it("emits peer-down when a peer is closed", async () => {
    const discoveryPort = nextPort();
    discovery = startDiscoveryServer({ port: discoveryPort });
    await sleep(50);

    const a = await spawnNode("aaaaaaaaaaaaaaaa", discoveryPort);
    const b = await spawnNode("bbbbbbbbbbbbbbbb", discoveryPort);

    await waitFor(() => a.transport.peerCount() === 1 && b.transport.peerCount() === 1);

    let aSawPeerDown = false;
    a.transport.on("peer-down", () => {
      aSawPeerDown = true;
    });

    // Close b's transport entirely (simulates a crashed pod from a's POV)
    await b.transport.close();
    await b.dc.close();

    await waitFor(() => aSawPeerDown && a.transport.peerCount() === 0, {
      timeoutMs: 3_000,
      label: "peer-down-emitted",
    });

    expect(aSawPeerDown).toBe(true);
    expect(a.transport.peerCount()).toBe(0);
  });
});
