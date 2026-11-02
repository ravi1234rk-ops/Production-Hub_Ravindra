"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { WorkspaceStore, workspacePaths } = require("../workspace-store");

const { legacyFile, databaseFile } = workspacePaths();
let store;
try {
  store = new WorkspaceStore(databaseFile);
  const imported = store.importLegacy(legacyFile);
  const data = store.load();
  if (!data) throw new Error(`No workspace found. Expected legacy JSON at ${legacyFile}.`);
  if (imported) {
    assert.deepStrictEqual(data, JSON.parse(fs.readFileSync(legacyFile, "utf8")));
  }
  const integrity = store.db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") throw new Error(`SQLite integrity check failed: ${integrity}`);
  console.log(`${imported ? "Imported and verified" : "Using existing"} SQLite workspace: ${databaseFile}`);
  console.log("Legacy JSON is unchanged. Stop the app before migrating; restart it to use SQLite.");
  for (const [section, value] of Object.entries(data)) {
    if (Array.isArray(value)) console.log(`${section}: ${value.length} records`);
  }
} catch (error) {
  console.error("SQLite migration failed:", error.message);
  process.exitCode = 1;
} finally {
  store?.close();
}
