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
  readonly productionUnit: {
    readonly systemUid: string;
    readonly unitRole: "PRODUCTION";
    readonly userFacingRole: "Production Vehicle";
  };
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

export class BrakeDataHttp {
  private readonly currentUnits: ReadonlyMap<string, "VALIDATION" | "PRODUCTION"> | null;
  private readonly sortedSystemUids: readonly [string, string] | null;
  private readonly subscribers = new Set<Subscriber>();
  private eventId = 0n;

  public constructor(
    private readonly store: BrakeDataStore,
    context: CurrentUnitContext | undefined,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly hmacKey: Uint8Array = randomBytes(32),
  ) {
    const validated = validateContext(context);
    this.currentUnits = validated;
    this.sortedSystemUids = validated === null
      ? null
      : [...validated.keys()].sort() as [string, string];
  }

  public async handlePublic(request: IncomingMessage, response: ServerResponse): Promise<void> {
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

  private async ingest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readBody(request, PUBLIC_MAXIMUM, true);
    const message = parseBrakeMessage(raw);
    const result = this.store.ingest(message, this.now());
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
    if (url.searchParams.getAll("limit").length > 1 || url.searchParams.getAll("cursor").length > 1) {
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
            cursor[3].length !== expectedTieBreakers || typeof cursor[2] !== "string") throw new Error("scope mismatch");
        after = [cursor[2], ...cursor[3] as string[]];
      } catch {
        sendError(response, 400, "INVALID_CURSOR", "cursor is invalid for this Unit and resource", false);
        return;
      }
    }
    const page = this.store.query(resource, uid, limit, after);
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
    if (uid === null || url.searchParams.getAll("systemUid").length !== 1) {
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
    const summary = this.store.recordSet(systemUids);
    const expiresAt = new Date(Date.parse(this.now()) + 60_000).toISOString();
    const payload: JsonValue = [
      "brake-cleanup-preview-v1", [...systemUids], countsJson(summary.counts), summary.sha256, expiresAt,
    ];
    const encoded = Buffer.from(canonicalize(payload)).toString("base64url");
    const mac = createHmac("sha256", this.hmacKey).update(encoded).digest("base64url");
    sendJson(response, 200, {
      schemaVersion: 1, contractVersion: "1.0.0", systemUids,
      recordCounts: summary.counts, recordSetSha256: summary.sha256,
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
    const current = this.store.recordSet(systemUids);
    if (canonicalize(countsJson(current.counts)) !== canonicalize(countsJson(decoded.counts)) || current.sha256 !== decoded.digest) {
      sendError(response, 409, "PREVIEW_STALE", "current row set differs from the preview", false);
      return;
    }
    const result = this.store.deleteMatching(systemUids, decoded.digest);
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
      completedAt: this.now(),
    });
  }

  private verifyToken(token: string): {
    systemUids: readonly [string, string]; counts: RecordCounts; digest: string; expiresAt: string;
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
          !Array.isArray(payload[1]) || payload[1].length !== 2 ||
          !payload[1].every((item) => typeof item === "string") ||
          !validCounts(payload[2]) ||
          typeof payload[3] !== "string" || !/^[0-9a-f]{64}$/.test(payload[3]) ||
          typeof payload[4] !== "string" || !Number.isFinite(Date.parse(payload[4])) ||
          Buffer.from(canonicalize(payload)).toString("base64url") !== parts[1]) return null;
      return {
        systemUids: payload[1] as [string, string],
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
  ): readonly [string, string] | null {
    if (this.sortedSystemUids === null) return null;
    const allowed = execute
      ? ["schemaVersion", "contractVersion", "systemUids", "confirmationToken"]
      : ["schemaVersion", "contractVersion", "systemUids"];
    if (Object.keys(value).sort().join("|") !== allowed.sort().join("|") ||
        value.schemaVersion !== 1 || value.contractVersion !== "1.0.0" ||
        !Array.isArray(value.systemUids) || value.systemUids.length !== 2 ||
        value.systemUids[0] !== this.sortedSystemUids[0] || value.systemUids[1] !== this.sortedSystemUids[1]) {
      throw new HttpRequestError("INVALID_REQUEST", "cleanup selector must be the exact sorted current Unit UIDs");
    }
    return this.sortedSystemUids;
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
  if (typeof testUnit !== "object" || testUnit === null || typeof productionUnit !== "object" || productionUnit === null ||
      context.schemaVersion !== 1 || context.contractVersion !== "1.0.0" ||
      context.source !== "CURRENT_RUN_PROVISIONING_JOURNAL" ||
      testUnit.unitRole !== "VALIDATION" || testUnit.userFacingRole !== "Test Vehicle" ||
      productionUnit.unitRole !== "PRODUCTION" || productionUnit.userFacingRole !== "Production Vehicle" ||
      !UID.test(testUnit.systemUid) || !UID.test(productionUnit.systemUid) ||
      testUnit.systemUid === productionUnit.systemUid ||
      Object.keys(context).sort().join("|") !== "contractVersion|productionUnit|schemaVersion|source|testUnit" ||
      Object.keys(testUnit).sort().join("|") !== "systemUid|unitRole|userFacingRole" ||
      Object.keys(productionUnit).sort().join("|") !== "systemUid|unitRole|userFacingRole") return null;
  return new Map([
    [testUnit.systemUid, "VALIDATION"],
    [productionUnit.systemUid, "PRODUCTION"],
  ]);
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
