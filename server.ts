import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

import { createAdapter } from "./src";

const app = express();
app.use(express.static(__dirname));

const httpServer = createServer(app);

const port = parseInt(process.env.PORT || "3000", 10);

const io = new Server(httpServer);

const wsPort = parseInt(process.env.MESH_WS_PORT || "4000", 10);
const serverAddress = `ws://${process.env.MESH_WS_IP || "localhost"}:${wsPort}`;
const discoveryServiceAddress =
  process.env.MESH_DISCOVERY_SERVICE_ADDRESS || "ws://localhost:8000";
const metricsPort = process.env.MESH_METRICS_PORT
  ? parseInt(process.env.MESH_METRICS_PORT, 10)
  : undefined;

io.adapter(
  createAdapter({
    wsPort,
    serverAddress,
    discoveryServiceAddress,
    metrics:
      metricsPort !== undefined
        ? {
            port: metricsPort,
            defaultLabels: {
              instance: process.env.MESH_INSTANCE || process.env.HOSTNAME || `pod-${port}`,
            },
          }
        : undefined,
  })
);

let messageCount = 0;
let messagesPerSecond = 0;
const latencySamples: number[] = [];
let connectionErrors = 0;

setInterval(() => {
  messagesPerSecond = messageCount;
  messageCount = 0;
}, 1000);

setInterval(() => {
  connectionErrors = 0;
}, 5000);

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on("message", (data) => {
    messageCount++;
    io.emit("recv_message", data);
  });

  socket.on("get-local-users", async () => {
    const sockets = await io.local.fetchSockets();
    socket.emit("local-users", sockets.length);
  });

  socket.on("get-total-users", async () => {
    const sockets = await io.fetchSockets();
    socket.emit("total-users", sockets.length);
  });

  socket.on("ping", (clientTimestamp: number) => {
    socket.emit("pong", clientTimestamp);
  });

  socket.on("metrics-latency", (latency: number) => {
    latencySamples.push(latency);
    if (latencySamples.length > 100) {
      latencySamples.shift();
    }
  });

  socket.on("metrics-connection-error", () => {
    connectionErrors++;
  });

  socket.on("get-metrics", async () => {
    const localSockets = await io.local.fetchSockets();
    const totalSockets = await io.fetchSockets();
    const adapter = io.of("/").adapter;
    const serverCount = await adapter.serverCount();

    const averageLatency =
      latencySamples.length > 0
        ? latencySamples.reduce((sum, val) => sum + val, 0) / latencySamples.length
        : 0;

    socket.emit("metrics-update", {
      latency: Math.round(averageLatency),
      messagesPerSecond,
      totalClients: totalSockets.length,
      localClients: localSockets.length,
      serverCount,
      connectionErrors,
    });
  });

  socket.on("disconnect", () =>
    console.log(`Client disconnected: ${socket.id}`)
  );
});

httpServer.listen(port, () => {
  console.log(`Socket.IO Server running on port ${port}`);
  if (metricsPort !== undefined) {
    console.log(`Prometheus /metrics listening on http://0.0.0.0:${metricsPort}/metrics`);
  }
});
