// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  canonicalize,
  type ChangedResource,
  type JsonValue,
  normalizeRfc3339Instant,
  parseJsonRejectDuplicates,
  type ParsedBrakeMessage,
  sha256Hex,
} from "./brake-data-contract.js";
import {
  reconstructWindow,
  type WindowChunkFact,
  type WindowCompletionFact,
  type WindowProjection,
} from "./brake-data-domain.js";

export interface DurableAcknowledgement {
  readonly schemaVersion: 1;
  readonly contractVersion: "1.0.0";
  readonly receiptId: string;
  readonly messageKeySha256: string;
  readonly contentSha256: string;
  readonly state: "DURABLE_ACCEPTED" | "DUPLICATE_ACCEPTED";
  readonly receivedAt: string;
}

export type IngestResult =
  | {
      readonly httpStatus: 200 | 201;
      readonly acknowledgement: DurableAcknowledgement;
      readonly changedResources: readonly ChangedResource[];
    }
  | {
      readonly httpStatus: 409;
      readonly errorCode: "CONTENT_CONFLICT";
      readonly changedResources: readonly ChangedResource[];
    };

export type QueryResource = "WINDOW" | "ASSESSMENT" | "EVENT" | "ADVISORY";

export interface QueryResult {
  readonly items: readonly JsonValue[];
  readonly nextKey: readonly string[] | null;
}

export interface RecordCounts {
  readonly messages: number;
  readonly windows: number;
  readonly assessments: number;
  readonly events: number;
  readonly advisories: number;
  readonly quarantine: number;
}

export interface RecordSetSummary {
  readonly counts: RecordCounts;
  readonly sha256: string;
}

export interface DeleteResult {
  readonly stale: boolean;
  readonly deleted: RecordCounts;
  readonly remaining: RecordCounts;
  readonly nonmatchingSha256: string;
  readonly nonmatchingCounts: RecordCounts;
}

interface SqlRow {
  readonly [key: string]: unknown;
}

const TABLES = ["messages", "windows", "assessments", "events", "advisories", "quarantine"] as const;
const PHYSICAL_TABLES = {
  messages: "messages", windows: "windows", assessments: "assessments",
  events: "condition_events", advisories: "advisory_facts", quarantine: "quarantine",
} as const;

export class BrakeDataStore {
  /** Used only by the separate DEMO_MOCK database, never a live query fallback. */
  public mockSummary(uid: string): unknown {
    return {
      source: "DEMO_MOCK", vehicleTelemetry: false, unitSystemUid: uid,
      counts: this.database.prepare("SELECT message_type AS kind, count(*) AS count FROM messages WHERE unit_system_uid=? GROUP BY message_type ORDER BY message_type").all(uid),
      records: this.database.prepare("SELECT canonical_message, backend_received_at FROM messages WHERE unit_system_uid=? ORDER BY id DESC LIMIT 3").all(uid).map((row) => ({
        message: JSON.parse(String((row as SqlRow).canonical_message)) as unknown, backendReceivedAt: (row as SqlRow).backend_received_at,
      })),
    };
  }

  public constructor(
    private readonly database: DatabaseSync,
    private readonly validateReadOnlySchema?: () => void,
  ) {}

