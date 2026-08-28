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

declare module "node:fs" {
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export function mkdtempSync(prefix: string): string;
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
    off(event: "error", listener: (error: Error) => void): this;
    once(event: "error", listener: (error: Error) => void): this;
  }

  interface IncomingMessage {
    readonly method?: string;
    readonly url?: string;
  }

  interface ServerResponse {
    statusCode: number;
    end(value: string): void;
    setHeader(name: string, value: string): void;
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
    get(...parameters: readonly unknown[]): unknown;
    run(...parameters: readonly unknown[]): unknown;
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
