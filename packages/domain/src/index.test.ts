// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DASHBOARD_VIEWS,
  initialDashboardState,
  selectDashboardView,
  viewLabel,
  compareDescendingKeyset,
} from "./index";

describe("dashboard domain state", () => {
  it("provides stable view state and labels without a UI framework", () => {
    const initial = initialDashboardState();
    expect(initial.activeView).toBe("RELEASE_CANDIDATES");
    expect(
      DASHBOARD_VIEWS.map((view) =>
        viewLabel(selectDashboardView(initial, view).activeView),
      ),
    ).toEqual(["Release Candidates", "Vehicle Data", "Service Logs"]);
  });
});

describe("Brake query ordering", () => {
  it("orders resource keysets descending with identity tie breakers", () => {
    const rows = [["2026-08-29T01:00:00Z", "a"], ["2026-08-29T02:00:00Z", "b"], ["2026-08-29T02:00:00Z", "a"]];
    expect(rows.sort(compareDescendingKeyset)).toEqual([
      ["2026-08-29T02:00:00Z", "b"], ["2026-08-29T02:00:00Z", "a"], ["2026-08-29T01:00:00Z", "a"],
    ]);
  });
});
