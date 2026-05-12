# Socket.IO Mesh — Docker Monitoring Stack

A self-contained, runnable example that boots a 3-node Socket.IO mesh, the discovery service, Prometheus, and a pre-provisioned Grafana dashboard.

```text
                ┌─────────────────────────────────────────────┐
                │             Prometheus :9090                │
                └─────────▲───────▲───────▲───────▲───────────┘
   scrape /metrics        │       │       │       │
                          │       │       │       │
   ┌──────────┐        ┌──┴──┐ ┌──┴──┐ ┌──┴──┐ ┌──┴────────┐
   │ Grafana  │ ─────▶ │app1 │ │app2 │ │app3 │ │ discovery │
   │  :3030   │        │:3000│ │:3000│ │:3000│ │   :8000   │
   └──────────┘        └──┬──┘ └──┬──┘ └──┬──┘ └─────▲─────┘
                          │       │       │           │
                          └───────┴───────┴───────────┘
                              peer-to-peer mesh (ws)
```

## Run it

```bash
cd examples/docker
docker compose up --build
```

Once everything is up:

| URL                                | What you get                                    |
| ---------------------------------- | ----------------------------------------------- |
| http://localhost:3000              | Chat demo on `app1`                             |
| http://localhost:3001              | Chat demo on `app2`                             |
| http://localhost:3002              | Chat demo on `app3`                             |
| http://localhost:9090              | Prometheus UI (targets, graph, query)           |
| http://localhost:3030              | Grafana, auto-loaded "Socket.IO Mesh" dashboard |
| http://localhost:9091/metrics      | Raw discovery metrics                           |
| http://localhost:3000 → DevTools   | Raw app metrics: `curl localhost:3000/...` n/a; metrics are on the *internal* `:9090` ports of each container (see `docker compose port app1 9090` if you want to scrape externally) |

Grafana is configured with anonymous admin access (`GF_AUTH_ANONYMOUS_ENABLED=true`), so the dashboard is one click away.

## What the dashboard shows

| # | Panel                              | Insight                                                                                   |
| - | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| 1 | Peers connected per pod            | Every pod should see N-1 peers. A dip means a pod lost mesh connectivity.                 |
| 2 | Mesh health                        | `connected / expected` ratio. 100% = perfect mesh.                                        |
| 3 | Discovery roster size              | Pods currently registered with the discovery service.                                     |
| 4 | Mesh messages/sec by type          | Per-type rate of `broadcast`, `heartbeat`, `fetch_sockets`, etc.                          |
| 5 | Cluster request latency p50/p95/p99| Time spent in `fetchSockets` / `broadcastWithAck` / `serverSideEmit`.                     |
| 6 | Mesh frame size p50/p95/p99        | Distribution of frame sizes (sent vs received) — useful for tuning payload sizes.         |
| 7 | Peer drops by reason (5m)          | Slow-consumer kicks, transport errors, peers leaving discovery, etc.                      |
| 8 | Local clients per pod              | Sampled every 5s. Useful to validate load-balancer fairness across pods.                  |

## Things to try

- **Watch broadcasts propagate** — send a chat message in one tab and watch `socketio_mesh_messages_sent_total{type="broadcast"}` tick on the originating pod and `socketio_mesh_messages_received_total{type="broadcast"}` tick on the others.
- **Kill a pod, watch the mesh self-heal**:
  ```bash
  docker compose kill app3
  ```
  → `Peers connected per pod` panel drops to 1 on the survivors, the roster shrinks to 2. Then bring it back:
  ```bash
  docker compose up -d app3
  ```
  → mesh re-converges within a few seconds.
- **Open many tabs** at `:3000`, `:3001`, `:3002` and watch `Local Socket.IO clients per pod` redistribute as the load balancer (here just your browser) sticks new clients to a pod.
- **Sluggish peer simulation** — `tc qdisc add dev eth0 root netem delay 200ms` inside a container, then watch `Cluster request latency` panels widen.

## Layout

```
examples/docker/
├── docker-compose.yml
├── prometheus/
│   └── prometheus.yml
├── grafana/
│   ├── provisioning/
│   │   ├── datasources/prometheus.yml
│   │   └── dashboards/mesh.yml
│   └── dashboards/
│       └── socket-io-mesh.json
└── README.md
```

The `Dockerfile` at the repository root has two stages — `app` and `discovery-svc` — both referenced by `docker-compose.yml`.

## Environment variables

| Service     | Variable                            | Purpose                                                            |
| ----------- | ----------------------------------- | ------------------------------------------------------------------ |
| `app*`      | `PORT`                              | HTTP port for the Socket.IO server (`3000` inside the container).  |
| `app*`      | `MESH_WS_PORT`                      | Port the peer-to-peer mesh listens on (`4000`).                    |
| `app*`      | `MESH_WS_IP`                        | Hostname peers should reach this pod at (matches the service name).|
| `app*`      | `MESH_DISCOVERY_SERVICE_ADDRESS`    | URL of the discovery service.                                      |
| `app*`      | `MESH_METRICS_PORT`                 | `/metrics` HTTP port (`9090`). Omit to disable metrics.            |
| `app*`      | `MESH_INSTANCE`                     | Optional `instance=` label baked into every emitted metric.        |
| `discovery` | `PORT`                              | Discovery WebSocket port (`8000`).                                 |
| `discovery` | `METRICS_PORT`                      | Discovery `/metrics` HTTP port (`9091`). Omit to disable.          |

## Stopping

```bash
docker compose down -v
```

The `-v` flag also wipes the Prometheus/Grafana volumes so the next run starts clean.