  /** Whole-store counts, without selectors, rows, changes or inferred identity. */
  public wholeStoreCounts(): RecordCounts {
    if (this.validateReadOnlySchema === undefined) throw new Error("expected schema validator is unavailable");
    this.database.exec("BEGIN");
    try {
      this.validateReadOnlySchema();
      if (this.database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
        throw new Error("database contains inconsistent relationships");
      }
      const counts: { -readonly [Key in keyof RecordCounts]: number } = zeroCounts();
      for (const table of TABLES) {
        const row = this.database.prepare(`SELECT COUNT(*) AS count FROM ${PHYSICAL_TABLES[table]}`).get() as SqlRow | undefined;
        const count = row?.count;
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
          throw new Error("whole-store record count is invalid");
        }
        counts[table] = count;
      }
      this.database.exec("COMMIT");
      return counts;
    } catch (error) {
      rollbackIfActive(this.database);
      throw error;
    }
  }

  public ingest(message: ParsedBrakeMessage, receivedAt: string): IngestResult {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare(
          "SELECT m.id, m.canonical_message_sha256, r.receipt_id, r.received_at " +
            "FROM messages m JOIN receipts r ON r.message_id = m.id " +
            "WHERE m.unit_system_uid = ? AND m.message_type = ? AND m.message_identity = ?",
        )
        .get(message.unitSystemUid, message.messageType, message.messageIdentity) as SqlRow | undefined;
      if (existing !== undefined) {
        if (existing.canonical_message_sha256 === message.canonicalMessageSha256) {
          this.database.exec("COMMIT");
          return {
            httpStatus: 200,
            acknowledgement: acknowledgement(
              message,
              stringColumn(existing, "receipt_id"),
              stringColumn(existing, "received_at"),
              "DUPLICATE_ACCEPTED",
            ),
            changedResources: [],
          };
        }
        this.insertQuarantine(message, "CONTENT_CONFLICT", receivedAt);
        this.database.exec("COMMIT");
        return {
          httpStatus: 409,
          errorCode: "CONTENT_CONFLICT",
          changedResources: this.visibleConflictResources(message, receivedAt),
        };
      }

      const inserted = this.database
        .prepare(
          "INSERT INTO messages(" +
            "unit_system_uid, unit_role, message_type, message_identity, message_key_sha256, " +
            "content_sha256, canonical_message_sha256, canonical_message, source_time, source_time_normalized, " +
            "local_time, backend_received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
        )
        .run(
          message.unitSystemUid,
          message.unitRole,
          message.messageType,
          message.messageIdentity,
          message.messageKeySha256,
          message.contentSha256,
          message.canonicalMessageSha256,
          message.canonicalMessage,
          message.sourceTime,
          message.sourceTimeNormalized,
          receivedAt,
        );
      const messageId = Number(inserted.lastInsertRowid);
      this.insertTyped(messageId, message);
      const changedResources = message.changedResource === "WINDOW"
        ? this.rebuildWindow(message, receivedAt)
        : message.messageType === "BRAKE_HEALTH_ASSESSMENT" && this.hasExactlyCorrelatedEvent(message)
          ? ["ASSESSMENT", "EVENT"] as const
          : [message.changedResource];
      const receiptId = randomUUID();
      this.database
        .prepare("INSERT INTO receipts(message_id, receipt_id, received_at) VALUES (?, ?, ?)")
        .run(messageId, receiptId, receivedAt);
      this.database.exec("COMMIT");
      return {
        httpStatus: 201,
        acknowledgement: acknowledgement(message, receiptId, receivedAt, "DURABLE_ACCEPTED"),
        changedResources,
      };
    } catch (error) {
      rollbackIfActive(this.database);
      throw error;
    }
  }

  public query(
    resource: QueryResource,
    unitSystemUid: string,
    limit: number,
    after: readonly string[] | null,
  ): QueryResult {
    switch (resource) {
      case "WINDOW":
        return this.queryWindows(unitSystemUid, limit, after);
      case "ASSESSMENT":
        return this.queryMessages(
          "assessments", "assessed_at", "assessed_at_normalized", "assessment_id",
          resource, unitSystemUid, limit, after,
        );
      case "EVENT":
        return this.queryEvents(unitSystemUid, limit, after);
      case "ADVISORY":
        return this.queryAdvisories(unitSystemUid, limit, after);
    }
  }

  public recordSet(systemUids: readonly string[], matching = true): RecordSetSummary {
    const placeholders = unitPlaceholders(systemUids);
    const predicate = `${matching ? "IN" : "NOT IN"} (${placeholders})`;
    const parameters = systemUids;
    const messages = this.rows(
      "SELECT m.unit_system_uid, m.message_type, m.message_identity, m.message_key_sha256, " +
        "m.content_sha256, m.canonical_message_sha256, m.backend_received_at, r.receipt_id, r.received_at " +
        `FROM messages m JOIN receipts r ON r.message_id = m.id WHERE m.unit_system_uid ${predicate}`,
      parameters,
      ["unit_system_uid", "message_type", "message_identity", "message_key_sha256", "content_sha256", "canonical_message_sha256", "backend_received_at", "receipt_id", "received_at"],
    );
    const windows = this.rows(
      "SELECT unit_system_uid, event_id, projection_state, terminal_state, received_chunk_count, " +
        "expected_chunk_count, received_sample_count, window_start_timestamp, completion_content_sha256, " +
        `window_sha256, last_backend_received_at FROM windows WHERE unit_system_uid ${predicate}`,
      parameters,
      ["unit_system_uid", "event_id", "projection_state", "terminal_state", "received_chunk_count", "expected_chunk_count", "received_sample_count", "window_start_timestamp", "completion_content_sha256", "window_sha256", "last_backend_received_at"],
    );
    const assessments = this.rows(
      "SELECT a.unit_system_uid, a.assessment_id, a.source_event_id, a.content_sha256, m.backend_received_at " +
        `FROM assessments a JOIN messages m ON m.id = a.message_id WHERE a.unit_system_uid ${predicate}`,
      parameters,
      ["unit_system_uid", "assessment_id", "source_event_id", "content_sha256", "backend_received_at"],
    );
    const events = this.rows(
      "SELECT e.unit_system_uid, e.event_id, e.assessment_id, e.source_event_id, e.content_sha256, m.backend_received_at " +
        `FROM condition_events e JOIN messages m ON m.id = e.message_id WHERE e.unit_system_uid ${predicate}`,
      parameters,
      ["unit_system_uid", "event_id", "assessment_id", "source_event_id", "content_sha256", "backend_received_at"],
    );
    const advisories = this.rows(
      "SELECT a.unit_system_uid, a.request_id, a.gateway_state, a.content_sha256, m.backend_received_at " +
        `FROM advisory_facts a JOIN messages m ON m.id = a.message_id WHERE a.unit_system_uid ${predicate}`,
      parameters,
      ["unit_system_uid", "request_id", "gateway_state", "content_sha256", "backend_received_at"],
    );
    const quarantine = this.rows(
      "SELECT unit_system_uid, message_type, message_identity, message_key_sha256, attempted_content_sha256, " +
        `reason_code, quarantined_at FROM quarantine WHERE unit_system_uid ${predicate}`,
      parameters,
      ["unit_system_uid", "message_type", "message_identity", "message_key_sha256", "attempted_content_sha256", "reason_code", "quarantined_at"],
    );
    const blocks: JsonValue[] = [
      ["messages", messages],
      ["windows", windows],
      ["assessments", assessments],
      ["events", events],
      ["advisories", advisories],
      ["quarantine", quarantine],
    ];
    return {
      counts: {
        messages: messages.length,
        windows: windows.length,
        assessments: assessments.length,
        events: events.length,
        advisories: advisories.length,
        quarantine: quarantine.length,
      },
      sha256: sha256Hex(canonicalize(blocks)),
    };
  }

  public deleteMatching(
    systemUids: readonly string[],
    expectedRecordSetSha256: string,
  ): DeleteResult {
    const placeholders = unitPlaceholders(systemUids);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.recordSet(systemUids);
      if (current.sha256 !== expectedRecordSetSha256) {
        this.database.exec("ROLLBACK");
        const nonmatching = this.recordSet(systemUids, false);
        return {
          stale: true,
          deleted: zeroCounts(),
          remaining: current.counts,
          nonmatchingSha256: nonmatching.sha256,
          nonmatchingCounts: nonmatching.counts,
        };
      }
      const nonmatchingBefore = this.recordSet(systemUids, false).sha256;
      this.database.prepare(`DELETE FROM windows WHERE unit_system_uid IN (${placeholders})`).run(...systemUids);
      this.database.prepare(`DELETE FROM quarantine WHERE unit_system_uid IN (${placeholders})`).run(...systemUids);
      this.database.prepare(`DELETE FROM messages WHERE unit_system_uid IN (${placeholders})`).run(...systemUids);
      const remaining = this.recordSet(systemUids).counts;
      const nonmatchingAfter = this.recordSet(systemUids, false);
      if (!allZero(remaining) || nonmatchingAfter.sha256 !== nonmatchingBefore) {
        throw new Error("cleanup postcondition failed");
      }
      this.database.exec("COMMIT");
      return {
        stale: false,
        deleted: current.counts,
        remaining,
        nonmatchingSha256: nonmatchingAfter.sha256,
        nonmatchingCounts: nonmatchingAfter.counts,
      };
    } catch (error) {
      rollbackIfActive(this.database);
      throw error;
    }
  }

  private insertTyped(messageId: number, message: ParsedBrakeMessage): void {
    const value = message.value;
    const content = message.content;
    switch (message.messageType) {
      case "WINDOW_CHUNK": {
        const samples = content.samples as JsonValue[];
        const phases = { PRE: 0, ACTIVE: 0, POST: 0 };
        for (const sample of samples) {
          const phase = (sample as Record<string, JsonValue>).phase;
          if (phase === "PRE" || phase === "ACTIVE" || phase === "POST") phases[phase]++;
        }
        this.database.prepare(
          "INSERT INTO window_chunks(message_id, unit_system_uid, event_id, chunk_index, first_sample_index, " +
            "sample_count, phase_pre_count, phase_active_count, phase_post_count, first_sample_source_timestamp, " +
            "first_sample_source_timestamp_normalized, content_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          messageId, message.unitSystemUid, text(value.eventId), integer(content.chunkIndex),
          integer(content.firstSampleIndex), integer(content.sampleCount), phases.PRE, phases.ACTIVE, phases.POST,
          text((samples[0] as Record<string, JsonValue>).sourceTimestamp),
          normalizeRfc3339Instant(text((samples[0] as Record<string, JsonValue>).sourceTimestamp)), canonicalize(content),
        );
        return;
      }
      case "WINDOW_COMPLETION": {
        const phases = content.phaseSampleCounts as Record<string, JsonValue>;
        this.database.prepare(
          "INSERT INTO window_completions(message_id, unit_system_uid, event_id, terminal_state, reason_code, " +
            "trigger_timestamp, window_start_timestamp, window_start_timestamp_normalized, window_end_timestamp, phase_pre_count, phase_active_count, " +
            "phase_post_count, total_samples, total_chunks, chunk_content_sha256_json, window_sha256, content_sha256) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          messageId, message.unitSystemUid, text(value.eventId), text(content.terminalState), text(content.reasonCode),
          text(content.triggerTimestamp), text(content.windowStartTimestamp), normalizeRfc3339Instant(text(content.windowStartTimestamp)),
          text(content.windowEndTimestamp),
          integer(phases.PRE), integer(phases.ACTIVE), integer(phases.POST), integer(content.totalSamples),
          integer(content.totalChunks), canonicalize(content.chunkContentSha256!), text(content.windowSha256),
          message.contentSha256,
        );
        return;
      }
      case "BRAKE_HEALTH_ASSESSMENT":
        this.database.prepare(
          "INSERT INTO assessments(wire_schema_version, service_instance_json, message_id, unit_system_uid, assessment_id, source_event_id, assessed_at, content_sha256, " +
            "assessed_at_normalized, service_version, service_artifact_sha256, vdp_contract_version, vdp_contract_sha256, " +
            "model_id, model_version, model_config_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          integer(value.schemaVersion), nativeIdentity(value), messageId, message.unitSystemUid, text(value.assessmentId), text(value.sourceEventId), text(value.assessedAt),
          message.contentSha256, normalizeRfc3339Instant(text(value.assessedAt)), text(value.serviceVersion),
          legacyArtifact(value), text(value.vdpContractVersion),
          text(value.vdpContractSha256), text(value.modelId), text(value.modelVersion), text(value.modelConfigSha256),
        );
        return;
      case "BRAKE_HEALTH_EVENT":
        this.database.prepare(
          "INSERT INTO condition_events(wire_schema_version, service_instance_json, message_id, unit_system_uid, event_id, assessment_id, source_event_id, effective_at, " +
            "effective_at_normalized, content_sha256, service_version, service_artifact_sha256, model_id, model_version, " +
            "model_config_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          integer(value.schemaVersion), nativeIdentity(value), messageId, message.unitSystemUid, text(value.eventId), text(value.assessmentId), text(value.sourceEventId),
          text(content.effectiveAt), normalizeRfc3339Instant(text(content.effectiveAt)), message.contentSha256,
          text(value.serviceVersion), legacyArtifact(value),
          text(value.modelId), text(value.modelVersion), text(value.modelConfigSha256),
        );
        return;
      case "BRAKE_ADVISORY_FACT":
        this.database.prepare(
          "INSERT INTO advisory_facts(message_id, unit_system_uid, request_id, gateway_state, recorded_at, " +
            "recorded_at_normalized, content_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          messageId, message.unitSystemUid, text(value.requestId), text(value.gatewayState), text(value.recordedAt),
          normalizeRfc3339Instant(text(value.recordedAt)), message.contentSha256,
        );
    }
  }

  private hasExactlyCorrelatedEvent(message: ParsedBrakeMessage): boolean {
    const value = message.value;
    return this.database.prepare(
      "SELECT 1 FROM condition_events WHERE unit_system_uid = ? AND assessment_id = ? AND source_event_id = ? " +
        "AND service_version = ? AND service_artifact_sha256 IS ? AND model_id = ? AND model_version = ? " +
        "AND model_config_sha256 = ? AND wire_schema_version = ? AND service_instance_json IS ? LIMIT 1",
    ).get(
      message.unitSystemUid, text(value.assessmentId), text(value.sourceEventId), text(value.serviceVersion),
      legacyArtifact(value), text(value.modelId), text(value.modelVersion), text(value.modelConfigSha256),
      integer(value.schemaVersion), nativeIdentity(value),
    ) !== undefined;
  }

  private rebuildWindow(message: ParsedBrakeMessage, receivedAt: string): readonly ChangedResource[] {
    const eventId = text(message.value.eventId);
    const chunkRows = this.database.prepare(
      "SELECT c.chunk_index, m.content_sha256, c.content_json, m.canonical_message " +
        "FROM window_chunks c JOIN messages m ON m.id = c.message_id " +
        "WHERE c.unit_system_uid = ? AND c.event_id = ? ORDER BY c.chunk_index",
    ).all(message.unitSystemUid, eventId) as SqlRow[];
    const completionRow = this.database.prepare(
      "SELECT m.content_sha256, m.canonical_message FROM window_completions c " +
        "JOIN messages m ON m.id = c.message_id WHERE c.unit_system_uid = ? AND c.event_id = ?",
    ).get(message.unitSystemUid, eventId) as SqlRow | undefined;
    const chunks: WindowChunkFact[] = chunkRows.map((row) => ({
      chunkIndex: numberColumn(row, "chunk_index"),
      contentSha256: stringColumn(row, "content_sha256"),
      content: objectJson(stringColumn(row, "content_json")),
    }));
    const completionMessage = completionRow === undefined
      ? null
      : objectJson(stringColumn(completionRow, "canonical_message"));
    const completionContent = completionMessage === null ? null : completionMessage.content;
    const completion: WindowCompletionFact | null = completionRow === undefined ||
      typeof completionContent !== "object" || completionContent === null || Array.isArray(completionContent)
      ? null
      : {
          contentSha256: stringColumn(completionRow, "content_sha256"),
          content: completionContent,
        };
    let projection = reconstructWindow(chunks, completion);
    if (projection === null) return [];

    const canonicalRows = [
      ...chunkRows.map((row) => stringColumn(row, "canonical_message")),
      ...(completionRow === undefined ? [] : [stringColumn(completionRow, "canonical_message")]),
    ].map(objectJson);
    const metadata = canonicalRows.map((row) =>
      canonicalize([
        row.schemaVersion!, row.unitRole!, row.serviceVersion!, legacyArtifact(row), nativeIdentity(row),
        row.vdpContractVersion!, row.vdpContractSha256!,
      ]),
    );
    if (new Set(metadata).size !== 1) {
      projection = {
        ...projection,
        projectionState: "QUARANTINED",
        deliveryState: "CONFLICT",
        terminalState: null,
        windowSha256: null,
        inconsistencyReason: "WINDOW_IDENTITY_METADATA_MISMATCH",
      };
    }
    if (this.hasWindowContentConflict(message.unitSystemUid, eventId)) {
      projection = { ...projection, deliveryState: "CONFLICT" };
    }
    if (projection.inconsistencyReason !== null) {
      this.insertQuarantine(message, projection.inconsistencyReason, receivedAt);
    }
    this.upsertWindow(message, eventId, projection, receivedAt);
    return ["WINDOW"];
  }

  private hasWindowContentConflict(unitSystemUid: string, eventId: string): boolean {
    return this.database.prepare(
      "SELECT 1 FROM quarantine WHERE unit_system_uid = ? AND reason_code = 'CONTENT_CONFLICT' " +
        "AND ((message_type = 'WINDOW_COMPLETION' AND message_identity = ?) OR " +
        "(message_type = 'WINDOW_CHUNK' AND message_identity LIKE ?)) LIMIT 1",
    ).get(unitSystemUid, eventId, `${eventId}:%`) !== undefined;
  }

  private upsertWindow(
    message: ParsedBrakeMessage,
    eventId: string,
    projection: WindowProjection,
    receivedAt: string,
  ): void {
    const value = message.value;
    this.database.prepare(
      "INSERT INTO windows(wire_schema_version, service_instance_json, unit_system_uid, event_id, unit_role, service_version, service_artifact_sha256, " +
        "vdp_contract_version, vdp_contract_sha256, delivery_state, projection_state, terminal_state, " +
        "received_chunk_count, expected_chunk_count, received_sample_count, phase_pre_count, phase_active_count, " +
        "phase_post_count, window_start_timestamp, window_start_timestamp_normalized, completion_content_sha256, " +
        "window_sha256, last_backend_received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(unit_system_uid, event_id) DO UPDATE SET " +
        "delivery_state=excluded.delivery_state, projection_state=excluded.projection_state, terminal_state=excluded.terminal_state, " +
        "received_chunk_count=excluded.received_chunk_count, expected_chunk_count=excluded.expected_chunk_count, " +
        "received_sample_count=excluded.received_sample_count, phase_pre_count=excluded.phase_pre_count, " +
        "phase_active_count=excluded.phase_active_count, phase_post_count=excluded.phase_post_count, " +
        "window_start_timestamp=excluded.window_start_timestamp, " +
        "window_start_timestamp_normalized=excluded.window_start_timestamp_normalized, " +
        "completion_content_sha256=excluded.completion_content_sha256, " +
        "window_sha256=excluded.window_sha256, last_backend_received_at=excluded.last_backend_received_at",
    ).run(
      integer(value.schemaVersion), nativeIdentity(value), message.unitSystemUid, eventId, message.unitRole, text(value.serviceVersion), legacyArtifact(value),
      text(value.vdpContractVersion), text(value.vdpContractSha256), projection.deliveryState,
      projection.projectionState, projection.terminalState, projection.receivedChunkCount,
      projection.expectedChunkCount, projection.receivedSampleCount, projection.phaseSampleCounts.PRE,
      projection.phaseSampleCounts.ACTIVE, projection.phaseSampleCounts.POST, projection.windowStartTimestamp,
      normalizeRfc3339Instant(projection.windowStartTimestamp), projection.completionContentSha256,
      projection.windowSha256, receivedAt,
    );
  }

  private insertQuarantine(message: ParsedBrakeMessage, reason: string, receivedAt: string): void {
    this.database.prepare(
      "INSERT INTO quarantine(unit_system_uid, message_type, message_identity, message_key_sha256, " +
        "attempted_content_sha256, reason_code, quarantined_at, attempted_canonical_message) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      message.unitSystemUid, message.messageType, message.messageIdentity, message.messageKeySha256,
      message.contentSha256, reason, receivedAt, message.canonicalMessage,
    );
  }

  private visibleConflictResources(message: ParsedBrakeMessage, receivedAt: string): readonly ChangedResource[] {
    if (message.changedResource !== "WINDOW") return [message.changedResource];
    const eventId = text(message.value.eventId);
    const row = this.database.prepare(
      "SELECT id FROM windows WHERE unit_system_uid = ? AND event_id = ?",
    ).get(message.unitSystemUid, eventId);
    if (row === undefined) return [];
    this.database.prepare(
      "UPDATE windows SET delivery_state = 'CONFLICT', last_backend_received_at = ? " +
        "WHERE unit_system_uid = ? AND event_id = ?",
    ).run(receivedAt, message.unitSystemUid, eventId);
    return ["WINDOW"];
  }

  private queryWindows(
    uid: string,
    limit: number,
    after: readonly string[] | null,
  ): QueryResult {
    const where = after === null
      ? "unit_system_uid = ?"
      : "unit_system_uid = ? AND (window_start_timestamp_normalized < ? OR " +
        "(window_start_timestamp_normalized = ? AND event_id < ?))";
    const parameters = after === null
      ? [uid, limit + 1]
      : [uid, after[0], after[0], after[1], limit + 1];
    const rows = this.database.prepare(
      "SELECT * FROM windows WHERE " + where +
        " ORDER BY window_start_timestamp_normalized DESC, event_id DESC LIMIT ?",
    ).all(...parameters) as SqlRow[];
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        eventId: stringColumn(row, "event_id"),
        unitSystemUid: stringColumn(row, "unit_system_uid"),
        unitRole: stringColumn(row, "unit_role"),
        serviceVersion: stringColumn(row, "service_version"),
        ...(numberColumn(row, "wire_schema_version") === 1
          ? { serviceArtifactSha256: stringColumn(row, "service_artifact_sha256") }
          : { messageSchemaVersion: 2, serviceInstance: objectJson(stringColumn(row, "service_instance_json")) }),
        vdpContractVersion: stringColumn(row, "vdp_contract_version"),
        vdpContractSha256: stringColumn(row, "vdp_contract_sha256"),
        windowStartTimestamp: stringColumn(row, "window_start_timestamp"),
        backendReceivedAt: stringColumn(row, "last_backend_received_at"),
        deliveryState: stringColumn(row, "delivery_state"),
        projectionState: stringColumn(row, "projection_state"),
        terminalState: nullableString(row.terminal_state),
        receivedChunkCount: numberColumn(row, "received_chunk_count"),
        expectedChunkCount: nullableNumber(row.expected_chunk_count),
        receivedSampleCount: numberColumn(row, "received_sample_count"),
        phaseSampleCounts: {
          PRE: numberColumn(row, "phase_pre_count"),
          ACTIVE: numberColumn(row, "phase_active_count"),
          POST: numberColumn(row, "phase_post_count"),
        },
        completionContentSha256: nullableString(row.completion_content_sha256),
        windowSha256: nullableString(row.window_sha256),
      })),
      nextKey: rows.length > limit && page.length > 0
        ? [stringColumn(page.at(-1)!, "window_start_timestamp_normalized"), stringColumn(page.at(-1)!, "event_id")]
        : null,
    };
  }

  private queryMessages(
    table: "assessments",
    timeColumn: "assessed_at",
    normalizedTimeColumn: "assessed_at_normalized",
    identityColumn: "assessment_id",
    resource: "ASSESSMENT",
    uid: string,
    limit: number,
    after: readonly string[] | null,
  ): QueryResult {
    const where = after === null
      ? `a.unit_system_uid = ?`
      : `a.unit_system_uid = ? AND (a.${normalizedTimeColumn} < ? OR ` +
        `(a.${normalizedTimeColumn} = ? AND a.${identityColumn} < ?))`;
    const parameters = after === null ? [uid, limit + 1] : [uid, after[0], after[0], after[1], limit + 1];
    const rows = this.database.prepare(
      `SELECT a.${timeColumn}, a.${normalizedTimeColumn}, a.${identityColumn}, m.backend_received_at, m.canonical_message ` +
        `FROM ${table} a JOIN messages m ON m.id = a.message_id WHERE ${where} ` +
        `ORDER BY a.${normalizedTimeColumn} DESC, a.${identityColumn} DESC LIMIT ?`,
    ).all(...parameters) as SqlRow[];
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        sourceEventTime: stringColumn(row, timeColumn),
        backendReceivedAt: stringColumn(row, "backend_received_at"),
        deliveryState: this.deliveryState(objectJson(stringColumn(row, "canonical_message"))),
        message: objectJson(stringColumn(row, "canonical_message")),
      })),
      nextKey: rows.length > limit && page.length > 0
        ? [stringColumn(page.at(-1)!, normalizedTimeColumn), stringColumn(page.at(-1)!, identityColumn)]
        : null,
    };
  }

  private queryEvents(uid: string, limit: number, after: readonly string[] | null): QueryResult {
    const where = after === null
      ? "e.unit_system_uid = ?"
      : "e.unit_system_uid = ? AND (e.effective_at_normalized < ? OR " +
        "(e.effective_at_normalized = ? AND e.event_id < ?))";
    const parameters = after === null ? [uid, limit + 1] : [uid, after[0], after[0], after[1], limit + 1];
    const rows = this.database.prepare(
      "SELECT e.*, m.backend_received_at, m.canonical_message FROM condition_events e " +
        "JOIN messages m ON m.id = e.message_id WHERE " + where +
        " ORDER BY e.effective_at_normalized DESC, e.event_id DESC LIMIT ?",
    ).all(...parameters) as SqlRow[];
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => {
        const assessment = this.database.prepare(
          "SELECT a.vdp_contract_version, a.vdp_contract_sha256 FROM assessments a " +
            "WHERE a.unit_system_uid = ? AND a.assessment_id = ? AND a.source_event_id = ? " +
            "AND a.service_version = ? AND a.service_artifact_sha256 IS ? AND a.model_id = ? " +
            "AND a.model_version = ? AND a.model_config_sha256 = ? AND a.wire_schema_version = ? AND a.service_instance_json IS ?",
        ).get(
          row.unit_system_uid, row.assessment_id, row.source_event_id, row.service_version,
          row.service_artifact_sha256, row.model_id, row.model_version, row.model_config_sha256,
          row.wire_schema_version, row.service_instance_json,
        ) as SqlRow | undefined;
        const message = objectJson(stringColumn(row, "canonical_message"));
        return {
          sourceEventTime: stringColumn(row, "effective_at"),
          backendReceivedAt: stringColumn(row, "backend_received_at"),
          deliveryState: this.deliveryState(message),
          vdpProvenanceState: assessment === undefined ? "PENDING_ASSESSMENT_CORRELATION" : "CORRELATED_ASSESSMENT",
          vdpContractVersion: assessment === undefined ? null : stringColumn(assessment, "vdp_contract_version"),
          vdpContractSha256: assessment === undefined ? null : stringColumn(assessment, "vdp_contract_sha256"),
          message,
        } as JsonValue;
      }),
      nextKey: rows.length > limit && page.length > 0
        ? [stringColumn(page.at(-1)!, "effective_at_normalized"), stringColumn(page.at(-1)!, "event_id")]
        : null,
    };
  }

  private queryAdvisories(uid: string, limit: number, after: readonly string[] | null): QueryResult {
    const where = after === null
      ? "a.unit_system_uid = ?"
      : "a.unit_system_uid = ? AND (a.recorded_at_normalized < ? OR (a.recorded_at_normalized = ? AND " +
        "(a.request_id < ? OR (a.request_id = ? AND a.gateway_state < ?))))";
    const parameters = after === null
      ? [uid, limit + 1]
      : [uid, after[0], after[0], after[1], after[1], after[2], limit + 1];
    const rows = this.database.prepare(
      "SELECT a.*, m.backend_received_at, m.canonical_message FROM advisory_facts a " +
        "JOIN messages m ON m.id = a.message_id WHERE " + where +
        " ORDER BY a.recorded_at_normalized DESC, a.request_id DESC, a.gateway_state DESC LIMIT ?",
    ).all(...parameters) as SqlRow[];
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => {
        const message = objectJson(stringColumn(row, "canonical_message"));
        return {
          sourceEventTime: stringColumn(row, "recorded_at"),
          backendReceivedAt: stringColumn(row, "backend_received_at"),
          deliveryState: this.deliveryState(message),
          message,
        } as JsonValue;
      }),
      nextKey: rows.length > limit && page.length > 0
        ? [stringColumn(page.at(-1)!, "recorded_at_normalized"), stringColumn(page.at(-1)!, "request_id"), stringColumn(page.at(-1)!, "gateway_state")]
        : null,
    };
  }

  private deliveryState(message: Readonly<Record<string, JsonValue>>): "DURABLY_RECEIVED" | "CONFLICT" {
    const unit = text(message.unitSystemUid);
    const type = text(message.messageType);
    const parsedIdentity = messageIdentity(message);
    const conflict = this.database.prepare(
      "SELECT id FROM quarantine WHERE unit_system_uid = ? AND message_type = ? AND message_identity = ? " +
        "AND reason_code = 'CONTENT_CONFLICT' LIMIT 1",
    ).get(unit, type, parsedIdentity);
    return conflict === undefined ? "DURABLY_RECEIVED" : "CONFLICT";
  }

  private rows(sql: string, parameters: readonly string[], fields: readonly string[]): JsonValue[] {
    const rows = this.database.prepare(sql).all(...parameters) as SqlRow[];
    const values = rows.map((row) => fields.map((field) => sqlValue(row[field])) as JsonValue);
    return values.sort((left, right) => Buffer.compare(Buffer.from(canonicalize(left)), Buffer.from(canonicalize(right))));
  }
}

