import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.js";

describe("apps/web skeleton", () => {
  it("opens straight into the workbench (local single-user form — no login)", () => {
    render(<App />);
    expect(screen.getByText("项目")).toBeTruthy();
    expect(screen.queryByText("连接 Arbor")).toBeNull();
  });
});
