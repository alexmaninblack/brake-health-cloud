// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";

import {
  canonicalize,
  type ChangedResource,
  ContractError,
  type JsonValue,
  parseBrakeMessage,
  parseJsonRejectDuplicates,
} from "./brake-data-contract.js";
import { BrakeDataStore, type QueryResource, type RecordCounts } from "./brake-data-store.js";

export interface CurrentUnitContext {
  readonly schemaVersion: 1;
  readonly contractVersion: "1.0.0";
  readonly source: "CURRENT_RUN_PROVISIONING_JOURNAL";
  readonly testUnit: {
    readonly systemUid: string;
    readonly unitRole: "VALIDATION";
    readonly userFacingRole: "Test Vehicle";
  };
  readonly productionUnit?: {
    readonly systemUid: string;
    readonly unitRole: "PRODUCTION";
    readonly userFacingRole: "Production Vehicle";
  };
}

export type CurrentUnitContextInput = CurrentUnitContext | (() => CurrentUnitContext | undefined);

export interface QueryReadiness {
  readonly ready: boolean;
  readonly reason: "READY" | "CURRENT_UNIT_CONTEXT_UNAVAILABLE" | "TEMPORARILY_UNAVAILABLE";
  readonly systemUids: readonly string[];
}

type ErrorCode =
  | "INVALID_REQUEST" | "INVALID_CURSOR" | "NOT_FOUND" | "UNIT_NOT_CURRENT"
  | "CONTENT_CONFLICT" | "PREVIEW_STALE" | "PREVIEW_TOKEN_EXPIRED"
  | "PAYLOAD_TOO_LARGE" | "UNPROCESSABLE_MESSAGE" | "TEMPORARILY_UNAVAILABLE"
  | "CURRENT_UNIT_CONTEXT_UNAVAILABLE";

interface Subscriber {
  readonly response: ServerResponse;
  readonly systemUid: string;
}

const UID = /^[A-Za-z0-9._:-]{1,128}$/;
const PUBLIC_MAXIMUM = 131_072;
const ADMIN_MAXIMUM = 4_096;
const TOKEN_MAXIMUM = 1_024;

class HttpRequestError extends Error {
  public constructor(public readonly code: "INVALID_REQUEST" | "INVALID_CURSOR", message: string) {
    super(message);
  }
}

class StorageError extends Error {
  public constructor(options: ErrorOptions) {
    super("Brake data storage is unavailable", options);
    this.name = "StorageError";
  }
}

export class BrakeDataHttp {
  private currentUnits: ReadonlyMap<string, "VALIDATION" | "PRODUCTION"> | null = null;
  private sortedSystemUids: readonly string[] | null = null;
  private readonly subscribers = new Set<Subscriber>();
  private eventId = 0n;
  private storageAvailable = true;

  public constructor(
    private readonly store: BrakeDataStore,
    private readonly context: CurrentUnitContextInput | undefined,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly hmacKey: Uint8Array = randomBytes(32),
    private readonly onStorageFailure: () => void = () => undefined,
  ) {
    this.refreshContext();
  }

  public queryReadiness(): QueryReadiness {
    this.refreshContext();
    if (!this.storageAvailable) return { ready: false, reason: "TEMPORARILY_UNAVAILABLE", systemUids: [] };
    return this.sortedSystemUids === null
      ? { ready: false, reason: "CURRENT_UNIT_CONTEXT_UNAVAILABLE", systemUids: [] }
      : { ready: true, reason: "READY", systemUids: [...this.sortedSystemUids] };
  }

  public async handlePublic(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.refreshContext();
    if (!this.storageAvailable) {
      sendError(response, 503, "TEMPORARILY_UNAVAILABLE", "data service is temporarily unavailable", true);
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/api/v1/brake/messages") {
        if (!isJsonContentType(request.headers["content-type"])) {
          throw new HttpRequestError("INVALID_REQUEST", "content-type must be application/json");
        }
        await this.ingest(request, response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/brake/stream") {
        this.stream(url, response);
        return;
      }
      const match = /^\/api\/v1\/brake\/units\/([^/]+)\/(windows|assessments|events|advisories)$/.exec(url.pathname);
      if (request.method === "GET" && match !== null) {
        this.query(decodeURIComponent(match[1]!), match[2]!, url, response);
        return;
      }
      sendError(response, 404, "NOT_FOUND", "route was not found", false);
    } catch (error) {
      this.handleFailure(response, error);
    }
  }

