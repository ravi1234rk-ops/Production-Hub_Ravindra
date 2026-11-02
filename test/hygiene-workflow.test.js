"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { chromium } = require("playwright");
const { WorkspaceStore } = require("../workspace-store");

test("one adherence row per project, evidence colors, local editing, recheck, CSV and persisted override invalidation", async (t) => {
  const root = path.resolve(__dirname, "..");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hygiene-workflow-"));
  const database = path.join(directory, "workspace.sqlite");
  let child;
  let baseUrl;
  let browser;
  const stop = async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  };
  t.after(async () => {
    if (browser) await browser.close();
    await stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const start = async () => {
    let output = "";
    child = spawn(process.execPath, ["server.js"], { cwd: root, env: { ...process.env, HOST: "127.0.0.1", PORT: "0",
      DATA_FILE: path.join(directory, "workspace.json"), SQLITE_FILE: database }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      const port = output.match(/http:\/\/localhost:(\d+)/)?.[1];
      if (port) { baseUrl = `http://127.0.0.1:${port}`; return; }
      if (child.exitCode !== null) throw new Error(output);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(output || "Test server startup timed out.");
  };
  const request = async (route, cookie, body) => {
    const response = await fetch(`${baseUrl}${route}`, { method: body ? "POST" : "GET",
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, payload: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  await start();
  assert.equal((await request("/api/auth/setup", "", { username: "manager", name: "Manager", password: "secure-password-123" })).status, 201);
  await stop();
  const store = new WorkspaceStore(database);
  try {
    const data = store.load();
    data.workfrontProjects = ["MATCH", "MISMATCH", "DOUBTFUL"].map((ref) => ({
      workfrontId: ref, ref, title: `${ref} project`, productionTeamId: "design", workfrontTeam: "Design Team",
      assetType: "Poster", channel: "Poster", pages: 4, complexity: "High", requestType: "Updates", sourceStatus: "Complete",
      actualStartDate: "2026-10-20", actualCompletionDate: "2026-10-21", dueDate: "2026-10-21", materialExpectedDate: "2026-10-21",
      userUpdates: ref === "DOUBTFUL" ? [] : [{ id: `${ref}-NOTE`, author: "Manager", date: "2026-10-20",
        text: `Asset audit\nPrimary Material: Poster\nComplexity: High\nRequest Type: Updates\nPage count: ${ref === "MATCH" ? 4 : 5}\nMaterial expected delivery date: 2026-10-21` }]
    }));
    store.save(data);
  } finally { store.close(); }
  await start();
  const credentials = { username: "manager", password: "secure-password-123" };
  const cookie = (await request("/api/auth/login", "", credentials)).cookie;
  assert.equal((await request("/api/hygiene-verifications", cookie, { projectRef: "OUTSIDE", action: "recheck" })).status, 403);
  assert.equal((await request("/api/hygiene-verifications", cookie, { projectRef: "MISMATCH", checks: [], note: "No check selected" })).status, 400);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const [name, value] = cookie.split("=");
  await context.addCookies([{ name, value, url: baseUrl }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl);
  await page.locator('[data-view="hygiene"]').click();
  assert.equal(await page.locator("#hygiene-list tbody tr").count(), 3);
  assert.equal(await page.locator("#hygiene-list thead th").count(), 8);
  for (const [ref, color] of [["MATCH", "match"], ["MISMATCH", "mismatch"], ["DOUBTFUL", "doubtful"]]) {
    assert.match(await page.locator(`[data-adherence-ref="${ref}"]`).getAttribute("class"), new RegExp(`adherence-${color}`));
  }
  assert.match(await page.locator('[data-adherence-ref="MISMATCH"]').textContent(), /MISMATCH-NOTE/);
  await page.locator('[data-hygiene-verify="MISMATCH"]').click();
  await page.locator('#hygiene-verify-checks select[data-rule="Page count"]').selectOption("Manually verified");
  await page.locator('#hygiene-verify-form [name="note"]').fill("Confirmed four pages in the approved brief.");
  await page.locator('#hygiene-verify-form [type="submit"]').click();
  await page.waitForSelector("#hygiene-verify-dialog", { state: "hidden" });
  await page.waitForFunction(() => document.querySelector('[data-adherence-ref="MISMATCH"]')?.classList.contains("adherence-match"));
  assert.match(await page.locator('[data-adherence-ref="MISMATCH"]').textContent(), /Manually verified/);
  await page.locator('[data-hygiene-recheck="MISMATCH"]').click();
  await page.waitForFunction(() => document.querySelector('[data-adherence-ref="MISMATCH"]')?.classList.contains("adherence-mismatch"));
  const snapshot = (await request("/api/data", cookie)).payload;
  assert.equal(snapshot.hygiene.find((row) => row.ref === "MISMATCH").checks.find((check) => check.rule === "Page count").status, "Action required");
  await page.locator("#hygiene-filter").selectOption("Action required");
  assert.equal(await page.locator("#hygiene-list tbody tr").count(), 1);
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#hygiene-export").click();
  const download = await downloadEvent;
  const csv = await fs.readFile(await download.path(), "utf8");
  assert.match(csv, /Primary Material.*Material Expected date.*Plan completion date.*SLA/);
  assert.match(csv, /MISMATCH/);
  assert.doesNotMatch(csv, /DOUBTFUL/);
  assert.deepEqual(errors, []);
  await browser.close();
  browser = null;
  await stop();
  const persisted = new WorkspaceStore(database);
  try {
    const saved = persisted.load();
    assert.ok(saved.hygieneVerifications[0].invalidatedAt);
    assert.equal(saved.hygieneVerifications[0].note, "Confirmed four pages in the approved brief.");
    saved.workfrontProjects.find((project) => project.ref === "MISMATCH").pages = 5;
    persisted.save(saved);
  } finally { persisted.close(); }
  await start();
  const restoredCookie = (await request("/api/auth/login", "", credentials)).cookie;
  const restored = (await request("/api/data", restoredCookie)).payload;
  assert.equal(restored.hygiene.find((row) => row.ref === "MISMATCH").status, "Corrected");
});
