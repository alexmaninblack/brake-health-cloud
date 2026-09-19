// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
// Frozen service-function-observation v3. Keep packaged copies byte-identical.
import {createHash, randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";

type ObjectValue = Record<string, unknown>;
const fail = (): never => { throw new Error("INVALID_FUNCTION_OBSERVATION"); };
const object = (value: unknown, keys: string[]): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) return fail();
  return value as ObjectValue;
};
const pick = (value: unknown, values: string[]): string =>
  typeof value === "string" && values.includes(value) ? value : fail();
const integer = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail();
const id = (value: unknown): string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/.test(value) ? value : fail();
const version = (value: unknown): string =>
  typeof value === "string" && value.length <= 32 && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$(?![\s\S])/.test(value) ? value : fail();
const instant = (value: unknown): string => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return fail();
  return value;
};
export const observationCanonical = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(observationCanonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ":" + observationCanonical((value as ObjectValue)[key])).join(",") + "}";
  return fail();
};
export const observationDigest = (value: string): string => createHash("sha256").update(value).digest("hex");
export function validateFunctionObservation(value: unknown, team: "brake" | "tire") {
  const m = object(value, ["schemaVersion","contractVersion","messageType","unitSystemUid","unitRole",
    "serviceInstance","serviceVersion","serviceProfile","generation","sequence","observedAt","content","contentSha256"]);
  if (m.schemaVersion !== 3 || m.contractVersion !== "3.0.0"
      || m.messageType !== team.toUpperCase() + "_FUNCTION_OBSERVATION") return fail();
  id(m.unitSystemUid); pick(m.unitRole, ["VALIDATION","PRODUCTION"]); version(m.serviceVersion);
  const profile = pick(m.serviceProfile, team === "brake" ? ["v1","v2","v3"] : ["v1"]);
  const binding = object(m.serviceInstance, ["serviceId","subjectId","instanceIndex","instanceId"]);
  id(binding.serviceId); id(binding.subjectId); id(binding.instanceId); integer(binding.instanceIndex);
  if (!integer(m.generation) || !integer(m.sequence)) return fail();
  instant(m.observedAt);
  const c = object(m.content, ["connection","input","activity","delivery","advisory","lastResult"]);
  pick(c.connection, ["STARTING","CONNECTED","REAUTHENTICATING","DISCONNECTED","ACCESS_DENIED"]);
  const input = object(c.input, ["state","reason"]);
  pick(input.state, ["WAITING","RECEIVING","STALE","DISCONNECTED","ACCESS_DENIED","INVALID"]);
  pick(input.reason, ["NONE","AWAITING_INPUT","SOURCE_GAP","INVALID_SAMPLE","TRANSPORT_LOST","ACCESS_DENIED","REAUTHENTICATING"]);
  if ((input.state === "RECEIVING") !== (input.reason === "NONE")) return fail();
  const activity = object(c.activity, ["state","reason","episodeId"]);
  pick(activity.state, ["WAITING","PRE","ACTIVE","POST","COMPLETED","SKIPPED"]);
  pick(activity.reason, ["NONE","NOT_QUALIFIED","INSUFFICIENT_SAMPLES","INVALID_INPUT","SOURCE_DISCONTINUITY","REAUTHENTICATING","RESET","STORAGE_UNAVAILABLE"]);
  if (activity.episodeId !== null) id(activity.episodeId);
  if (activity.state === "SKIPPED" && activity.reason === "NONE") return fail();
  const delivery = object(c.delivery, ["state","queuedMessages","lastReceiptAt"]);
  pick(delivery.state, ["IDLE","PENDING","RETRYING","BLOCKED"]);
  integer(delivery.queuedMessages);
  if (delivery.lastReceiptAt !== null) instant(delivery.lastReceiptAt);
  const advisory = object(c.advisory, ["state","requestId"]);
  pick(advisory.state, ["NOT_SUPPORTED","WAITING","CONFIRMED","UNAVAILABLE","REAUTHENTICATING"]);
  if (advisory.requestId !== null) id(advisory.requestId);
  if (advisory.state === "CONFIRMED" && advisory.requestId === null) return fail();
  if (team === "brake" && profile !== "v3" && (advisory.state !== "NOT_SUPPORTED" || advisory.requestId !== null)) return fail();
  if ((team === "tire" || profile === "v3") && advisory.state === "NOT_SUPPORTED") return fail();
  if (c.lastResult !== null) {
    const result = object(c.lastResult, ["kind","id","sourceTime","serviceVersion"]);
    pick(result.kind, ["WINDOW","ASSESSMENT"]); id(result.id); instant(result.sourceTime); version(result.serviceVersion);
  }
  const canonical = observationCanonical(m);
  if (Buffer.byteLength(canonical) > 8192) throw new Error("FUNCTION_OBSERVATION_TOO_LARGE");
  if (m.contentSha256 !== observationDigest(observationCanonical(c))) return fail();
  const bindingJson = observationCanonical(binding);
  const key = observationDigest(observationCanonical([m.unitSystemUid,m.messageType,binding,m.generation,m.sequence]));
  return {message: m, canonical, binding: bindingJson, key, digest: observationDigest(canonical)};
}

