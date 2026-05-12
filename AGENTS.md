# AGENTS.md

Guidance for AI coding agents working on `socket.io-mesh-adapter`.
Human-facing docs live in [`README.md`](./README.md); this file is the engineering map.

## Project at a glance

`socket.io-mesh-adapter` is a Socket.IO adapter that scales horizontally over a peer-to-peer WebSocket **mesh** instead of a broker. It is a thin subclass of `ClusterAdapterWithHeartbeat` from `socket.io-adapter`: the cluster algorithm (broadcast, `broadcastWithAck`, `fetchSockets`, `serverSideEmit`, heartbeats, request/response correlation) is inherited; we only replace the transport.

The library is **pure Node.js** (no browser code). A separate CLI binary `discovery-server` ships in the same package — peers consult it on join/leave but it is **never on the message hot path**.

## Repository layout

```
src/
  index.ts                       Public surface: `createAdapter`, `shutdownAdapter`, re-exports.
  mesh-adapter.ts                Subclass of `ClusterAdapterWithHeartbeat`. Implements `doPublish`/`doPublishResponse` and wraps `fetchSockets`/`serverSideEmit`/`broadcastWithAck` for metrics.
  mesh-context.ts                Per-`wsPort` singleton. Owns `MeshTransport` + `DiscoveryClient` + (optional) `MetricsRegistry` + `/metrics` HTTP server. Routes inbound frames to the right namespace's adapter.
  transport/mesh-transport.ts    WebSocket peer mesh. HELLO handshake, "lex-smaller UID initiates" rule, backpressure (`bufferedAmount`), per-peer reconnect with jitter.
  discovery/
    discovery-server.ts          Standalone WS discovery service. Optional `/metrics` (METRICS_PORT). Exported as the `discovery-server` bin.
    discovery-client.ts          Reconnecting client used by `MeshContext`.
    protocol.ts                  Wire types shared between client and server.
  metrics.ts                     `MetricsRegistry` interface + `NoopMetricsRegistry` + `PromMetricsRegistry` (lazy `require("prom-client")`).
  metrics-server.ts              Tiny Express `/metrics` + `/health` server. Shared by adapter and discovery server.
  logger.ts                      `createLogger(sub)` → `debug("socket.io-mesh-adapter:" + sub)`.
  types.ts                       `MeshAdapterOptions`, `MetricsOptions`, wire-framing enum.

tests/                           Vitest, file-parallelism off, real ports + real WS.
  helpers.ts                     `bootDiscovery`, `bootNode`, `bootCluster`, `clientFor`, `waitFor`. Allocates random-offset ports per file.
  *.test.ts                      Each file is a worker; do not share state across files.

server.ts                        Demo chat server used by the docker example.
index.html                       Demo UI for the chat server.
examples/docker/                 docker-compose: discovery + 3 apps + Prometheus + Grafana (provisioned).
docs/PHASE2.md                   Roadmap for Phase 2 items (Plugin API, Discovery HA still open).
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run the full vitest suite (currently 17 tests across 6 files). |
| `npx tsc --noEmit` | Typecheck without emitting. Run after any non-trivial change. |
| `npm run build` | Emit `dist/` (CJS). `prepublishOnly` calls this. |
| `npm run dev` | Demo server on `:3000` / mesh `:4000` (`DEBUG=...` already set in script). |
| `npm run dev1` | Second demo server on `:3001` / mesh `:4001`. |
| `npm run dev:discovery` | Discovery service on `:8000`. |
| `cd examples/docker && docker compose up --build` | 3-pod mesh + Prometheus + Grafana stack. |

Always run `npx tsc --noEmit` and `npm test` after edits to `src/`. Tests boot real WebSocket servers on ephemeral ports; total runtime is ~15-20s.

## Architecture rules (preserve these)

1. **Adapter UID == Context UID.** All `MeshAdapter` instances on a single Node.js process share the **context's** UID (see `src/mesh-adapter.ts` constructor — `(this as { uid }).uid = ctx.uid;`). Peer routing in the transport is keyed by UID; multiple namespaces must look like one server to the cluster, otherwise `fetchSockets` aggregation hangs.
2. **One `MeshContext` per `wsPort`** (see `src/index.ts` `contexts` map). Multiple `io.adapter(createAdapter(...))` calls in the same process must share transport. Never construct `MeshContext` directly outside `index.ts`.
3. **`prom-client` is lazy-loaded.** It must NOT be top-level imported anywhere in `src/`. Only `PromMetricsRegistry`'s constructor `require()`s it. Tests verify this in `tests/metrics-disabled.test.ts`.
4. **One peer connection per pair.** The lex-smaller UID initiates; the larger one waits. See `MeshTransport.maybeInitiate`. Don't relax this — it doubles file descriptors and produces duplicate-frame bugs.
5. **Discovery is bootstrap-only.** Never put data-plane traffic through it. Heartbeats, broadcasts, fetchSockets all flow peer-to-peer.
6. **Frames carry a 1-byte kind.** `FrameKind.Hello` (0x00) is mandatory first message; `FrameKind.Mesh` (0x01) carries the msgpack-encoded `ClusterMessage`/`ClusterResponse`. Don't add new frame kinds without updating both transport ends.
7. **Metrics are opt-in.** When `metrics` option is omitted, `NoopMetricsRegistry` is plumbed and no HTTP server is started. Hot paths (`sendMeshToAll`, `dispatch`) must compile to no-op calls in this case.

## Gotchas (real bugs we've shipped)

1. **`Object.assign(defaults, opts)` overwrites with `undefined`.** Never forward an option as `{ key: opts.key }` when the user didn't set it — strip `undefined` keys before merging into something with defaults. See `createAdapter` in `src/index.ts` and the regression test in `tests/heartbeat-defaults.test.ts`. The bug previously caused heartbeats to fire at ~1ms instead of 5s.

2. **`host = "0.0.0.0"` is IPv4-only.** Alpine images resolve `localhost` to `::1` first, which then refuses connection. `metrics-server.ts` defaults `host` to *undefined* so Node binds dual-stack (`::`). If you add another HTTP server, do the same.

3. **`setTimeout(fn, undefined)` fires at 1ms.** Related to #1. Always validate that timer delays are real numbers.

4. **`debug` is silent without `DEBUG=*`.** Logs via `createLogger(...)` are invisible by default. User-actionable failures (e.g. "metrics server failed to start") must ALSO emit `console.warn` — never rely on debug alone for visibility.

5. **Vitest 4 option rename.** `vitest.config.ts` uses `fileParallelism: false`, not `fileParallel: false`. The latter is silently ignored and tests collide on ports.

6. **Port collisions in tests.** Each test file gets a random starting offset (`tests/helpers.ts`) because vitest workers can interleave port allocations. Don't hard-code ports in tests.

7. **`scheduleHeartbeat` refreshes its timer on every `publish`.** Be careful before adding extra `publish` calls — they will *suppress* heartbeats, which can mask a missing-heartbeat bug.

## Coding conventions

- **TypeScript strict mode.** No `any` unless interfacing with the cluster-adapter's loose types (already isolated to `mesh-adapter.ts` overrides).
- **Logging**: use `createLogger("subsystem")`. `console.log` is reserved for startup banners. `console.warn` is reserved for user-actionable failures the user must see without `DEBUG`.
- **No narration comments.** Don't add comments that describe what code does. Comments explain *why* (intent, trade-offs, non-obvious constraints). The "Object.assign undefined" bug comment in `src/index.ts` is the model.
- **Don't add runtime deps lightly.** Current runtime deps: `@msgpack/msgpack`, `debug`, `express`, `prom-client`, `socket.io-adapter`, `ws`. Adding to this list is a real cost to every consumer.
- **`socket.io` is a `peerDependency`**, not a dependency. The adapter implements its types; the user supplies the instance.
- **Per-process singletons live in `src/index.ts`**, not inside class instances.

## Testing patterns

- Use the helpers in `tests/helpers.ts` — `bootDiscovery`, `bootNode`, `bootCluster`. Don't construct `Server`/`createAdapter` manually unless you're testing a specific edge case (see `tests/heartbeat-defaults.test.ts`).
- For metrics-enabled tests, pass `metricsPort: 0` to `bootNode` (random port). Scrape via `fetch("http://127.0.0.1:" + port + "/metrics")`.
- To exercise the **library's default heartbeat interval** (5s, not the test-friendly 500ms), pass `useLibraryHeartbeatDefaults: true` to `bootNode`.
- `tests/metrics-disabled.test.ts` MUST stay in its own file — it asserts `prom-client` is absent from `require.cache`, and vitest's per-file worker isolation is what gives it a clean cache.
- `afterEach` should always `await shutdownAdapter()` and `await sleep(50)` to release ports before the next test.
- Convergence checks use `waitFor(predicate, { timeoutMs })`. Don't `setTimeout` your way to determinism.

## Build and publish

- `tsc` only — no bundler. CJS output to `dist/`. The library ships as per-file `.js` + `.d.ts` + `.js.map`. Don't bundle without explicit reason (Node-library bundling has weak benefits and breaks sub-path imports).
- `dist/discovery/discovery-server.js` retains the `#!/usr/bin/env node` shebang from the source. Exposed via `bin` in `package.json` as both `socket.io-mesh-adapter` and `discovery-server`.
- `prepublishOnly` runs the build. Never publish without a clean `npm test && npm run build`.

## When you're stuck

- Mesh formation issue → log peer events from `src/transport/mesh-transport.ts` via `DEBUG=socket.io-mesh-adapter:transport`.
- Cluster-level bug (broadcast, ack, fetchSockets) → likely in `node_modules/socket.io-adapter/dist/cluster-adapter.js`. Our adapter is a thin wrapper.
- Metrics not appearing → check the `prom-client` lazy-load path; check the metrics HTTP server didn't silently die at startup (now logged via `console.warn`).
- Hangs in tests → almost always a UID mismatch (rule #1 above) or a port that didn't release.

## Out of scope (do not implement without a discussion)

- Replacing `ws` with `uWebSockets.js` (perf win, but native deps complicate users' deploys).
- Sharded rooms (defeats the broker-less premise).
- Persistent message offsets / connection state recovery (needs durable storage; the mesh is intentionally stateless).
- A custom plugin API for cross-mesh RPC — see `docs/PHASE2.md` for the design sketch.
