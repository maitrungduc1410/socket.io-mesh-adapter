/**
 * Regression test for the "heartbeat storm" bug.
 *
 * Previously, `createAdapter()` forwarded `heartbeatInterval: undefined` and
 * `heartbeatTimeout: undefined` to the upstream `ClusterAdapterWithHeartbeat`,
 * which uses `Object.assign({hbInt: 5000, ...}, opts)` to merge defaults.
 * `Object.assign` overwrites with `undefined`, leaving `_opts.hbInt`
 * undefined and `setTimeout(fn, undefined)` firing at ~1ms intervals — a
 * heartbeat storm of ~500-900 ops/sec/pod.
 *
 * This test boots a 2-node mesh WITHOUT passing any heartbeat options to
 * `createAdapter`. With the library's 5s default in effect, fewer than ~10
 * `heartbeat`-type messages should be sent across a 2-second observation
 * window. With the bug, the count would be in the hundreds.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  bootDiscovery,
  bootNode,
  shutdownAdapter,
  sleep,
  waitFor,
} from "./helpers";

async function fetchHeartbeatsSent(port: number): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/metrics`);
  if (!res.ok) throw new Error(`metrics scrape failed: ${res.status}`);
  const body = await res.text();
  const re = /^socketio_mesh_messages_sent_total\{[^}]*type="heartbeat"[^}]*\} (\d+)$/m;
  const m = body.match(re);
  return m ? Number(m[1]) : 0;
}

describe("heartbeat defaults (regression: heartbeat storm)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) {
      try {
        await fn();
      } catch {
        // ignore
      }
    }
    await shutdownAdapter();
    await sleep(50);
  });

  it("falls back to the library 5s default when no heartbeat options are passed", async () => {
    const discovery = await bootDiscovery();
    cleanups.push(discovery.close);

    const a = await bootNode({
      discoveryPort: discovery.port,
      useLibraryHeartbeatDefaults: true,
      metricsPort: 0,
    });
    const b = await bootNode({
      discoveryPort: discovery.port,
      useLibraryHeartbeatDefaults: true,
      metricsPort: 0,
    });
    cleanups.push(a.close, b.close);

    // Wait for the 2-node mesh to converge. With the bug (1ms heartbeat
    // refresh), peers learn about each other via the storm itself, so we
    // need the convergence wait to be long enough that the bug-version
    // would have built up thousands of heartbeats.
    await waitFor(
      async () => {
        const sa = await a.io.of("/").adapter.serverCount();
        const sb = await b.io.of("/").adapter.serverCount();
        return sa === 2 && sb === 2;
      },
      { timeoutMs: 8_000, label: "2-node convergence with default heartbeat" }
    );

    // Snapshot heartbeats sent at this moment, then again 2s later.
    const before = await Promise.all([
      fetchHeartbeatsSent(a.metricsPort!),
      fetchHeartbeatsSent(b.metricsPort!),
    ]);
    await sleep(2_000);
    const after = await Promise.all([
      fetchHeartbeatsSent(a.metricsPort!),
      fetchHeartbeatsSent(b.metricsPort!),
    ]);

    const deltaA = after[0] - before[0];
    const deltaB = after[1] - before[1];
    const total = deltaA + deltaB;

    // With the bug, this would be ~1000-2000.
    // With a 5s heartbeat interval, expect 0-2 heartbeats sent per pod
    // during a 2-second observation window (at most one timer firing).
    expect(total).toBeLessThan(10);
  });
});
