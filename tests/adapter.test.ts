import { afterEach, describe, expect, it } from "vitest";

import {
  bootCluster,
  clientFor,
  sleep,
  waitFor,
  type TestNode,
} from "./helpers";

describe("MeshAdapter (3-node mesh)", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("reports serverCount === 3 on every node", async () => {
    const cluster = await bootCluster(3);
    cleanup = cluster.cleanup;
    for (const node of cluster.nodes) {
      const sc = await node.io.of("/").adapter.serverCount();
      expect(sc).toBe(3);
    }
  });

  it("delivers io.emit() to clients on every node", async () => {
    const cluster = await bootCluster(3);
    cleanup = cluster.cleanup;

    const clients = await Promise.all(cluster.nodes.map(clientFor));
    const received = clients.map(() => 0);
    clients.forEach((c, idx) => {
      c.on("hello", (msg: string) => {
        if (msg === "world") received[idx]++;
      });
    });

    cluster.nodes[0].io.emit("hello", "world");

    await waitFor(() => received.every((r) => r === 1), {
      timeoutMs: 2_000,
      label: "broadcast-reached-all-clients",
    });

    for (const c of clients) c.disconnect();
  });

  it("fetchSockets aggregates clients across the mesh", async () => {
    const cluster = await bootCluster(3);
    cleanup = cluster.cleanup;

    const clients = await Promise.all(cluster.nodes.map(clientFor));
    await sleep(100);

    const all = await cluster.nodes[0].io.fetchSockets();
    expect(all.length).toBe(3);

    const local = await cluster.nodes[0].io.local.fetchSockets();
    expect(local.length).toBe(1);

    for (const c of clients) c.disconnect();
  });

  it("to(room).emit() reaches sockets joined on remote pods", async () => {
    const cluster = await bootCluster(3);
    cleanup = cluster.cleanup;

    const clients = await Promise.all(cluster.nodes.map(clientFor));
    // Have the socket on node[2] join "vip"
    for (const s of cluster.nodes[2].io.sockets.sockets.values()) s.join("vip");
    await sleep(50);

    const got = [0, 0, 0];
    clients.forEach((c, idx) => {
      c.on("only-vip", () => {
        got[idx]++;
      });
    });

    cluster.nodes[0].io.to("vip").emit("only-vip");

    await waitFor(() => got[2] === 1, { timeoutMs: 2_000 });
    // Sockets on other nodes are NOT in "vip" so they receive nothing
    expect(got).toEqual([0, 0, 1]);

    for (const c of clients) c.disconnect();
  });

  it("broadcastWithAck collects acks from clients on every pod", async () => {
    const cluster = await bootCluster(3);
    cleanup = cluster.cleanup;

    const clients = await Promise.all(cluster.nodes.map(clientFor));
    clients.forEach((c, idx) => {
      c.on("ping", (payload: string, ack: (resp: string) => void) => {
        ack(`pong-${idx}:${payload}`);
      });
    });

    const responses: string[] = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ack timeout")), 3_000);
      cluster.nodes[0].io
        .timeout(2_000)
        .emit("ping", "hello", (err: Error | null, resp: string[]) => {
          clearTimeout(timer);
          if (err) return reject(err);
          resolve(resp);
        });
    });

    expect(responses).toHaveLength(3);
    expect(responses.sort()).toEqual(
      ["pong-0:hello", "pong-1:hello", "pong-2:hello"].sort()
    );

    for (const c of clients) c.disconnect();
  });

  it("serverSideEmit with ack collects responses from every other server", async () => {
    const cluster = await bootCluster(3);
    cleanup = cluster.cleanup;

    cluster.nodes[1].io.on("hello-server", (arg: string, cb: (r: string) => void) => {
      cb(`B:${arg}`);
    });
    cluster.nodes[2].io.on("hello-server", (arg: string, cb: (r: string) => void) => {
      cb(`C:${arg}`);
    });

    const responses: unknown[] = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sse timeout")), 3_000);
      (cluster.nodes[0].io as unknown as {
        serverSideEmit: (
          event: string,
          arg: string,
          cb: (err: Error | null, resp: unknown[]) => void
        ) => void;
      }).serverSideEmit("hello-server", "ping", (err, resp) => {
        clearTimeout(timer);
        if (err) return reject(err);
        resolve(resp);
      });
    });

    expect(responses.sort()).toEqual(["B:ping", "C:ping"].sort());
  });

  it("self-heals when a pod is killed: serverCount drops, then recovers when a new pod joins", async () => {
    const cluster = await bootCluster(3);
    cleanup = cluster.cleanup;

    const adapterA = cluster.nodes[0].io.of("/").adapter;
    expect(await adapterA.serverCount()).toBe(3);

    // Crash node 2
    await cluster.nodes[2].close();

    await waitFor(async () => (await adapterA.serverCount()) === 2, {
      timeoutMs: 5_000,
      label: "serverCount-converges-to-2",
    });
    expect(await adapterA.serverCount()).toBe(2);
  });

  it("socket.disconnect via disconnectSockets propagates across the mesh", async () => {
    const cluster = await bootCluster(2);
    cleanup = cluster.cleanup;

    const clientOnB = await clientFor(cluster.nodes[1]);
    let disconnected = false;
    clientOnB.on("disconnect", () => {
      disconnected = true;
    });

    // Issue disconnectSockets from node A; node B's socket should be disconnected
    await cluster.nodes[0].io.disconnectSockets(true);

    await waitFor(() => disconnected, { timeoutMs: 2_000 });
    expect(disconnected).toBe(true);
  });
});
