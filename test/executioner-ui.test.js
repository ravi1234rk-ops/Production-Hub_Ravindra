"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const FILES = { "/": "index.html", "/app.js": "app.js", "/workflow-ui.js": "workflow-ui.js", "/operations-ui.js": "operations-ui.js",
  "/process-audit-ui.js": "process-audit-ui.js", "/styles.css": "styles.css" };

function snapshotFor(role) {
  const executioner = role === "executioner";
  const capabilities = executioner
    ? { viewExecution: true, viewQuality: true, viewWorkfront: true, viewAht: false, viewPerformance: true, manageProjects: false }
    : { viewExecution: false, viewQuality: true, viewWorkfront: true, viewAht: true, viewPerformance: true, viewManagerReports: true, manageProjects: true, manageWorkspace: true };
  const items = [
    { id: "chk-1", section: "Content", label: "Copy matches source", detail: "Compare to brief", result: "Done", done: true, comment: "Checked twice" },
    { id: "chk-2", section: "Content", label: "Legal text present", result: "N.A.", done: false, comment: "No legal copy in this asset" },
    { id: "chk-3", section: "Layout", label: "Margins correct", result: "In Progress", done: false, comment: "" },
    { id: "chk-4", section: "Layout", label: "Fonts embedded", result: "Pending", done: false, comment: "" }
  ];
  return {
    user: { id: "user-1", name: "Test Designer", role, teamIds: ["design"] },
    roleCapabilities: capabilities,
    departments: [{ id: "design", name: "Design Team", assetTypes: ["Print"] }],
    team: [{ id: "user-1", name: "Test Designer", teamIds: ["design"], role: "executioner", shiftStart: "09:00", shiftEnd: "18:00" }],
    projects: [{ id: "proj-1", ref: "LOCAL-1", title: "Local project", status: "In Progress", progress: 20, productionTeamId: "design" }],
    tasks: [{ id: "local-task", projectId: "proj-1", projectRef: "LOCAL-1", projectTitle: "Local project", title: "Build", category: "Build",
      assignee: "Test Designer", status: "In Progress", startDate: "2026-10-12", startTime: "12:30", etaDate: "2026-10-14", etaTime: "15:00",
      plannedHours: 10, productionHours: 6, qaBufferHours: 4, loggedHours: 1, progress: 20 }],
    workfrontProjects: [{ ref: "WF-1", title: "Workfront project", sourceStatus: "Execution in Progress", productionTeamId: "design", assetType: "Print" }],
    workfrontTasks: [{ workfrontId: "wf-task-1", id: "wf-task-1", projectRef: "WF-1", projectName: "Workfront project", taskName: "Build", taskStatus: "In Progress",
      assignees: "Test Designer", assignmentNames: ["Test Designer"], productionTeamId: "design", plannedStartDate: "2026-10-12", plannedCompletionDate: "2026-10-14",
      percentComplete: 35, ahtHours: 5.5 }],
    workfrontChangeRounds: [], workfrontGanttTasks: [], workLogs: [], sourceWorkLogs: [],
    execution: { deliveries: [
      { key: "workfront:wf-task-1", source: "workfront", id: "wf-task-1", ref: "WF-1", title: "Workfront project", type: "Build", crId: "", names: ["Test Designer"],
        status: "In Progress", progress: 35, due: "2026-10-20", hours: 5.5, project: { ref: "WF-1", assetType: "Print" }, handoff: {} }
    ], quality: { rows: [] }, checklists: [{ deliveryKey: "workfront:wf-task-1", userId: "user-1", items, observations: "", inputDocuments: [], outputDocuments: [] }] },
    operationsWorkspace: { deliveries: [], quality: { rows: [] }, kpis: [], issues: [], activityLogs: [],
      checklistTemplates: [{ assetType: "Print", source: "Test source", items: items.map(({ id, section, label, detail }) => ({ id, section, label, detail })) }] },
    aht: executioner ? null : { teamAverage: 1.3, completedUnits: 0, loggedHours: 0, completedProjects: 0, baselineHoursPerUnit: 1.3, categories: [],
      validationMatrix: { records: [], addOns: [] } },
    workfrontAutomation: { enabled: false, status: "idle" }
  };
}

