import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * P13 `05` §4 / EC-12: the frontend dependency set is exactly the governed
 * exact-pin set. UI primitives are pinned here so the shadcn/Radix layer is
 * reproducible across clean installs.
 */
const pkg = JSON.parse(readFileSync("package.json", { encoding: "utf8" })) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const PINNED_RUNTIME = {
  "@arbor/api-contracts": "workspace:*",
  "@radix-ui/react-dialog": "1.3.1",
  "@radix-ui/react-dropdown-menu": "2.2.1",
  "@radix-ui/react-tabs": "1.2.1",
  "@tanstack/react-query": "5.103.2",
  "class-variance-authority": "0.7.1",
  clsx: "2.1.1",
  "lucide-react": "1.72.0",
  react: "19.3.0",
  "react-dom": "19.3.0",
  "react-hook-form": "7.88.0",
  "react-virtuoso": "4.18.15",
  "tailwind-merge": "3.7.0",
  zod: "4.6.6",
} as const;

const PINNED_DEV = {
  "@testing-library/react": "16.3.3",
  "@testing-library/user-event": "14.6.7",
  "@tailwindcss/vite": "4.3.5",
  "@types/react": "19.3.0",
  "@types/react-dom": "19.3.0",
  "@vitejs/plugin-react": "6.1.1",
  jsdom: "30.1.1",
  tailwindcss: "4.3.5",
  typescript: "7.0.2",
  vite: "8.3.8",
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
