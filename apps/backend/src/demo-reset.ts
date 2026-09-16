// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0
import {DatabaseSync} from "node:sqlite";

type ObjectValue = Record<string, unknown>;
type Row = {command_id: string; system_uid: string; binding: string; issued_at: string; expires_at: string; state: string; result: string | null};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uid = /^[A-Za-z0-9._:-]{1,128}$/;
const bindingKeys = ["schemaVersion", "unitSystemUid", "serviceVersion", "serviceInstance", "producerEpoch"];
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RESET_INVALID_REQUEST");
  return value as ObjectValue;
}
function closed(value: unknown, keys: string[]): ObjectValue {
  const result = object(value);
  if (Object.keys(result).sort().join() !== [...keys].sort().join()) throw new Error("RESET_INVALID_REQUEST");
  return result;
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error("RESET_INVALID_REQUEST");
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const entry = value as ObjectValue;
    return "{" + Object.keys(entry).sort().map(key => JSON.stringify(key) + ":" + canonical(entry[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))) throw new Error("RESET_CLEAR_NOT_CONFIRMED");
  return Date.parse(value);
}
export const resetSchema = [
  "CREATE TABLE demo_reset_producers (system_uid TEXT PRIMARY KEY, binding TEXT NOT NULL, last_seen INTEGER NOT NULL) STRICT",
  "CREATE TABLE demo_reset_commands (command_id TEXT PRIMARY KEY, system_uid TEXT NOT NULL, binding TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, state TEXT NOT NULL, result TEXT) STRICT"
];

