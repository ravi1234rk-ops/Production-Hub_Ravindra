"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const readExcelFile = require("read-excel-file/node");
const { unzipSync, strFromU8 } = require("fflate");
const { chromium } = require("playwright");
const { CATEGORIES, validateReport, filterRows, reportWorkbook, summarize, teamWorkloadCounts, findingSummary } = require("../process-audit");

function row(overrides = {}) {
  return {
    projectId: "P-1", projectCreationDate: "2026-09-01", assetAuditCompletionDate: "2026-09-02",
    productionManagerName: "Production Manager", assetAuditorName: "Email Auditor", holdTime: 1.5,
    workingHoursDifference: 9, reasonCategory: "High Workload / Competing Priorities",
    reason: "Competing work is contextual, not confirmed.", verificationStatus: "Inferred",
    sameDayProjectCount: 12, sameDayAuditorProjectCount: 3, workfrontUrl: "https://laroche.my.workfront.adobe.com/project/abc/overview",
    updatesReadStatus: "Project Updates read", evidence: [{ source: "Project Updates", author: "Email Auditor",
      date: "2026-09-02", text: "Review completed after clarification.", url: "" }],
    pendingClarification: "", translationRequest: "", ...overrides
  };
}

function report(overrides = {}) {
  return { month: "2026-09", sourceFile: "source.xlsx", generatedAt: "2026-10-23T10:00:00.000Z",
    coverageNote: "Reviewed report; source-wide private note.", rows: [row()], ...overrides };
}

test("monthly audit validates dates, identity, categories, metrics, evidence and payload limits without automatic classification", () => {
  const normalized = validateReport(report());
  assert.equal(normalized.rows[0].reasonCategory, "High Workload / Competing Priorities");
  for (const category of CATEGORIES.filter((item) => item !== "Actual Miss Confirmed")) {
    assert.equal(validateReport(report({ rows: [row({ reasonCategory: category })] })).rows[0].reasonCategory, category);
  }
  const badReports = [
    {}, report({ month: "2026-13" }), report({ rows: [] }), report({ rows: [row(), row()] }),
    report({ rows: [row({ projectId: "p-1" }), row()] }), report({ rows: [row({ projectCreationDate: "2026-08-31" })] }),
    report({ rows: [row({ projectCreationDate: "2026-09-31" })] }),
    report({ rows: [row({ assetAuditCompletionDate: "2026-08-31" })] }),
    report({ rows: [row({ holdTime: -1 })] }), report({ rows: [row({ workingHoursDifference: Infinity })] }),
    report({ rows: [row({ sameDayProjectCount: 2.5 })] }), report({ rows: [row({ sameDayAuditorProjectCount: "3" })] }),
    report({ rows: [row({ reasonCategory: "Actual miss" })] }), report({ rows: [row({ verificationStatus: "Confirmed" })] }),
    report({ rows: [row({ workfrontUrl: "javascript:alert(1)" })] }), report({ rows: [row({ workfrontUrl: "https://workfront.adobe.com.evil.example/" })] }),
    report({ rows: [row({ evidence: [{ source: "AI", author: "", date: "", text: "Guess", url: "" }] })] }),
    report({ rows: [row({ verificationStatus: "Verified", evidence: [] })] }),
    report({ rows: [row({ reasonCategory: "Actual Miss Confirmed" })] }),
    report({ rows: [row({ reasonCategory: "Actual Miss Confirmed", verificationStatus: "Verified",
      evidence: [{ source: "Source workbook", author: "", date: "", text: "Late", url: "" }] })] }),
    report({ rows: [row({ evidence: [{ source: "Issue", author: "", date: "2026-09-31", text: "Invalid date", url: "" }] })] }),
    report({ generatedAt: "2026-09-31T10:00:00.000Z" }),
    report({ generatedAt: "yesterday" }), report({ coverageNote: "x".repeat(12001) }), report({ extra: "x".repeat(8 * 1024 * 1024) })
  ];
  for (const input of badReports) assert.throws(() => validateReport(input), (error) => error.status === 400);
  assert.equal(validateReport(report({ rows: [row({ assetAuditCompletionDate: "", evidence: [] })] })).rows[0].assetAuditCompletionDate, "");
  assert.equal(validateReport(report({ rows: [row({ reasonCategory: "Actual Miss Confirmed", verificationStatus: "Verified" })] })).rows[0].reasonCategory, "Actual Miss Confirmed");
});

