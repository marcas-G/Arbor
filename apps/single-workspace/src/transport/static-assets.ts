import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";

/**
 * P13 TR-W2 (`05` §2): same-origin static hosting of the `apps/web` Vite
 * build. Pure file serving + SPA fallback — no API semantics live here.
 */

export type StaticResolution =
  | {
      readonly kind: "file";
      readonly bytes: Buffer;
      readonly contentType: string;
      readonly cacheControl: string;
    }
  | { readonly kind: "not-configured" }
  | { readonly kind: "rejected" };

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const contentTypeFor = (filePath: string): string => {
  const dot = filePath.lastIndexOf(".");
  const ext = dot === -1 ? "" : filePath.slice(dot);
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
};

const readIfFile = (absolute: string): Buffer | null => {
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    return null;
  }
  return readFileSync(absolute);
};

/**
 * Resolve a GET/HEAD URL path against the Vite `dist` root.
 *
 * - `/` and unknown non-`/assets` paths -> SPA fallback `index.html`
 *   (client-side routing; no server route semantics).
 * - `/assets/*` -> hashed build artifacts, served immutable.
 * - traversal attempts (`..`, encoded or not) are rejected.
 */
export const resolveStatic = (
  distRoot: string | undefined,
  urlPath: string,
): StaticResolution => {
  if (distRoot === undefined) {
    return { kind: "not-configured" };
  }
  const root = resolve(distRoot);
  const clean = urlPath.split("?")[0] ?? urlPath;
  if (clean.includes("..")) {
    return { kind: "rejected" };
  }
  const isAssets = clean === "/assets" || clean.startsWith("/assets/");
  const relative = normalize(clean).replaceAll(sep === "/" ? "\\" : "\\", "/");
  const absolute = resolve(
    join(root, relative.startsWith("/") ? relative.slice(1) : relative),
  );
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    return { kind: "rejected" };
  }
  if (isAssets) {
    const bytes = readIfFile(absolute);
    if (bytes === null) {
      return { kind: "rejected" };
    }
    return {
      kind: "file",
      bytes,
      contentType: contentTypeFor(absolute),
      cacheControl: "public, max-age=31536000, immutable",
    };
  }
  const indexBytes = readIfFile(join(root, "index.html"));
  if (indexBytes === null) {
    return { kind: "not-configured" };
  }
  return {
    kind: "file",
    bytes: indexBytes,
    contentType: "text/html; charset=utf-8",
    cacheControl: "no-cache",
  };
};
