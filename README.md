# Socket.IO Mesh Adapter

Socket.IO Mesh Adapter is a custom Socket.IO adapter designed to enable horizontal scaling of Socket.IO applications using a **mesh network architecture**. Unlike traditional pub/sub-based adapters that rely on a centralized broker (which can become a bottleneck), this adapter allows **server-to-server communication** in a decentralized manner, making it ideal for distributed systems.

## Features

- **Horizontal Scaling**: Scale your Socket.IO application across multiple servers without relying on a centralized pub/sub broker.
- **Decentralized Communication**: Servers communicate directly with each other using WebSocket connections.
- **Discovery Service**: Automatically discover and connect servers in the mesh network.
- **Namespace Support**: Each namespace can have its own adapter instance.
- **Efficient Messaging**: Broadcast messages, fetch sockets, and manage rooms across servers seamlessly.

## Installation

Install the package via npm:

```bash
npm install socket.io-mesh-adapter
```

## Usage
### Setting Up the Adapter

To use the adapter, you need to configure it with your Socket.IO server. Here's an example:
```js
const { createServer } = require("http");
const { Server } = require("socket.io");
const { createAdapter } = require("socket.io-mesh-adapter");

const httpServer = createServer();
const io = new Server(httpServer);

// Configure the adapter
const wsPort = 4000; // WebSocket port for server-to-server communication
const serverAddress = [ws://localhost:${wsPort}](http://_vscodecontentref_/0);
const discoveryServiceAddress = "ws://localhost:8000"; // Discovery service address

io.adapter(createAdapter({ wsPort, serverAddress, discoveryServiceAddress }));

httpServer.listen(3000, () => {
  console.log("Socket.IO server is running on port 3000");
});
```
### Running the Discovery Service
The discovery service is responsible for maintaining a list of active servers in the mesh network. You can run it using the provided binary:

```
npx socket.io-mesh-adapter@latest
```

The discovery service listens on port `8000` by default. You can change the port using the `PORT` environment variable.

## Options

The `createAdapter` function accepts the following options:

- `wsPort` (optional): The WebSocket port for server-to-server communication (default: 4000).
- `serverAddress` (optional): The WebSocket address of the server (default: `ws://localhost:<wsPort>`).
- `discoveryServiceAddress`: The WebSocket address of the discovery service (required).