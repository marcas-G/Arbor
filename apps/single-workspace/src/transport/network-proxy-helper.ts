import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Fixed installed relay. This JavaScript is executed without transpilation,
 * so qualification can hash the same complete file that bubblewrap mounts. */
export const NETWORK_PROXY_HELPER_PATH = fileURLToPath(
  new URL("../../src/transport/network-proxy-helper.mjs", import.meta.url),
);

// V1 retains its per-invocation copy. V2 mounts the installed artifact directly.
export const readNetworkProxyHelperSource = (): string =>
  readFileSync(NETWORK_PROXY_HELPER_PATH, "utf8");