  public async handleAdmin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.storageAvailable) {
      sendError(response, 503, "TEMPORARILY_UNAVAILABLE", "data service is temporarily unavailable", true);
      return;
    }
    try {
      if (request.method !== "POST") {
        sendError(response, 404, "NOT_FOUND", "admin route was not found", false);
        return;
      }
      if (!isJsonContentType(request.headers["content-type"])) {
        throw new HttpRequestError("INVALID_REQUEST", "content-type must be application/json");
      }
      const raw = await readBody(request, ADMIN_MAXIMUM, false);
      const value = object(parseJsonRejectDuplicates(raw));
      this.refreshContext();
      const path = new URL(request.url ?? "/", "http://local").pathname;
      if (path === "/api/v1/brake/admin/current-run/cleanup-preview") {
        this.preview(value, response);
        return;
      }
      if (path === "/api/v1/brake/admin/current-run/cleanup") {
        this.execute(value, response);
        return;
      }
      sendError(response, 404, "NOT_FOUND", "admin route was not found", false);
    } catch (error) {
      this.handleFailure(response, error);
    }
  }

  public closeStreams(): void {
    for (const subscriber of this.subscribers) subscriber.response.destroy();
    this.subscribers.clear();
  }

  private refreshContext(): void {
    let validated: ReadonlyMap<string, "VALIDATION" | "PRODUCTION"> | null;
    try {
      validated = validateContext(typeof this.context === "function" ? this.context() : this.context);
    } catch {
      // Missing, malformed or temporarily unreadable injected context is not
      // permission to reuse an earlier Unit identity or infer one from records.
      validated = null;
    }
    this.currentUnits = validated;
    this.sortedSystemUids = validated === null ? null : [...validated.keys()].sort();
    for (const subscriber of this.subscribers) {
      if (!validated?.has(subscriber.systemUid)) {
        subscriber.response.destroy();
        this.subscribers.delete(subscriber);
      }
    }
  }

  private async ingest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readBody(request, PUBLIC_MAXIMUM, true);
    const message = parseBrakeMessage(raw);
    const result = this.storage(() => this.store.ingest(message, this.now()));
    if (result.httpStatus === 409) {
      this.notify(message.unitSystemUid, result.changedResources);
      sendError(response, 409, result.errorCode, "message key already has different content", false);
      return;
    }
    this.notify(message.unitSystemUid, result.changedResources);
    sendJson(response, result.httpStatus, result.acknowledgement);
  }

  private query(uid: string, plural: string, url: URL, response: ServerResponse): void {
    const role = this.authorize(uid, response);
    if (role === null) return;
    const resource = resourceFor(plural);
    if ([...url.searchParams.keys()].some((key) => key !== "limit" && key !== "cursor") ||
        url.searchParams.getAll("limit").length > 1 || url.searchParams.getAll("cursor").length > 1) {
      sendError(response, 400, "INVALID_REQUEST", "query parameters must not be repeated", false);
      return;
    }
    const limitText = url.searchParams.get("limit");
    const limit = limitText === null ? 50 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      sendError(response, 400, "INVALID_REQUEST", "limit must be an integer from 1 through 100", false);
      return;
    }
    let after: readonly string[] | null = null;
    const cursorText = url.searchParams.get("cursor");
    if (cursorText !== null) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursorText)) throw new Error("invalid encoding");
        const cursor = parseJsonRejectDuplicates(Buffer.from(cursorText, "base64url").toString("utf8"));
        const expectedTieBreakers = resource === "ADVISORY" ? 2 : 1;
        if (!Array.isArray(cursor) || cursor.length !== 4 || cursor[0] !== uid || cursor[1] !== resource ||
            !Array.isArray(cursor[3]) || !cursor[3].every((item) => typeof item === "string") ||
            cursor[3].length !== expectedTieBreakers || typeof cursor[2] !== "string" ||
            Buffer.from(canonicalize(cursor)).toString("base64url") !== cursorText) throw new Error("scope mismatch");
        after = [cursor[2], ...cursor[3] as string[]];
      } catch {
        sendError(response, 400, "INVALID_CURSOR", "cursor is invalid for this Unit and resource", false);
        return;
      }
    }
    const page = this.storage(() => this.store.query(resource, uid, limit, after));
    const nextCursor = page.nextKey === null ? null : Buffer.from(canonicalize([
      uid, resource, page.nextKey[0]!, page.nextKey.slice(1),
    ])).toString("base64url");
    sendJson(response, 200, {
      schemaVersion: 1,
      contractVersion: "1.0.0",
      resourceType: resource,
      unitSystemUid: uid,
      unitRole: role,
      limit,
      items: page.items,
      nextCursor,
    });
  }

  private stream(url: URL, response: ServerResponse): void {
    const uid = url.searchParams.get("systemUid");
    if (this.currentUnits === null) {
      sendError(response, 503, "CURRENT_UNIT_CONTEXT_UNAVAILABLE", "current Unit context is unavailable", true);
      return;
    }
    if (uid === null || [...url.searchParams.keys()].some((key) => key !== "systemUid") ||
        url.searchParams.getAll("systemUid").length !== 1) {
      sendError(response, 400, "INVALID_REQUEST", "stream requires exactly one systemUid", false);
      return;
    }
    if (this.authorize(uid, response) === null) return;
    response.statusCode = 200;
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "text/event-stream");
    response.setHeader("connection", "keep-alive");
    const subscriber = { response, systemUid: uid };
    this.subscribers.add(subscriber);
    response.on("close", () => this.subscribers.delete(subscriber));
    if (!response.write(": connected\n\n")) {
      this.subscribers.delete(subscriber);
      response.destroy();
    }
  }

  private preview(value: Readonly<Record<string, JsonValue>>, response: ServerResponse): void {
    const systemUids = this.cleanupSelector(value, false);
    if (systemUids === null) {
      sendError(response, 503, "CURRENT_UNIT_CONTEXT_UNAVAILABLE", "current Unit context is unavailable", true);
      return;
    }
    const summary = this.storage(() => this.store.recordSet(systemUids));
    const nonmatching = this.storage(() => this.store.recordSet(systemUids, false));
    const expiresAt = new Date(Date.parse(this.now()) + 60_000).toISOString();
    const payload: JsonValue = [
      "brake-cleanup-preview-v1", [...systemUids], countsJson(summary.counts), summary.sha256, expiresAt,
    ];
    const encoded = Buffer.from(canonicalize(payload)).toString("base64url");
    const mac = createHmac("sha256", this.hmacKey).update(encoded).digest("base64url");
    sendJson(response, 200, {
      schemaVersion: 1, contractVersion: "1.0.0", systemUids,
      recordCounts: summary.counts, recordSetSha256: summary.sha256,
      nonmatchingRecordCounts: nonmatching.counts,
      confirmationToken: `v1.${encoded}.${mac}`, expiresAt,
    });
  }

  private execute(value: Readonly<Record<string, JsonValue>>, response: ServerResponse): void {
    const systemUids = this.cleanupSelector(value, true);
    if (systemUids === null) {
      sendError(response, 503, "CURRENT_UNIT_CONTEXT_UNAVAILABLE", "current Unit context is unavailable", true);
      return;
    }
    const token = value.confirmationToken;
    if (typeof token !== "string" || token.length < 32 || token.length > TOKEN_MAXIMUM) {
      this.tokenExpired(response);
      return;
    }
    const decoded = this.verifyToken(token);
    if (decoded === null || Date.parse(decoded.expiresAt) <= Date.parse(this.now())) {
      this.tokenExpired(response);
      return;
    }
    if (canonicalize([...decoded.systemUids]) !== canonicalize([...systemUids])) {
      this.tokenExpired(response);
      return;
    }
    const current = this.storage(() => this.store.recordSet(systemUids));
    if (canonicalize(countsJson(current.counts)) !== canonicalize(countsJson(decoded.counts)) || current.sha256 !== decoded.digest) {
      sendError(response, 409, "PREVIEW_STALE", "current row set differs from the preview", false);
      return;
    }
    const result = this.storage(() => this.store.deleteMatching(systemUids, decoded.digest));
    if (result.stale) {
      sendError(response, 409, "PREVIEW_STALE", "current row set differs from the preview", false);
      return;
    }
    if (Object.values(result.deleted).some((count) => count > 0)) {
      for (const uid of systemUids) this.notify(uid, ["WINDOW", "ASSESSMENT", "EVENT", "ADVISORY"]);
    }
    sendJson(response, 200, {
      schemaVersion: 1, contractVersion: "1.0.0", systemUids,
      deletedRecordCounts: result.deleted,
      remainingMatchingRecordCounts: result.remaining,
      nonmatchingRecordSetSha256: result.nonmatchingSha256,
      nonmatchingRecordCounts: result.nonmatchingCounts,
      completedAt: this.now(),
    });
  }

  private verifyToken(token: string): {
    systemUids: readonly string[]; counts: RecordCounts; digest: string; expiresAt: string;
  } | null {
    try {
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== "v1" ||
          !/^[A-Za-z0-9_-]+$/.test(parts[1]!) || !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) return null;
      const supplied = Buffer.from(parts[2]!, "base64url");
      const expected = createHmac("sha256", this.hmacKey).update(parts[1]!).digest();
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
      const payload = parseJsonRejectDuplicates(Buffer.from(parts[1]!, "base64url").toString("utf8"));
      if (!Array.isArray(payload) || payload.length !== 5 || payload[0] !== "brake-cleanup-preview-v1" ||
          !Array.isArray(payload[1]) || payload[1].length < 1 || payload[1].length > 2 ||
          !payload[1].every((item) => typeof item === "string" && UID.test(item)) ||
          new Set(payload[1]).size !== payload[1].length ||
          !validCounts(payload[2]) ||
          typeof payload[3] !== "string" || !/^[0-9a-f]{64}$/.test(payload[3]) ||
          typeof payload[4] !== "string" || !Number.isFinite(Date.parse(payload[4])) ||
          Buffer.from(canonicalize(payload)).toString("base64url") !== parts[1]) return null;
      return {
        systemUids: payload[1] as string[],
        counts: payload[2],
        digest: payload[3], expiresAt: payload[4],
      };
    } catch {
      return null;
    }
  }

  private cleanupSelector(
    value: Readonly<Record<string, JsonValue>>,
    execute: boolean,
  ): readonly string[] | null {
    if (this.sortedSystemUids === null) return null;
    const allowed = execute
      ? ["schemaVersion", "contractVersion", "systemUids", "confirmationToken"]
      : ["schemaVersion", "contractVersion", "systemUids"];
    if (Object.keys(value).sort().join("|") !== allowed.sort().join("|") ||
        value.schemaVersion !== 1 || value.contractVersion !== "1.0.0" ||
        !Array.isArray(value.systemUids)) {
      throw new HttpRequestError("INVALID_REQUEST", "cleanup selector must be the current Test UID or all sorted current Unit UIDs");
    }
    const selected = value.systemUids;
    if (selected.length === 1 && typeof selected[0] === "string" &&
        this.currentUnits?.get(selected[0]) === "VALIDATION") return [selected[0]];
    if (selected.length === this.sortedSystemUids.length &&
        selected.every((uid, index) => uid === this.sortedSystemUids![index])) return this.sortedSystemUids;
    throw new HttpRequestError("INVALID_REQUEST", "cleanup selector must be the current Test UID or all sorted current Unit UIDs");
  }

  private authorize(uid: string, response: ServerResponse): "VALIDATION" | "PRODUCTION" | null {
    if (this.currentUnits === null) {
      sendError(response, 503, "CURRENT_UNIT_CONTEXT_UNAVAILABLE", "current Unit context is unavailable", true);
      return null;
    }
    const role = this.currentUnits.get(uid);
    if (role === undefined) {
      sendError(response, 404, "UNIT_NOT_CURRENT", "Unit is not in the current Unit context", false);
      return null;
    }
    return role;
  }

  private notify(systemUid: string, resources: readonly ChangedResource[]): void {
    this.refreshContext();
    if (resources.length === 0) return;
    const changedResources = [...new Set(resources)].sort();
    for (const subscriber of this.subscribers) {
      if (subscriber.systemUid !== systemUid) continue;
      this.eventId++;
      const data = canonicalize({
        schemaVersion: 1, contractVersion: "1.0.0", notificationType: "BRAKE_DATA_CHANGED",
        unitSystemUid: systemUid, changedResources, emittedAt: this.now(),
      });
      if (!subscriber.response.write(`id: ${this.eventId}\nevent: brake-data-changed\ndata: ${data}\n\n`)) {
        this.subscribers.delete(subscriber);
        subscriber.response.destroy();
      }
    }
  }

  private tokenExpired(response: ServerResponse): void {
    sendError(response, 409, "PREVIEW_TOKEN_EXPIRED", "preview token is invalid or expired", false);
  }

  private storage<T>(operation: () => T): T {
    try {
      return operation();
    } catch (cause) {
      if (!isRetryableSqliteContention(cause)) {
        this.storageAvailable = false;
        this.onStorageFailure();
      }
      throw new StorageError({ cause });
    }
  }

  private handleFailure(response: ServerResponse, error: unknown): void {
    if (error instanceof HttpRequestError) {
      sendError(response, 400, error.code, error.message, false);
      return;
    }
    if (error instanceof ContractError) {
      const status = error.code === "PAYLOAD_TOO_LARGE" ? 413 : 422;
      sendError(response, status, error.code, error.message, false);
      return;
    }
    if (error instanceof StorageError) {
      sendError(response, 503, "TEMPORARILY_UNAVAILABLE", "data service is temporarily unavailable", true);
      return;
    }
    if (error instanceof SyntaxError || error instanceof URIError) {
      sendError(response, 400, "INVALID_REQUEST", "request syntax is invalid", false);
      return;
    }
    sendError(response, 503, "TEMPORARILY_UNAVAILABLE", "data service is temporarily unavailable", true);
  }
}

