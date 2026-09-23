import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.js";

describe("apps/web skeleton", () => {
  it("renders the login shell", () => {
    render(<App />);
    expect(screen.getByText("连接 Arbor")).toBeTruthy();
  });
});
