/**
 * Verifies that when `metrics` is omitted, `prom-client` is never required
 * and no metrics HTTP port is opened. Lives in its own file so vitest's
 * per-file worker isolation gives this a clean module cache.
 */
import { sep } from "path";
import { describe, expect, it } from "vitest";

import { bootCluster } from "./helpers";

function isPromClientLoaded(): boolean {
  return Object.keys(require.cache).some((k) =>
    k.includes(`${sep}prom-client${sep}`)
  );
}

describe("metrics (disabled)", () => {
  it("does not load prom-client and does not open a metrics port", async () => {
    expect(isPromClientLoaded()).toBe(false);

    const cluster = await bootCluster(2);
    try {
      // Sanity: 2-node mesh actually converged.
      for (const n of cluster.nodes) {
        expect(await n.io.of("/").adapter.serverCount()).toBe(2);
        expect((n as { metricsPort?: number }).metricsPort).toBeUndefined();
      }
      expect(isPromClientLoaded()).toBe(false);
    } finally {
      await cluster.cleanup();
    }
  });
});
