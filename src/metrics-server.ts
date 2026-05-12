import express, { type Request, type Response } from "express";
import type { IncomingMessage, ServerResponse } from "http";

import { createLogger } from "./logger";

const log = createLogger("metrics-server");

export interface MetricsHttpServer {
  /** Actual port (useful when the caller passed 0 to grab a random port). */
  port: number;
  close(): Promise<void>;
}

/**
 * Start a tiny Express server that serves `/metrics` and a `200 ok` on `/`
 * and `/health`. Any other path returns 404 via Express's default handler.
 *
 * When `host` is omitted, Node binds the unspecified IPv6 address (`::`) on
 * dual-stack systems, which also accepts IPv4 connections. This makes
 * `localhost` resolve to a working address regardless of whether `getaddrinfo`
 * returns the IPv4 or IPv6 entry first (Alpine images often prefer `::1`).
 */
export function startMetricsServer(
  port: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  host?: string
): Promise<MetricsHttpServer> {
  const app = express();

  const okHandler = (_req: Request, res: Response) => {
    res.type("text/plain").send("ok\n");
  };
  app.get("/", okHandler);
  app.get("/health", okHandler);
  app.get("/metrics", (req, res) => handler(req, res));

  return new Promise((resolve, reject) => {
    const listenCallback = () => {
      const addr = server.address();
      const actualPort =
        typeof addr === "object" && addr ? addr.port : port;
      log("metrics listening on %s:%d/metrics", host ?? "::", actualPort);
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    };

    // Pass `host` only when set; otherwise let Node pick its default (`::`
    // on dual-stack systems, falling back to `0.0.0.0`).
    const server = host
      ? app.listen(port, host, listenCallback)
      : app.listen(port, listenCallback);

    server.on("error", (err) => {
      log("metrics server error: %s", err.message);
      reject(err);
    });
  });
}
