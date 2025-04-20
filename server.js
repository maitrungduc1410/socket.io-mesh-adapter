const express = require("express");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { createAdapter } = require("./dist/mesh-adapter");

const app = express();
app.use(express.static(__dirname));

const httpServer = createServer(app);

// Dynamic ports from environment variables
const port = process.env.PORT || 3000;

// Set up Socket.IO server for client connections
const io = new Server(httpServer);

// Use the custom adapter with WebSocket port
const wsPort = parseInt(process.env.MESH_WS_PORT || "4000");
const serverAddress = `ws://${process.env.MESH_WS_IP || "localhost"}:${wsPort}`;
const discoveryServiceAddress =
  process.env.MESH_DISCOVERY_SERVICE_ADDRESS || "ws://localhost:8000";

io.adapter(createAdapter({ wsPort, serverAddress, discoveryServiceAddress }));

// Metrics storage
let messageCount = 0;
let messagesPerSecond = 0;
let latencySamples = [];
let connectionErrors = 0;

// Track messages per second
setInterval(() => {
  messagesPerSecond = messageCount;
  messageCount = 0; // Reset counter
}, 1000);

// Reset connection errors periodically (every 5 seconds, aligned with client polling)
setInterval(() => {
  connectionErrors = 0;
}, 5000);

io.on("connection", async (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on("message", (data) => {
    messageCount++; // Increment message counter
    io.emit("recv_message", data); // Broadcast to all servers and clients
  });

  socket.on("get-local-users", async () => {
    const sockets = await io.local.fetchSockets();
    socket.emit("local-users", sockets.length);
  });

  socket.on("get-total-users", async () => {
    const sockets = await io.fetchSockets();
    socket.emit("total-users", sockets.length);
  });

  socket.on("ping", (clientTimestamp) => {
    socket.emit("pong", clientTimestamp); // Echo back timestamp
  });

  socket.on("metrics-latency", (latency) => {
    latencySamples.push(latency);
    // Keep only the last 100 samples to avoid memory growth
    if (latencySamples.length > 100) {
      latencySamples.shift();
    }
  });

  socket.on("metrics-connection-error", () => {
    connectionErrors++; // Increment error counter
  });

  socket.on("get-metrics", async () => {
    const localSockets = await io.local.fetchSockets();
    const totalSockets = await io.fetchSockets();
    const adapter = io.of("/").adapter; // Access adapter for serverCount
    const serverCount = await adapter.serverCount();

    // Calculate average latency
    const averageLatency =
      latencySamples.length > 0
        ? latencySamples.reduce((sum, val) => sum + val, 0) /
          latencySamples.length
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

// Start the Socket.IO server
httpServer.listen(port, () =>
  console.log(`Socket.IO Server running on port ${port}`)
);
