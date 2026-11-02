"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { test } = require("node:test");
const { WorkspaceStore, workspacePaths } = require("../workspace-store");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "creative-lab-sqlite-"));
  const databaseFile = path.join(directory, "workspace.sqlite");
  const legacyFile = path.join(directory, "workspace.json");
  const store = new WorkspaceStore(databaseFile);
  t.after(() => {
    if (store.db.open) store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const data = {
    version: 1, users: [{ id: "admin", passwordHash: "preserved-hash" }],
    projects: [], audits: [], workLogs: [], team: [],
    workfrontProjects: [{ id: "local-1", workfrontId: "wf-1", sourceStatus: "New" }],
    workfrontTasks: [{ workfrontId: "task-1", assignees: "Example", plannedHours: 5 }],
    reportingHistory: { projects: [{ workfrontId: "wf-old", sourceStatus: "Complete" }], tasks: [], rounds: [] },
    custom: { emptyObject: {}, emptyArray: [], enabled: true, note: null }
  };
  return { directory, databaseFile, legacyFile, store, data };
}

test("imports all legacy data losslessly once and leaves the JSON unchanged", (t) => {
  const { store, data, legacyFile, databaseFile } = fixture(t);
  const original = JSON.stringify(data, null, 2);
  fs.writeFileSync(legacyFile, original);
  assert.equal(store.importLegacy(legacyFile), true);
  assert.deepEqual(store.load(), data);
  assert.equal(fs.readFileSync(legacyFile, "utf8"), original);
  if (process.platform !== "win32") assert.equal(fs.statSync(databaseFile).mode & 0o777, 0o600);
  store.close();
  const reopened = new WorkspaceStore(databaseFile);
  try {
    fs.writeFileSync(legacyFile, "{}");
    assert.equal(reopened.importLegacy(legacyFile), false);
    assert.deepEqual(reopened.load(), data);
    assert.equal(reopened.db.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    reopened.close();
  }
});

test("writes exactly one row for a changed Workfront record and zero for an unchanged snapshot", (t) => {
  const { store, data } = fixture(t);
  data.workfrontTasks = Array.from({ length: 2000 }, (_, index) => ({
    id: `local-${index}`, workfrontId: `task-${index}`, taskStatus: "New", description: "x".repeat(1000)
  }));
  store.save(data);
  const changes = () => store.db.prepare("SELECT total_changes() AS count").get().count;
  let before = changes();
  assert.equal(store.save(data), 0);
  assert.equal(changes() - before, 0);
  data.workfrontTasks[1000].taskStatus = "Complete";
  before = changes();
  assert.equal(store.save(data), 1);
  assert.equal(changes() - before, 1);
  assert.deepEqual(store.load(), data);
  data.reportingHistory.projects[0].sourceStatus = "Archived";
  assert.equal(store.save(data), 1);
  assert.deepEqual(store.load(), data);
});

test("preserves order, duplicate IDs, anonymous rows, removals and section type changes across restarts", (t) => {
  const { store, data, databaseFile } = fixture(t);
  data.mixed = [{ id: "duplicate", text: "first" }, { id: "duplicate", text: "second" }, "plain", null, { text: "no ID" }];
  store.save(data);
  data.mixed.reverse();
  data.workfrontProjects = [];
  delete data.custom;
  data.reportingHistory.tasks = { replaced: ["new"] };
  store.save(data);
  store.close();
  const reopened = new WorkspaceStore(databaseFile);
  try {
    assert.deepEqual(reopened.load(), data);
    data.mixed = null;
    reopened.save(data);
    assert.deepEqual(reopened.load(), data);
    assert.deepEqual(reopened.db.pragma("foreign_key_check"), []);
  } finally {
    reopened.close();
  }
});

test("rolls back the entire batch on a write error and can retry without losing records", (t) => {
  const { store, data } = fixture(t);
  store.save(data);
  const original = structuredClone(data);
  store.db.exec(`CREATE TRIGGER fail_write BEFORE UPDATE ON workspace_records
    WHEN NEW.node_path = '["workfrontTasks"]'
    BEGIN SELECT RAISE(ABORT, 'test write failure'); END;`);
  data.workfrontProjects[0].sourceStatus = "Complete";
  data.workfrontTasks[0].plannedHours = 10;
  assert.throws(() => store.save(data), /test write failure/);
  assert.deepEqual(store.load(), original);
  assert.deepEqual(store.readSnapshot(), store.snapshot);
  store.db.exec("DROP TRIGGER fail_write");
  assert.equal(store.save(data), 2);
  assert.deepEqual(store.load(), data);
});

test("missing legacy JSON permits setup but invalid input never seeds an empty replacement", (t) => {
  const { store, legacyFile, data } = fixture(t);
  assert.equal(store.importLegacy(legacyFile), false);
  assert.equal(store.load(), null);
  fs.writeFileSync(legacyFile, "{broken");
  assert.throws(() => store.importLegacy(legacyFile), SyntaxError);
  assert.equal(store.load(), null);
  fs.writeFileSync(legacyFile, '{"version":99}');
  assert.throws(() => store.importLegacy(legacyFile), /invalid structure/);
  assert.throws(() => store.save({ ...data, users: null }), /invalid structure/);
  assert.equal(store.load(), null);
});

test("migration command verifies a transfer and never overwrites an existing database", (t) => {
  const { store, data, legacyFile, databaseFile } = fixture(t);
  store.close();
  fs.writeFileSync(legacyFile, JSON.stringify(data));
  const migrate = () => spawnSync(process.execPath, [path.join(__dirname, "../scripts/migrate-sqlite.js")], {
    env: { ...process.env, DATA_FILE: legacyFile, SQLITE_FILE: databaseFile }, encoding: "utf8"
  });
  const first = migrate();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Imported and verified/);
  fs.writeFileSync(legacyFile, "{}");
  const second = migrate();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Using existing/);
});

