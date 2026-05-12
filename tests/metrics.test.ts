/**
 * Boot a 2-node mesh with metrics enabled and assert that counters / gauges
 * scraped from `/metrics` reflect actual mesh activity.
 *
 * The "prom-client is not loaded when metrics are off" assertion lives in
 * its own file (`metrics-disabled.test.ts`) so vitest's per-file worker
 * isolation gives it a clean require.cache.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  bootDiscovery,
  bootNode,
  clientFor,
  shutdownAdapter,
  sleep,
  waitFor,
} from "./helpers";

async function fetchMetrics(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/metrics`);
  if (!res.ok) throw new Error(`metrics scrape failed: ${res.status}`);
  return await res.text();
}

function metricValue(body: string, line: string): number | undefined {
  const re = new RegExp(`^${line.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")} (.+)$`, "m");
  const m = body.match(re);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

function counterTotal(body: string, name: string): number {
  let sum = 0;
  const re = new RegExp(`^${name}(?:\\{[^}]*\\})? (\\d+(?:\\.\\d+)?)$`, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) sum += Number(m[1]);
  return sum;
}

describe("metrics", () => {
  let cleanups: Array<() => Promise<void>> = [];

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

  it("exposes /metrics with peer + message gauges/counters on a 2-node mesh", async () => {
    const discovery = await bootDiscovery();
    cleanups.push(discovery.close);

    const a = await bootNode({ discoveryPort: discovery.port, metricsPort: 0 });
    const b = await bootNode({ discoveryPort: discovery.port, metricsPort: 0 });
    cleanups.push(a.close, b.close);

    // Wait for the mesh of 2 to converge.
    await waitFor(
      async () => {
        const sa = await a.io.of("/").adapter.serverCount();
        const sb = await b.io.of("/").adapter.serverCount();
        return sa === 2 && sb === 2;
      },
      { timeoutMs: 8_000, label: "2-node convergence" }
    );

    // Trigger some traffic that should show up in metrics.
    const client = await clientFor(a);
    cleanups.push(async () => {
      client.disconnect();
    });

    await a.io.fetchSockets();
    await b.io.fetchSockets();
    a.io.emit("hello", "world");
    await sleep(100);

    expect(a.metricsPort).toBeDefined();
    expect(b.metricsPort).toBeDefined();

    const bodyA = await fetchMetrics(a.metricsPort!);
    const bodyB = await fetchMetrics(b.metricsPort!);

    expect(metricValue(bodyA, "socketio_mesh_peers_connected")).toBe(1);
    expect(metricValue(bodyB, "socketio_mesh_peers_connected")).toBe(1);
    expect(metricValue(bodyA, "socketio_mesh_peers_expected")).toBe(1);
    expect(metricValue(bodyB, "socketio_mesh_peers_expected")).toBe(1);
    expect(metricValue(bodyA, "socketio_mesh_namespaces")).toBeGreaterThanOrEqual(1);

    // Some message activity should be visible (heartbeats + the fetchSockets
    // round-trip + the broadcast).
    expect(counterTotal(bodyA, "socketio_mesh_messages_sent_total")).toBeGreaterThan(0);
    expect(counterTotal(bodyA, "socketio_mesh_messages_received_total")).toBeGreaterThan(0);
    expect(counterTotal(bodyB, "socketio_mesh_messages_sent_total")).toBeGreaterThan(0);
    expect(counterTotal(bodyB, "socketio_mesh_messages_received_total")).toBeGreaterThan(0);

    // Default-metrics sanity check: nodejs_eventloop_lag_seconds should be
    // registered if prom-client's collectDefaultMetrics is wired up.
    expect(bodyA).toContain("nodejs_eventloop_lag_seconds");
  });
});