function acknowledgement(
  message: ParsedBrakeMessage,
  receiptId: string,
  receivedAt: string,
  state: DurableAcknowledgement["state"],
): DurableAcknowledgement {
  return {
    schemaVersion: 1,
    contractVersion: "1.0.0",
    receiptId,
    messageKeySha256: message.messageKeySha256,
    contentSha256: message.contentSha256,
    state,
    receivedAt,
  };
}

function messageIdentity(message: Readonly<Record<string, JsonValue>>): string {
  switch (message.messageType) {
    case "WINDOW_CHUNK":
      return `${text(message.eventId)}:${integer((message.content as Record<string, JsonValue>).chunkIndex)}`;
    case "WINDOW_COMPLETION":
      return text(message.eventId);
    case "BRAKE_HEALTH_ASSESSMENT":
      return text(message.assessmentId);
    case "BRAKE_HEALTH_EVENT":
      return text(message.eventId);
    case "BRAKE_ADVISORY_FACT":
      return `${text(message.requestId)}:${text(message.gatewayState)}`;
    default:
      throw new TypeError("stored message type is invalid");
  }
}

function unitPlaceholders(systemUids: readonly string[]): string {
  if (systemUids.length < 1 || systemUids.length > 2 ||
      new Set(systemUids).size !== systemUids.length ||
      systemUids.some((uid) => typeof uid !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(uid))) {
    throw new TypeError("record selector requires one or two distinct exact Unit UIDs");
  }
  return systemUids.map(() => "?").join(", ");
}

