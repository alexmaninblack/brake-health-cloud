// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

export { ADMIN_SOCKET_PATH, LOOPBACK_HOST, startBackend } from "./server.js";
export type { BackendApplication, BackendOptions } from "./server.js";
export { BrakeDataHttp } from "./brake-data-http.js";
export type { CurrentUnitContext, CurrentUnitContextInput, QueryReadiness } from "./brake-data-http.js";
export {
  canonicalize,
  ContractError,
  parseBrakeMessage,
  parseJsonRejectDuplicates,
  sha256Hex,
} from "./brake-data-contract.js";
export { reconstructWindow } from "./brake-data-domain.js";
export { BrakeDataStore } from "./brake-data-store.js";
export {
  applyMigrations,
  loadMigrations,
  MigrationError,
  readSchemaVersion,
} from "./migrations.js";
