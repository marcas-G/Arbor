import { Schema } from "effect";
import { toolFromSchema } from "../tool.js";

/** P4-03 (D-043 I3): host-side controlled web access — the agent's web
 * capability lives OUTSIDE the sandbox policy (Codex model: search is a
 * tool, not a shell command). GET only, response bounded. */
export function makeWebFetchTool(deps?: {
  readonly fetchImpl?: typeof fetch;
  readonly allowedHosts?: ReadonlyArray<string>;
}): ReturnType<typeof toolFromSchema> {
  const f = deps?.fetchImpl ?? fetch;
  return toolFromSchema({
    name: "web_fetch",
    description:
      "Fetch an https URL and return its text content (bounded). Runs on the host, outside any sandbox. GET only.",
    params: Schema.Struct({
      url: Schema.String,
    }),
    execute: async (p) => {
      const url = new URL(p.url);
      if (url.protocol !== "https:") {
        throw new Error("only https URLs are allowed");
      }
      if (deps?.allowedHosts !== undefined && !deps.allowedHosts.includes(url.hostname)) {
        throw new Error(`host ${url.hostname} is not in the allowlist`);
      }
      const res = await f(url.toString(), {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = await res.text();
      return body.length > 20_000 ? `${body.slice(0, 20_000)}\n[truncated]` : body;
    },
  });
}