function validateContext(context: CurrentUnitContext | undefined): ReadonlyMap<string, "VALIDATION" | "PRODUCTION"> | null {
  if (typeof context !== "object" || context === null) return null;
  const testUnit = context.testUnit;
  const productionUnit = context.productionUnit;
  const expectedKeys = productionUnit === undefined
    ? "contractVersion|schemaVersion|source|testUnit"
    : "contractVersion|productionUnit|schemaVersion|source|testUnit";
  if (typeof testUnit !== "object" || testUnit === null ||
      context.schemaVersion !== 1 || context.contractVersion !== "1.0.0" ||
      context.source !== "CURRENT_RUN_PROVISIONING_JOURNAL" ||
      testUnit.unitRole !== "VALIDATION" || testUnit.userFacingRole !== "Test Vehicle" ||
      typeof testUnit.systemUid !== "string" || !UID.test(testUnit.systemUid) ||
      Object.keys(context).sort().join("|") !== expectedKeys ||
      Object.keys(testUnit).sort().join("|") !== "systemUid|unitRole|userFacingRole") return null;
  const units = new Map<string, "VALIDATION" | "PRODUCTION">([[testUnit.systemUid, "VALIDATION"]]);
  if (productionUnit !== undefined) {
    if (typeof productionUnit !== "object" || productionUnit === null ||
        productionUnit.unitRole !== "PRODUCTION" || productionUnit.userFacingRole !== "Production Vehicle" ||
        typeof productionUnit.systemUid !== "string" || !UID.test(productionUnit.systemUid) ||
        testUnit.systemUid === productionUnit.systemUid ||
        Object.keys(productionUnit).sort().join("|") !== "systemUid|unitRole|userFacingRole") return null;
    units.set(productionUnit.systemUid, "PRODUCTION");
  }
  return units;
}