export const functionObservationSchema = [
  "CREATE TABLE function_observations (id INTEGER PRIMARY KEY, system_uid TEXT NOT NULL, binding TEXT NOT NULL, generation INTEGER NOT NULL, sequence INTEGER NOT NULL, message_key TEXT NOT NULL UNIQUE, message_digest TEXT NOT NULL, content_digest TEXT NOT NULL, canonical TEXT, observed_at TEXT NOT NULL, received_at TEXT NOT NULL, receipt_id TEXT NOT NULL UNIQUE, UNIQUE(system_uid,binding,generation,sequence)) STRICT",
  "CREATE INDEX function_observations_order ON function_observations(system_uid,binding,generation DESC,sequence DESC)",
  "CREATE TABLE function_observation_conflicts (message_key TEXT NOT NULL, message_digest TEXT NOT NULL, system_uid TEXT NOT NULL, PRIMARY KEY(message_key,message_digest)) STRICT",
];
type Row = Record<string, unknown>;
export class FunctionObservationStore {
  private db: DatabaseSync;
  private team: "brake" | "tire";
  private now: () => string;
  constructor(db: DatabaseSync, team: "brake" | "tire", now: () => string = () => new Date().toISOString()) {
    this.db = db; this.team = team; this.now = now;
  }
  ingest(value: unknown, role: string) {
    const input = validateFunctionObservation(value, this.team), m = input.message;
    if (role !== m.unitRole) return fail();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT * FROM function_observations WHERE message_key=?").get(input.key) as Row | undefined;
      if (previous && previous.message_digest !== input.digest) {
        this.db.prepare("INSERT OR IGNORE INTO function_observation_conflicts VALUES(?,?,?)").run(input.key,input.digest,m.unitSystemUid as string);
        this.db.exec("COMMIT");
        return {status: 409, body: {schemaVersion:1,contractVersion:"1.0.0",errorCode:"CONTENT_CONFLICT",retryable:false}};
      }
      const receivedAt = previous?.received_at as string ?? this.now(), receiptId = previous?.receipt_id as string ?? randomUUID();
      if (!previous) {
        this.db.prepare("INSERT INTO function_observations(system_uid,binding,generation,sequence,message_key,message_digest,content_digest,canonical,observed_at,received_at,receipt_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .run(m.unitSystemUid as string,input.binding,m.generation as number,m.sequence as number,input.key,input.digest,m.contentSha256 as string,input.canonical,m.observedAt as string,receivedAt,receiptId);
        // Bound retained payloads per native binding, keeping compact receipts
        // permanently for exact retry/conflict checks until owned-run cleanup.
        this.db.prepare("UPDATE function_observations SET canonical=NULL WHERE system_uid=? AND binding=? AND canonical IS NOT NULL AND id NOT IN (SELECT id FROM function_observations WHERE system_uid=? AND binding=? ORDER BY generation DESC,sequence DESC LIMIT 1024)")
          .run(m.unitSystemUid as string,input.binding,m.unitSystemUid as string,input.binding);
      }
      this.db.exec("COMMIT");
      return {status:previous ? 200 : 201,body:{schemaVersion:1,contractVersion:"1.0.0",receiptId,messageKeySha256:input.key,
        contentSha256:m.contentSha256,state:previous ? "DUPLICATE_ACCEPTED" : "DURABLE_ACCEPTED",receivedAt}};
    } catch(error) {this.db.exec("ROLLBACK"); throw error;}
  }
  query(uid: string, limit = 10) {
    id(uid);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail();
    // One source-ordered head per native binding. No cross-instance "winner".
    const rows = this.db.prepare("SELECT f.*, EXISTS(SELECT 1 FROM function_observation_conflicts c WHERE c.message_key=f.message_key) AS conflicted FROM function_observations f WHERE system_uid=? AND canonical IS NOT NULL AND NOT EXISTS(SELECT 1 FROM function_observations n WHERE n.system_uid=f.system_uid AND n.binding=f.binding AND (n.generation>f.generation OR (n.generation=f.generation AND n.sequence>f.sequence))) ORDER BY binding LIMIT ?")
      .all(uid,limit+1) as Row[];
    return {schemaVersion:3,contractVersion:"3.0.0",resourceType:"FUNCTION_OBSERVATION",unitSystemUid:uid,
      items:rows.slice(0,limit).map(row => {
        const age = Date.parse(this.now()) - Date.parse(row.observed_at as string);
        return {message:JSON.parse(row.canonical as string) as unknown,backendReceivedAt:row.received_at,
          authority:"FUNCTION_TEAM_REPORTED_OBSERVATION",stale:age < 0 || age > 90000,
          clockSkew:age < 0,deliveryState:row.conflicted ? "CONFLICT" : "DURABLY_RECEIVED"};
      }), truncated:rows.length > limit};
  }
}

