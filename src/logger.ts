import debug from "debug";

/**
 * Returns a debug logger scoped under `socket.io-mesh-adapter:<sub>`.
 *
 * Enable via the `DEBUG` env var, e.g. `DEBUG=socket.io-mesh-adapter:*`.
 */
export const createLogger = (sub: string) =>
  debug(`socket.io-mesh-adapter:${sub}`);
