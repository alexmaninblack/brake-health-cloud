// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, type KeyboardEvent } from "react";

import {
  DASHBOARD_VIEWS,
  initialDashboardState,
  selectDashboardView,
  viewLabel,
  type DashboardView,
} from "@brake-health/domain";

import { readDashboardFixtures } from "./fixture-adapter";

const fixtures = readDashboardFixtures();

export function App() {
  const [dashboard, setDashboard] = useState(initialDashboardState);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectView(view: DashboardView): void {
    setDashboard((current) => selectDashboardView(current, view));
  }

  function handleTabKey(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % DASHBOARD_VIEWS.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + DASHBOARD_VIEWS.length) % DASHBOARD_VIEWS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = DASHBOARD_VIEWS.length - 1;
    }
    if (nextIndex === undefined) {
      return;
    }
    event.preventDefault();
    const nextView = DASHBOARD_VIEWS[nextIndex];
    if (nextView !== undefined) {
      selectView(nextView);
      tabs.current[nextIndex]?.focus();
    }
  }

  return (
    <div className="app-shell">
      <header className="product-header">
        <div>
          <p className="eyebrow">Brake Function Team</p>
          <h1>Brake Health Dashboard</h1>
        </div>
        <p className="source-badge" role="status">
          Fixture source · non-live
        </p>
      </header>

      <nav aria-label="Dashboard views" className="view-tabs" role="tablist">
        {DASHBOARD_VIEWS.map((view, index) => (
          <button
            aria-controls={`${view.toLowerCase()}-panel`}
            aria-selected={dashboard.activeView === view}
            className="view-tab"
            id={`${view.toLowerCase()}-tab`}
            key={view}
            onClick={() => selectView(view)}
            onKeyDown={(event) => handleTabKey(event, index)}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            role="tab"
            tabIndex={dashboard.activeView === view ? 0 : -1}
            type="button"
          >
            {viewLabel(view)}
          </button>
        ))}
      </nav>

      <main>
        {dashboard.activeView === "RELEASE_CANDIDATES" ? (
          <ReleaseCandidatesView />
        ) : null}
        {dashboard.activeView === "VEHICLE_DATA" ? <VehicleDataView /> : null}
        {dashboard.activeView === "SERVICE_LOGS" ? <ServiceLogsView /> : null}
      </main>
    </div>
  );
}

function ReleaseCandidatesView() {
  return (
    <section
      aria-labelledby="release-candidates-tab"
      className="view-panel"
      id="release_candidates-panel"
      role="tabpanel"
    >
      <ViewHeading
        description="Prepared catalogue fixtures only. Nothing here is signed or published."
        title="Release Candidates"
      />
      <div className="card-grid">
        {fixtures.releaseCandidates.map((candidate) => (
          <article className="data-card" key={candidate.candidateId}>
            <div className="card-heading">
              <div>
                <p className="eyebrow">{candidate.serviceId}</p>
                <h3>Service v{candidate.serviceVersion}</h3>
              </div>
              <span className="state-chip">Prepared fixture</span>
            </div>
            <Definition
              label="Compatible VDP"
              value={candidate.compatibleVdp.join(", ")}
            />
            <Definition
              label="Read permissions"
              value={candidate.permissions.read.join(", ")}
            />
            <Definition
              label="Actuate permissions"
              value={candidate.permissions.actuate.join(", ") || "None"}
            />
            <Definition
              label="Service quota"
              value={`${candidate.quota.cpuDmips} DMIPS · ${candidate.quota.memoryMiB} MiB`}
            />
            <Definition label="Candidate ID" value={candidate.candidateId} />
          </article>
        ))}
      </div>
    </section>
  );
}

function VehicleDataView() {
  const [fixtureIndex, setFixtureIndex] = useState(0);
  const fixture = fixtures.vehicleData[fixtureIndex];
  if (fixture === undefined) {
    throw new Error("vehicle fixture index is outside the closed fixture set");
  }
  return (
    <section
      aria-labelledby="vehicle_data-tab"
      className="view-panel"
      id="vehicle_data-panel"
      role="tabpanel"
    >
      <ViewHeading
        description="Deterministic projection shells; these values are not persisted operational evidence."
        title="Vehicle Data"
      />
      <div aria-label="Vehicle fixture states" className="fixture-selector">
        {fixtures.vehicleData.map((item, index) => (
          <button
            aria-pressed={fixtureIndex === index}
            key={vehicleFixtureLabel(item)}
            onClick={() => setFixtureIndex(index)}
            type="button"
          >
            {vehicleFixtureLabel(item)}
          </button>
        ))}
      </div>
      <article className="data-card projection-card">
        <p className="eyebrow">Fixture state</p>
        <h3>{fixture.kind}</h3>
        {fixture.kind === "EMPTY" ? (
          <p>No fixture values are selected.</p>
        ) : fixture.kind === "DISCONNECTED" ? (
          <p>The fixture represents a disconnected vehicle source.</p>
        ) : (
          <>
            <Definition label="VDP version" value={fixture.vdpVersion} />
            <dl className="signal-list">
              {Object.entries(fixture.values).map(([signal, value]) => (
                <div key={signal}>
                  <dt>{signal}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </article>
    </section>
  );
}

function ServiceLogsView() {
  return (
    <section
      aria-labelledby="service_logs-tab"
      className="view-panel"
      id="service_logs_panel"
      role="tabpanel"
    >
      <ViewHeading
        description="Local process output is not shown as authoritative AosEdge or AosCloud evidence."
        title="Service Logs"
      />
      <div className="card-grid two-column">
        {fixtures.serviceLogs.map((fixture) => (
          <article className="data-card" key={fixture.kind}>
            <p className="eyebrow">Fixture state</p>
            <h3>{fixture.kind}</h3>
            <p>{fixture.explanation}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ViewHeading({ description, title }: { description: string; title: string }) {
  return (
    <div className="view-heading">
      <div>
        <p className="eyebrow">Non-live demonstration</p>
        <h2>{title}</h2>
      </div>
      <p>{description}</p>
    </div>
  );
}

function Definition({ label, value }: { label: string; value: string }) {
  return (
    <dl className="definition">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </dl>
  );
}

function vehicleFixtureLabel(
  fixture: (typeof fixtures.vehicleData)[number],
): string {
  return fixture.kind === "REPRESENTATIVE"
    ? `VDP ${fixture.vdpVersion}`
    : fixture.kind === "EMPTY"
      ? "Empty"
      : "Disconnected";
}
