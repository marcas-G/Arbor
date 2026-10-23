import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { makePublicClient } from "../functional/support/public-client.js";

describe("PublicClient absolute request deadline", () => {
  it("aborts a public view request when the deadline expires without a response", async () => {
    const server = createServer(() => {
      // Deliberately keep the request open to model a stalled public endpoint.
    });
    let requestReceived!: () => void;
    const receivedRequest = new Promise<void>((resolve) => {
      requestReceived = resolve;
    });
    server.on("request", () => requestReceived());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("fake public server did not bind a TCP port");
    }

    let receiveTimeout: NodeJS.Timeout | undefined;
    try {
      const deadlineAt = Date.now() + 250;
      const request = makePublicClient(`http://127.0.0.1:${address.port}`, {
        deadlineAt,
      }).view("stalled-view", {});
      await Promise.race([
        receivedRequest,
        new Promise<never>((_, reject) => {
          receiveTimeout = setTimeout(
            () => reject(new Error("fake server did not receive the request")),
            2_000,
          );
        }),
      ]);
      const startedAt = Date.now();
      await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      if (receiveTimeout !== undefined) clearTimeout(receiveTimeout);
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  });
});
