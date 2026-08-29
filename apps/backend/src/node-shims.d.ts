// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

/** Minimal declarations for the Node 26 built-ins used by this foundation. */

declare const process: {
  readonly argv: readonly string[];
  readonly execPath: string;
  readonly stdout: { write(value: string): void };
  readonly version: string;
  exit(code?: number): never;
  exitCode: number | undefined;
  cwd(): string;
  once(event: "SIGINT" | "SIGTERM", listener: () => void): void;
};

declare class Buffer extends Uint8Array {
  static byteLength(value: string, encoding?: string): number;
  static compare(left: Uint8Array, right: Uint8Array): number;
  static concat(values: readonly Uint8Array[]): Buffer;
  static from(value: string | Uint8Array, encoding?: string): Buffer;
  toString(encoding?: string): string;
}

declare module "node:crypto" {
  interface Digest {
    update(value: string | Uint8Array): this;
    digest(encoding: "hex" | "base64url"): string;
    digest(): Buffer;
  }
  export function createHash(algorithm: "sha256"): Digest;
  export function createHmac(algorithm: "sha256", key: Uint8Array): Digest;
  export function randomBytes(size: number): Buffer;
  export function randomUUID(): string;
  export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean;
}

declare module "node:fs" {
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export function mkdtempSync(prefix: string): string;
  export function chmodSync(path: string, mode: number): void;
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
  export function readdirSync(
    path: string,
    options: { readonly withFileTypes: true },
  ): Dirent[];
  export function rmSync(
    path: string,
    options?: { readonly force?: boolean; readonly recursive?: boolean },
  ): void;
}

declare module "node:child_process" {
  export function execFileSync(
    executable: string,
    argumentsList: readonly string[],
    options: { readonly cwd: string; readonly encoding: "utf8" },
  ): string;
}

declare module "node:http" {
  export interface Server {
    address(): { readonly port: number } | string | null;
    close(callback: (error?: Error) => void): void;
    listen(port: number, host: string, callback: () => void): void;
    listen(path: string, callback: () => void): void;
    off(event: "error", listener: (error: Error) => void): this;
    once(event: "error", listener: (error: Error) => void): this;
  }

  export interface IncomingMessage {
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    readonly method?: string;
    readonly url?: string;
    on(event: "data", listener: (chunk: Uint8Array) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export interface ServerResponse {
    statusCode: number;
    destroy(): void;
    end(value?: string): void;
    on(event: "close", listener: () => void): this;
    setHeader(name: string, value: string): void;
    write(value: string): boolean;
  }

  export function createServer(
    listener: (request: IncomingMessage, response: ServerResponse) => void,
  ): Server;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export function join(...paths: readonly string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: readonly string[]): string;
}

declare module "node:sqlite" {
  interface StatementSync {
    all(...parameters: readonly unknown[]): unknown[];
    get(...parameters: readonly unknown[]): unknown;
    run(...parameters: readonly unknown[]): {
      readonly changes: number;
      readonly lastInsertRowid: number | bigint;
    };
  }

  export class DatabaseSync {
    public constructor(path: string);
    public close(): void;
    public exec(sql: string): void;
    public prepare(sql: string): StatementSync;
  }
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module "node:zlib" {
  export function gunzipSync(value: Uint8Array, options?: { readonly maxOutputLength?: number }): Buffer;
}