export class DemoResetStore {
  private readonly db: DatabaseSync;
  private readonly currentTest: () => string | undefined;
  private readonly clock: () => number;
  constructor(db: DatabaseSync, currentTest: () => string | undefined, clock: () => number = Date.now) {
    this.db = db; this.currentTest = currentTest; this.clock = clock;
  }
  private scope(value: unknown): string {
    const selected = this.currentTest();
    if (!selected) throw new Error("CURRENT_UNIT_CONTEXT_UNAVAILABLE");
    if (text(value, uid) !== selected) throw new Error("UNIT_NOT_CURRENT");
    return selected;
  }
  private binding(value: unknown): ObjectValue {
    const entry = closed(value, bindingKeys);
    this.scope(entry.unitSystemUid);
    if (entry.schemaVersion !== 1) throw new Error("RESET_INVALID_REQUEST");
    text(entry.serviceVersion, /^[0-9]+\.[0-9]+\.[0-9]+$/);
    text(entry.producerEpoch, uuid);
    const instance = closed(entry.serviceInstance, ["serviceId", "subjectId", "instanceIndex", "instanceId"]);
    text(instance.serviceId, uid); text(instance.subjectId, uid); text(instance.instanceId, uid);
    if (!Number.isSafeInteger(instance.instanceIndex) || (instance.instanceIndex as number) < 0) throw new Error("RESET_INVALID_REQUEST");
    return entry;
  }
  private expire(): void {
    this.db.prepare("UPDATE demo_reset_commands SET state='EXPIRED' WHERE state='PENDING' AND expires_at<=?").run(new Date(this.clock()).toISOString());
  }
  private envelope(row: Row): ObjectValue {
    return {...object(JSON.parse(row.binding)), commandId: row.command_id, operation: "RESET_DEMO_SCENARIO", issuedAt: row.issued_at, expiresAt: row.expires_at};
  }
  poll(value: unknown): ObjectValue {
    const binding = this.binding(value), encoded = canonical(binding);
    const selected = binding.unitSystemUid as string;
    this.expire();
    this.db.prepare("INSERT INTO demo_reset_producers VALUES(?,?,?) ON CONFLICT(system_uid) DO UPDATE SET binding=excluded.binding,last_seen=excluded.last_seen").run(selected, encoded, this.clock());
    const row = this.db.prepare("SELECT * FROM demo_reset_commands WHERE system_uid=? AND binding=? AND state='PENDING' ORDER BY issued_at DESC LIMIT 1").get(selected, encoded) as Row | undefined;
    return {schemaVersion: 1, command: row ? this.envelope(row) : null};
  }
  create(value: unknown): ObjectValue {
    const entry = closed(value, ["schemaVersion", "unitSystemUid", "commandId"]);
    const selected = this.scope(entry.unitSystemUid), commandId = text(entry.commandId, uuid);
    if (entry.schemaVersion !== 1) throw new Error("RESET_INVALID_REQUEST");
    this.expire();
    const existing = this.db.prepare("SELECT * FROM demo_reset_commands WHERE command_id=?").get(commandId) as Row | undefined;
    if (existing) {
      if (existing.system_uid !== selected) throw new Error("UNIT_NOT_CURRENT");
      return this.status(selected, commandId);
    }
    if (this.db.prepare("SELECT command_id FROM demo_reset_commands WHERE system_uid=? AND state='PENDING'").get(selected)) throw new Error("RESET_ALREADY_PENDING");
    const producer = this.db.prepare("SELECT binding,last_seen FROM demo_reset_producers WHERE system_uid=?").get(selected) as {binding: string; last_seen: number} | undefined;
    if (!producer || this.clock() - producer.last_seen > 15000 || this.clock() < producer.last_seen) throw new Error("RESET_SERVICE_NOT_CONNECTED");
    this.db.prepare("INSERT INTO demo_reset_commands VALUES(?,?,?,?,?,'PENDING',NULL)").run(commandId, selected, producer.binding,
      new Date(this.clock()).toISOString(), new Date(this.clock()+60000).toISOString());
    this.db.prepare("DELETE FROM demo_reset_commands WHERE system_uid=? AND command_id NOT IN (SELECT command_id FROM demo_reset_commands WHERE system_uid=? ORDER BY issued_at DESC,rowid DESC LIMIT 32)").run(selected, selected);
    return this.status(selected, commandId);
  }
  acknowledge(value: unknown): ObjectValue {
    const entry = closed(value, [...bindingKeys, "commandId", "result", "clearRequest", "gatewayStatus"]);
    const binding = this.binding(Object.fromEntries(bindingKeys.map(key => [key, entry[key]])));
    const commandId = text(entry.commandId, uuid);
    const row = this.db.prepare("SELECT * FROM demo_reset_commands WHERE command_id=?").get(commandId) as Row | undefined;
    if (!row || row.binding !== canonical(binding)) throw new Error("RESET_BINDING_MISMATCH");
    if (!["CLEARED", "REJECTED", "FAILED"].includes(String(entry.result))) throw new Error("RESET_INVALID_REQUEST");
    if (entry.result === "CLEARED") {
      let request: ObjectValue, status: ObjectValue;
      try {
        request = closed(entry.clearRequest, ["schemaVersion","requestId","producerEpoch","sequence","operation","reasonCode","decisionId","serviceVersion","modelVersion","issuedAt","expiresAt"]);
        status = closed(entry.gatewayStatus, ["schemaVersion","requestId","producerEpoch","sequence","state","reason","gatewayObservedAt","activeRecommendation","activeReasonCode","activeUntil"]);
      } catch { throw new Error("RESET_CLEAR_NOT_CONFIRMED"); }
      const issued = timestamp(request.issuedAt), expires = timestamp(request.expiresAt), observed = timestamp(status.gatewayObservedAt);
      if (request.schemaVersion !== 1 || status.schemaVersion !== 1 || status.reason !== "NONE" ||
          request.operation !== "CLEAR" || request.reasonCode !== "CONDITION_CLEARED" || request.decisionId !== commandId ||
          request.producerEpoch !== binding.producerEpoch || request.serviceVersion !== binding.serviceVersion ||
          !Number.isSafeInteger(request.sequence) || (request.sequence as number) < 1 ||
          status.state !== "CLEARED" || status.activeRecommendation !== "NONE" || status.activeReasonCode !== "NONE" || status.activeUntil !== null ||
          status.producerEpoch !== request.producerEpoch || status.sequence !== request.sequence || status.requestId !== request.requestId ||
          typeof request.modelVersion !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(request.modelVersion) ||
          issued < Date.parse(row.issued_at) || issued >= Date.parse(row.expires_at) ||
          expires <= issued || expires-issued > 30000 || observed < issued || observed > expires ||
          observed > this.clock()) throw new Error("RESET_CLEAR_NOT_CONFIRMED");
      text(request.requestId, uuid);
    } else if (entry.clearRequest !== null || entry.gatewayStatus !== null) throw new Error("RESET_INVALID_REQUEST");
    const encoded = canonical(entry);
    if (row.result && row.result !== encoded) throw new Error("RESET_ACK_CONFLICT");
    // A delayed ACK can reconcile an already applied CLEAR after the execution
    // deadline; it never authorizes starting a new reset.
    this.db.prepare("UPDATE demo_reset_commands SET state=?,result=? WHERE command_id=?").run(String(entry.result), encoded, commandId);
    return {schemaVersion: 1, commandId, state: entry.result};
  }
  status(value: unknown, commandId?: string): ObjectValue {
    const selected = this.scope(value);
    const row = (commandId
      ? this.db.prepare("SELECT * FROM demo_reset_commands WHERE system_uid=? AND command_id=?").get(selected, commandId)
      : this.db.prepare("SELECT * FROM demo_reset_commands WHERE system_uid=? ORDER BY issued_at DESC,rowid DESC LIMIT 1").get(selected)) as Row | undefined;
    const producer = this.db.prepare("SELECT last_seen FROM demo_reset_producers WHERE system_uid=?").get(selected) as {last_seen: number} | undefined;
    return {schemaVersion: 1, unitSystemUid: selected, connected: !!producer && this.clock() >= producer.last_seen && this.clock()-producer.last_seen<=15000,
      command: row ? {...this.envelope(row),
        state: row.state === "PENDING" && Date.parse(row.expires_at) <= this.clock() ? "EXPIRED" : row.state,
        result: row.result ? JSON.parse(row.result) : null} : null};
  }
}