function objectJson(value: string): Readonly<Record<string, JsonValue>> {
  const parsed = parseJsonRejectDuplicates(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("stored JSON object is invalid");
  }
  return parsed;
}

function text(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new TypeError("expected string field");
  return value;
}

function integer(value: JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new TypeError("expected integer field");
  return value;
}

function stringColumn(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError(`${key} is not a string column`);
  return value;
}

function numberColumn(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new TypeError(`${key} is not a number column`);
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError("nullable string column is invalid");
  return value;
}

function nullableNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number") throw new TypeError("nullable number column is invalid");
  return value;
}

function sqlValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  throw new TypeError("logical row contains an unsupported SQLite value");
}

function zeroCounts(): RecordCounts {
  return { messages: 0, windows: 0, assessments: 0, events: 0, advisories: 0, quarantine: 0 };
}

function allZero(counts: RecordCounts): boolean {
  return TABLES.every((table) => counts[table] === 0);
}

function rollbackIfActive(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // BEGIN itself may have failed because the single SQLite writer is busy.
  }
}

/** Legacy digest columns are absent for native records, never fabricated. */
function legacyArtifact(value: Readonly<Record<string, JsonValue>>): string | null {
  return value.schemaVersion === 1 ? text(value.serviceArtifactSha256) : null;
}

function nativeIdentity(value: Readonly<Record<string, JsonValue>>): string | null {
  return value.schemaVersion === 2 ? canonicalize(value.serviceInstance!) : null;
}
