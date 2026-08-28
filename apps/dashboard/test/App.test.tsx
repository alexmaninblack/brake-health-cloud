// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "../src/App";

afterEach(cleanup);

describe("fixture-only dashboard", () => {
  it("navigates all accepted views without live action controls", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent(/fixture source.*non-live/i);
    expect(screen.getByRole("heading", { name: "Release Candidates" })).toBeVisible();
    expect(screen.getAllByText(/Prepared fixture/i)).toHaveLength(3);
    expect(screen.getAllByText(/Compatible VDP/i)).toHaveLength(3);
    expect(screen.getAllByText(/Service quota/i)).toHaveLength(3);

    await user.click(screen.getByRole("tab", { name: "Vehicle Data" }));
    expect(screen.getByRole("heading", { name: "Vehicle Data" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Empty" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "VDP 3.0.0" }));
    expect(screen.getByText("Vehicle.Speed")).toBeVisible();
    expect(screen.getByText(/not persisted operational evidence/i)).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Service Logs" }));
    expect(screen.getByRole("heading", { name: "Service Logs" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "UNAVAILABLE" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "EMPTY" })).toBeVisible();
    expect(screen.getByText(/not shown as authoritative/i)).toBeVisible();

    expect(
      screen.queryByRole("button", { name: /sign|publish|connect|upload/i }),
    ).not.toBeInTheDocument();
  });

  it("supports roving tab focus with arrow, Home and End keys", async () => {
    const user = userEvent.setup();
    render(<App />);
    const tablist = screen.getByRole("tablist", { name: "Dashboard views" });
    const release = within(tablist).getByRole("tab", {
      name: "Release Candidates",
    });
    const vehicle = within(tablist).getByRole("tab", { name: "Vehicle Data" });
    const logs = within(tablist).getByRole("tab", { name: "Service Logs" });

    release.focus();
    await user.keyboard("{ArrowRight}");
    expect(vehicle).toHaveFocus();
    expect(vehicle).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(logs).toHaveFocus();
    expect(logs).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(release).toHaveFocus();
    expect(release).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowLeft}");
    expect(logs).toHaveFocus();
  });
});
