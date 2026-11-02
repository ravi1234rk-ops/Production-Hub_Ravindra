"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { chromium } = require("playwright");
const readXlsxFile = require("read-excel-file/node");
const { WorkspaceStore } = require("../workspace-store");
const { dueWindows, shiftDate } = require("../leadership-reports");

test("scheduled snapshots persist; scopes, review/version history, Excel, Quality pagination and leadership sharing work end-to-end", async (t) => {
  const root = path.resolve(__dirname, "..");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "leadership-workflow-"));
  const database = path.join(directory, "workspace.sqlite");
  let child;
  let browser;
  let baseUrl;
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
    throw new Error(output || "Server startup timed out.");
  };
  const request = async (route, cookie, body) => {
    const response = await fetch(`${baseUrl}${route}`, { method: body ? "POST" : "GET",
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, payload: response.headers.get("content-type")?.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer()),
      cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const login = async (username) => (await request("/api/auth/login", "", { username, password: "secure-password-123" })).cookie;
  await start();
  const setup = await request("/api/auth/setup", "", { username: "manager", name: "Manager", password: "secure-password-123" });
  assert.equal(setup.status, 201);
  for (const [username, name, role, teamIds] of [
    ["designer", "Design Executor", "executioner", ["design"]],
    ["emailer", "Email Executor", "executioner", ["email"]],
    ["shared", "Shared Auditor", "auditor", ["design", "email"]],
    ["designmanager", "Design Manager", "teamManager", ["design"]],
    ["leader", "Leader", "leadership", []]
  ]) assert.equal((await request("/api/users", setup.cookie, { username, name, role, teamIds, password: "secure-password-123" })).status, 201);
  await stop();
  const window = dueWindows(new Date()).find((window) => window.kind === "weekly");
  const completedAt = shiftDate(window.from, 4);
  const store = new WorkspaceStore(database);
  try {
    const data = store.load();
    data.team = data.users.filter((user) => ["executioner", "auditor"].includes(user.role)).map((user) => ({
      id: user.id, name: user.name, role: user.role, teamIds: user.teamIds, shiftStart: "09:00", shiftEnd: "18:00" }));
    data.workfrontProjects = [...Array.from({ length: 14 }, (_, i) => ({ ref: `D-${i}`, team: "design", name: "Design Executor" })),
      { ref: "E-1", team: "email", name: "Email Executor" }].map(({ ref, team, name }) => ({
      workfrontId: ref, ref, title: `${ref} production`, productionTeamId: team, assetType: team === "design" ? "Print" : "Email",
      channel: team === "design" ? "Print" : "Email", sourceStatus: "Complete", dueDate: completedAt,
      actualStartDate: window.from, actualCompletionDate: completedAt, materialExpectedDate: completedAt,
      pages: 2, complexity: "Low", requestType: "New Build", executorName: name, userUpdates: []
    }));
    data.workfrontTasks = data.workfrontProjects.map((project) => ({ workfrontId: `T-${project.ref}`, projectRef: project.ref,
      projectName: project.title, productionTeamId: project.productionTeamId, taskName: "Build", taskStatus: "Complete",
      assignmentNames: [project.executorName], assignees: project.executorName, assetType: project.assetType,
      plannedStartDate: window.from, plannedCompletionDate: completedAt, actualCompletionDate: completedAt, percentComplete: 100 }));
    data.sourceWorkLogs = data.workfrontTasks.map((task) => ({ id: `L-${task.workfrontId}`, taskId: task.workfrontId, projectRef: task.projectRef,
      taskCategory: "Build", userName: task.assignmentNames[0], userId: data.users.find((user) => user.name === task.assignmentNames[0]).id,
      date: completedAt, status: "Completed", progress: 100, hours: 1, note: task.productionTeamId === "email" ? "EMAIL-PRIVATE-EVIDENCE" : "Design effort" }));
    data.qaResults = data.workfrontTasks.map((task) => ({ deliveryKey: `workfront:${task.workfrontId}`,
      result: "Pass", firstTime: true, confirmedBy: "QA", createdAt: `${completedAt}T12:00:00Z` }));
    data.leadershipReports = [];
    data.holidays = [];
    data.leaves = [];
    data.workfrontAutomation.enabled = false;
    store.save(data);
  } finally { store.close(); }
  await start();
  const manager = await login("manager");
  const teamManager = await login("designmanager");
  const executor = await login("designer");
  const leader = await login("leader");
  assert.equal((await request("/api/leadership-reports")).status, 401);
  assert.equal((await request("/api/leadership-reports", executor)).status, 403);
  const listing = await request("/api/leadership-reports", manager);
  assert.equal(listing.payload.reports.length, 2);
  const id = listing.payload.reports.find((report) => report.kind === "weekly").id;
  const report = (await request(`/api/leadership-reports/${id}`, manager)).payload;
  assert.equal(report.totals.deliveriesCompleted, 15);
  assert.equal(report.totals.productiveHours, 15);
  assert.equal(report.totals.ftr.eligible, 1);
  assert.equal(report.totals.ftr.pending, 14);
  assert.equal(report.totals.capacityHours, 120);
  assert.equal(report.totals.ftr.rate, 100);
  assert.match(report.bulletin, /Draft/);
  const scoped = (await request(`/api/leadership-reports/${id}`, teamManager)).payload;
  assert.deepEqual(scoped.teams.map((team) => team.id), ["design"]);
  assert.equal(scoped.totals.capacityHours, 40);
  assert.doesNotMatch(JSON.stringify(scoped), /EMAIL-PRIVATE-EVIDENCE|Email Executor|Shared Auditor/);
  assert.equal((await request(`/api/leadership-reports/${id}?team=email`, teamManager)).status, 403);
  assert.equal((await request(`/api/leadership-reports/${id}/review`, leader, { version: 1, note: "Review" })).status, 403);
  assert.equal((await request(`/api/leadership-reports/${id}/refresh`, teamManager, { note: "Refresh" })).status, 403);
  assert.equal((await request(`/api/leadership-reports/${id}/review`, teamManager, { version: 0, note: "Review" })).status, 409);
  assert.equal((await request(`/api/leadership-reports/${id}/review`, teamManager, { version: 1, note: "Reviewed Design evidence." })).status, 200);
  assert.ok((await request(`/api/leadership-reports/${id}`, teamManager)).payload.teams[0].reviewedAt);
  assert.equal((await request(`/api/leadership-reports/${id}`, manager)).payload.teams.find((team) => team.id === "email").reviewedAt, undefined);
  const xlsx = (await request(`/api/leadership-reports/${id}/xlsx`, teamManager)).payload;
  const sheets = await readXlsxFile(xlsx);
  assert.doesNotMatch(JSON.stringify(sheets), /EMAIL-PRIVATE-EVIDENCE|Email Executor|Shared Auditor/);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const [name, value] = manager.split("=");
  await context.addCookies([{ name, value, url: baseUrl }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl);
  await page.locator('#main-nav [data-view="quality"]').click();
  await page.locator("#quality-quarter").selectOption({ label: "Q3 2026 (Jul–Sep)" });
  assert.equal(await page.locator("#quality-period").inputValue(), "quarterly");
  assert.match(await page.locator("#quality-coverage").innerText(), /2026-07-01 to 2026-09-30/);
  await page.locator("#quality-quarter").selectOption({ label: "Q4 2026 (Oct–Dec)" });
  assert.match(await page.locator("#quality-coverage").innerText(), /2026-10-01 to 2026-12-31/);
  await page.locator('#main-nav [data-view="kpi"]').click();
  await page.locator("#kpi-quarter").selectOption({ label: "Q3 2026 (Jul–Sep)" });
  await page.waitForFunction(() => document.querySelector("#kpi-load-status").textContent.includes("Loaded quarterly: 2026-07-01 to 2026-09-30"));
  assert.equal(await page.locator("#kpi-period").inputValue(), "quarterly");
  await page.locator('#main-nav [data-view="quality"]').click();
  await page.locator("#quality-period").selectOption("weekly");
  await page.locator("#quality-date").fill(completedAt);
  await page.locator("#quality-date").dispatchEvent("change");
  assert.match(await page.locator("#quality-week-bulletin").innerText(), /1 first-time-right out of 1/);
  assert.match(await page.locator("#quality-summary").innerText(), /14/);
  assert.equal(await page.locator("#quality-list tbody tr").count(), 10);
  assert.equal(await page.locator("#quality-list").isVisible(), false);
  await page.locator("details").filter({ has: page.locator("#quality-list") }).locator("summary").click();
  await page.locator("#quality-next").click();
  assert.equal(await page.locator("#quality-list tbody tr").count(), 4);
  await page.locator("#quality-outcome").selectOption("ftr");
  assert.equal(await page.locator("#quality-list tbody tr").count(), 1);
  assert.match(await page.locator("#quality-list").innerText(), /E-1/);
  await page.locator("#quality-last-week").click();
  await page.waitForFunction(() => document.querySelector("#leadership-report-content")?.textContent.includes("Weekly utilisation"));
  await page.locator("#leadership-report-team").selectOption("");
  await page.waitForFunction(() => document.querySelector("#leadership-bulletin")?.value.includes("15 deliveries"));
  assert.equal(await page.locator(".leadership-card-briefing td").count(), 8);
  assert.match(await page.locator(".leadership-card-briefing td").first().innerText(), /15/);
  await page.locator("#leadership-report-team").selectOption("design");
  await page.waitForFunction(() => document.querySelector("#leadership-bulletin")?.value.includes("14 deliveries"));
  assert.doesNotMatch(await page.locator("#leadership-bulletin").inputValue(), /Email Executor|EMAIL-PRIVATE-EVIDENCE/);
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#leadership-xlsx").click();
  assert.match((await downloadEvent).suggestedFilename(), /weekly.*design\.xlsx/);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.copiedBulletin = text; } } }); });
  await page.locator("#leadership-copy").click();
  assert.match(await page.evaluate(() => window.copiedBulletin), /14 deliveries/);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    write: async (items) => { window.copiedCards = await items[0].getType("text/html").then((blob) => blob.text()); }
  } }); });
  await page.locator("#leadership-copy").click();
  await page.waitForFunction(() => Boolean(window.copiedCards));
  assert.match(await page.evaluate(() => window.copiedCards), /Design Team|Production completed/);
  assert.doesNotMatch(await page.evaluate(() => window.copiedCards), /Email Team|EMAIL-PRIVATE-EVIDENCE/);
  await page.locator("#leadership-review").click();
  await page.locator('#leadership-action-form [name="note"]').fill("Manager reviewed Design bulletin.");
  await page.locator('#leadership-action-form [type="submit"]').click();
  await page.waitForFunction(() => document.querySelector("#leadership-report-status")?.textContent.startsWith("Reviewed"));
  await page.evaluate(() => document.body.classList.add("print-leadership"));
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator(".sidebar").evaluate((element) => getComputedStyle(element).visibility), "hidden");
  assert.equal(await page.locator("#leadership-report-content").evaluate((element) => getComputedStyle(element).visibility), "visible");
  assert.ok((await page.pdf()).length > 1000);
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => document.body.classList.remove("print-leadership"));
  assert.deepEqual(errors, []);
  const managerContext = await browser.newContext();
  const [managerCookieName, managerCookieValue] = teamManager.split("=");
  await managerContext.addCookies([{ name: managerCookieName, value: managerCookieValue, url: baseUrl }]);
  const managerPage = await managerContext.newPage();
  await managerPage.goto(baseUrl);
  await managerPage.locator('#main-nav [data-view="manager-reports"]').click();
  await managerPage.waitForFunction(() => document.querySelector(".leadership-card-briefing"));
  assert.equal(await managerPage.locator("#leadership-report-team").inputValue(), "design");
  assert.equal(await managerPage.locator("#leadership-report-team option").count(), 1);
  assert.match(await managerPage.locator(".leadership-card-briefing").innerText(), /Shared by Design Manager/);
  assert.doesNotMatch(await managerPage.locator("#leadership-bulletin").inputValue(), /Email Team|EMAIL-PRIVATE-EVIDENCE/);
  await managerPage.locator("#leadership-report-select").selectOption({ index: 2 });
  await managerPage.waitForFunction(() => document.querySelector(".leadership-card-briefing"));
  assert.equal(await managerPage.locator("#leadership-report-team").inputValue(), "design");
  await managerContext.close();
  await browser.close();
  browser = null;
  const refreshed = await request(`/api/leadership-reports/${id}/refresh`, manager, { version: 1, note: "Late evidence received." });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.payload.version, 2);
  assert.equal(refreshed.payload.teams[0].reviewedAt, undefined);
  await stop();
  await start();
  const restored = (await request(`/api/leadership-reports/${id}`, await login("manager"))).payload;
  assert.equal(restored.version, 2, "startup does not silently regenerate an existing report");
  assert.equal(restored.totals.deliveriesCompleted, 15);
  await stop();
  const saved = new WorkspaceStore(database);
  try {
    const data = saved.load();
    assert.equal(data.leadershipReportHistory.length, 1);
    assert.equal(data.leadershipReportHistory[0].version, 1);
    assert.equal(data.leadershipReportHistory[0].teams.find((team) => team.id === "design").reviewNote, "Manager reviewed Design bulletin.");
  } finally { saved.close(); }
});