async function openApp(browser, role) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const snapshot = snapshotFor(role);
  const requests = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://frontend.test/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/auth/status") return route.fulfill({ json: { user: snapshot.user, setupRequired: false } });
    if (pathname === "/api/data") return route.fulfill({ json: snapshot });
    if (pathname.startsWith("/api/") && request.method() !== "GET") {
      requests.push({ pathname, method: request.method(), body: request.postDataJSON() });
      return route.fulfill({ status: pathname === "/api/execution/checklist" ? 200 : 201, json: {} });
    }
    if (!FILES[pathname]) return route.fulfill({ status: 404, json: {} });
    return route.fulfill({
      body: await fs.readFile(path.join(__dirname, "../public", FILES[pathname])),
      contentType: pathname.endsWith(".js") ? "application/javascript" : pathname === "/styles.css" ? "text/css" : "text/html"
    });
  });
  await page.goto("http://frontend.test/");
  await page.waitForFunction(() => !document.querySelector("#app-shell").classList.contains("hidden"));
  return { page, snapshot, requests, errors };
}

const visibleNav = (page) => page.locator("#main-nav .nav-link:not(.hidden)").evaluateAll((buttons) => buttons.map((button) => button.dataset.view));

test("executioner navigation keeps personal KPI, folds non-productive hours into Work log and hides AHT matrix", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, errors } = await openApp(browser, "executioner");
    assert.deepEqual(await visibleNav(page), ["my-work", "quality", "kpi", "feedback", "worklog", "gantt", "team"]);
    assert.equal(await page.locator('[data-view="activity"]').count(), 0);
    const ids = await page.evaluate(() => [...document.querySelectorAll("[id]")].map((element) => element.getAttribute("id")));
    assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), []);
    await page.evaluate(() => setView("activity"));
    assert.deepEqual(await page.locator(".view:not(.hidden)").evaluateAll((views) => views.map((view) => view.id)), ["view-worklog"]);
    assert.equal(await page.locator("#page-title").innerText(), "Work log");
    for (const id of ["non-productive-form", "non-productive-summary", "non-productive-list", "personal-log-table"]) {
      assert.equal(await page.locator(`#view-worklog #${id}`).count(), 1, id);
    }
    await page.locator('[data-view="gantt"]').click();
    await page.locator('#main-nav [data-view="kpi"]').click();
    assert.equal(await page.locator("#view-kpi").isVisible(), true);
    assert.equal(await page.locator("#kpi-manager-tools").isVisible(), false);
    assert.equal(await page.locator("#kpi-quarter").isVisible(), true);
    for (const hidden of ["aht"]) {
      await page.evaluate((view) => setView(view), hidden);
      assert.notEqual(await page.evaluate(() => state.view), hidden);
      assert.equal(await page.locator(`#view-${hidden}`).isVisible(), false);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("managers keep KPI and AHT navigation and the legacy activity route opens Work log", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page } = await openApp(browser, "manager");
    const nav = await visibleNav(page);
    assert.ok(nav.includes("kpi") && nav.includes("aht") && nav.includes("worklog") && !nav.includes("activity"));
    await page.evaluate(() => setView("activity"));
    assert.equal(await page.locator("#view-worklog").isVisible(), true);
    assert.equal(await page.locator("#personal-log-panel").isHidden(), true);
  } finally { await browser.close(); }
});

test("My work shows the current AHT benchmark and no AHT matrix for executioners", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page } = await openApp(browser, "executioner");
    await page.locator('[data-view="my-work"]').click();
    assert.match(await page.locator("#execution-summary").innerText(), /Open AHT benchmark\s*5\.50h/);
    assert.match(await page.locator("#execution-list").innerText(), /AHT benchmark 5\.50h · Logged 0\.00h/);
    assert.equal(await page.locator("#aht-validation-matrix .aht-matrix-input").count(), 0);
  } finally { await browser.close(); }
});

