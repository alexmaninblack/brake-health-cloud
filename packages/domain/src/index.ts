// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

export const DASHBOARD_VIEWS = [
  "RELEASE_CANDIDATES",
  "VEHICLE_DATA",
  "SERVICE_LOGS",
] as const;

export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export interface DashboardState {
  readonly activeView: DashboardView;
}

export function initialDashboardState(): DashboardState {
  return { activeView: "RELEASE_CANDIDATES" };
}

export function selectDashboardView(
  state: DashboardState,
  view: DashboardView,
): DashboardState {
  if (!DASHBOARD_VIEWS.includes(view)) {
    return state;
  }
  return { activeView: view };
}

export function viewLabel(view: DashboardView): string {
  switch (view) {
    case "RELEASE_CANDIDATES":
      return "Release Candidates";
    case "VEHICLE_DATA":
      return "Vehicle Data";
    case "SERVICE_LOGS":
      return "Service Logs";
  }
}