function resourceFor(plural: string): QueryResource {
  return ({ windows: "WINDOW", assessments: "ASSESSMENT", events: "EVENT", advisories: "ADVISORY" } as const)[plural as "windows"];
}

async function readBody(request: IncomingMessage, maximum: number, allowGzip: boolean): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximum) reject(new ContractError("PAYLOAD_TOO_LARGE", "request exceeds byte limit"));
      else chunks.push(chunk);
    });
    request.on("end", resolve);
    request.on("error", reject);
  });
  const compressed = Buffer.concat(chunks);
  const encoding = request.headers["content-encoding"];
  if (encoding === undefined || encoding === "identity") return compressed.toString("utf8");
  if (allowGzip && encoding === "gzip") {
    try {
      return gunzipSync(compressed, { maxOutputLength: maximum + 1 }).toString("utf8");
    } catch (error) {
      if (error instanceof RangeError) {
        throw new ContractError("PAYLOAD_TOO_LARGE", "decompressed request exceeds byte limit");
      }
      throw new ContractError("UNPROCESSABLE_MESSAGE", "gzip payload is invalid");
    }
  }
  throw new ContractError("UNPROCESSABLE_MESSAGE", "content encoding is not supported");
}

function object(value: JsonValue): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ContractError("UNPROCESSABLE_MESSAGE", "request body must be an object");
  }
  return value;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function sendError(response: ServerResponse, status: number, code: ErrorCode, message: string, retryable: boolean): void {
  sendJson(response, status, { schemaVersion: 1, contractVersion: "1.0.0", errorCode: code, message, retryable });
}

function countsJson(counts: RecordCounts): JsonValue {
  return {
    messages: counts.messages, windows: counts.windows, assessments: counts.assessments,
    events: counts.events, advisories: counts.advisories, quarantine: counts.quarantine,
  };
}

function validCounts(value: JsonValue | undefined): value is RecordCounts & { [key: string]: JsonValue } {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).sort().join("|") !== "advisories|assessments|events|messages|quarantine|windows") return false;
  return [value.messages, value.windows, value.assessments, value.events, value.advisories, value.quarantine]
    .every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
}

function isJsonContentType(value: string | readonly string[] | undefined): boolean {
  return typeof value === "string" && value.split(";", 1)[0]!.trim().toLowerCase() === "application/json";
}

function isRetryableSqliteContention(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("errcode" in error)) return false;
  const errcode = (error as { readonly errcode?: unknown }).errcode;
  return errcode === 5 || errcode === 6;
}