test("same-day workload intersects team, creation day and auditor assignments without counting other teams or duplicate tasks", async () => {
  const projects = [
    { projectId: "D1", team: "Design Team", creationDate: "2026-09-01" },
    { projectId: "D2", team: "Design Team", creationDate: "2026-09-01" },
    { projectId: "D2", team: "Design Team", creationDate: "2026-09-01" },
    { projectId: "D3", team: "Design Team", creationDate: "2026-09-02" },
    ...["Email Team", "Video Team", "Web Team", "Outside PRD WPP Production"].map((team, i) =>
      ({ projectId: `O${i}`, team, creationDate: "2026-09-01" }))
  ];
  const tasks = [
    { projectId: "D1", name: "Asset Audit", assignmentNames: ["Auditor"] },
    { projectId: "D1", name: "Asset Audit", assignmentNames: ["Auditor"] },
    { projectId: "D2", name: "Asset Audit", assignmentNames: ["Other"] },
    { projectId: "D2", name: "Build", assignmentNames: ["Auditor"] },
    { projectId: "D3", name: "Asset Audit", assignmentNames: ["Auditor"] },
    ...[0, 1, 2, 3].map((i) => ({ projectId: `O${i}`, name: "Asset Audit", assignmentNames: ["Auditor"] }))
  ];
  assert.deepEqual(teamWorkloadCounts(projects, tasks, "Design Team", "2026-09-01", " AUDITOR "),
    { sameDayProjectCount: 2, sameDayAuditorProjectCount: 1 });
  assert.deepEqual(teamWorkloadCounts(projects, tasks, "Design Team", "2026-09-03", "Auditor"),
    { sameDayProjectCount: 0, sameDayAuditorProjectCount: 0 });
  assert.throws(() => teamWorkloadCounts(projects, tasks, "Unknown", "2026-09-01", "Auditor"));
  assert.throws(() => validateReport(report({ workloadTeam: "Unknown" })));
  const input = validateReport(report({ workloadTeam: "Design Team" }));
  assert.equal(input.workloadTeam, "Design Team");
  assert.equal(summarize(input).workloadTeam, "Design Team");
  const sheets = await readExcelFile(await reportWorkbook(input));
  assert.equal(sheets[0].data[0][10], "Design Team · Same-day Project Count");
  assert.equal(sheets[0].data[0][11], "Design Team · Same-day Auditor Project Count");
  assert.ok(JSON.stringify(sheets[2].data).includes("other production teams are excluded"));
  assert.equal(validateReport(report()).workloadTeam, undefined);
});