test("Gantt Log hrs opens the matching task for local and Workfront work and saves to the right endpoint", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, requests, errors } = await openApp(browser, "executioner");
    await page.locator('[data-view="gantt"]').click();
    await page.locator("#gantt-anchor").fill("2026-10-12");
    await page.locator("#gantt-anchor").dispatchEvent("change");

    await page.locator("#gantt-source").selectOption("workfront");
    await page.locator('[data-action="log-source-task"][data-id="wf-task-1"]').click();
    assert.equal(await page.locator("#worklog-dialog").evaluate((dialog) => dialog.open), true);
    assert.equal(await page.locator('#worklog-form [name="taskId"]').inputValue(), "wf:wf-task-1");
    assert.equal(await page.locator('#worklog-form [name="progress"]').inputValue(), "35");
    await page.locator('#worklog-form [name="hours"]').fill("2.5");
    await page.locator('#worklog-form [type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector("#worklog-dialog").open);
    assert.equal(requests.at(-1).pathname, "/api/workfront-worklogs");
    assert.equal(requests.at(-1).body.taskId, "wf-task-1");
    assert.equal(requests.at(-1).body.hours, 2.5);
    assert.match(await page.locator("#toast").innerText(), /saved/i);

    await page.locator("#gantt-source").selectOption("local");
    await page.locator('[data-action="log-task"][data-id="local-task"]').first().click();
    assert.equal(await page.locator("#worklog-dialog").evaluate((dialog) => dialog.open), true);
    assert.equal(await page.locator('#worklog-form [name="taskId"]').inputValue(), "local-task");
    assert.equal(await page.locator('#worklog-form [name="projectId"]').inputValue(), "proj-1");
    await page.locator('#worklog-form [name="hours"]').fill("1.5");
    await page.locator('#worklog-form [type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector("#worklog-dialog").open);
    assert.equal(requests.at(-1).pathname, "/api/worklogs");
    assert.equal(requests.at(-1).body.taskId, "local-task");
    assert.equal(requests.at(-1).body.projectId, "proj-1");
    assert.equal(requests.at(-1).body.hours, 1.5);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("managers can log local Gantt hours but get no Workfront log button", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, requests } = await openApp(browser, "manager");
    await page.locator('[data-view="gantt"]').click();
    await page.locator("#gantt-anchor").fill("2026-10-12");
    await page.locator("#gantt-anchor").dispatchEvent("change");
    await page.locator("#gantt-source").selectOption("workfront");
    assert.equal(await page.locator('[data-action="log-source-task"]').count(), 0);
    await page.locator("#gantt-source").selectOption("local");
    await page.locator('.gantt-person [data-action="log-task"]').first().click();
    assert.equal(await page.locator('#worklog-form [name="taskId"]').inputValue(), "local-task");
    await page.locator('#worklog-form [type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector("#worklog-dialog").open);
    assert.equal(requests.at(-1).pathname, "/api/worklogs");
  } finally { await browser.close(); }
});

test("executioner checklist uses one checkbox and optional notes and keeps legacy states until changed", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, requests, errors } = await openApp(browser, "executioner");
    await page.locator('[data-view="my-work"]').click();
    await page.locator('[data-execution-checklist="workfront:wf-task-1"]').click();
    assert.equal(await page.locator("#execution-checklist-items [data-check-result]").count(), 0);
    assert.equal(await page.locator("#execution-checklist-items [data-check-done]").count(), 4);
    assert.deepEqual(await page.locator("#execution-checklist-items [data-check-done]").evaluateAll((boxes) => boxes.map((box) => box.checked)), [true, false, false, false]);
    assert.equal(await page.locator("#execution-checklist-items [data-check-comment]").first().inputValue(), "Checked twice");
    assert.equal(await page.locator("#execution-checklist-items [data-check-legacy]").count(), 2);
    assert.equal(await page.locator("#execution-checklist-items [data-check-comment][required]").count(), 0);

    await page.locator("#execution-checklist-form").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Checklist saved"));
    const unchanged = requests.at(-1).body.items;
    assert.deepEqual(unchanged.map((item) => item.result), ["Done", "N.A.", "In Progress", "Pending"]);
    assert.equal(unchanged[1].comment, "No legal copy in this asset");

    const rows = page.locator(".execution-checklist-row");
    await rows.nth(1).locator("[data-check-done]").check();
    await rows.nth(3).locator("[data-check-comment]").fill("Awaiting font licence");
    await rows.nth(0).locator("[data-check-done]").uncheck();
    await page.locator("#execution-checklist-form").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Checklist saved"));
    const changed = requests.at(-1).body.items;
    assert.deepEqual(changed.map((item) => item.result), ["Pending", "Done", "In Progress", "Pending"]);
    assert.deepEqual(changed.map((item) => item.done), [false, true, false, false]);
    assert.equal(changed[3].comment, "Awaiting font licence");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
