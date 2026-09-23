import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * P13 `05` §4 / EC-12: the frontend dependency set is exactly the frozen
 * exact-pin set. No additional runtime dependencies may appear; adding one
 * requires a contract revision.
 */
const pkg = JSON.parse(readFileSync("package.json", { encoding: "utf8" })) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const PINNED_RUNTIME = {
  "@arbor/api-contracts": "workspace:*",
  "@tanstack/react-query": "5.103.2",
  react: "19.3.0",
  "react-dom": "19.3.0",
  "react-hook-form": "7.88.0",
  zod: "4.6.5",
} as const;

const PINNED_DEV = {
  "@testing-library/react": "16.3.3",
  "@testing-library/user-event": "14.6.7",
  "@types/react": "19.3.0",
  "@types/react-dom": "19.3.0",
  "@vitejs/plugin-react": "6.1.1",
  jsdom: "30.1.1",
  typescript: "7.0.2",
  vite: "8.3.0",
  vitest: "5.0.1",
} as const;

describe("EC-12 dependency pins", () => {
  it("runtime dependencies are exactly the frozen set, exact-pinned", () => {
    expect(pkg.dependencies).toEqual({ ...PINNED_RUNTIME });
  });

  it("dev dependencies are exactly the frozen set, exact-pinned", () => {
    expect(pkg.devDependencies).toEqual({ ...PINNED_DEV });
  });

  it("no version ranges anywhere (exact pins only)", () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, version] of Object.entries(all)) {
      if (version === "workspace:*") {
        continue;
      }
      expect(
        /^(\d+)\.(\d+)\.(\d+)$/.test(version),
        `${name}@${version} must be an exact pin`,
      ).toBe(true);
    }
  });
});