test("filtering, summary and genuine multi-sheet XLSX preserve imported metrics and formula-like text as strings", async () => {
  const input = validateReport(report({ rows: [row({ reason: '=HYPERLINK("https://evil.example")', productionManagerName: "+SUM(1,2)" }),
    row({ projectId: "P-2", assetAuditorName: "Other", reasonCategory: "Needs confirmation", verificationStatus: "Needs confirmation" })] }));
  const filtered = filterRows(input.rows, { search: "email", status: "Inferred" });
  assert.equal(filtered.length, 1);
  assert.equal(filterRows(input.rows, { search: "clarification" }).length, 2);
  assert.throws(() => filterRows(input.rows, { category: "unknown" }));
  assert.equal(summarize(input).statuses.Inferred, 1);
  const buffer = await reportWorkbook(input, filtered);
  assert.equal(buffer.subarray(0, 2).toString(), "PK");
  const sheets = await readExcelFile(buffer);
  assert.deepEqual(sheets.map((sheet) => sheet.sheet), ["Hygiene", "Evidence", "Summary"]);
  assert.deepEqual(sheets[0].data[0].slice(0, 8), ["Project ID", "Project Creation Date", "Asset Audit Completion Date",
    "Production Manager Name", "Asset Auditor Name", "Hold Time", "Working Hrs Difference", "Reason for Delay"]);
  assert.equal(sheets[0].data.length, 2);
  assert.equal(sheets[0].data[1][5], 1.5);
  assert.equal(sheets[0].data[1][7], findingSummary(input.rows[0]));
  assert.equal(sheets[1].data.length, 3);
  assert.equal(sheets[1].data[1][4], '=HYPERLINK("https://evil.example")');
  const zip = unzipSync(buffer);
  assert.doesNotMatch(strFromU8(zip["xl/worksheets/sheet1.xml"]), /<f[ >]/);
  assert.doesNotMatch(strFromU8(zip["xl/worksheets/sheet2.xml"]), /<f[ >]/);
  for (const [sheetNumber, columnCount, wideColumn] of [[1, 16, 8], [2, 6, 5], [3, 2, 2]]) {
    const xml = strFromU8(zip[`xl/worksheets/sheet${sheetNumber}.xml`]);
    assert.equal((xml.match(/<col /g) || []).length, columnCount);
    assert.match(xml, new RegExp(`<col [^>]*min="${wideColumn}"[^>]*width="(?:85|100|120)"`));
    assert.match(xml, /<pane [^>]*ySplit="1"[^>]*topLeftCell="A2"[^>]*state="frozen"/);
    assert.match(xml, /<c r="A1"[^>]*s="\d+"/);
  }
  const styles = strFromU8(zip["xl/styles.xml"]);
  assert.match(styles, /wrapText="1"/);
  assert.match(styles, /vertical="top"/);
  assert.match(styles, /<b\s*\/>/);
  assert.match(styles, /(?:FF)?E8EEF5/i);
  assert.match(strFromU8(zip["xl/worksheets/sheet1.xml"]), /<c r="F2"[^>]*><v>1\.5<\/v><\/c>/);
  assert.ok(JSON.stringify(sheets[2].data).includes("does not specify its unit"));
});

