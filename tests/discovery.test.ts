import { afterEach, describe, expect, it } from "vitest";

import { DiscoveryClient } from "../src/discovery/discovery-client";
import { startDiscoveryServer } from "../src/discovery/discovery-server";
import { sleep, waitFor } from "./helpers";

let portCursor = 23000;
const nextPort = () => portCursor++;

describe("DiscoveryClient", () => {
  let cleanups: Array<() => Promise<void>> = [];

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

  it("registers with the discovery server and receives the roster", async () => {
    const port = nextPort();
    const discovery = startDiscoveryServer({ port });
    cleanups.push(() => discovery.close());
    await sleep(50);

    const rosters: Array<Array<{ serverId: string; address: string }>> = [];
    const dc1 = new DiscoveryClient({
      url: `ws://localhost:${port}`,
      uid: "node-one",
      address: "ws://localhost:1111",
    });
    dc1.on("peer-list", (peers) => rosters.push(peers));
    dc1.connect();
    cleanups.push(() => dc1.close());

    const dc2 = new DiscoveryClient({
      url: `ws://localhost:${port}`,
      uid: "node-two",
      address: "ws://localhost:2222",
    });
    dc2.connect();
    cleanups.push(() => dc2.close());

    await waitFor(
      () =>
        rosters.some(
          (r) =>
            r.length === 2 &&
            r.some((p) => p.serverId === "node-one") &&
            r.some((p) => p.serverId === "node-two")
        ),
      { timeoutMs: 3_000, label: "roster-includes-both" }
    );
  });

  it("reconnects with backoff when the discovery server bounces", async () => {
    const port = nextPort();
    let discovery = startDiscoveryServer({ port });
    cleanups.push(() => discovery.close());
    await sleep(50);

    let connectedCount = 0;
    const dc = new DiscoveryClient({
      url: `ws://localhost:${port}`,
      uid: "reconnect-client",
      address: "ws://localhost:9999",
      initialBackoffMs: 100,
      maxBackoffMs: 500,
    });
    dc.on("connected", () => connectedCount++);
    dc.connect();
    cleanups.push(() => dc.close());

    await waitFor(() => connectedCount === 1, { timeoutMs: 2_000 });

    // Bounce the discovery server
    await discovery.close();
    await sleep(200);
    discovery = startDiscoveryServer({ port });
    cleanups.push(() => discovery.close());

    await waitFor(() => connectedCount >= 2, {
      timeoutMs: 5_000,
      label: "reconnected-after-bounce",
    });
    expect(connectedCount).toBeGreaterThanOrEqual(2);
  });
});
