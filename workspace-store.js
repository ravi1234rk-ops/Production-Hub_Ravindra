"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

function workspacePaths(env = process.env) {
  const legacyFile = path.resolve(env.DATA_FILE || path.join(__dirname, "data", "team-project-hub.json"));
  const databaseFile = path.resolve(env.SQLITE_FILE || `${legacyFile.replace(/\.json$/i, "")}.sqlite`);
  if (legacyFile === databaseFile) throw new Error("SQLITE_FILE must not replace the legacy JSON file.");
  return { legacyFile, databaseFile };
}

function validateWorkspace(data) {
  if (!data || data.version !== 1 || !["users", "projects", "audits", "workLogs", "team"].every((key) => Array.isArray(data[key]))) {
    throw new Error("Workspace has an unsupported or invalid structure.");
  }
}

function encodeWorkspace(data) {
  const nodes = new Map();
  const records = new Map();
  function visit(value, parts) {
    const nodePath = JSON.stringify(parts);
    if (Array.isArray(value)) {
      nodes.set(nodePath, { kind: "array", payload: null });
      const occurrences = new Map();
      value.forEach((record, position) => {
        const identity = record && typeof record === "object" ? record.id ?? record.workfrontId : undefined;
        const base = identity === undefined ? `position:${position}` : `id:${JSON.stringify(identity)}`;
        const occurrence = occurrences.get(base) || 0;
        occurrences.set(base, occurrence + 1);
        const recordKey = JSON.stringify([base, occurrence]);
        records.set(JSON.stringify([nodePath, recordKey]), {
          nodePath, recordKey, position, payload: JSON.stringify(record)
        });
      });
    } else if (value !== null && typeof value === "object") {
      nodes.set(nodePath, { kind: "object", payload: null });
      for (const [key, child] of Object.entries(value)) {
        if (child !== undefined) visit(child, [...parts, key]);
      }
    } else {
      nodes.set(nodePath, { kind: "value", payload: JSON.stringify(value) });
    }
  }
  visit(data, []);
  return { nodes, records };
}

class WorkspaceStore {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    // Create with restricted permissions before SQLite creates its journal files.
    fs.closeSync(fs.openSync(filename, "a", 0o600));
    fs.chmodSync(filename, 0o600);
    this.db = new Database(filename);
    try {
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("foreign_keys = ON");
      const version = this.db.pragma("user_version", { simple: true });
      if (version !== 0 && version !== 1) throw new Error(`Unsupported SQLite workspace schema version: ${version}.`);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS workspace_nodes (
            path TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN ('object', 'array', 'value')),
            payload TEXT
          );
          CREATE TABLE IF NOT EXISTS workspace_records (
            node_path TEXT NOT NULL REFERENCES workspace_nodes(path) ON DELETE CASCADE,
            record_key TEXT NOT NULL,
            position INTEGER NOT NULL,
            payload TEXT NOT NULL CHECK (json_valid(payload)),
            PRIMARY KEY (node_path, record_key)
          );
          CREATE INDEX IF NOT EXISTS workspace_record_order ON workspace_records(node_path, position);
          CREATE INDEX IF NOT EXISTS workspace_workfront_id ON workspace_records(node_path, json_extract(payload, '$.workfrontId'));
          PRAGMA user_version = 1;
        `);
      })();
      this.upsertNode = this.db.prepare(`INSERT INTO workspace_nodes(path, kind, payload) VALUES (?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, payload = excluded.payload`);
      this.upsertRecord = this.db.prepare(`INSERT INTO workspace_records(node_path, record_key, position, payload) VALUES (?, ?, ?, ?)
        ON CONFLICT(node_path, record_key) DO UPDATE SET position = excluded.position, payload = excluded.payload`);
      this.deleteNode = this.db.prepare("DELETE FROM workspace_nodes WHERE path = ?");
      this.deleteRecord = this.db.prepare("DELETE FROM workspace_records WHERE node_path = ? AND record_key = ?");
      this.snapshot = this.readSnapshot();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  readSnapshot() {
    const nodes = new Map(this.db.prepare("SELECT path, kind, payload FROM workspace_nodes").all()
      .map((row) => [row.path, { kind: row.kind, payload: row.payload }]));
    const records = new Map(this.db.prepare("SELECT node_path, record_key, position, payload FROM workspace_records ORDER BY node_path, position").all()
      .map((row) => [JSON.stringify([row.node_path, row.record_key]), {
        nodePath: row.node_path, recordKey: row.record_key, position: row.position, payload: row.payload
      }]));
    return { nodes, records };
  }

  load() {
    this.snapshot = this.readSnapshot();
    if (!this.snapshot.nodes.size) return null;
    if (!this.snapshot.nodes.has("[]")) throw new Error("SQLite workspace is missing its root node.");
    const children = new Map();
    for (const nodePath of this.snapshot.nodes.keys()) {
      const parts = JSON.parse(nodePath);
      if (!parts.length) continue;
      const name = parts.pop();
      const parent = JSON.stringify(parts);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push([name, nodePath]);
    }
    const arrays = new Map();
    for (const record of this.snapshot.records.values()) {
      if (!arrays.has(record.nodePath)) arrays.set(record.nodePath, []);
      arrays.get(record.nodePath).push(JSON.parse(record.payload));
    }
    const decode = (nodePath) => {
      const node = this.snapshot.nodes.get(nodePath);
      if (node.kind === "array") return arrays.get(nodePath) || [];
      if (node.kind === "value") return JSON.parse(node.payload);
      return Object.fromEntries((children.get(nodePath) || []).map(([name, child]) => [name, decode(child)]));
    };
    const data = decode("[]");
    validateWorkspace(data);
    return data;
  }

  save(data) {
    validateWorkspace(data);
    const next = encodeWorkspace(data);
    let changed = 0;
    this.db.transaction(() => {
      for (const [nodePath, node] of next.nodes) {
        const previous = this.snapshot.nodes.get(nodePath);
        if (!previous || previous.kind !== node.kind || previous.payload !== node.payload) {
          this.upsertNode.run(nodePath, node.kind, node.payload);
          changed += 1;
        }
      }
      for (const [key, record] of this.snapshot.records) {
        if (!next.records.has(key)) {
          this.deleteRecord.run(record.nodePath, record.recordKey);
          changed += 1;
        }
      }
      for (const [key, record] of next.records) {
        const previous = this.snapshot.records.get(key);
        if (!previous || previous.position !== record.position || previous.payload !== record.payload) {
          this.upsertRecord.run(record.nodePath, record.recordKey, record.position, record.payload);
          changed += 1;
        }
      }
      for (const nodePath of this.snapshot.nodes.keys()) {
        if (!next.nodes.has(nodePath)) {
          this.deleteNode.run(nodePath);
          changed += 1;
        }
      }
    })();
    this.snapshot = next;
    return changed;
  }

  importLegacy(filename) {
    if (this.snapshot.nodes.size) return false;
    let contents;
    try {
      contents = fs.readFileSync(filename, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    const data = JSON.parse(contents);
    validateWorkspace(data);
    this.save(data);
    return true;
  }

  close() {
    this.db.close();
  }
}

module.exports = { WorkspaceStore, workspacePaths };