test("monthly API and Hygiene UI enforce role scopes, explicit replacement, filtered XLSX and restart persistence", async (t) => {
  const root = path.resolve(__dirname, "..");
  const directory = path.join(root, `.process-audit-test-${process.pid}-${Date.now()}`);
  await fs.mkdir(directory);
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
      DATA_FILE: path.join(directory, "workspace.json"), SQLITE_FILE: path.join(directory, "workspace.sqlite") },
    stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      const port = output.match(/http:\/\/localhost:(\d+)/)?.[1];
      if (port) { baseUrl = `http://127.0.0.1:${port}`; return; }
      if (child.exitCode !== null) throw new Error(output);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Test server failed to start: ${output}`);
  };
  const request = async (route, { cookie, body, method = body ? "POST" : "GET", origin } = {}) => {
    const response = await fetch(`${baseUrl}${route}`, { method,
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...(origin ? { origin } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const payload = response.headers.get("content-type")?.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, payload, response, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  await start();
  assert.equal((await request("/api/process-audit-reports")).status, 401);
  const setup = await request("/api/auth/setup", { body: { username: "admin", name: "Manager", password: "secure-password-123" } });
  const manager = setup.cookie;
  for (const [username, name, role, teamIds] of [
    ["email.auditor", "Email Auditor", "auditor", ["email"]], ["design.auditor", "Design Auditor", "auditor", ["design"]],
    ["email.manager", "Email Manager", "teamManager", ["email"]], ["leader", "Leader", "leadership", []],
    ["executor", "Executor", "executioner", ["email"]], ["designer", "Designer", "executioner", ["design"]]
  ]) assert.equal((await request("/api/users", { cookie: manager, body: { username, name, role, teamIds, password: "secure-password-123" } })).status, 201);
  const login = async (username) => (await request("/api/auth/login", { body: { username, password: "secure-password-123" } })).cookie;
  const auditor = await login("email.auditor");
  const teamManager = await login("email.manager");
  const leader = await login("leader");
  const executor = await login("executor");
  const scopedProject = await request("/api/projects", { cookie: manager, body: {
    ref: "P-SCOPE", title: "Design project with mismatched imported auditor", assignee: "Designer",
    productionTeamId: "design", taskType: "Email", requestType: "Standard", workfrontRequestType: "New Build",
    pages: 3, complexity: 1.5, progress: 0, status: "Not Started", dueDate: "2026-12-15", tatDate: "2026-12-10"
  } });
  assert.equal(scopedProject.status, 201, JSON.stringify(scopedProject.payload));
  for (const cookie of [leader, executor]) {
    assert.equal((await request("/api/process-audit-reports", { cookie })).status, 403);
    assert.deepEqual((await request("/api/data", { cookie })).payload.processAuditMonths, []);
  }
  assert.equal((await request("/api/process-audit-reports", { cookie: auditor, body: { report: report() } })).status, 403);
  assert.equal((await request("/api/process-audit-reports", { cookie: manager, origin: "https://evil.example", body: { report: report() } })).status, 403);
  assert.equal((await request("/api/process-audit-reports", { cookie: manager, body: { report: report({ month: "2026-08" }) } })).status, 400);
  assert.equal((await request("/api/process-audit-reports", { cookie: manager, body: { report: report(), extra: "x".repeat(8 * 1024 * 1024 + 1024) } })).status, 413);
  const input = report({ rows: [row(), row({ projectId: "P-2", assetAuditorName: "Design Auditor" }),
    row({ projectId: "P-3", assetAuditorName: "", verificationStatus: "Needs confirmation", reasonCategory: "Needs confirmation", evidence: [] }),
    row({ projectId: "P-SCOPE" })] });
  assert.equal((await request("/api/process-audit-reports", { cookie: teamManager, body: { report: input } })).status, 403);
  assert.equal((await request("/api/process-audit-reports", { cookie: manager, body: { report: input } })).status, 201);
  assert.equal((await request("/api/process-audit-reports", { cookie: manager, body: { report: input } })).status, 409);
  assert.equal((await request("/api/process-audit-reports", { cookie: teamManager, body: { report: report(), replaceExisting: true } })).status, 403);
  assert.equal((await request("/api/process-audit-reports/2026-09", { cookie: manager })).payload.rows.length, 4);
  for (const cookie of [auditor, teamManager]) {
    const scoped = (await request("/api/process-audit-reports/2026-09", { cookie })).payload;
    assert.equal(scoped.rows.length, 1);
    assert.equal(scoped.rows[0].projectId, "P-1");
    assert.ok(!JSON.stringify(scoped).includes("private note"));
    assert.ok(!JSON.stringify(scoped).includes("importedBy"));
    const snapshot = (await request("/api/data", { cookie })).payload;
    assert.equal(snapshot.processAuditMonths[0].rowCount, 1);
    assert.equal(snapshot.processAuditMonths[0].rows, undefined);
  }
  assert.equal((await request("/api/process-audit-reports/2026-10", { cookie: auditor })).status, 404);
  assert.equal((await request("/api/process-audit-reports/invalid", { cookie: manager })).status, 400);
  assert.equal((await request("/api/process-audit-reports/2026-09?status=bad", { cookie: auditor })).status, 400);
  const download = await request("/api/process-audit-reports/2026-09/xlsx?search=P-1", { cookie: auditor });
  assert.equal(download.status, 200);
  assert.match(download.response.headers.get("content-disposition"), /process-audit-2026-09\.xlsx/);
  const sheets = await readExcelFile(download.payload);
  assert.equal(sheets[0].data.length, 2);
  assert.equal(sheets[0].data[1][0], "P-1");
  assert.ok(!JSON.stringify(sheets).includes("private note"));
  assert.equal((await request("/api/process-audit-reports/2026-09/xlsx", { cookie: executor })).status, 403);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const [name, value] = manager.split("=");
  await context.addCookies([{ name, value, url: baseUrl }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl);
  await page.locator('[data-view="hygiene"]').click();
  assert.equal(await page.locator("#hygiene-adherence-panel").isVisible(), true);
  assert.equal(await page.locator("#sla-export").isVisible(), true);
  await page.locator("#hygiene-audit-tab").click();
  await page.waitForFunction(() => document.querySelector("#process-audit-list tbody")?.rows.length === 4);
  await page.locator("#process-audit-search").fill("P-1");
  assert.equal(await page.locator("#process-audit-list tbody tr").count(), 1);
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#process-audit-download").click();
  assert.equal((await downloadEvent).suggestedFilename(), "process-audit-2026-09.xlsx");
  await page.locator("#hygiene-adherence-tab").click();
  assert.equal(await page.locator("#sla-export").isVisible(), true);
  await page.locator("#hygiene-audit-tab").click();
  const uploaded = report({ workloadTeam: "Design Team", rows: [row({ reason: "<img src=x onerror=alert(1)> Reviewed evidence only" })] });
  await page.locator("#process-audit-search").fill("");
  await page.locator("#process-audit-file").setInputFiles({ name: "reviewed.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(uploaded)) });
  await page.locator("#process-audit-confirm").check();
  await page.locator("#process-audit-import-button").click();
  await page.waitForFunction(() => document.querySelector("#process-audit-list tbody")?.rows.length === 1);
  assert.match(await page.locator("#process-audit-list").textContent(), /<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator("#process-audit-list img").count(), 0);
  assert.match(await page.locator("#process-audit-list thead").textContent(), /Design Team only/);
  assert.equal((await request("/api/process-audit-reports/2026-09", { cookie: manager })).payload.rows.length, 1);
  const auditorContext = await browser.newContext();
  const [auditorCookieName, auditorCookieValue] = auditor.split("=");
  await auditorContext.addCookies([{ name: auditorCookieName, value: auditorCookieValue, url: baseUrl }]);
  const auditorPage = await auditorContext.newPage();
  await auditorPage.goto(baseUrl);
  await auditorPage.locator('[data-view="hygiene"]').click();
  await auditorPage.locator("#hygiene-audit-tab").click();
  await auditorPage.waitForFunction(() => document.querySelector("#process-audit-list tbody")?.rows.length === 1);
  assert.equal(await auditorPage.locator("#process-audit-import").isVisible(), false);
  assert.match(await auditorPage.locator("#process-audit-list thead").textContent(), /Design Team only/);
  assert.equal((await request("/api/process-audit-reports/2026-09", { cookie: auditor })).payload.workloadTeam, "Design Team");
  assert.deepEqual(pageErrors, []);
  await browser.close();
  browser = null;

  const replacement = report({ workloadTeam: "Design Team", coverageNote: "Replacement persisted", rows: [row({ reason: "Revised reviewed explanation" })] });
  assert.equal((await request("/api/process-audit-reports", { cookie: manager, body: { report: replacement, replaceExisting: true } })).status, 200);
  await stop();
  await start();
  const restored = (await request("/api/process-audit-reports/2026-09", { cookie: await login("admin") })).payload;
  assert.equal(restored.rows.length, 1);
  assert.equal(restored.rows[0].reason, "Revised reviewed explanation");
  assert.equal(restored.coverageNote, "Replacement persisted");
  assert.equal(restored.workloadTeam, "Design Team");
  assert.ok(restored.importedAt);
  const newMonth = report({ month: "2026-10", rows: [row({ projectCreationDate: "2026-10-01", assetAuditCompletionDate: "" })] });
  const restoredTeamManager = await login("email.manager");
  assert.equal((await request("/api/process-audit-reports", { cookie: restoredTeamManager, body: { report: newMonth } })).status, 201);
  assert.equal((await request("/api/process-audit-reports", { cookie: restoredTeamManager, body: { report: newMonth, replaceExisting: true } })).status, 200);
});
