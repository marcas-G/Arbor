import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";

afterEach(() => vi.unstubAllGlobals());

describe("apps/web skeleton", () => {
  it("opens straight into the workbench (local single-user form — no login)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ configured: true }), { status: 200 }),
        ),
      ),
    );
    render(<App />);
    expect(await screen.findByText("当前项目")).toBeTruthy();
    expect(screen.queryByText("连接 Arbor")).toBeNull();
  });
});