test("database paths support an isolated legacy source and explicit SQLite override", () => {
  assert.deepEqual(workspacePaths({ DATA_FILE: "/tmp/source.json" }), {
    legacyFile: "/tmp/source.json", databaseFile: "/tmp/source.sqlite"
  });
  assert.equal(workspacePaths({ DATA_FILE: "/tmp/source.json", SQLITE_FILE: "/tmp/custom.sqlite" }).databaseFile, "/tmp/custom.sqlite");
  assert.throws(() => workspacePaths({ DATA_FILE: "/tmp/same", SQLITE_FILE: "/tmp/same" }), /must not replace/);
});

test("server automatically migrates legacy JSON and uses SQLite on subsequent starts", async (t) => {
  const { store, data, legacyFile, databaseFile } = fixture(t);
  store.close();
  data.users = [];
  data.workfrontProjects = [];
  data.workfrontTasks = [];
  data.reportingHistory = { projects: [], tasks: [], rounds: [] };
  const original = JSON.stringify(data);
  fs.writeFileSync(legacyFile, original);
  let child;
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  };
  t.after(stop);
  const start = async () => {
    let output = "";
    child = spawn(process.execPath, [path.join(__dirname, "../server.js")], {
      env: { ...process.env, DATA_FILE: legacyFile, SQLITE_FILE: databaseFile, PORT: "0", HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      const port = output.match(/http:\/\/localhost:(\d+)/)?.[1];
      if (port) {
        const response = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).setupRequired, true);
        return;
      }
      if (child.exitCode !== null) assert.fail(`Server exited: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`Server did not start: ${output}`);
  };
  await start();
  await stop();
  assert.equal(fs.readFileSync(legacyFile, "utf8"), original);
  const migrated = new WorkspaceStore(databaseFile);
  try {
    assert.deepEqual(migrated.load().custom, data.custom);
  } finally {
    migrated.close();
  }
  fs.writeFileSync(legacyFile, "{invalid and must not be re-imported");
  await start();
  await stop();
});
