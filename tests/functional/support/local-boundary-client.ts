import { request as httpRequest } from "node:http";

/** Raw HTTP/WS client for checking the built product boundary with browser headers. */
export const sendLocalBoundaryRequest = (
  port: number,
  path: string,
  headers: Record<string, string> = {},
  upgrade = false,
): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: upgrade ? "GET" : "POST",
        headers: {
          ...(upgrade
            ? {
                connection: "Upgrade",
                upgrade: "websocket",
                "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
                "sec-websocket-version": "13",
              }
            : { "content-type": "application/json" }),
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.once("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.once("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("request timed out")));
    req.end(upgrade ? undefined : "{}");
  });
