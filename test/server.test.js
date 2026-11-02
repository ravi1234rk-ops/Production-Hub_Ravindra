"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");
const { zipSync } = require("fflate");
const { chromium } = require("playwright");
const { WorkspaceStore } = require("../workspace-store");

const root = path.resolve(__dirname, "..");
const tempDir = path.join(os.tmpdir(), `team-project-hub-test-${process.pid}-${Date.now()}`);
const dataFile = path.join(tempDir, "data.json");
const databaseFile = path.join(tempDir, "data.sqlite");
let child;
let baseUrl;
let output = "";

function readSavedData() {
  const store = new WorkspaceStore(databaseFile);
  try {
    return store.load();
  } finally {
    store.close();
  }
}

function writeSavedData(data) {
  const store = new WorkspaceStore(databaseFile);
  try {
    store.save(data);
  } finally {
    store.close();
  }
}

function xmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
  })[character]);
}

function xlsxUpload(name, sheetName, headers, records) {
  const columnName = (index) => {
    let value = index + 1;
    let result = "";
    while (value) {
      value -= 1;
      result = String.fromCharCode(65 + value % 26) + result;
      value = Math.floor(value / 26);
    }
    return result;
  };
  const cell = (column, row, value) => `<c r="${column}${row}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
  const rows = [headers, ...records].map((values, rowIndex) => `<row r="${rowIndex + 1}">${values.map((value, columnIndex) => cell(columnName(columnIndex), rowIndex + 1, value)).join("")}</row>`).join("");
  const parts = {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
  };
  const archive = zipSync(Object.fromEntries(Object.entries(parts).map(([file, contents]) => [file, Buffer.from(contents)])));
  return { name, contentBase64: Buffer.from(archive).toString("base64") };
}

async function startServer() {
  output = "";
  child = spawn(process.execPath, [path.join(root, "server.js")], {
    env: { ...process.env, OUTLOOK_TENANT_ID: "", OUTLOOK_CLIENT_ID: "", OUTLOOK_CLIENT_SECRET: "",
      DATA_FILE: dataFile, SQLITE_FILE: databaseFile, HOST: "127.0.0.1", PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const match = output.match(/http:\/\/localhost:(\d+)/);
    if (match) {
      baseUrl = `http://127.0.0.1:${match[1]}`;
      return;
    }
    if (child.exitCode !== null) throw new Error(`Server exited early: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start: ${output}`);
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  await new Promise((resolve) => {
    current.once("exit", resolve);
    current.kill("SIGTERM");
  });
}

async function request(route, { method = "GET", body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${baseUrl}${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json();
  return { response, payload, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

after(async () => {
  await stopServer();
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("shared project, audit, login, and work-log flows persist on the host", async () => {
  await fs.mkdir(tempDir, { recursive: true });
  await startServer();

  const status = await request("/api/auth/status");
  assert.equal(status.payload.setupRequired, true);

  const setup = await request("/api/auth/setup", {
    method: "POST",
    body: { username: "workspace.admin", name: "Workspace Admin", password: "secure-password-123" }
  });
  assert.equal(setup.response.status, 201);
  const adminCookie = setup.cookie;

  const snapshot = await request("/api/data", { cookie: adminCookie });
  assert.equal(snapshot.payload.projects.length, 0);
  assert.equal(snapshot.payload.tasks.length, 0);
  assert.equal(snapshot.payload.team.length, 9);
  assert.ok(snapshot.payload.departments.find((department) => department.id === "email").assetTypes.includes("Campaign"));
  assert.equal(snapshot.payload.marketMatrix.length, 74);
  assert.ok(snapshot.payload.holidays.some((holiday) => holiday.date === "2026-10-20"));
  assert.equal(snapshot.payload.user.role, "manager");
  assert.equal(snapshot.payload.roleCapabilities.viewManagerReports, true);
  assert.equal(snapshot.payload.aht.teamAverage, 1.3);
  assert.equal(snapshot.payload.aht.validationMatrix.sourceSheet, "Validation 2026");
  assert.equal(snapshot.payload.aht.validationMatrix.records.length, 108);
  assert.equal(snapshot.payload.aht.validationMatrix.addOns.length, 12);
  assert.ok(snapshot.payload.projects.every((item) => item.plannedHours > 0 && item.plannedStartDate && item.plannedEndDate));
  for (const name of ["Om Rathore", "Sarthak Gupta"]) {
    const member = snapshot.payload.team.find((item) => item.name === name);
    const membership = await request(`/api/team/${member.id}/departments`, {
      method: "PUT", cookie: adminCookie, body: { teamIds: ["email", "design"] }
    });
    assert.equal(membership.response.status, 200);
  }
  const kriti = snapshot.payload.team.find((item) => item.name === "Kriti Grover");
  assert.equal((await request(`/api/team/${kriti.id}/departments`, {
    method: "PUT", cookie: adminCookie, body: { teamIds: ["email", "design"] }
  })).response.status, 200);

  const emailTat = await request("/api/tat-estimate", {
    method: "POST", cookie: adminCookie,
    body: { channel: "Email", requestType: "New Build", complexity: "Medium", pageCount: 2, startDate: "2026-10-07", startTime: "11:00" }
  });
  assert.equal(emailTat.payload.tatDays, 3);
  assert.equal(emailTat.payload.calculatedTat, "3 Business Day(s)");
  assert.equal(emailTat.payload.etaDate, "2026-10-12");
  assert.equal(emailTat.payload.etaTime, "12:30");

  const printTat = await request("/api/tat-estimate", {
    method: "POST", cookie: adminCookie,
    body: { channel: "Print", requestType: "New Build", complexity: "Complex", pageCount: 6, startDate: "2026-10-07", startTime: "15:30" }
  });
  assert.equal(printTat.payload.tatDays, 11);
  assert.equal(printTat.payload.etaDate, "2026-10-23");
  assert.equal(printTat.payload.etaTime, "15:30");

  const aemTat = await request("/api/tat-estimate", {
    method: "POST", cookie: adminCookie,
    body: { channel: "AEM webpage", requestType: "Update/Repurpose", complexity: "Complex", pageCount: 7, startDate: "2026-10-07", startTime: "15:30" }
  });
  assert.equal(aemTat.payload.tatDays, 5);

  const bannerTat = await request("/api/tat-estimate", {
    method: "POST", cookie: adminCookie,
    body: { channel: "Banner-GIF", requestType: "New Build", complexity: "Medium", pageCount: 6, startDate: "2026-10-07", startTime: "15:30" }
  });
  assert.equal(bannerTat.payload.tatDays, 5);
  const websiteTat = await request("/api/tat-estimate", {
    method: "POST", cookie: adminCookie,
    body: { channel: "Website", requestType: "New Build", complexity: "Medium", pageCount: 1, startDate: "2026-10-07", startTime: "12:30" }
  });
  assert.equal(websiteTat.payload.tatDays, 2);

  const holidayTat = await request("/api/tat-estimate", {
    method: "POST", cookie: adminCookie,
    body: { channel: "Email", requestType: "New Build", complexity: "Simple", pageCount: 1, startDate: "2026-10-19", startTime: "15:30" }
  });
  assert.equal(holidayTat.payload.etaDate, "2026-10-21");

  const duplicateSetup = await request("/api/auth/setup", {
    method: "POST",
    body: { username: "other.admin", name: "Other Admin", password: "secure-password-123" }
  });
  assert.equal(duplicateSetup.response.status, 409);

  const project = await request("/api/projects", {
    method: "POST", cookie: adminCookie,
    body: {
      ref: "LOCAL-100", title: "Shared network test project", assignee: "Om Rathore",
      productionTeamId: "design",
      taskType: "Email", requestType: "Standard", workfrontRequestType: "New Build", pages: 3, complexity: 1.5,
      progress: 0, status: "Not Started", dueDate: "2026-12-15", tatDate: "2026-12-10"
    }
  });
  assert.equal(project.response.status, 201);
  assert.ok(project.payload.plannedHours > 0);

  const suggestions = await request("/api/planner/suggestions", {
    method: "POST", cookie: adminCookie, body: { projectId: project.payload.id }
  });
  assert.equal(suggestions.response.status, 200);
  assert.ok(suggestions.payload.plannedHours > 0);
  assert.ok(suggestions.payload.resources.length > 0);
  assert.ok(suggestions.payload.resources.some((resource) => resource.recommended));

  const emailBuildEstimate = await request("/api/planner/task-suggestions", {
    method: "POST", cookie: adminCookie,
    body: { projectId: project.payload.id, category: "Build", complexity: "Low", units: 3 }
  });
  assert.equal(emailBuildEstimate.response.status, 200);
  assert.equal(emailBuildEstimate.payload.estimateSource, "Validation 2026");
  assert.equal(emailBuildEstimate.payload.productionHours, 7.5);
  assert.equal(emailBuildEstimate.payload.qaBufferHours, 3.77);
  assert.equal(emailBuildEstimate.payload.plannedHours, 11.27);
  const capacityInput = { projectRef: "LOCAL-100", channel: "Email", requestType: "New Build", complexity: "Simple", pageCount: 3, startDate: "2030-01-07", startTime: "12:30" };
  const capacityEstimate = await request("/api/audit-capacity-estimate", { method: "POST", cookie: adminCookie, body: capacityInput });
  assert.equal(capacityEstimate.response.status, 200);
  assert.equal(capacityEstimate.payload.plannedHours, 11.27);
  const freeResource = capacityEstimate.payload.candidates.find((member) => member.name === "Sarthak Gupta");
  assert.equal(freeResource.backlogHours, 0);
  assert.equal(freeResource.tentativeDate, "2030-01-08");
  assert.equal(freeResource.tentativeTime, "14:46");
  assert.equal((await request("/api/audit-capacity-estimate", { method: "POST", cookie: adminCookie, body: { ...capacityInput, projectRef: "NOT-ACCESSIBLE" } })).response.status, 404);
  const ahtMatrixUpdate = await request("/api/aht-matrix", {
    method: "PUT", cookie: adminCookie,
    body: { overrides: { "3": { designerMinutes: 36 } } }
  });
  assert.equal(ahtMatrixUpdate.response.status, 200);
  assert.equal(ahtMatrixUpdate.payload.validationMatrix.records.find((row) => row.rowNumber === 3).designerMinutes, 36);
  const optimizedEmailEstimate = await request("/api/planner/task-suggestions", {
    method: "POST", cookie: adminCookie,
    body: { projectId: project.payload.id, category: "Build", complexity: "Low", units: 3 }
  });
  assert.equal(optimizedEmailEstimate.payload.productionHours, 7.6);
  assert.equal(optimizedEmailEstimate.payload.plannedHours, 11.37);

  const crEstimate = await request("/api/planner/task-suggestions", {
    method: "POST", cookie: adminCookie,
    body: { projectId: project.payload.id, category: "CR", complexity: "High", units: 2 }
  });
  assert.equal(crEstimate.response.status, 200);
  assert.equal(crEstimate.payload.estimateSource, "Validation 2026");
  const crTask = await request("/api/tasks", {
    method: "POST", cookie: adminCookie,
    body: {
      projectId: project.payload.id, category: "CR", crId: "CR1", complexity: "High",
      units: 2, assignee: "Om Rathore", startDate: "2026-12-16", startTime: "12:30",
      priority: "High", priorityOrder: 1, etaOverride: true, etaDate: "2026-12-16", etaTime: "13:00"
    }
  });
  assert.equal(crTask.response.status, 201);
  assert.equal(crTask.payload.task.category, "CR");
  assert.equal(crTask.payload.task.productionHours, crEstimate.payload.productionHours);
  assert.equal(crTask.payload.task.qaBufferHours, crEstimate.payload.qaBufferHours);
  assert.equal(crTask.payload.task.plannedHours, crEstimate.payload.plannedHours);
  assert.equal(crTask.payload.task.etaTime, "13:00");
  assert.ok(`${crTask.payload.task.capacityEtaDate}T${crTask.payload.task.capacityEtaTime}` > `${crTask.payload.task.etaDate}T${crTask.payload.task.etaTime}`);
  assert.equal(crTask.payload.changeRound.etaDate, "2026-12-21");
  const duplicateCrTask = await request("/api/tasks", {
    method: "POST", cookie: adminCookie,
    body: { projectId: project.payload.id, category: "CR", crId: "CR1", complexity: "Low", units: 1 }
  });
  assert.equal(duplicateCrTask.response.status, 409);
  const invalidCapacityEta = await request("/api/tasks", {
    method: "POST", cookie: adminCookie,
    body: {
      projectId: project.payload.id, category: "CR", crId: "CR2", complexity: "Low",
      units: 1, startDate: "2026-12-16", startTime: "12:30",
      etaOverride: true, etaDate: "2026-12-15", etaTime: "17:00"
    }
  });
  assert.equal(invalidCapacityEta.response.status, 400);

  const movedCrTask = await request(`/api/tasks/${crTask.payload.task.id}`, {
    method: "PUT", cookie: adminCookie,
    body: {
      assignee: "Kriti Grover", startDate: "2026-12-18", startTime: "12:30",
      priority: "High", priorityOrder: 1, etaOverride: true, etaDate: "2026-12-21", etaTime: "13:00"
    }
  });
  assert.equal(movedCrTask.response.status, 200);
  assert.equal(movedCrTask.payload.assignee, "Kriti Grover");
  assert.equal(movedCrTask.payload.startDate, "2026-12-18");
  assert.equal(movedCrTask.payload.etaDate, "2026-12-21");

  const bugTask = await request("/api/tasks", {
    method: "POST", cookie: adminCookie,
    body: {
      projectId: project.payload.id, category: "Bug Fixing", bugScope: "Build",
      complexity: "Low", units: 1, assignee: "Om Rathore", startDate: "2026-12-22", startTime: "12:30"
    }
  });
  assert.equal(bugTask.response.status, 201);
  assert.equal(bugTask.payload.task.category, "Bug Fixing");
  assert.equal(bugTask.payload.task.qaBufferHours, 1.83);

  const invalidLink = await request("/api/audits", {
    method: "POST", cookie: adminCookie,
    body: {
      projectRef: "LOCAL-100", auditType: "Audit", auditStatus: "Pending", priority: "Normal",
      sourceFile: "Available", channel: "Email", requestType: "New Build", complexity: "Simple",
      pageCount: 1, startDate: "2026-12-01", startTime: "12:30", etaDate: "2026-12-02",
      etaTime: "12:30", fileLink: "javascript:alert(1)"
    }
  });
  assert.equal(invalidLink.response.status, 400);

  const audit = await request("/api/audits", {
    method: "POST", cookie: adminCookie,
    body: {
      projectRef: "LOCAL-100", projectName: "Shared network test project",
      auditType: "Audit", auditStatus: "Pass",
      priority: "High", sourceFile: "Available", channel: "Email", requestType: "New Build",
      complexity: "Simple", pageCount: 1, startDate: "2026-12-01", startTime: "12:30",
      etaDate: "2026-12-02", etaTime: "12:30", outputFormat: "iPDF", observations: "Check translated copy.",
      capacityRequested: "true",
      market: "France", primaryDpm: "Somenath Roy", backupDpm: "Shivani Sharma",
      documents: [
        { name: "Source brief", link: "https://example.test/brief.pdf" },
        { name: "Reference artwork", link: "https://example.test/reference.pdf" }
      ]
    }
  });
  assert.equal(audit.response.status, 201);
  assert.equal(audit.payload.auditor, "Workspace Admin");
  assert.equal(audit.payload.primaryDpm, "Somenath Roy");
  assert.equal(audit.payload.calculatedTat, "1 Business Day(s)");
  assert.equal(audit.payload.documents.length, 2);
  assert.ok(audit.payload.capacityEstimate.candidates.length > 0);
  assert.equal(audit.payload.etaDate, "2026-12-02");

  const allocation = await request(`/api/projects/${project.payload.id}/allocation`, {
    method: "POST", cookie: adminCookie,
    body: { auditId: audit.payload.id, assignee: "Kriti Grover", dueDate: "2026-12-18" }
  });
  assert.equal(allocation.response.status, 200);
  assert.equal(allocation.payload.project.assignee, "Kriti Grover");
  assert.equal(allocation.payload.project.dueDate, "2026-12-18");
  assert.equal(allocation.payload.project.tatDate, "2026-12-10");
  assert.ok(allocation.payload.project.plannedHours > 0);
  assert.ok(allocation.payload.project.plannedStartDate);

  const lowRound = await request("/api/change-rounds", {
    method: "POST", cookie: adminCookie,
    body: { projectRef: "LOCAL-100", crId: "CR-01", complexity: "Low", landedDate: "2026-10-07", landedTime: "12:30" }
  });
  assert.equal(lowRound.response.status, 201);
  assert.equal(lowRound.payload.etaDate, "2026-10-08");
  assert.equal(lowRound.payload.etaTime, "12:30");

  const highRound = await request("/api/change-rounds", {
    method: "POST", cookie: adminCookie,
    body: { projectRef: "LOCAL-100", crId: "CR-02", complexity: "High", landedDate: "2026-10-07", landedTime: "12:30" }
  });
  assert.equal(highRound.response.status, 201);
  assert.equal(highRound.payload.etaDate, "2026-10-12");
  assert.equal(highRound.payload.etaTime, "12:30");

  const weekendRound = await request("/api/change-rounds", {
    method: "POST", cookie: adminCookie,
    body: { projectRef: "LOCAL-100", crId: "CR-03", complexity: "High", landedDate: "2026-10-09", landedTime: "12:30" }
  });
  assert.equal(weekendRound.payload.etaDate, "2026-10-14");

  const duplicateRound = await request("/api/change-rounds", {
    method: "POST", cookie: adminCookie,
    body: { projectRef: "LOCAL-100", crId: "CR-01", complexity: "Medium", landedDate: "2026-10-07", landedTime: "12:30" }
  });
  assert.equal(duplicateRound.response.status, 409);

  const settings = await request("/api/planner-settings", {
    method: "PUT", cookie: adminCookie,
    body: {
      rows: [...snapshot.payload.marketMatrix, { market: "Test Market", primaryDpm: "Primary", backupDpm: "Backup", secondaryBackupDpm: "" }],
      holidays: [{ date: "2026-10-08", name: "Studio closure" }]
    }
  });
  assert.equal(settings.response.status, 200);
  assert.equal(settings.payload.marketMatrix.length, 75);
  const holidayOnly = await request("/api/holidays", { method: "PUT", cookie: adminCookie, body: { holidays: [{ date: "2026-10-08", name: "Studio closure" }] } });
  assert.equal(holidayOnly.response.status, 200);
  assert.equal(holidayOnly.payload.holidays[0].name, "Studio closure");
  const duplicateHoliday = await request("/api/holidays", { method: "PUT", cookie: adminCookie, body: { holidays: [{ date: "2026-10-08" }, { date: "2026-10-08" }] } });
  assert.equal(duplicateHoliday.response.status, 409);

  const holidayRound = await request("/api/change-rounds", {
    method: "POST", cookie: adminCookie,
    body: { projectRef: "LOCAL-100", crId: "CR-04", complexity: "Medium", landedDate: "2026-10-07", landedTime: "12:30" }
  });
  assert.equal(holidayRound.payload.etaDate, "2026-10-09");

  const account = await request("/api/users", {
    method: "POST", cookie: adminCookie,
    body: { username: "designer.one", name: "Designer One", password: "another-secure-123", role: "executioner", teamIds: ["email"] }
  });
  assert.equal(account.response.status, 201);
  assert.equal(account.payload.role, "executioner");
  const accountWithoutDepartment = await request("/api/users", {
    method: "POST", cookie: adminCookie,
    body: { username: "missing.team", name: "Missing Team", password: "another-secure-123", role: "executioner", teamIds: [] }
  });
  assert.equal(accountWithoutDepartment.response.status, 400);

  const auditorAccount = await request("/api/users", {
    method: "POST", cookie: adminCookie,
    body: { username: "auditor.one", name: "Auditor One", password: "auditor-secure-123", role: "auditor", teamIds: ["email", "design"] }
  });
  assert.equal(auditorAccount.response.status, 201);
  assert.equal(auditorAccount.payload.role, "auditor");
  const roleChange = await request(`/api/users/${auditorAccount.payload.id}/access`, {
    method: "PUT", cookie: adminCookie, body: { role: "executioner" }
  });
  assert.equal(roleChange.response.status, 200);
  assert.equal(roleChange.payload.role, "executioner");
  const restoreAuditorRole = await request(`/api/users/${auditorAccount.payload.id}/access`, {
    method: "PUT", cookie: adminCookie, body: { role: "auditor" }
  });
  assert.equal(restoreAuditorRole.response.status, 200);
  assert.equal(restoreAuditorRole.payload.role, "auditor");

  const workProject = await request("/api/projects", {
    method: "POST", cookie: adminCookie,
    body: {
      ref: "LOCAL-101", title: "Assigned executioner task", assignee: "Designer One",
      productionTeamId: "email", channel: "Email",
      taskType: "New Build", requestType: "Standard", pages: 2, complexity: 1,
      progress: 0, status: "Not Started", dueDate: "2026-12-20", tatDate: "2026-12-19"
    }
  });
  assert.equal(workProject.response.status, 201);
  const designerMembership = (await request("/api/data", { cookie: adminCookie })).payload.team.find((member) => member.name === "Designer One");
  const removeActiveDepartment = await request(`/api/team/${designerMembership.id}/departments`, {
    method: "PUT", cookie: adminCookie, body: { teamIds: ["design"] }
  });
  assert.equal(removeActiveDepartment.response.status, 409);
  const scheduleBeforeLeave = await request(`/api/tasks/${workProject.payload.buildTaskId}`, {
    method: "PUT", cookie: adminCookie,
    body: { startDate: "2026-12-01", startTime: "12:30" }
  });
  assert.equal(scheduleBeforeLeave.response.status, 200);
  assert.equal(scheduleBeforeLeave.payload.startDate, "2026-12-01");
  const teamLeave = await request("/api/leaves", {
    method: "POST", cookie: adminCookie,
    body: { assignee: "Designer One", type: "Annual leave", startDate: "2026-12-01", endDate: "2026-12-02", note: "Coverage planned" }
  });
  assert.equal(teamLeave.response.status, 201);
  assert.equal(teamLeave.payload.leave.assignee, "Designer One");
  assert.equal(teamLeave.payload.leave.status, "Pending");
  assert.deepEqual(teamLeave.payload.impacts, []);
  const scheduleWhilePending = await request("/api/data", { cookie: adminCookie });
  assert.equal(scheduleWhilePending.payload.tasks.find((task) => task.id === workProject.payload.buildTaskId).startDate, "2026-12-01");
  const approveTeamLeave = await request(`/api/leaves/${teamLeave.payload.leave.id}`, {
    method: "PUT", cookie: adminCookie, body: { action: "approve" }
  });
  assert.equal(approveTeamLeave.response.status, 200);
  assert.ok(approveTeamLeave.payload.impacts.some((impact) => impact.beforeStartDate === "2026-12-01" && impact.afterStartDate > "2026-12-02"));
  const declinedLeave = await request("/api/leaves", {
    method: "POST", cookie: adminCookie,
    body: { assignee: "Designer One", type: "Personal leave", startDate: "2026-12-10", endDate: "2026-12-10" }
  });
  assert.equal(declinedLeave.response.status, 201);
  const decline = await request(`/api/leaves/${declinedLeave.payload.leave.id}`, {
    method: "PUT", cookie: adminCookie, body: { action: "decline" }
  });
  assert.equal(decline.response.status, 200);
  assert.equal(decline.payload.leave.status, "Declined");
  const overlappingLeave = await request("/api/leaves", {
    method: "POST", cookie: adminCookie,
    body: { assignee: "Designer One", type: "Personal leave", startDate: "2026-12-02", endDate: "2026-12-03" }
  });
  assert.equal(overlappingLeave.response.status, 409);
  const invalidLeave = await request("/api/leaves", {
    method: "POST", cookie: adminCookie,
    body: { assignee: "Designer One", type: "Annual leave", startDate: "2026-12-04", endDate: "2026-12-03" }
  });
  assert.equal(invalidLeave.response.status, 400);
  const multiDayHalf = await request("/api/leaves", {
    method: "POST", cookie: adminCookie,
    body: { assignee: "Designer One", type: "Personal leave", halfDay: "First half", startDate: "2026-12-15", endDate: "2026-12-16" }
  });
  assert.equal(multiDayHalf.response.status, 400);
  const firstHalf = await request("/api/leaves", {
    method: "POST", cookie: adminCookie,
    body: { assignee: "Designer One", type: "Personal leave", halfDay: "First half", startDate: "2026-12-15", endDate: "2026-12-15" }
  });
  assert.equal(firstHalf.response.status, 201);
  assert.equal(firstHalf.payload.leave.halfDay, "First half");
  const sameHalf = await request("/api/leaves", {
    method: "POST", cookie: adminCookie,
    body: { assignee: "Designer One", type: "Personal leave", halfDay: "First half", startDate: "2026-12-15", endDate: "2026-12-15" }
  });
  assert.equal(sameHalf.response.status, 409);
  const secondHalf = await request("/api/leaves", {
    method: "POST", cookie: adminCookie,
    body: { assignee: "Designer One", type: "Personal leave", halfDay: "Second half", startDate: "2026-12-15", endDate: "2026-12-15" }
  });
  assert.equal(secondHalf.response.status, 201);
  for (const leave of [firstHalf, secondHalf]) {
    const removed = await request(`/api/leaves/${leave.payload.leave.id}`, { method: "DELETE", cookie: adminCookie });
    assert.equal(removed.response.status, 200);
  }
  const leaveScheduledTask = await request("/api/tasks", {
    method: "POST", cookie: adminCookie,
    body: {
      projectId: workProject.payload.id, category: "Bug Fixing", bugScope: "Build",
      complexity: "Low", units: 1, assignee: "Designer One", startDate: "2026-12-01", startTime: "12:30"
    }
  });
  assert.equal(leaveScheduledTask.response.status, 201);
  assert.ok(leaveScheduledTask.payload.task.startDate > teamLeave.payload.leave.endDate);

  const unassignedProject = await request("/api/projects", {
    method: "POST", cookie: adminCookie,
    body: {
      ref: "LOCAL-102", title: "Self-assignment task", assignee: "",
      productionTeamId: "email", channel: "Email",
      taskType: "Adaptation", requestType: "Standard", pages: 1, complexity: 1,
      progress: 0, status: "Not Started", dueDate: "2026-12-22", tatDate: "2026-12-21"
    }
  });
  assert.equal(unassignedProject.response.status, 201);

  const memberLogin = await request("/api/auth/login", {
    method: "POST", body: { username: "designer.one", password: "another-secure-123" }
  });
  assert.equal(memberLogin.response.status, 200);
  assert.equal(memberLogin.payload.user.role, "executioner");

  const forbiddenAccount = await request("/api/users", {
    method: "POST", cookie: memberLogin.cookie,
    body: { username: "third.person", name: "Third Person", password: "another-secure-123" }
  });
  assert.equal(forbiddenAccount.response.status, 403);

  const privateSnapshot = await request("/api/data", { cookie: memberLogin.cookie });
  assert.equal(privateSnapshot.payload.aht, null);
  assert.equal(privateSnapshot.payload.roleCapabilities.viewManagerReports, false);
  assert.deepEqual(privateSnapshot.payload.audits, []);
  assert.deepEqual(privateSnapshot.payload.users, []);
  assert.ok(privateSnapshot.payload.projects.some((item) => item.id === workProject.payload.id));
  assert.ok(!privateSnapshot.payload.projects.some((item) => item.id === project.payload.id));
  assert.equal(privateSnapshot.payload.performance.hours, 0);
  assert.ok(privateSnapshot.payload.tasks.some((task) => task.assignee === "Designer One"));
  assert.ok(privateSnapshot.payload.tasks.every((task) => !task.assignee || task.assignee === "Designer One"));
  assert.deepEqual(privateSnapshot.payload.leaves.map((leave) => leave.type).sort(), ["Away", "Personal leave"]);
  assert.equal(privateSnapshot.payload.leaves[0].note, undefined);
  const privateTaskSuggestions = await request("/api/planner/task-suggestions", {
    method: "POST", cookie: memberLogin.cookie,
    body: { projectId: workProject.payload.id, category: "CR", complexity: "Medium", units: 1 }
  });
  assert.equal(privateTaskSuggestions.response.status, 200);
  assert.equal(privateTaskSuggestions.payload.resources[0].nextLeave.type, "Away");
  assert.equal(privateTaskSuggestions.payload.resources[0].nextLeave.note, undefined);

  const selfTask = await request("/api/tasks", {
    method: "POST", cookie: memberLogin.cookie,
    body: {
      projectId: workProject.payload.id, category: "CR", crId: "CR1",
      complexity: "Medium", units: 1, priority: "Urgent", priorityOrder: 1,
      etaOverride: true, etaDate: "2026-12-01", etaTime: "09:00",
      status: "Completed", progress: 100
    }
  });
  assert.equal(selfTask.response.status, 201);
  assert.equal(selfTask.payload.task.assignee, "Designer One");
  assert.equal(selfTask.payload.task.priority, "Normal");
  assert.equal(selfTask.payload.task.etaOverride, false);
  assert.equal(selfTask.payload.task.status, "Not Started");
  assert.equal(selfTask.payload.task.progress, 0);
  const forbiddenTaskUpdate = await request(`/api/tasks/${selfTask.payload.task.id}`, {
    method: "PUT", cookie: memberLogin.cookie, body: { assignee: "Kriti Grover" }
  });
  assert.equal(forbiddenTaskUpdate.response.status, 403);
  const forbiddenLeaveDelete = await request(`/api/leaves/${teamLeave.payload.leave.id}`, {
    method: "DELETE", cookie: memberLogin.cookie
  });
  assert.equal(forbiddenLeaveDelete.response.status, 403);

  const forbiddenAudit = await request("/api/audits", {
    method: "POST", cookie: memberLogin.cookie,
    body: {
      projectRef: "LOCAL-101", auditType: "Audit", auditStatus: "Pending", priority: "Normal",
      sourceFile: "Available", channel: "Email", requestType: "New Build", complexity: "Simple",
      pageCount: 1, startDate: "2026-12-01", startTime: "12:30", etaDate: "2026-12-02", etaTime: "12:30"
    }
  });
  assert.equal(forbiddenAudit.response.status, 403);
  const forbiddenSuggestions = await request("/api/planner/suggestions", {
    method: "POST", cookie: memberLogin.cookie, body: { projectId: workProject.payload.id }
  });
  assert.equal(forbiddenSuggestions.response.status, 403);

  const selfAllocation = await request(`/api/projects/${unassignedProject.payload.id}/allocation`, {
    method: "POST", cookie: memberLogin.cookie,
    body: { assignee: "Designer One", dueDate: "2026-12-22", plannedStartDate: "2026-12-01" }
  });
  assert.equal(selfAllocation.response.status, 200);
  assert.equal(selfAllocation.payload.project.assignee, "Designer One");
  assert.ok(selfAllocation.payload.project.plannedStartDate > teamLeave.payload.leave.endDate);
  const stealingAllocation = await request(`/api/projects/${project.payload.id}/allocation`, {
    method: "POST", cookie: memberLogin.cookie,
    body: { assignee: "Designer One", dueDate: "2026-12-18" }
  });
  assert.equal(stealingAllocation.response.status, 403);
  const forbiddenLog = await request("/api/worklogs", {
    method: "POST", cookie: memberLogin.cookie,
    body: {
      projectId: project.payload.id, date: "2026-12-01", hours: 1,
      phase: "Build", progress: 10, status: "In Progress", note: "Not assigned to this executioner"
    }
  });
  assert.equal(forbiddenLog.response.status, 403);

  const log = await request("/api/worklogs", {
    method: "POST", cookie: memberLogin.cookie,
    body: {
      projectId: workProject.payload.id, date: "2026-12-01", hours: 2.5,
      phase: "Build", progress: 100, status: "In Progress", note: "Build complete"
    }
  });
  assert.equal(log.response.status, 201);
  assert.equal(log.payload.status, "Completed");
  const taskLog = await request("/api/worklogs", {
    method: "POST", cookie: memberLogin.cookie,
    body: {
      projectId: workProject.payload.id, taskId: selfTask.payload.task.id,
      date: "2026-12-02", hours: 1, phase: "Build", progress: 50,
      status: "In Progress", note: "CR in progress"
    }
  });
  assert.equal(taskLog.response.status, 201);
  assert.equal(taskLog.payload.taskCategory, "CR");
  assert.equal(taskLog.payload.crId, "CR1");
  const personalLogSnapshot = await request("/api/data", { cookie: memberLogin.cookie });
  assert.equal(personalLogSnapshot.payload.workLogs.length, 2);
  assert.equal(personalLogSnapshot.payload.workLogs[0].userName, "Designer One");
  assert.equal(personalLogSnapshot.payload.performance.completedProjects, 1);

  const auditorLogin = await request("/api/auth/login", {
    method: "POST", body: { username: "auditor.one", password: "auditor-secure-123" }
  });
  assert.equal(auditorLogin.payload.user.role, "auditor");
  const auditorLeave = await request("/api/leaves", {
    method: "POST", cookie: auditorLogin.cookie,
    body: { assignee: "Auditor One", type: "Personal leave", startDate: "2026-12-10", endDate: "2026-12-10" }
  });
  assert.equal(auditorLeave.response.status, 201);
  assert.equal(auditorLeave.payload.leave.status, "Pending");
  const auditorSnapshot = await request("/api/data", { cookie: auditorLogin.cookie });
  assert.equal(auditorSnapshot.payload.audits.length, 1);
  assert.equal(auditorSnapshot.payload.roleCapabilities.viewManagerReports, false);
  assert.equal(auditorSnapshot.payload.marketMatrix.length, 75);
  assert.ok(auditorSnapshot.payload.aht.teamAverage > 0);
  assert.ok(auditorSnapshot.payload.productionInsights.byCategory.some((item) => item.label === "CR"));
  assert.ok(auditorSnapshot.payload.productionInsights.auditsByStatus.some((item) => item.label === "Pass"));
  assert.equal(auditorSnapshot.payload.leaves.find((leave) => leave.assignee === "Designer One").type, "Away");
  assert.equal(auditorSnapshot.payload.leaves.length, 2);
  assert.deepEqual(auditorSnapshot.payload.users, []);
  const auditorSettings = await request("/api/planner-settings", {
    method: "PUT", cookie: auditorLogin.cookie,
    body: { rows: [], holidays: [] }
  });
  assert.equal(auditorSettings.response.status, 403);
  const auditorHolidays = await request("/api/holidays", { method: "PUT", cookie: auditorLogin.cookie, body: { holidays: [] } });
  assert.equal(auditorHolidays.response.status, 403);
  const auditorCapacitySettings = await request("/api/capacity-settings", {
    method: "PUT", cookie: auditorLogin.cookie,
    body: { complexityMultipliers: { Low: 0.8, Medium: 1, High: 1.6 } }
  });
  assert.equal(auditorCapacitySettings.response.status, 403);
  const auditorAhtMatrixUpdate = await request("/api/aht-matrix", {
    method: "PUT", cookie: auditorLogin.cookie,
    body: { overrides: { "3": { designerMinutes: 24 } } }
  });
  assert.equal(auditorAhtMatrixUpdate.response.status, 403);
  const forbiddenAuditorAccount = await request("/api/users", {
    method: "POST", cookie: auditorLogin.cookie,
    body: { username: "not.allowed", name: "Not Allowed", password: "another-secure-123" }
  });
  assert.equal(forbiddenAuditorAccount.response.status, 403);

  const updated = await request("/api/data", { cookie: adminCookie });
  const savedProject = updated.payload.projects.find((item) => item.id === workProject.payload.id);
  assert.equal(savedProject.progress, 100);
  assert.equal(savedProject.status, "Completed");
  assert.equal(updated.payload.audits.length, 1);
  assert.equal(updated.payload.workLogs.length, 2);
  assert.equal(updated.payload.aht.completedProjects, 1);
  assert.ok(updated.payload.aht.categories.find((item) => item.taskType === "New Build").hoursPerUnit > 0);
  assert.equal(updated.payload.changeRounds.length, 6);
  assert.equal(updated.payload.holidays[0].name, "Studio closure");
  assert.equal(updated.payload.marketMatrix.at(-1).market, "Test Market");
  assert.equal(updated.payload.projects.find((item) => item.id === project.payload.id).tatDate, "2026-12-10");
  assert.equal(updated.payload.users.length, 3);
  const capacitySettings = await request("/api/capacity-settings", {
    method: "PUT", cookie: adminCookie,
    body: { complexityMultipliers: { Low: 0.8, Medium: 1, High: 1.6 } }
  });
  assert.equal(capacitySettings.response.status, 200);
  assert.equal(capacitySettings.payload.complexityMultipliers.High, 1.6);

  const openHeaders = ["Reference Number", "Project Name", "Status", "Planned Completion Date", "Number of Pages", "Complexity", "Primary Material", "Country", "LEM", "Owner: Name", "Delivery Centre", "Last Update Date", "Request Type"];
  const openRows = [
    [project.payload.ref, "Existing native project", "In Progress", "2026-11-10", "2", "Medium", "Email", "Switzerland", "Local LEM", "Native Owner", "PRD WPP Production", "2026-10-01T11:00:00Z", "Localization"],
    ["WF-NEW-1", "New Workfront email project", "Current", "2026-11-11", "3", "Low", "Email", "Germany", "Team LEM", "Project Owner", "PRD WPP Production", "2026-10-02T15:30:00Z", "New Build"],
    ["WF-QA-1", "QA Workfront project", "QA In Progress", "2026-11-12", "1", "High", "iPDF", "France", "Team LEM", "Project Owner", "PRD WPP Production", "2026-10-03T09:15:00Z", "Update/Repurpose"],
    ...[
      ["WF-STATUS-AUDIT", "Audit Ongoing"],
      ["WF-STATUS-AWAIT", "Awaiting Execution"],
      ["WF-STATUS-CR-EXEC", "CR in Execution"],
      ["WF-STATUS-CR-REVIEW", "CR in Review"],
      ["WF-STATUS-CR-PENDING", "CR Pending Review"],
      ["WF-STATUS-EXEC", "Execution in Progress"],
      ["WF-STATUS-QC", "in QC"],
      ["WF-STATUS-REVIEW", "In Review"],
      ["WF-STATUS-HOLD", "On Hold"],
      ["WF-STATUS-CLAR", "Pending Clarification"],
      ["WF-STATUS-PENDING", "Pending review"],
      ["WF-STATUS-PLAN", "Planning"],
      ["WF-STATUS-PRE", "Pre-Audit"],
      ["WF-STATUS-PRE-DONE", "Pre-Audit Complete"],
      ["WF-STATUS-VO", "VO In Progress"]
    ].map(([ref, status]) => [ref, `${status} project`, status, "2026-11-15", "1", "Medium", "Email", "Germany", "Team LEM", "Project Owner", "PRD WPP Production", "2026-10-06T09:15:00Z", "Localization"]),
    ["WF-CRV-1", "Excluded CRV project", "Current", "2026-11-14", "1", "Medium", "Email", "Germany", "Team LEM", "Project Owner", "CRV WPP Production", "2026-10-04T09:15:00Z", "New Build"],
    ["WF-OUT-1", "Outside production centre", "Current", "2026-11-13", "1", "Medium", "Email", "Germany", "Team LEM", "Project Owner", "PRD Mumbai", "2026-10-05T09:15:00Z", "New Build"]
  ];
  const changeHeaders = ["Project Ref #", "Project Name", "Reference Number", "Name", "Assigned To: Name", "Project: Primary Material", "Project: Complexity", "Status", "Project: Country", "Project: Delivery Centre"];
  openHeaders.push("Priority");
  for (const row of openRows) row.push(row[0] === "WF-NEW-1" ? "Urgent" : "");
  const changeRows = [
    [project.payload.ref, "Native project CR", "WF-CR-001", "WFCR-1", "Auditor One", "iPDF", "High", "Assigned to Execution", "Switzerland", "PRD WPP Production"],
    ["WF-ORPHAN", "Missing parent project", "WF-CR-002", "CR2", "", "Banner HTML", "Medium", "New", "France", "PRD WPP Production"],
    [project.payload.ref, "Already managed CR", "WF-CR-003", "CR1", "Sarthak Gupta", "Print", "Medium", "Assigned to Execution", "Switzerland", "PRD WPP Production"],
    ["WF-NEW-1", "Manager-assigned CR", "WF-CR-004", "CR3", "Workspace Admin", "Print", "Medium", "Assigned to Execution", "Germany", "PRD WPP Production"],
    ...[
      ["WF-CR-QA", "CR4", "Assigned to QA"],
      ["WF-CR-FEEDBACK", "CR5", "Awaiting Feedback"],
      ["WF-CR-COMPLETE", "CR6", "Execution Complete"],
      ["WF-CR-PROGRESS", "CR7", "In Progress"],
      ["WF-CR-CLARIFICATION", "CR8", "Pending Clarification"],
      ["WF-CR-QA-COMPLETE", "CR9", "QA Completed"],
      ["WF-CR-QA-PROGRESS", "CR10", "QA In Progress"],
      ["WF-CR-REWORK", "CR11", "Rework Identified"]
    ].map(([workfrontId, crId, status]) => ["WF-NEW-1", `Imported ${crId}`, workfrontId, crId, "", "Email", "Medium", status, "Germany", "PRD WPP Production"]),
    ["WF-OUT-1", "Outside production centre CR", "WF-CR-005", "CR4", "Sarthak Gupta", "iPDF", "Low", "Assigned to Execution", "France", "CRV RSS"]
  ];
  const openReport = xlsxUpload("all-open-projects.xlsx", "Open Projects", openHeaders, openRows);
  const changeReport = xlsxUpload("all-change-rounds.xlsx", "Change Rounds", changeHeaders, changeRows);
  const initialAutomation = await request("/api/data", { cookie: adminCookie });
  assert.deepEqual(
    { enabled: initialAutomation.payload.workfrontAutomation.enabled, status: initialAutomation.payload.workfrontAutomation.status, intervalMinutes: initialAutomation.payload.workfrontAutomation.intervalMinutes },
    { enabled: false, status: "idle", intervalMinutes: 15 }
  );
  assert.deepEqual(initialAutomation.payload.workfrontLogin, {
    status: "idle",
    openedAt: null,
    completedAt: null,
    lastError: ""
  });
  const deniedAutomationUpdate = await request("/api/workfront/automation", {
    method: "POST", cookie: memberLogin.cookie, body: { enabled: true }
  });
  assert.equal(deniedAutomationUpdate.response.status, 403);
  const invalidAutomationUpdate = await request("/api/workfront/automation", {
    method: "POST", cookie: adminCookie, body: { enabled: "yes" }
  });
  assert.equal(invalidAutomationUpdate.response.status, 400);
  const deniedWorkfrontSync = await request("/api/workfront/sync", {
    method: "POST", cookie: memberLogin.cookie, body: { openProjects: openReport, changeRounds: changeReport }
  });
  assert.equal(deniedWorkfrontSync.response.status, 403);
  const deniedAuditorWorkfrontSync = await request("/api/workfront/sync", {
    method: "POST", cookie: auditorLogin.cookie, body: { openProjects: openReport, changeRounds: changeReport }
  });
  assert.equal(deniedAuditorWorkfrontSync.response.status, 403);
  for (const endpoint of ["/api/workfront/login", "/api/workfront/login/complete", "/api/workfront/login/cancel"]) {
    const denied = await request(endpoint, { method: "POST", cookie: memberLogin.cookie, body: {} });
    assert.equal(denied.response.status, 403, `Expected Manager-only authorization for ${endpoint}`);
  }
  const invalidWorkfrontSync = await request("/api/workfront/sync", {
    method: "POST", cookie: adminCookie, body: { openProjects: openReport, changeRounds: { name: "broken.xlsx", contentBase64: "UEsDBA==" } }
  });
  assert.equal(invalidWorkfrontSync.response.status, 400);
  assert.equal((await request("/api/data", { cookie: adminCookie })).payload.workfrontProjects.length, 0);
  const workfrontSync = await request("/api/workfront/sync", {
    method: "POST", cookie: adminCookie, body: { openProjects: openReport, changeRounds: changeReport }
  });
  assert.equal(workfrontSync.response.status, 200, `${JSON.stringify(workfrontSync.payload)}\n${output}`);
  assert.deepEqual(workfrontSync.payload.projects, { total: 18, excludedDeliveryCentre: 2, added: 17, updated: 0, alreadyInWorkspace: 1 });
  assert.deepEqual(workfrontSync.payload.changeRounds, { total: 12, excludedDeliveryCentre: 1, added: 11, updated: 0, alreadyInWorkspace: 1 });
  assert.equal(workfrontSync.payload.changeRoundsWithoutProject, 1);
  assert.deepEqual(workfrontSync.payload.currentProjectRefs, ["WF-NEW-1", "WF-STATUS-PRE"]);
  const importedStatuses = new Set(workfrontSync.payload.projectStatusCounts.map((row) => row.label));
  for (const status of ["Current", "Pre-Audit", "Audit Ongoing", "Awaiting Execution", "CR in Execution", "CR in Review", "CR Pending Review", "Execution in Progress", "in QC", "In Review", "On Hold", "Pending Clarification", "Pending review", "Planning", "Pre-Audit Complete", "VO In Progress", "QA In Progress"]) {
    assert.ok(importedStatuses.has(status), `Missing imported Workfront project status: ${status}`);
  }
  assert.deepEqual(workfrontSync.payload.changeRoundExecutionCounts, [
    { label: "Other workflow status", count: 8 },
    { label: "Needs executioner assignment", count: 2 },
    { label: "Assigned to executioner", count: 1 },
    { label: "New / not yet assigned", count: 1 }
  ]);
  const workfrontSnapshot = await request("/api/data", { cookie: adminCookie });
  assert.equal(workfrontSnapshot.payload.workfrontProjects.length, 17);
  assert.equal(workfrontSnapshot.payload.workfrontProjects[0].ref, "WF-NEW-1");
  assert.equal(workfrontSnapshot.payload.workfrontProjects[0].priority, "Urgent");
  assert.ok(workfrontSnapshot.payload.workfrontChangeRounds.filter((round) => round.projectRef === "WF-NEW-1").every((round) => round.projectPriority === "Urgent"));
  assert.equal(workfrontSnapshot.payload.workfrontProjects[0].workfrontTeam, "Email Team");
  assert.equal(workfrontSnapshot.payload.workfrontProjects[0].qaQueue, false);
  assert.equal(workfrontSnapshot.payload.workfrontProjects[0].channel, "Email");
  assert.equal(workfrontSnapshot.payload.workfrontProjects[0].lastUpdateDate, "2026-10-02T15:30:00.000Z");
  assert.equal(workfrontSnapshot.payload.workfrontProjects[1].ref, "WF-QA-1");
  assert.equal(workfrontSnapshot.payload.workfrontProjects[1].qaQueue, true);
  assert.equal(workfrontSnapshot.payload.workfrontProjects.find((item) => item.sourceStatus === "Audit Ongoing").qaQueue, false);
  const mappedStages = new Map(workfrontSnapshot.payload.workfrontProjects.map((item) => [item.sourceStatus, item.productionStage]));
  for (const status of ["Current", "Pre-Audit"]) assert.equal(mappedStages.get(status), "Awaiting Audit");
  assert.equal(mappedStages.get("Audit Ongoing"), "Audit");
  assert.equal(mappedStages.get("Awaiting Execution"), "Awaiting Execution");
  assert.equal(mappedStages.get("Pre-Audit Complete"), "Pre-Audit Complete");
  assert.equal(mappedStages.get("Execution in Progress"), "Execution in progress");
  assert.equal(mappedStages.get("CR in Execution"), "CR in Execution");
  for (const status of ["In Review", "CR in Review", "CR Pending Review", "Pending review", "VO In Progress"]) assert.equal(mappedStages.get(status), "Client-side hold");
  for (const status of ["in QC", "QA In Progress"]) assert.equal(mappedStages.get(status), "In QC");
  assert.equal(mappedStages.get("On Hold"), "On Hold");
  assert.equal(mappedStages.get("Pending Clarification"), "Pending Clarification");
  assert.equal(mappedStages.get("Planning"), "Planning");
  assert.ok(workfrontSnapshot.payload.workfrontProjects.every((item) => item.deliveryCentre === "PRD WPP Production"));
  assert.equal(workfrontSnapshot.payload.workfrontChangeRounds.length, 11);
  assert.equal(workfrontSnapshot.payload.workfrontChangeRounds[0].workfrontTeam, "Design Team");
  assert.equal(workfrontSnapshot.payload.workfrontChangeRounds[0].executionAssignment, "Needs executioner assignment");
  assert.equal(workfrontSnapshot.payload.workfrontChangeRounds[1].projectRef, "WF-ORPHAN");
  assert.equal(workfrontSnapshot.payload.workfrontChangeRounds[1].executionAssignment, "New / not yet assigned");
  assert.deepEqual(new Set(workfrontSnapshot.payload.workfrontChangeRounds.map((item) => item.sourceStatus)), new Set([
    "Assigned to Execution", "New", "Assigned to QA", "Awaiting Feedback", "Execution Complete",
    "In Progress", "Pending Clarification", "QA Completed", "QA In Progress", "Rework Identified"
  ]));
  assert.ok(workfrontSnapshot.payload.workfrontChangeRounds.every((item) => item.deliveryCentre === "PRD WPP Production"));
  assert.equal(workfrontSnapshot.payload.workfrontSync.openProjectsFile, "all-open-projects.xlsx");
  const teamManagerAccount = await request("/api/users", {
    method: "POST", cookie: adminCookie,
    body: { username: "email.manager", name: "Email Team Manager", password: "team-manager-secure-123", role: "teamManager", teamIds: ["email"] }
  });
  assert.equal(teamManagerAccount.response.status, 201);
  const leadershipAccount = await request("/api/users", {
    method: "POST", cookie: adminCookie,
    body: { username: "leadership.reader", name: "Leadership Reader", password: "leadership-secure-123", role: "leadership", teamIds: [] }
  });
  assert.equal(leadershipAccount.response.status, 201);
  const teamManagerLogin = await request("/api/auth/login", {
    method: "POST", body: { username: "email.manager", password: "team-manager-secure-123" }
  });
  assert.equal(teamManagerLogin.response.status, 200);
  const teamManagerSnapshot = await request("/api/data", { cookie: teamManagerLogin.cookie });
  assert.equal(teamManagerSnapshot.payload.roleCapabilities.viewManagerReports, true);
  assert.equal(teamManagerSnapshot.payload.roleCapabilities.manageWorkspace, false);
  assert.ok(teamManagerSnapshot.payload.workfrontProjects.length > 0);
  assert.ok(teamManagerSnapshot.payload.workfrontProjects.every((item) => item.productionTeamId === "email"));
  assert.ok(teamManagerSnapshot.payload.workfrontChangeRounds.every((item) => item.productionTeamId === "email"));
  const teamManagerCrossDepartment = await request("/api/workfront/WF-QA-1/suggestions", {
    method: "POST", cookie: teamManagerLogin.cookie, body: {}
  });
  assert.equal(teamManagerCrossDepartment.response.status, 403);
  const leadershipLogin = await request("/api/auth/login", {
    method: "POST", body: { username: "leadership.reader", password: "leadership-secure-123" }
  });
  assert.equal(leadershipLogin.response.status, 200);
  const leadershipSnapshot = await request("/api/data", { cookie: leadershipLogin.cookie });
  assert.equal(leadershipSnapshot.payload.roleCapabilities.viewManagerReports, true);
  assert.equal(leadershipSnapshot.payload.roleCapabilities.manageProjects, false);
  assert.equal(leadershipSnapshot.payload.workfrontProjects.length, 17);
  const leadershipCannotCreateProject = await request("/api/projects", {
    method: "POST", cookie: leadershipLogin.cookie,
    body: { ref: "READ-ONLY", title: "Should not create", taskType: "Email", status: "Not Started" }
  });
  assert.equal(leadershipCannotCreateProject.response.status, 403);
  const blockedPreAudit = await request("/api/audits", {
    method: "POST", cookie: adminCookie,
    body: {
      auditType: "Pre-Audit", workfrontId: "WF-STATUS-PRE-DONE", projectRef: "WF-STATUS-PRE-DONE",
      projectName: "Pre-Audit Complete project", channel: "Email", requestType: "Localization",
      complexity: "Medium", pageCount: 1, startDate: "2026-10-06", startTime: "12:30",
      etaDate: "2026-10-06", etaTime: "13:30", auditStatus: "Pass", sourceFile: "Available", priority: "Normal"
    }
  });
  assert.equal(blockedPreAudit.response.status, 409);
  const preAuditStatusPass = await request("/api/audits", {
    method: "POST", cookie: adminCookie,
    body: {
      auditType: "Pre-Audit", workfrontId: "WF-STATUS-PRE", projectRef: "WF-STATUS-PRE",
      projectName: "Pre-Audit source status project", channel: "Email", requestType: "Localization",
      complexity: "Medium", pageCount: 1, startDate: "2026-10-06", startTime: "12:30",
      etaDate: "2026-10-06", etaTime: "13:30", auditStatus: "Pass", sourceFile: "Available", priority: "Normal"
    }
  });
  assert.equal(preAuditStatusPass.response.status, 201, JSON.stringify(preAuditStatusPass.payload));
  assert.equal((await request("/api/data", { cookie: adminCookie })).payload.workfrontProjects.find((item) => item.workfrontId === "WF-STATUS-PRE").productionStage, "Pre-Audit Complete");
  const preAuditAllocation = await request("/api/workfront/WF-STATUS-PRE/allocate", {
    method: "POST", cookie: adminCookie, body: { assignee: "Om Rathore", plannedStartDate: "2026-11-02", startTime: "12:30" }
  });
  assert.equal(preAuditAllocation.response.status, 409);
  const unchangedPreAuditSync = await request("/api/workfront/sync", {
    method: "POST", cookie: adminCookie,
    body: { openProjects: openReport, changeRounds: changeReport }
  });
  assert.equal(unchangedPreAuditSync.response.status, 200);
  assert.equal((await request("/api/data", { cookie: adminCookie })).payload.workfrontProjects.find((item) => item.workfrontId === "WF-STATUS-PRE").productionStage, "Pre-Audit Complete");
  const clarifiedRows = openRows.map((row) => [...row]);
  clarifiedRows.find((row) => row[0] === "WF-STATUS-PRE")[2] = "Current";
  const clarifiedSync = await request("/api/workfront/sync", {
    method: "POST", cookie: adminCookie,
    body: { openProjects: xlsxUpload("all-open-projects.xlsx", "Open Projects", openHeaders, clarifiedRows), changeRounds: changeReport }
  });
  assert.equal(clarifiedSync.response.status, 200);
  const clarifiedProject = (await request("/api/data", { cookie: adminCookie })).payload.workfrontProjects.find((item) => item.workfrontId === "WF-STATUS-PRE");
  assert.equal(clarifiedProject.sourceStatus, "Current");
  assert.equal(clarifiedProject.productionStage, "Awaiting Audit");
  const currentAssetAudit = await request("/api/audits", {
    method: "POST", cookie: adminCookie,
    body: {
      auditType: "Audit", workfrontId: "WF-STATUS-PRE", projectRef: "WF-STATUS-PRE",
      projectName: "Current asset project", channel: "Email", requestType: "Localization",
      complexity: "Medium", pageCount: 1, startDate: "2026-10-06", startTime: "12:30",
      etaDate: "2026-10-06", etaTime: "13:30", auditStatus: "Pending", sourceFile: "Available", priority: "Normal"
    }
  });
  assert.equal(currentAssetAudit.response.status, 201, JSON.stringify(currentAssetAudit.payload));
  const finalAudit = await request("/api/audits", {
    method: "POST", cookie: adminCookie,
    body: {
      auditType: "Audit", workfrontId: "WF-STATUS-AUDIT", projectRef: "WF-STATUS-AUDIT",
      projectName: "Audit Ongoing project", channel: "Email", requestType: "Localization",
      complexity: "Medium", pageCount: 1, startDate: "2026-10-06", startTime: "12:30",
      etaDate: "2026-10-06", etaTime: "13:30", auditStatus: "Pass", sourceFile: "Available", priority: "Normal"
    }
  });
  assert.equal(finalAudit.response.status, 201, JSON.stringify(finalAudit.payload));
  assert.equal((await request("/api/data", { cookie: adminCookie })).payload.workfrontProjects.find((item) => item.workfrontId === "WF-STATUS-AUDIT").productionStage, "Complete");
  const preAudit = await request("/api/audits", {
    method: "POST", cookie: adminCookie,
    body: {
      auditType: "Pre-Audit", workfrontId: "WF-NEW-1", projectRef: "WF-NEW-1",
      projectName: "New Workfront email project", channel: "Email", requestType: "New Build",
      complexity: "Simple", pageCount: 3, startDate: "2026-10-05", startTime: "12:30",
      etaDate: "2026-10-06", etaTime: "12:30", auditStatus: "Pass", sourceFile: "Available", priority: "Normal"
    }
  });
  assert.equal(preAudit.response.status, 201, JSON.stringify(preAudit.payload));
  assert.equal((await request("/api/data", { cookie: adminCookie })).payload.workfrontProjects.find((item) => item.workfrontId === "WF-NEW-1").productionStage, "Awaiting Execution");
  const wfSuggestions = await request("/api/workfront/WF-NEW-1/suggestions", { method: "POST", cookie: adminCookie, body: {} });
  assert.equal(wfSuggestions.response.status, 200);
  assert.ok(wfSuggestions.payload.resources.length > 0);
  const wfAllocation = await request("/api/workfront/WF-NEW-1/allocate", {
    method: "POST", cookie: adminCookie,
    body: { assignee: "Om Rathore", plannedStartDate: "2026-11-02", startTime: "12:30" }
  });
  assert.equal(wfAllocation.response.status, 201, JSON.stringify(wfAllocation.payload));
  assert.equal(wfAllocation.payload.project.workfrontId, "WF-NEW-1");
  assert.equal(wfAllocation.payload.task.startTime, "12:30");
  assert.equal(wfAllocation.payload.productionStage, "Execution in progress");
  const allocatedPriorities = (await request("/api/data", { cookie: adminCookie })).payload;
  assert.equal(allocatedPriorities.projects.find((item) => item.id === wfAllocation.payload.project.id).projectPriority, "Urgent");
  assert.equal(allocatedPriorities.tasks.find((item) => item.id === wfAllocation.payload.task.id).projectPriority, "Urgent");
  const wfBuildLog = await request("/api/worklogs", {
    method: "POST", cookie: adminCookie,
    body: { projectId: wfAllocation.payload.project.id, taskId: wfAllocation.payload.task.id, date: "2026-11-02", hours: 3, phase: "Build", progress: 100, status: "Completed" }
  });
  assert.equal(wfBuildLog.response.status, 201);
  assert.equal((await request("/api/data", { cookie: adminCookie })).payload.workfrontProjects.find((item) => item.workfrontId === "WF-NEW-1").productionStage, "In QC");
  const blockedStatusRows = openRows.map((row) => [...row]);
  blockedStatusRows[1][2] = "On Hold";
  const blockedStatusSync = await request("/api/workfront/sync", {
    method: "POST", cookie: adminCookie,
    body: {
      openProjects: xlsxUpload("all-open-projects.xlsx", "Open Projects", openHeaders, blockedStatusRows),
      changeRounds: changeReport
    }
  });
  assert.equal(blockedStatusSync.response.status, 200);
  assert.equal((await request("/api/data", { cookie: adminCookie })).payload.workfrontProjects.find((item) => item.workfrontId === "WF-NEW-1").productionStage, "In QC");
  const blockedQc = await request("/api/workfront/WF-NEW-1/qc-complete", { method: "POST", cookie: adminCookie, body: {} });
  assert.equal(blockedQc.response.status, 409);
  const blockedRework = await request("/api/workfront/WF-NEW-1/rework", {
    method: "POST", cookie: adminCookie,
    body: { category: "Bug Fixing", bugScope: "Build", complexity: "Low", assignee: "Kriti Grover" }
  });
  assert.equal(blockedRework.response.status, 409);
  const restoredStatusRows = blockedStatusRows.map((row) => [...row]);
  restoredStatusRows[1][2] = "Current";
  const restoredStatusSync = await request("/api/workfront/sync", {
    method: "POST", cookie: adminCookie,
    body: {
      openProjects: xlsxUpload("all-open-projects.xlsx", "Open Projects", openHeaders, restoredStatusRows),
      changeRounds: changeReport
    }
  });
  assert.equal(restoredStatusSync.response.status, 200);
  const wfQc = await request("/api/workfront/WF-NEW-1/qc-complete", { method: "POST", cookie: adminCookie, body: {} });
  assert.equal(wfQc.response.status, 200);
  assert.equal(wfQc.payload.productionStage, "Complete");
  const wfRework = await request("/api/workfront/WF-NEW-1/rework", {
    method: "POST", cookie: auditorLogin.cookie,
    body: { category: "Bug Fixing", bugScope: "Build", complexity: "Low", assignee: "Kriti Grover", startDate: "2026-11-03", startTime: "12:30", observations: "QA found a broken footer link." }
  });
  assert.equal(wfRework.response.status, 201, `${JSON.stringify(wfRework.payload)}\n${output}`);
  assert.equal(wfRework.payload.task.observations, "QA found a broken footer link.");
  assert.equal(wfRework.payload.productionStage, "Execution in progress");
  const wfReworkLog = await request("/api/worklogs", {
    method: "POST", cookie: adminCookie,
    body: { projectId: wfAllocation.payload.project.id, taskId: wfRework.payload.task.id, date: "2026-11-03", hours: 1, phase: "Bug Fixing", progress: 100, status: "Completed" }
  });
  assert.equal(wfReworkLog.response.status, 201);
  assert.equal((await request("/api/workfront/WF-NEW-1/qc-complete", { method: "POST", cookie: auditorLogin.cookie, body: {} })).response.status, 200);
  assert.equal((await request("/api/data", { cookie: adminCookie })).payload.workfrontProjects.find((item) => item.workfrontId === "WF-NEW-1").productionStage, "Complete");
  const refreshedOpenRows = openRows.map((row) => [...row]);
  refreshedOpenRows[1][1] = "Updated Workfront project title";
  refreshedOpenRows[1][openHeaders.indexOf("Priority")] = "High";
  const repeatSync = await request("/api/workfront/sync", {
    method: "POST", cookie: adminCookie,
    body: {
      openProjects: xlsxUpload("all-open-projects.xlsx", "Open Projects", openHeaders, refreshedOpenRows),
      changeRounds: changeReport
    }
  });
  assert.equal(repeatSync.response.status, 200);
  assert.equal(repeatSync.payload.projects.added, 0);
  assert.equal(repeatSync.payload.projects.updated, 17);
  assert.equal(repeatSync.payload.projects.alreadyInWorkspace, 1);
  assert.equal(repeatSync.payload.changeRounds.added, 0);
  assert.equal(repeatSync.payload.changeRounds.updated, 11);
  assert.equal(repeatSync.payload.changeRounds.alreadyInWorkspace, 1);
  const afterRepeatWorkfront = await request("/api/data", { cookie: adminCookie });
  assert.equal(afterRepeatWorkfront.payload.workfrontProjects.length, 17);
  assert.equal(afterRepeatWorkfront.payload.workfrontProjects[0].title, "Updated Workfront project title");
  assert.equal(afterRepeatWorkfront.payload.workfrontChangeRounds.length, 11);
  assert.equal(afterRepeatWorkfront.payload.workfrontProjects[0].priority, "High");
  assert.equal(afterRepeatWorkfront.payload.projects.find((item) => item.id === wfAllocation.payload.project.id).projectPriority, "High");

  const unauthenticated = await request("/api/data");
  assert.equal(unauthenticated.response.status, 401);

  await stopServer();
  const savedData = readSavedData();
  savedData.workfrontTasks = [{
    id: "task-row-test",
    workfrontId: "WF-TASK-TEST",
    projectRef: "WF-NEW-1",
    projectName: "New Workfront email project",
    taskName: "Build",
    taskStatus: "In Progress",
    assignees: "Other Workfront Person",
    assetType: "Campaign",
    workfrontTeam: "Design Team",
    productionTeamId: "design",
    qaQueue: false,
    plannedStartDate: "2026-11-03",
    plannedCompletionDate: "2026-11-11",
    deliveryCentre: "PRD WPP Production",
    percentComplete: 80
  }];
  writeSavedData(savedData);
  output = "";
  await startServer();
  const persistedLogin = await request("/api/auth/login", {
    method: "POST", body: { username: "workspace.admin", password: "secure-password-123" }
  });
  assert.equal(persistedLogin.response.status, 200);
  const afterRestart = await request("/api/data", { cookie: persistedLogin.cookie });
  assert.equal(afterRestart.payload.projects.length, 4);
  assert.equal(afterRestart.payload.audits.length, 5);
  assert.ok(afterRestart.payload.audits.some((audit) => audit.workfrontId === "WF-STATUS-PRE"));
  assert.equal(afterRestart.payload.workLogs.length, 4);
  assert.equal(afterRestart.payload.changeRounds.length, 6);
  assert.equal(afterRestart.payload.workfrontProjects.length, 17);
  assert.equal(afterRestart.payload.workfrontChangeRounds.length, 11);
  assert.equal(afterRestart.payload.workfrontProjects[0].title, "Updated Workfront project title");
  const persistedTask = afterRestart.payload.workfrontTasks.find((task) => task.workfrontId === "WF-TASK-TEST");
  assert.equal(persistedTask.taskStatus, "In Progress");
  assert.equal(persistedTask.projectPriority, "High");
  assert.equal(persistedTask.percentComplete, 80);
  assert.equal(persistedTask.workfrontTeam, "Email Team");
  assert.equal(persistedTask.productionTeamId, "email");
  assert.equal(persistedTask.projectStatus, afterRestart.payload.workfrontProjects.find((project) => project.ref === "WF-NEW-1").sourceStatus);
  assert.equal(afterRestart.payload.aht.validationMatrix.records.find((row) => row.rowNumber === 3).designerMinutes, 36);
  assert.equal(afterRestart.payload.leaves.length, 3);
  const teamManagerAfterRestart = await request("/api/auth/login", {
    method: "POST", body: { username: "email.manager", password: "team-manager-secure-123" }
  });
  const scopedTaskSnapshot = await request("/api/data", { cookie: teamManagerAfterRestart.cookie });
  assert.deepEqual(scopedTaskSnapshot.payload.workfrontTasks.map((task) => task.workfrontId), ["WF-TASK-TEST"]);
  const linkedCrTask = await request("/api/tasks", {
    method: "POST", cookie: persistedLogin.cookie,
    body: { projectId: project.payload.id, category: "CR", crId: "CR-WF-ASSIGN-TEST", complexity: "Medium", units: 1, assignee: "Om Rathore" }
  });
  assert.equal(linkedCrTask.response.status, 201, JSON.stringify(linkedCrTask.payload));
  assert.equal(linkedCrTask.payload.changeRound.crId, "CR-WF-ASSIGN-TEST");
  assert.equal(linkedCrTask.payload.changeRound.taskId, linkedCrTask.payload.task.id);
  const duplicateLinkedCrTask = await request("/api/tasks", {
    method: "POST", cookie: persistedLogin.cookie,
    body: { projectId: project.payload.id, category: "CR", crId: "CR-WF-ASSIGN-TEST", complexity: "Medium", units: 1, assignee: "Om Rathore" }
  });
  assert.equal(duplicateLinkedCrTask.response.status, 409);
  const removeLeave = await request(`/api/leaves/${teamLeave.payload.leave.id}`, {
    method: "DELETE", cookie: persistedLogin.cookie
  });
  assert.equal(removeLeave.response.status, 200);
  const removeAuditorLeave = await request(`/api/leaves/${auditorLeave.payload.leave.id}`, {
    method: "DELETE", cookie: persistedLogin.cookie
  });
  assert.equal(removeAuditorLeave.response.status, 200);
  assert.equal(afterRestart.payload.holidays[0].date, "2026-10-08");

  await stopServer();
  const legacyData = readSavedData();
  delete legacyData.marketMatrix;
  delete legacyData.holidays;
  delete legacyData.leaves;
  delete legacyData.changeRounds;
  legacyData.users.find((user) => user.username === "designer.one").role = "member";
  delete legacyData.team.find((member) => member.name === "Om Rathore").shiftEnd;
  delete legacyData.audits.find((audit) => audit.auditType === "Audit" && audit.documents?.length).documents;
  legacyData.workfrontProjects.find((item) => item.sourceStatus === "Audit Ongoing").productionStage = "Awaiting triage";
  legacyData.workfrontProjects.find((item) => item.sourceStatus === "Current").productionStage = "Pre-Audit";
  legacyData.workfrontProjects.push(
    { workfrontId: "BANNER-HTML", ref: "BANNER-HTML", title: "Austria_Banner_HTML5_resize_PRD", sourceStatus: "New", assetType: "Banner", channel: "Banner", workfrontTeam: "Design Team", productionTeamId: "design", deliveryCentre: "PRD WPP Production" },
    { workfrontId: "BANNER-GIF", ref: "BANNER-GIF", title: "Obesity Week_Banner_Animation_PRD", sourceStatus: "New", assetType: "Banner", channel: "Banner", workfrontTeam: "Design Team", productionTeamId: "design", deliveryCentre: "PRD WPP Production" },
    { workfrontId: "BANNER-STATIC", ref: "BANNER-STATIC", title: "Finland_Vabysmo banner_PRD", sourceStatus: "New", assetType: "Banner", channel: "Banner", workfrontTeam: "Web Team", productionTeamId: "web", deliveryCentre: "PRD WPP Production" }
  );
  writeSavedData(legacyData);
  output = "";
  await startServer();
  const migratedLogin = await request("/api/auth/login", {
    method: "POST", body: { username: "workspace.admin", password: "secure-password-123" }
  });
  const migrated = await request("/api/data", { cookie: migratedLogin.cookie });
  assert.equal(migrated.payload.marketMatrix.length, 74);
  assert.equal(migrated.payload.holidays.length, 12);
  assert.deepEqual(migrated.payload.changeRounds, []);
  assert.equal(migrated.payload.projects.length, 4);
  assert.equal(migrated.payload.workLogs.length, 4);
  assert.deepEqual(migrated.payload.leaves, []);
  assert.equal(migrated.payload.audits.length, 5);
  assert.ok(migrated.payload.audits.some((audit) => audit.workfrontId === "WF-STATUS-PRE"));
  assert.equal(migrated.payload.workfrontProjects.find((item) => item.sourceStatus === "Audit Ongoing").productionStage, "Audit");
  assert.equal(migrated.payload.workfrontProjects.find((item) => item.sourceStatus === "Current").productionStage, "Awaiting Audit");
  assert.equal(migrated.payload.users.find((user) => user.username === "designer.one").role, "executioner");
  assert.deepEqual(["BANNER-HTML", "BANNER-GIF", "BANNER-STATIC"].map((ref) => migrated.payload.workfrontProjects.find((item) => item.ref === ref)?.productionTeamId), ["web", "video", "design"]);
  assert.ok(migrated.payload.audits.some((audit) => audit.documents.length === 1));

  const shiftMember = migrated.payload.team.find((member) => member.name === "Om Rathore");
  assert.equal(shiftMember.shiftEnd, "21:30", "legacy shift ends must be preserved");
  const beforeShift = await request("/api/data", { cookie: migratedLogin.cookie });
  const invalidShift = await request(`/api/team/${shiftMember.id}/shift`, {
    method: "PUT", cookie: migratedLogin.cookie, body: { shiftStart: "12:30", shiftEnd: "20:30" }
  });
  assert.equal(invalidShift.response.status, 400);
  const shiftUpdate = await request(`/api/team/${shiftMember.id}/shift`, {
    method: "PUT", cookie: migratedLogin.cookie, body: { shiftStart: "11:30", shiftEnd: "20:30" }
  });
  assert.equal(shiftUpdate.response.status, 200);
  assert.equal(shiftUpdate.payload.shiftStart, "11:30");
  assert.equal(shiftUpdate.payload.shiftEnd, "20:30");
  const afterShift = await request("/api/data", { cookie: migratedLogin.cookie });
  const updatedTasks = afterShift.payload.tasks.filter((task) => task.assignee === shiftMember.name && task.progress === 0 && !["Completed", "Archived"].includes(task.status));
  assert.ok(updatedTasks.length > 0);
  for (const task of updatedTasks) {
    assert.equal(task.startTime, "11:30");
    assert.ok(task.capacityEtaTime >= "11:30" && task.capacityEtaTime <= "20:30");
    const parent = afterShift.payload.projects.find((item) => item.id === task.projectId);
    if (task.category === "Build") assert.equal(parent.plannedStartTime, "11:30");
  }
  for (const task of beforeShift.payload.tasks.filter((item) => ["Completed", "Archived"].includes(item.status) || item.assignee !== shiftMember.name)) {
    assert.deepEqual(afterShift.payload.tasks.find((item) => item.id === task.id), task);
  }
  assert.deepEqual(afterShift.payload.workfrontTasks, beforeShift.payload.workfrontTasks);
  const lateShiftTask = await request("/api/tasks", {
    method: "POST", cookie: migratedLogin.cookie,
    body: {
      projectId: project.payload.id, category: "Bug Fixing", bugScope: "Build", complexity: "Low",
      units: 1, assignee: shiftMember.name, productionHours: 6, startDate: "2027-01-05", startTime: "19:30"
    }
  });
  assert.equal(lateShiftTask.response.status, 201, JSON.stringify(lateShiftTask.payload));
  assert.equal(lateShiftTask.payload.task.plannedHours, 7.83);
  assert.equal(lateShiftTask.payload.task.capacityEtaDate, "2027-01-06");
  assert.equal(lateShiftTask.payload.task.capacityEtaTime, "18:20");
  const outsideShift = await request(`/api/tasks/${lateShiftTask.payload.task.id}`, {
    method: "PUT", cookie: migratedLogin.cookie, body: { startTime: "20:45" }
  });
  assert.equal(outsideShift.response.status, 400);
  assert.match(outsideShift.payload.error, /11:30–20:30/);
  const outsideShiftEta = await request(`/api/tasks/${lateShiftTask.payload.task.id}`, {
    method: "PUT", cookie: migratedLogin.cookie,
    body: { etaOverride: true, etaDate: "2027-01-07", etaTime: "21:00" }
  });
  assert.equal(outsideShiftEta.response.status, 400);
  const savedShift = readSavedData().team.find((member) => member.id === shiftMember.id);
  assert.equal(savedShift.shiftEnd, "20:30");
  const capacityMember = await request("/api/team", {
    method: "POST", cookie: migratedLogin.cookie, body: { name: "Capacity Tester" }
  });
  assert.equal(capacityMember.response.status, 201);
  assert.equal((await request(`/api/team/${capacityMember.payload.id}/departments`, {
    method: "PUT", cookie: migratedLogin.cookie, body: { teamIds: ["email"] }
  })).response.status, 200);
  const overlapProject = await request("/api/projects", {
    method: "POST", cookie: migratedLogin.cookie,
    body: {
      ref: "CAPACITY-OVERLAP", title: "Existing Build capacity", assignee: "Capacity Tester",
      productionTeamId: "email", channel: "Email", taskType: "Email", workfrontRequestType: "New Build", requestType: "Standard",
      pages: 1, complexity: 1, progress: 0, status: "Not Started",
      dueDate: "2030-01-31", tatDate: "2030-01-31"
    }
  });
  assert.equal(overlapProject.response.status, 201);
  const overlapBuild = await request(`/api/tasks/${overlapProject.payload.buildTaskId}`, {
    method: "PUT", cookie: migratedLogin.cookie, body: { productionHours: 61.75 }
  });
  assert.equal(overlapBuild.response.status, 200);
  assert.equal(overlapBuild.payload.plannedHours, 64);
  const overlapEstimate = await request("/api/audit-capacity-estimate", {
    method: "POST", cookie: migratedLogin.cookie,
    body: { ...capacityInput, projectRef: "CAPACITY-OVERLAP" }
  });
  assert.equal(overlapEstimate.response.status, 200);
  const overlapResource = overlapEstimate.payload.candidates.find((member) => member.name === "Capacity Tester");
  assert.equal(overlapResource.backlogHours, 64);
  assert.equal(overlapResource.tentativeDate, "2030-01-16");
  assert.equal(overlapResource.tentativeTime, "19:30");

  await stopServer();
  const opsData = readSavedData();
  opsData.workfrontProjects.push({ id: "ops-project", workfrontId: "OPS-P1", ref: "OPS-P1", title: "Ops source project",
    assetType: "Email", channel: "Email", requestType: "New Build", complexity: "Simple", pages: 1,
    country: "Test Market", projectOwner: "Workfront DPM",
    productionTeamId: "email", sourceStatus: "Execution in Progress", dueDate: "2026-10-14", materialExpectedDate: "2026-10-12" });
  opsData.workfrontTasks.push({ id: "ops-task", workfrontId: "OPS-T1", projectRef: "OPS-P1", projectName: "Ops source project",
    taskName: "Build", taskStatus: "In Progress", productionTeamId: "email", assignmentNames: ["Designer One"],
    assignees: "Designer One", plannedHours: 8, actualHours: 0, percentComplete: 0, detailSyncedAt: "2026-10-12T10:00:00Z",
    plannedStartDate: "2026-10-12", plannedCompletionDate: "2026-10-14", deliveryCentre: "PRD WPP Production" });
  const sourceTaskBase = opsData.workfrontTasks.at(-1);
  opsData.workfrontTasks.push(
    { ...sourceTaskBase, id: "ops-reversed", workfrontId: "OPS-T2", assignmentNames: [], assignees: "One Designer, Role / team; ROC | Developer, Role / team" },
    { ...sourceTaskBase, id: "ops-alias", workfrontId: "OPS-T3", assignmentNames: [], assignees: "D.One.do7, Role / team" },
    { ...sourceTaskBase, id: "ops-bug-default", workfrontId: "OPS-BUG-DEFAULT", taskName: "Bug Fixing", assignmentNames: [], assignees: "ROC | Developer, Role / team" },
    { ...sourceTaskBase, id: "ops-bug-named", workfrontId: "OPS-BUG-NAMED", taskName: "Bug Fixing" },
    { ...sourceTaskBase, id: "ops-review", workfrontId: "OPS-REVIEW", taskName: "Engagement Lead Review" }
  );
  opsData.workfrontChangeRounds.push({ workfrontId: "OPS-CR", projectRef: "OPS-P1", crId: "CR1", title: "Own CR",
    productionTeamId: "email", assignee: "Designer One", sourceStatus: "Assigned to Execution", expectedDeliveryDate: "2026-10-21" });
  const pendingAuditRound = { workfrontId: "OPS-AUDIT-CR", projectRef: "OPS-P1", crId: "CR2", title: "Pending CR audit",
    productionTeamId: "email", assignee: "Workspace Admin", sourceStatus: "New" };
  opsData.workfrontChangeRounds.push(pendingAuditRound,
    { ...pendingAuditRound, workfrontId: "OPS-COMPACT-CR", crId: "CR5" },
    { ...pendingAuditRound, workfrontId: "OPS-UI-CR", crId: "CR6" },
    { ...pendingAuditRound, workfrontId: "OPS-ACCEPTED-CR", crId: "CR3", acceptanceDate: "2026-10-20" },
    { ...pendingAuditRound, workfrontId: "OPS-COMPLETED-CR", crId: "CR4", completionDate: "2026-10-20" });
  for (const assetType of ["iPDF", "PPT/Gslide"]) {
    const ref = assetType === "iPDF" ? "EST-IPDF" : "EST-PPT";
    opsData.workfrontProjects.push({ ...opsData.workfrontProjects.at(-1), ref, workfrontId: ref, assetType, productionTeamId: "design", pages: 5, complexity: "Medium" });
    opsData.workfrontTasks.push({ ...sourceTaskBase, id: ref, workfrontId: ref, projectRef: ref, assetType, productionTeamId: "design", assignmentNames: [], assignees: "" });
  }
  opsData.users.find((account) => account.username === "designer.one").teamIds = ["email", "design"];
  opsData.team.find((member) => member.name === "Designer One").teamIds = ["email", "design"];
  opsData.workfrontProjects.push({ ...opsData.workfrontProjects[opsData.workfrontProjects.length - 1], ref: "CHECK-P", workfrontId: "CHECK-P",
    title: "iPDF checklist project", assetType: "iPDF", channel: "iPDF", productionTeamId: "design" });
  opsData.workfrontProjects.push({ ref: "HIST-P", workfrontId: "HIST-P", title: "October historical delivery", productionTeamId: "design",
    workfrontUrl: `https://laroche.my.workfront.adobe.com/project/${"c".repeat(32)}/overview`,
    assetType: "Print", channel: "Print", executorName: "Designer One", sourceStatus: "Complete", dueDate: "2026-10-03",
    actualStartDate: "2026-10-01", actualCompletionDate: "2026-10-03" });
  opsData.workfrontTasks.push({ ...sourceTaskBase, id: "check-task", workfrontId: "CHECK-T", projectRef: "CHECK-P", assetType: "iPDF",
    productionTeamId: "design", entryDate: "2026-10-01" });
  opsData.workfrontTasks.push({ ...sourceTaskBase, id: "audit-task", workfrontId: "AUDIT-T", projectRef: "CHECK-P", assetType: "iPDF",
    productionTeamId: "design", taskName: "Asset Audit", assignmentNames: ["Auditor One"], assignees: "Auditor One",
    taskStatus: "Complete", actualCompletionDate: "2026-10-04", entryDate: "2026-10-01" });
  opsData.users.find((account) => account.username === "auditor.one").teamIds = ["qa"];
  opsData.team.find((member) => member.name === "Auditor One").teamIds = ["qa"];
  opsData.assignmentState = {};
  writeSavedData(opsData);
  await startServer();
  const sourceLogin = await request("/api/auth/login", {
    method: "POST", body: { username: "designer.one", password: "another-secure-123" }
  });
  assert.equal(sourceLogin.response.status, 200);
  const sourceSnapshot = await request("/api/data", { cookie: sourceLogin.cookie });
  assert.ok(sourceSnapshot.payload.workfrontTasks.some((task) => task.workfrontId === "OPS-T1"));
  assert.ok(sourceSnapshot.payload.workfrontProjects.some((project) => project.ref === "OPS-P1"));
  assert.ok(sourceSnapshot.payload.workfrontTasks.every((task) => task.assignmentNames.includes("Designer One")));
  assert.ok(sourceSnapshot.payload.workfrontTasks.some((task) => task.workfrontId === "OPS-T2"), "reversed Workfront name maps to roster member");
  assert.ok(sourceSnapshot.payload.execution.deliveries.some((row) => row.key === "cr:OPS-CR"));
  assert.ok(sourceSnapshot.payload.execution.deliveries.every((row) => row.names.includes("Designer One")));
  assert.equal(sourceSnapshot.payload.workfrontTasks.some((task) => task.workfrontId === "OPS-BUG-DEFAULT"), false);
  assert.equal(sourceSnapshot.payload.workfrontTasks.some((task) => task.workfrontId === "OPS-REVIEW"), false);
  assert.equal(sourceSnapshot.payload.roleCapabilities.viewHygiene, false);
  assert.equal(sourceSnapshot.payload.workfrontTasks.some((task) => task.workfrontId === "OPS-T3"), false);
  const mappingManager = await request("/api/auth/login", { method: "POST", body: { username: "workspace.admin", password: "secure-password-123" } });
  const mappingSnapshot = await request("/api/data", { cookie: mappingManager.cookie });
  assert.equal(mappingSnapshot.payload.workfrontTasks.some((task) => task.workfrontId === "OPS-BUG-DEFAULT"), false);
  assert.ok(mappingSnapshot.payload.workfrontGanttTasks.some((task) => task.workfrontId === "OPS-BUG-DEFAULT"),
    "role-only Bug Fixing remains available for the Gantt without changing other task views");
  const manualInput = { projectRef: "OPS-P1", note: "Reviewed Workfront against brief: 1 page, Simple complexity, New Build.",
    checks: ["Page count", "Complexity", "Request type"].map((rule) => ({ rule, status: "Manually verified" })) };
  assert.equal((await request("/api/hygiene-verifications", { method: "POST", cookie: sourceLogin.cookie, body: manualInput })).response.status, 403);
  assert.equal((await request("/api/hygiene-verifications", { method: "POST", cookie: mappingManager.cookie, body: manualInput })).response.status, 201);
  const manualReport = await request("/api/data", { cookie: mappingManager.cookie });
  assert.equal(manualReport.payload.hygiene.find((row) => row.ref === "OPS-P1").checks.find((check) => check.rule === "Page count").status, "Manually verified");
  const auditClock = { action: "start", projectRef: "OPS-P1", crId: "CR5" };
  assert.equal((await request("/api/audit-sessions", { method: "POST", cookie: sourceLogin.cookie, body: auditClock })).response.status, 403);
  assert.equal((await request("/api/audit-sessions", { method: "POST", cookie: mappingManager.cookie, body: auditClock })).response.status, 200);
  assert.equal((await request("/api/audit-sessions", { method: "POST", cookie: mappingManager.cookie, body: auditClock })).response.status, 409);
  assert.equal((await request("/api/audit-sessions", { method: "POST", cookie: mappingManager.cookie, body: { ...auditClock, action: "hold" } })).response.status, 200);
  assert.equal((await request("/api/audit-sessions", { method: "POST", cookie: mappingManager.cookie, body: auditClock })).response.status, 200);
  const compact = await request("/api/cr-audits", { method: "POST", cookie: mappingManager.cookie,
    body: { roundId: "OPS-COMPACT-CR", complexity: "Complex", startDate: "2026-10-23", note: "Higher complexity CR" } });
  assert.equal(compact.response.status, 201, JSON.stringify(compact.payload));
  assert.equal(compact.payload.tatDays, 3);
  assert.equal(compact.payload.etaDate, "2026-10-28");
  assert.ok(compact.payload.startedAt && compact.payload.endedAt && compact.payload.elapsedMs > 0);
  const auditClockData = (await request("/api/data", { cookie: mappingManager.cookie })).payload;
  assert.equal(auditClockData.auditSessions.find((session) => session.crId === "CR5").state, "stopped");
  assert.ok(auditClockData.operationsWorkspace.productiveLogs.some((log) => log.sessionId === compact.payload.sessionId && log.hours > 0));
  assert.equal(auditClockData.hygiene.find((row) => row.ref === "OPS-P1").checks.find((check) => check.rule === "CR complexity · CR5").status, "Action required");
  assert.equal((await request("/api/cr-audits", { method: "POST", cookie: mappingManager.cookie,
    body: { roundId: "OPS-COMPACT-CR", complexity: "Complex", startDate: "2026-10-23" } })).response.status, 409);
  assert.ok(readSavedData().auditSessions.some((session) => session.auditId === compact.payload.id), "audit clock persists");
  assert.equal(mappingSnapshot.payload.workfrontTasks.find((task) => task.workfrontId === "EST-PPT").ahtHours,
    mappingSnapshot.payload.workfrontTasks.find((task) => task.workfrontId === "EST-IPDF").ahtHours);
  assert.ok(mappingSnapshot.payload.workfrontTasks.find((task) => task.workfrontId === "EST-PPT").ahtHours > 0);
  const estimatedRound = mappingSnapshot.payload.workfrontChangeRounds.find((round) => round.workfrontId === "OPS-CR");
  assert.ok(estimatedRound.ahtHours > 0);
  assert.ok(estimatedRound.qaAhtHours > 0, "CR Gantt receives supplied QA AHT for its effort fill");
  assert.ok(mappingSnapshot.payload.unmappedWorkfrontAssignees.includes("D.One.do7"));
  const crAuditInput = { projectRef: "OPS-P1", workfrontId: "OPS-P1", crId: "CR2",
    auditType: "Audit", auditStatus: "Pass", priority: "Normal", sourceFile: "Available",
    channel: "Email", requestType: "New Build", complexity: "Simple", pageCount: 1,
    startDate: "2026-10-20", startTime: "12:30", etaDate: "2026-10-21", etaTime: "12:30" };
  const crAudit = await request("/api/audits", { method: "POST", cookie: mappingManager.cookie, body: crAuditInput });
  assert.equal(crAudit.response.status, 201, JSON.stringify(crAudit.payload));
  assert.equal(crAudit.payload.crId, "CR2");
  assert.equal((await request("/api/data", { cookie: mappingManager.cookie })).payload.workfrontProjects.find((item) => item.ref === "OPS-P1").sourceStatus, "Execution in Progress");
  for (const crId of ["CR1", "CR3", "CR4", "CR99"]) {
    assert.equal((await request("/api/audits", { method: "POST", cookie: mappingManager.cookie, body: { ...crAuditInput, crId } })).response.status, 409);
  }
  const designerMember = mappingSnapshot.payload.team.find((member) => member.name === "Designer One");
  const emailPath = `/api/team/${designerMember.id}/wpp-email`;
  const emailBody = { wppProductionEmail: "designer.one@wppproduction.com" };
  assert.equal((await request(emailPath, { method: "PUT", cookie: sourceLogin.cookie, body: emailBody })).response.status, 403);
  for (const invalid of ["designer@example.com", "a@wppproduction.com,b@wppproduction.com", "a\r\n@wppproduction.com", null]) {
    assert.equal((await request(emailPath, { method: "PUT", cookie: mappingManager.cookie, body: { wppProductionEmail: invalid } })).response.status, 400);
  }
  assert.equal((await request(emailPath, { method: "PUT", cookie: mappingManager.cookie, body: { wppProductionEmail: " Designer.One@WPPProduction.com " } })).payload.wppProductionEmail, emailBody.wppProductionEmail);
  const execAuditorAccount = mappingSnapshot.payload.users.find((account) => account.role === "auditor");
  const execAuditorMember = mappingSnapshot.payload.team.find((member) => member.name === execAuditorAccount.name);
  const reportExecutorPath = `/api/team/${execAuditorMember.id}/report-executor`;
  assert.equal((await request(reportExecutorPath, { method: "PUT", cookie: sourceLogin.cookie, body: { reportExecutor: true } })).response.status, 403);
  assert.equal((await request(reportExecutorPath, { method: "PUT", cookie: mappingManager.cookie, body: { reportExecutor: "yes" } })).response.status, 400);
  const reportRolesOf = async () => (await request("/api/operations?date=2026-10-20&period=quarterly", { cookie: mappingManager.cookie })).payload.members.find((member) => member.name === execAuditorMember.name)?.role;
  assert.equal(await reportRolesOf(), "auditor");
  assert.equal((await request(reportExecutorPath, { method: "PUT", cookie: mappingManager.cookie, body: { reportExecutor: true } })).payload.reportExecutor, true);
  assert.equal(await reportRolesOf(), "executioner", "flagged auditor is an executor in reports");
  assert.equal((await request("/api/data", { cookie: mappingManager.cookie })).payload.users.find((account) => account.id === execAuditorAccount.id).role, "auditor", "account role unchanged");
  await request(reportExecutorPath, { method: "PUT", cookie: mappingManager.cookie, body: { reportExecutor: false } });
  const senderMember = mappingSnapshot.payload.team.find((member) => member.name === mappingSnapshot.payload.user.name);
  assert.equal((await request(`/api/team/${senderMember.id}/wpp-email`, { method: "PUT", cookie: mappingManager.cookie, body: emailBody })).response.status, 409);
  assert.equal((await request(`/api/team/${senderMember.id}/wpp-email`, { method: "PUT", cookie: mappingManager.cookie,
    body: { wppProductionEmail: "manager.one@wppproduction.com" } })).response.status, 200);
  const monthlyReport = await request("/api/operations?date=2026-10-20&period=monthly", { cookie: mappingManager.cookie });
  assert.equal(monthlyReport.payload.window.period, "monthly");
  assert.equal((await request("/api/operations?date=2026-10-20&period=invalid", { cookie: mappingManager.cookie })).response.status, 400);
  const memberKPI = monthlyReport.payload.kpis.find((row) => row.name === "Designer One");
  const publicationInput = { memberId: memberKPI.memberId, date: "2026-10-20", period: "monthly", note: "Monthly evidence review", allowIncomplete: true };
  assert.equal((await request("/api/kpi-publications", { method: "POST", cookie: sourceLogin.cookie, body: publicationInput })).response.status, 403);
  assert.equal((await request("/api/kpi-publications", { method: "POST", cookie: mappingManager.cookie, body: { ...publicationInput, allowIncomplete: false } })).response.status, 409);
  const publication = await request("/api/kpi-publications", { method: "POST", cookie: mappingManager.cookie, body: publicationInput });
  assert.equal(publication.response.status, 201, JSON.stringify(publication.payload));
  assert.equal(publication.payload.final, false);
  assert.equal(publication.payload.version, 1);
  const revision = await request("/api/kpi-publications", { method: "POST", cookie: mappingManager.cookie, body: { ...publicationInput, note: "Corrected evidence note" } });
  assert.equal(revision.payload.version, 2);
  const memberPublications = (await request("/api/operations?date=2026-10-20&period=monthly", { cookie: sourceLogin.cookie })).payload.publications;
  assert.equal(memberPublications.find((item) => item.id === publication.payload.id).note, "Monthly evidence review");
  assert.equal((await request(`/api/kpi-publications/${revision.payload.id}`, { method: "PUT", cookie: sourceLogin.cookie, body: { reason: "Not permitted" } })).response.status, 403);
  assert.equal((await request(`/api/kpi-publications/${revision.payload.id}`, { method: "PUT", cookie: mappingManager.cookie, body: { reason: "Correct before sharing" } })).response.status, 200);
  assert.equal((await request(`/api/team/${designerMember.id}/workfront`, { method: "PUT", cookie: sourceLogin.cookie, body: { workfrontIds: "D.One.do7" } })).response.status, 403);
  const mapped = await request(`/api/team/${designerMember.id}/workfront`, { method: "PUT", cookie: mappingManager.cookie, body: { workfrontIds: "D.One.do7" } });
  assert.equal(mapped.response.status, 200, JSON.stringify(mapped.payload));
  assert.deepEqual(mapped.payload.workfrontIds, ["D.One.do7"]);
  const otherMember = mappingSnapshot.payload.team.find((member) => member.name !== "Designer One");
  assert.equal((await request(`/api/team/${otherMember.id}/workfront`, { method: "PUT", cookie: mappingManager.cookie, body: { workfrontIds: "d.one.do7" } })).response.status, 409);
  const aliasSnapshot = await request("/api/data", { cookie: sourceLogin.cookie });
  assert.deepEqual(aliasSnapshot.payload.workfrontTasks.find((task) => task.workfrontId === "OPS-T3")?.assignmentNames, ["Designer One"]);
  const timerInput = { deliveryKey: "workfront:OPS-T2", action: "start" };
  assert.equal((await request("/api/execution/timer", { method: "POST", cookie: sourceLogin.cookie, body: { ...timerInput, deliveryKey: "workfront:WF-TASK-TEST" } })).response.status, 403);
  assert.equal((await request("/api/execution/timer", { method: "POST", cookie: sourceLogin.cookie, body: timerInput })).response.status, 200);
  assert.equal((await request("/api/execution/timer", { method: "POST", cookie: sourceLogin.cookie, body: timerInput })).response.status, 409);
  assert.equal((await request("/api/execution/timer", { method: "POST", cookie: sourceLogin.cookie, body: { ...timerInput, action: "hold" } })).payload.timer.state, "held");
  assert.equal((await request("/api/execution/timer", { method: "POST", cookie: sourceLogin.cookie, body: { ...timerInput, action: "hold" } })).response.status, 409);
  assert.equal((await request("/api/execution/timer", { method: "POST", cookie: sourceLogin.cookie, body: timerInput })).response.status, 200);
  assert.equal((await request("/api/execution/timer", { method: "POST", cookie: sourceLogin.cookie, body: { ...timerInput, action: "stop" } })).payload.timer.state, "stopped");
  const timerSnapshot = await request("/api/data", { cookie: sourceLogin.cookie });
  assert.ok(timerSnapshot.payload.sourceWorkLogs.some((entry) => entry.taskId === "OPS-T2" && entry.timerEntry && entry.hours > 0));
  assert.equal(timerSnapshot.payload.workfrontTasks.find((task) => task.workfrontId === "OPS-T2").taskStatus, "In Progress");
  const checklistInput = { deliveryKey: "workfront:OPS-T2", items: [{ label: "Self QC", done: true }],
    inputDocuments: [{ name: "Source", link: "https://example.com/source" }], outputDocuments: [], observations: "Checked." };
  assert.equal((await request("/api/execution/checklist", { method: "PUT", cookie: sourceLogin.cookie, body: checklistInput })).response.status, 200);
  assert.equal((await request("/api/execution/checklist", { method: "PUT", cookie: sourceLogin.cookie,
    body: { ...checklistInput, inputDocuments: [{ name: "Unsafe", link: "javascript:alert(1)" }] } })).response.status, 400);
  assert.equal((await request("/api/quality-results", { method: "POST", cookie: sourceLogin.cookie,
    body: { deliveryKey: "workfront:OPS-T2", result: "Pass", firstTime: true, note: "Cannot self-approve." } })).response.status, 403);
  const qaLogin = await request("/api/auth/login", { method: "POST", body: { username: "auditor.one", password: "auditor-secure-123" } });
  assert.equal((await request("/api/quality-results", { method: "POST", cookie: qaLogin.cookie,
    body: { deliveryKey: "cr:OPS-CR", result: "Pass", firstTime: true, note: "QA verified CR1." } })).response.status, 201);
  const qualitySnapshot = await request("/api/data", { cookie: sourceLogin.cookie });
  assert.equal(qualitySnapshot.payload.execution.quality.rows.find((row) => row.key === "cr:OPS-CR").ftr, true);
  const notification = sourceSnapshot.payload.notifications.find((entry) => entry.projectRef === "OPS-P1");
  assert.ok(notification);
  const sourceLogInput = { taskId: "OPS-T1", date: "2026-10-12", hours: 8, phase: "Build",
    progress: 100, status: "Completed", note: "Actual completion recorded by executioner" };
  const sourceWorklog = await request("/api/workfront-worklogs", { method: "POST", cookie: sourceLogin.cookie, body: sourceLogInput });
  assert.equal(sourceWorklog.response.status, 201, JSON.stringify(sourceWorklog.payload));
  const loggedSnapshot = await request("/api/data", { cookie: sourceLogin.cookie });
  const loggedSource = loggedSnapshot.payload.workfrontTasks.find((task) => task.workfrontId === "OPS-T1");
  assert.equal(loggedSource.taskStatus, "In Progress");
  assert.equal(loggedSource.executionStatus, "Completed");
  assert.equal(loggedSource.actualCompletionDate, "2026-10-12");
  assert.equal(loggedSource.executionLoggedHours, 8);
  assert.equal((await request(`/api/notifications/${notification.id}/read`, { method: "POST", cookie: sourceLogin.cookie })).response.status, 200);
  const bot = await request("/api/ops-assistant", { method: "POST", cookie: sourceLogin.cookie, body: { question: "OPS-P1" } });
  assert.equal(bot.response.status, 200);
  assert.match(bot.payload.answer, /Ops source project/);
  assert.equal((await request("/api/ops-assistant", { method: "POST", cookie: sourceLogin.cookie, body: { question: "OPS-PRIVATE" } })).payload.answer.includes("Ops source project"), false);
  assert.equal((await request("/api/workfront-worklogs", { method: "POST", cookie: sourceLogin.cookie,
    body: { ...sourceLogInput, taskId: "WF-TASK-TEST" } })).response.status, 403);
  const persistedOps = readSavedData();
  assert.equal(persistedOps.sourceWorkLogs.at(-1).userName, "Designer One");
  assert.equal(persistedOps.notifications.find((entry) => entry.id === notification.id).readAt !== null, true);
  const historicalHeaders = ["Task ID", "Project: Reference Number", "Project: Name", "Task Name", "Status", "Assignments",
    "Project: Primary Material", "Planned Start Date", "Planned Completion Date", "Project: Delivery Centre", "% Complete", "Actual Completion Date", "Entry Date"];
  const historicalFile = xlsxUpload("history.xlsx", "History", historicalHeaders, [
    ["HIST-T", "HIST-P", "October historical delivery", "Build", "Complete", "Designer One", "Print", "2026-10-01", "2026-10-02", "PRD WPP Production", "100%", "2026-10-03", "2026-10-01"]
  ]);
  assert.equal((await request("/api/operations/history", { method: "POST", cookie: sourceLogin.cookie, body: { type: "tasks", file: historicalFile } })).response.status, 403);
  assert.equal((await request("/api/operations/history", { method: "POST", cookie: mappingManager.cookie, body: { type: "tasks", file: historicalFile } })).response.status, 201);
  const historySnapshot = await request("/api/data", { cookie: sourceLogin.cookie });
  assert.equal(historySnapshot.payload.workfrontTasks.some((row) => row.workfrontId === "HIST-T"), false, "history import cannot add active assignments");
  assert.equal(historySnapshot.payload.operationsWorkspace.quality.rows.find((row) => row.key === "workfront:HIST-T").completedAt, "2026-10-03");
  assert.equal(historySnapshot.payload.operationsWorkspace.kpis.length, 1);
  assert.equal(historySnapshot.payload.operationsWorkspace.kpis[0].name, "Designer One");
  assert.equal(historySnapshot.payload.operationsWorkspace.members.every((member) => member.name === "Designer One"), true);
  assert.equal((await request("/api/operations?date=2026-06-30", { cookie: sourceLogin.cookie })).response.status, 400);
  assert.equal((await request("/api/operations?date=2026-07-01", { cookie: sourceLogin.cookie })).response.status, 200);
  assert.equal((await request("/api/operations?date=2026-10-03", { cookie: sourceLogin.cookie })).payload.window.from, "2026-10-01");
  const qaDraft = await request("/api/weekly-qa", { method: "POST", cookie: mappingManager.cookie,
    body: { from: "2026-09-28", to: "2026-10-04", note: "QA reporting week" } });
  assert.equal(qaDraft.response.status, 201, JSON.stringify(qaDraft.payload));
  assert.equal((await request(`/api/weekly-qa/${qaDraft.payload.id}/publish`, { method: "POST", cookie: mappingManager.cookie, body: { note: "Empty report" } })).response.status, 409);
  const qaRow = await request(`/api/weekly-qa/${qaDraft.payload.id}/rows`, { method: "POST", cookie: mappingManager.cookie,
    body: { projectRef: "c".repeat(32), qaTaskId: "QA-HIST", executor: "Designer One", requestType: "D1", deliveredDate: "2026-10-03", bugCreated: false, totalBugs: 0, note: "QA explicit first-time pass" } });
  assert.equal(qaRow.response.status, 200, JSON.stringify(qaRow.payload));
  assert.equal(qaRow.payload.rows[0].projectRef, "HIST-P");
  const qaRowId = qaRow.payload.rows[0].id;
  assert.equal((await request(`/api/weekly-qa/${qaDraft.payload.id}/rows/${qaRowId}`, { method: "PUT", cookie: sourceLogin.cookie,
    body: { note: "Cannot self-approve" } })).response.status, 403);
  const qaPublish = await request(`/api/weekly-qa/${qaDraft.payload.id}/publish`, { method: "POST", cookie: mappingManager.cookie, body: { note: "QA bulletin counts without validation" } });
  assert.equal(qaPublish.response.status, 200, JSON.stringify(qaPublish.payload));
  assert.equal(qaPublish.payload.rows[0].validation, null);
  assert.equal(qaPublish.payload.version, 1);
  assert.equal((await request(`/api/weekly-qa/${qaDraft.payload.id}/rows`, { method: "POST", cookie: mappingManager.cookie, body: {} })).response.status, 409);
  const qaMemberView = (await request("/api/data", { cookie: sourceLogin.cookie })).payload.operationsWorkspace;
  assert.ok(qaMemberView.quality.rows.every((row) => row.names.includes("Designer One")), "multi-team Quality stays restricted to the executioner's own deliveries");
  assert.ok(qaMemberView.qualityDeliveries.every((row) => row.names.includes("Designer One")));
  assert.ok(qaMemberView.quality.rows.filter((row) => row.qaPublished).every((row) => row.teamId === "design"), "the existing validated QA publication workflow remains Design-specific");
  assert.equal(qaMemberView.quality.rows.find((row) => row.ref === "HIST-P").qaPublished, true);
  const writeQAWorkbook = require("write-excel-file/node");
  const qaImportWorkbook = await writeQAWorkbook([
    { sheet: "Deliveries", data: [
      ["QA Task ID", "Workfront ID", "Channel", "Request Type", "Executor", "Delivered Date", "Bug Created"],
      ["QA-IMPORT", "HIST-P", "Print", "D1", "Designer One", "2026-10-13", "No"],
      ["QA-EMAIL", "OPS-P1", "Email", "D1", "Designer One", "2026-10-13", "No"]
    ].map((row) => row.map((value) => ({ value, type: String }))) },
    { sheet: "Bugs", data: [
      ["QA Task ID", "Workfront ID", "Bug Assignee", "Bug Created Date", "Total Bugs", "Bug Description", "Delivered Date", "Channel", "Request Type"],
      ["QA-ORPHAN", "HIST-P", "Designer One", "2026-10-17", "5", "Source delivery missing", "2026-10-19", "Print", "D1"]
    ].map((row) => row.map((value) => ({ value, type: String }))) }
  ]).toBuffer();
  const qaImportInput = { from: "2026-10-12", to: "2026-10-18", note: "Fixture QA workbook",
    file: { name: "QA-week.xlsx", contentBase64: qaImportWorkbook.toString("base64") } };
  assert.equal((await request("/api/weekly-qa/import", { method: "POST", cookie: sourceLogin.cookie, body: qaImportInput })).response.status, 403);
  const importedQA = await request("/api/weekly-qa/import", { method: "POST", cookie: mappingManager.cookie, body: qaImportInput });
  assert.equal(importedQA.response.status, 201, JSON.stringify(importedQA.payload));
  assert.equal(importedQA.payload.status, "Draft");
  assert.equal(importedQA.payload.rows.length, 2);
  assert.equal(importedQA.payload.sourceTotals.excludedOtherTeams, 1);
  const orphanQA = importedQA.payload.rows.find((row) => row.deliveryMissing);
  assert.equal(orphanQA.executor, "");
  assert.equal(orphanQA.bugs[0].bugAssignee, "Designer One");
  assert.equal((await request("/api/weekly-qa/import", { method: "POST", cookie: mappingManager.cookie, body: qaImportInput })).response.status, 409);
  assert.equal((await request(`/api/weekly-qa/${importedQA.payload.id}/match`, { method: "POST", cookie: sourceLogin.cookie, body: {} })).response.status, 403);
  assert.equal((await request(`/api/weekly-qa/${importedQA.payload.id}/match`, { method: "POST", cookie: qaLogin.cookie, body: {} })).response.status, 403);
  const matchedQA = await request(`/api/weekly-qa/${importedQA.payload.id}/match`, { method: "POST", cookie: mappingManager.cookie, body: {} });
  assert.equal(matchedQA.response.status, 200, JSON.stringify(matchedQA.payload));
  assert.deepEqual(matchedQA.payload, { matched: 1, needsAttention: 1 });
  const matchedDraft = (await request("/api/data", { cookie: mappingManager.cookie })).payload.operationsWorkspace.weeklyQA.reports.find((item) => item.id === importedQA.payload.id);
  assert.ok(matchedDraft.rows.find((item) => !item.deliveryMissing).validation);
  assert.equal(matchedDraft.rows.find((item) => item.deliveryMissing).validation, null);
  assert.equal((await request(`/api/weekly-qa/${importedQA.payload.id}/publish`, { method: "POST", cookie: mappingManager.cookie, body: { note: "" } })).response.status, 400);
  const activityInput = { date: "2026-10-03", category: "Training", hours: 1.5, note: "Mandatory course" };
  assert.equal((await request("/api/non-productive-logs", { method: "POST", cookie: sourceLogin.cookie, body: activityInput })).response.status, 201);
  assert.equal((await request("/api/non-productive-logs", { method: "POST", cookie: sourceLogin.cookie, body: { ...activityInput, hours: 24 } })).response.status, 409);
  assert.equal((await request("/api/non-productive-logs", { method: "POST", cookie: sourceLogin.cookie, body: { ...activityInput, date: "2026-06-30" } })).response.status, 400);
  assert.equal((await request("/api/non-productive-logs", { method: "POST", cookie: sourceLogin.cookie, body: { ...activityInput, category: "Build" } })).response.status, 400);
  const feedback = await request("/api/project-feedback", { method: "POST", cookie: sourceLogin.cookie,
    body: { projectRef: "OPS-P1", category: "Challenge", message: "Input brief needs clarification." } });
  assert.equal(feedback.response.status, 201);
  assert.equal((await request("/api/project-feedback", { method: "POST", cookie: sourceLogin.cookie,
    body: { projectRef: "PRIVATE-NOT-OWN", category: "Learning", message: "Not my work." } })).response.status, 403);
  assert.equal((await request(`/api/project-feedback/${feedback.payload.id}`, { method: "PUT", cookie: sourceLogin.cookie,
    body: { status: "Actioned", response: "Cannot self-review." } })).response.status, 403);
  assert.equal((await request(`/api/project-feedback/${feedback.payload.id}`, { method: "PUT", cookie: mappingManager.cookie,
    body: { status: "Reviewed", response: "Still investigating", bestPractice: true, practiceTitle: "Premature solution" } })).response.status, 400);
  assert.equal((await request(`/api/project-feedback/${feedback.payload.id}`, { method: "PUT", cookie: mappingManager.cookie,
    body: { status: "Actioned", response: "Updated brief requested." } })).response.status, 200);
  const kpiMemberId = historySnapshot.payload.user.id;
  const kpiIssueInput = { memberId: kpiMemberId, date: "2026-10-03", category: "Quality", deliveryKey: "workfront:HIST-T", note: "Validated quality miss." };
  assert.equal((await request("/api/kpi-issues", { method: "POST", cookie: sourceLogin.cookie, body: kpiIssueInput })).response.status, 403);
  const evidenceFiles = [{ name: "QA evidence.txt", contentBase64: Buffer.from("First evidence").toString("base64") },
    { name: "Screenshot.png", contentBase64: Buffer.from([137, 80, 78, 71]).toString("base64") }];
  for (const attachments of [{}, Array(11).fill(evidenceFiles[0]), [{ name: "../bad.txt", contentBase64: "YQ==" }],
    [{ name: "bad.txt", contentBase64: "invalid!" }], [{ name: "empty.txt", contentBase64: "" }],
    [{ name: "large.txt", contentBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }],
    Array(3).fill({ name: "batch.txt", contentBase64: Buffer.alloc(4 * 1024 * 1024).toString("base64") })]) {
    assert.equal((await request("/api/kpi-issues", { method: "POST", cookie: mappingManager.cookie,
      body: { ...kpiIssueInput, attachments } })).response.status, 400);
  }
  const issue = await request("/api/kpi-issues", { method: "POST", cookie: mappingManager.cookie,
    body: { ...kpiIssueInput, attachments: evidenceFiles } });
  assert.equal(issue.response.status, 201);
  assert.equal(issue.payload.emailNotification.status, "not_configured");
  assert.equal(issue.payload.emailNotification.sender, "manager.one@wppproduction.com");
  assert.equal(issue.payload.emailNotification.recipient, "designer.one@wppproduction.com");
  assert.equal(readSavedData().kpiIssues.find((row) => row.id === issue.payload.id).emailNotification.status, "not_configured");
  assert.equal(readSavedData().team.find((row) => row.id === designerMember.id).wppProductionEmail, "designer.one@wppproduction.com");
  assert.equal(issue.payload.attachments.length, 2);
  assert.equal(issue.payload.attachments[0].contentBase64, undefined);
  const evidencePath = `/api/kpi-issues/${issue.payload.id}/attachments/${issue.payload.attachments[0].id}`;
  const evidenceDownload = await fetch(`${baseUrl}${evidencePath}`, { headers: { Cookie: sourceLogin.cookie } });
  assert.equal(evidenceDownload.status, 200);
  assert.equal(await evidenceDownload.text(), "First evidence");
  assert.match(evidenceDownload.headers.get("content-disposition"), /attachment/);
  assert.equal(evidenceDownload.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await fetch(`${baseUrl}${evidencePath}`)).status, 401);
  assert.equal(readSavedData().kpiIssues.find((row) => row.id === issue.payload.id).attachments[0].contentBase64, evidenceFiles[0].contentBase64);
  assert.doesNotMatch(JSON.stringify((await request("/api/data", { cookie: sourceLogin.cookie })).payload.operationsWorkspace.issues), /contentBase64/);
  assert.equal((await request("/api/data", { cookie: sourceLogin.cookie })).payload.operationsWorkspace.issues.some((row) => row.id === issue.payload.id), true);
  const reviewInput = { memberId: kpiMemberId, date: "2026-10-03", feedback: [true, true, false, true],
    qualityVerified: true, deliveryVerified: true, processVerified: true, coverageConfirmed: true, finalized: true, overallRating: 4, note: "Historical source and audit evidence reviewed." };
  assert.equal((await request("/api/kpi-reviews", { method: "PUT", cookie: sourceLogin.cookie, body: reviewInput })).response.status, 403);
  assert.equal((await request("/api/kpi-reviews", { method: "PUT", cookie: mappingManager.cookie, body: { ...reviewInput, coverageConfirmed: false } })).response.status, 409);
  const finalizedQAReview = await request("/api/kpi-reviews", { method: "PUT", cookie: mappingManager.cookie, body: reviewInput });
  assert.equal(finalizedQAReview.response.status, 200, JSON.stringify(finalizedQAReview.payload));
  assert.equal((await request("/api/data", { cookie: sourceLogin.cookie })).payload.operationsWorkspace.kpis[0].confirmed, true);
  const monthlyReview = await request("/api/kpi-reviews", { method: "PUT", cookie: mappingManager.cookie, body: { ...reviewInput, period: "monthly" } });
  assert.equal(monthlyReview.response.status, 200, JSON.stringify(monthlyReview.payload));
  assert.equal(monthlyReview.payload.period, "monthly");
  assert.equal((await request("/api/operations?date=2026-10-03&period=monthly", { cookie: sourceLogin.cookie })).payload.kpis[0].confirmed, true);
  assert.equal((await request("/api/data", { cookie: sourceLogin.cookie })).payload.operationsWorkspace.kpis[0].confirmed, true, "monthly review does not replace quarter review");
  assert.equal((await request(`/api/kpi-issues/${issue.payload.id}`, { method: "PUT", cookie: mappingManager.cookie, body: { reason: "Duplicate issue; retained audit trail." } })).response.status, 200);
  assert.equal((await request("/api/data", { cookie: sourceLogin.cookie })).payload.operationsWorkspace.kpis[0].confirmed, false);
  const approvedChecks = historySnapshot.payload.operationsWorkspace.checklistTemplates.find((template) => template.assetType === "iPDF").items;
  const approvedChecklist = { ...checklistInput, deliveryKey: "workfront:CHECK-T", items: approvedChecks.map((item) => ({ ...item, result: "Done", done: true })) };
  assert.equal((await request("/api/execution/checklist", { method: "PUT", cookie: sourceLogin.cookie,
    body: { ...approvedChecklist, items: approvedChecklist.items.slice(1) } })).response.status, 400);
  assert.equal((await request("/api/execution/checklist", { method: "PUT", cookie: sourceLogin.cookie,
    body: { ...approvedChecklist, items: approvedChecklist.items.map((item, index) => index ? item : { ...item, result: "N.A.", comment: "" }) } })).response.status, 400);
  assert.equal((await request("/api/execution/checklist", { method: "PUT", cookie: sourceLogin.cookie, body: approvedChecklist })).response.status, 200);
  const xlsxResponse = await fetch(`${baseUrl}/api/execution/checklist.xlsx?deliveryKey=workfront%3ACHECK-T`, { headers: { cookie: sourceLogin.cookie } });
  assert.equal(xlsxResponse.status, 200);
  assert.match(xlsxResponse.headers.get("content-type"), /spreadsheetml/);
  const workbook = await require("read-excel-file/node")(Buffer.from(await xlsxResponse.arrayBuffer()));
  assert.equal(workbook[1].data.length, 45);
  assert.equal(workbook[1].sheet, "iPDF");
  assert.equal(workbook[1].data[1][3], "Done");
  const qaChecklist = (await request("/api/data", { cookie: qaLogin.cookie })).payload.operationsWorkspace.checklistTemplates.find((template) => template.forAssetType === "iPDF");
  assert.equal(qaChecklist.items.length, 13);
  const qaChecklistSave = await request("/api/execution/checklist", { method: "PUT", cookie: qaLogin.cookie,
    body: { deliveryKey: "workfront:AUDIT-T", items: qaChecklist.items.map((item) => ({ ...item, done: true, result: "Done" })), inputDocuments: [], outputDocuments: [] } });
  assert.equal(qaChecklistSave.response.status, 200, JSON.stringify(qaChecklistSave.payload));
  const qaDownload = await fetch(`${baseUrl}/api/execution/checklist.xlsx?deliveryKey=workfront%3AAUDIT-T`, { headers: { cookie: qaLogin.cookie } });
  assert.equal(qaDownload.status, 200);
  const qaWorkbook = await require("read-excel-file/node")(Buffer.from(await qaDownload.arrayBuffer()));
  assert.equal(qaWorkbook[1].sheet, "Graphics Audit");
  assert.equal(qaWorkbook[1].data.length, 14);
  assert.equal((await request("/api/execution/checklist", { method: "PUT", cookie: sourceLogin.cookie,
    body: { ...approvedChecklist, items: approvedChecklist.items.concat(qaChecklist.items.map((item) => ({ ...item, done: true }))) } })).response.status, 400, "executioner cannot reintroduce Graphics Audit");
  const bugProgressInput = { deliveryKey: "workfront:OPS-BUG-NAMED", progress: 100, status: "In Progress", date: "2026-10-03", note: "Bug fixes completed and verified." };
  assert.equal((await request("/api/execution/progress", { method: "POST", cookie: sourceLogin.cookie, body: { ...bugProgressInput, deliveryKey: "workfront:PRIVATE" } })).response.status, 403);
  assert.equal((await request("/api/execution/progress", { method: "POST", cookie: sourceLogin.cookie, body: bugProgressInput })).response.status, 201);
  assert.equal((await request("/api/data", { cookie: sourceLogin.cookie })).payload.execution.deliveries.find((row) => row.key === bugProgressInput.deliveryKey).status, "Completed");
  const qaOperations = await request("/api/operations?date=2026-10-04", { cookie: qaLogin.cookie });
  assert.equal(qaOperations.payload.kpis.length, 1);
  assert.equal(qaOperations.payload.kpis[0].role, "auditor");
  assert.equal(qaOperations.payload.kpis[0].completed, 1);
  assert.equal(qaOperations.payload.kpis[0].scores.quality, null);
  const emailManagerLogin = await request("/api/auth/login", { method: "POST", body: { username: "email.manager", password: "team-manager-secure-123" } });
  assert.equal((await fetch(`${baseUrl}${evidencePath}`, { headers: { Cookie: qaLogin.cookie } })).status, 403);
  assert.equal((await request("/api/kpi-issues", { method: "POST", cookie: emailManagerLogin.cookie,
    body: { ...kpiIssueInput, memberId: qaOperations.payload.members[0].id } })).response.status, 403);
  const qaRevision = await request(`/api/weekly-qa/${qaDraft.payload.id}/revise`, { method: "POST", cookie: mappingManager.cookie, body: { note: "Corrected QA review" } });
  assert.equal(qaRevision.response.status, 201);
  assert.equal(qaRevision.payload.rows[0].validation, null);
  const correctedQA = await request(`/api/weekly-qa/${qaRevision.payload.id}/rows/${qaRevision.payload.rows[0].id}`, { method: "PUT", cookie: mappingManager.cookie,
    body: { executor: "Designer One", bugCreated: true, note: "Manual correction: bulletin missed a bug" } });
  assert.equal(correctedQA.response.status, 200);
  assert.equal(correctedQA.payload.rows[0].bugCreated, true);
  assert.equal((await request(`/api/weekly-qa/${qaRevision.payload.id}/publish`, { method: "POST", cookie: mappingManager.cookie, body: { note: "Republished QA" } })).payload.version, 2);
  assert.equal((await request(`/api/weekly-qa/${qaRevision.payload.id}/recall`, { method: "POST", cookie: mappingManager.cookie, body: { note: "Recall corrected version" } })).response.status, 200);
  assert.equal((await request("/api/data", { cookie: sourceLogin.cookie })).payload.operationsWorkspace.quality.rows.find((row) => row.ref === "HIST-P").reportId, qaDraft.payload.id);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(baseUrl);
    await page.getByRole("textbox", { name: "Username" }).first().fill("designer.one");
    await page.locator('input[type="password"]').first().fill("another-secure-123");
    await page.locator('input[type="password"]').first().press("Enter");
    await page.waitForSelector("#view-my-work:not(.hidden)");
    assert.deepEqual(errors, []);
    assert.match(await page.evaluate(() => deliveryWorkfrontLink({ source: "workfront", id: "a".repeat(32), ref: "TEST", type: "Build" })), /\/task\/a{32}\/overview/);
    assert.match(await page.evaluate(() => deliveryWorkfrontLink({ source: "cr", id: "b".repeat(32), ref: "TEST", type: "CR" })), /\/issue\/b{32}\/overview/);
    assert.ok((await page.locator("#execution-list").innerHTML()).includes('data-execution-checklist="workfront:OPS-T2"'), await page.locator("#execution-list").innerHTML());
    assert.deepEqual(await page.locator("#main-nav .nav-link:not(.hidden)").evaluateAll((buttons) => buttons.map((button) => button.dataset.view)), ["my-work", "quality", "kpi", "feedback", "worklog", "gantt", "team"]);
    await page.locator('#main-nav [data-view="gantt"]').click();
    assert.equal(await page.locator("#view-gantt").isVisible(), true);
    await page.evaluate(() => refreshData());
    assert.equal(await page.locator("#view-gantt").isVisible(), true, "refresh keeps executioners on Gantt");
    assert.equal(await page.locator("#gantt-chart").getByText("Private source project", { exact: false }).count(), 0);
    await page.locator('#main-nav [data-view="my-work"]').click();
    const task = page.locator(".execution-card").filter({ has: page.locator('[data-execution-checklist="workfront:OPS-T2"]') });
    await task.locator('[data-timer-action="start"]').click();
    await page.waitForFunction(() => document.querySelector("#execution-timer").textContent.includes("running"));
    await task.locator('[data-timer-action="hold"]').click();
    await page.waitForFunction(() => document.querySelector("#execution-timer").textContent.includes("held"));
    await task.locator('[data-timer-action="stop"]').click();
    await page.waitForFunction(() => document.querySelector("#execution-timer").textContent.includes("No running timer"));
    await task.locator("[data-execution-checklist]").click();
    assert.equal(await page.locator('#execution-checklist-items [data-check-done]').isChecked(), true);
    await page.locator('[data-add-document="outputDocuments"]').click();
    await page.locator('#handoff-outputDocuments [data-document-name]').fill("Final PDF");
    await page.locator('#handoff-outputDocuments [data-document-link]').fill("https://example.com/final.pdf");
    const downloadReady = page.waitForEvent("download");
    await page.locator("#execution-handoff-download").click();
    const download = await downloadReady;
    assert.match(download.suggestedFilename(), /QA-handoff\.eml$/);
    await page.locator("#execution-handoff-copy").click();
    await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Formatted handoff copied"));
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Puneet Srivastava/);
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Final PDF/);
    await page.locator('[data-close="execution-checklist-dialog"]').click();
    const approvedTask = page.locator(".execution-card").filter({ has: page.locator('[data-execution-checklist="workfront:CHECK-T"]') });
    await approvedTask.locator("[data-execution-checklist]").click();
    assert.equal(await page.locator("#execution-checklist-items [data-check-done]").count(), 44);
    assert.match(await page.locator("#execution-checklist-source").innerText(), /Checklist_iPdf.xlsx/);
    const xlsxReady = page.waitForEvent("download");
    await page.locator("#execution-checklist-download").click();
    assert.match((await xlsxReady).suggestedFilename(), /checklist\.xlsx$/);
    await page.locator('[data-close="execution-checklist-dialog"]').click();
    await page.locator("#execution-status").selectOption("all");
    await page.locator("#execution-type").selectOption("Bug Fixing");
    const bugCard = page.locator(".execution-card").filter({ has: page.locator('[data-execution-progress="workfront:OPS-BUG-NAMED"]') });
    assert.equal(await bugCard.count(), 1);
    assert.equal(await page.locator('[data-execution-progress="workfront:OPS-BUG-DEFAULT"]').count(), 0);
    await bugCard.locator("[data-execution-progress]").click();
    await page.locator('#execution-progress-form [name="progress"]').fill("75");
    await page.locator('#execution-progress-form [name="note"]').fill("Bug retest in progress.");
    await page.locator('#execution-progress-form [type="submit"]').click();
    await page.waitForSelector("#execution-progress-dialog", { state: "hidden" });
    assert.match(await bugCard.innerText(), /75%/);
    await page.locator('#main-nav [data-view="worklog"]').click();
    await page.locator('#non-productive-form [name="hours"]').fill("0.5");
    await page.locator('#non-productive-form [name="category"]').selectOption("Meeting");
    await page.locator('#non-productive-form [name="note"]').fill("Daily team meeting");
    await page.locator('#non-productive-form [type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#non-productive-list").textContent.includes("Daily team meeting"));
    await page.locator('#main-nav [data-view="feedback"]').click();
    assert.match(await page.locator("#project-feedback-list").innerText(), /Updated brief requested/);
    await page.locator('#project-feedback-form [name="projectRef"]').selectOption("OPS-P1");
    await page.locator('#project-feedback-form [name="category"]').selectOption("Learning");
    await page.locator('#project-feedback-form [name="message"]').fill("Reusable layout improvement.");
    await page.locator('#project-feedback-form [type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#project-feedback-list").textContent.includes("Reusable layout improvement"));
    assert.equal(await page.locator('#main-nav [data-view="kpi"]').isVisible(), true);
    await page.locator('#main-nav [data-view="quality"]').click();
    await page.locator("details").filter({ has: page.locator("#quality-list") }).locator("summary").click();
    await page.locator("#quality-outcome").selectOption("all");
    await page.locator("#quality-period").selectOption("daily");
    await page.locator("#quality-date").fill("2026-10-03");
    await page.locator("#quality-date").dispatchEvent("change");
    assert.match(await page.locator("#quality-list").innerText(), /October historical delivery/);
    for (const period of ["weekly", "monthly", "yearly", "ytd"]) {
      await page.locator("#quality-period").selectOption(period);
      assert.match(await page.locator("#quality-list").innerText(), /October historical delivery/);
    }
    await page.locator("#quality-date").fill(new Date().toLocaleDateString("en-CA"));
    await page.locator("#quality-period").selectOption("monthly");
    await page.locator("#quality-outcome").selectOption("ftr");
    assert.match(await page.locator("#quality-list").innerText(), /First-time-right/);
    await page.context().clearCookies();
    await page.reload();
    await page.getByRole("textbox", { name: "Username" }).first().fill("workspace.admin");
    await page.locator('input[type="password"]').first().fill("secure-password-123");
    await page.locator('input[type="password"]').first().press("Enter");
    await page.waitForSelector("#app-shell:not(.hidden)");
    await page.locator('#main-nav [data-view="quality"]').click();
    await page.locator("#weekly-qa-select").selectOption(importedQA.payload.id);
    assert.equal(await page.locator("#weekly-qa-filter").inputValue(), "all");
    assert.equal(await page.locator("#weekly-qa-rows tbody tr").count(), 2);
    assert.equal(await page.locator('[data-weekly-action="publish"]').isEnabled(), true);
    await page.locator("[data-weekly-match]").click();
    await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("1 matched; 1 need attention"));
    await page.locator("#weekly-qa-filter").selectOption("all");
    assert.equal(await page.locator("#weekly-qa-rows tbody tr").count(), 2);
    await page.locator("#weekly-qa-filter").selectOption("attention");
    await page.locator("[data-weekly-review]").click();
    assert.equal(await page.locator("#weekly-qa-review-cr").isVisible(), false);
    await page.locator('#weekly-qa-review-form [name="exclude"]').check();
    assert.equal(await page.locator('#weekly-qa-review-form [name="executor"]').getAttribute("required"), null);
    await page.locator('#weekly-qa-review-form [name="note"]').fill("No original delivery evidence; exclude until confirmed.");
    await page.locator('#weekly-qa-review-form [type="submit"]').click();
    await page.waitForSelector("#weekly-qa-review-dialog", { state: "hidden" });
    assert.equal(await page.locator('[data-weekly-action="publish"]').isEnabled(), true);
    await page.locator("#weekly-qa-filter").selectOption("matched");
    await page.locator("[data-weekly-hygiene]").click();
    assert.equal(await page.locator("#view-hygiene").isVisible(), true);
    assert.equal(await page.locator("#hygiene-project").inputValue(), "HIST-P");
    assert.ok((await page.locator("#hygiene-list tbody tr").count()) > 0);
    assert.ok((await page.locator("#hygiene-list tbody tr td:first-child").allTextContents()).every((text) => text.includes("HIST-P")));
    await page.locator("#hygiene-project").fill("");
    await page.locator('#main-nav [data-view="team-utilization"]').click();
    await page.locator("#utilization-anchor-date").fill("2026-10-03");
    await page.locator("#utilization-anchor-date").dispatchEvent("change");
    const utilizationMember = page.locator("#team-utilization-resources tbody tr").filter({ has: page.getByRole("cell", { name: "Designer One", exact: true }) });
    const utilizationCells = await utilizationMember.locator("td").allTextContents();
    assert.equal(utilizationCells[4], "1.5h");
    assert.equal(utilizationCells[7], "1.5h");
    assert.equal(Number.parseFloat(utilizationCells[8]), Number.parseFloat(utilizationCells[3]) + 1.5);
    assert.equal(utilizationCells[9], Number.parseFloat(utilizationCells[1])
      ? `${((Number.parseFloat(utilizationCells[3]) + 1.5) / Number.parseFloat(utilizationCells[1]) * 100).toFixed(1)}%` : "N/A");
    assert.match(await page.locator("#team-utilization-resources").innerText(), /Auditor One/);
    await page.locator("details").filter({ has: page.locator("#utilization-activity-details") }).locator("summary").click();
    assert.match(await page.locator("#utilization-activity-details").innerText(), /Mandatory course/);
    await page.locator('#main-nav [data-view="audits"]').click();
    assert.equal(await page.locator('[data-audit-cr="OPS-ACCEPTED-CR"]').count(), 0);
    assert.equal(await page.locator('[data-audit-cr="OPS-COMPLETED-CR"]').count(), 0);
    assert.equal(await page.locator("#new-project-button").count(), 0);
    await page.locator('[data-audit-cr="OPS-UI-CR"]').click();
    const auditForm = page.locator("#cr-audit-form");
    assert.equal(await auditForm.locator('[name="roundId"]').inputValue(), "OPS-UI-CR");
    await page.waitForFunction(() => document.querySelector("#cr-audit-clock").textContent.includes("running"));
    await auditForm.locator('[name="complexity"]').selectOption("Medium");
    assert.match(await page.locator("#cr-audit-result").innerText(), /Planned execution ETA/);
    await auditForm.locator('[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#cr-audit-result").textContent.includes("Audit recorded"));
    await page.locator('[data-close="cr-audit-dialog"]').click();
    await page.locator('#main-nav [data-view="hygiene"]').click();
    await page.locator("#hygiene-filter").selectOption("Not verified");
    assert.equal(await page.locator("#hygiene-list tbody tr").count(), 0, "the project-level filter does not hide confirmed mismatches behind individual unverified fields");
    assert.match(await page.locator("#hygiene-list").innerText(), /No records/);
    const hygieneDownload = page.waitForEvent("download");
    await page.locator("#hygiene-export").click();
    assert.equal((await hygieneDownload).suggestedFilename(), "process-adherence.csv");
    assert.match(await page.locator("#sla-list").innerText(), /SLA/);
    await page.locator("#hygiene-from").fill("2099-01-01");
    await page.locator("#hygiene-dated").selectOption("dated");
    assert.match(await page.locator("#hygiene-list").innerText(), /No records/);
    assert.match(await page.locator("#sla-list").innerText(), /No records/);
    await page.locator("#hygiene-from").fill("");
    await page.locator("#hygiene-dated").selectOption("all");
    await page.locator('#main-nav [data-view="feedback"]').click();
    await page.locator("[data-feedback-response]").first().click();
    await page.locator('#feedback-response-form [name="response"]').fill("Manager reviewed the learning.");
    await page.locator('#feedback-response-form [name="bestPractice"]').check();
    await page.locator('#feedback-response-form [name="practiceTitle"]').fill("Approved team learning");
    await page.locator('#feedback-response-form [type="submit"]').click();
    await page.waitForSelector("#feedback-response-dialog", { state: "hidden" });
    assert.match(await page.locator("#project-feedback-list").innerText(), /Manager reviewed the learning/);
    assert.match(await page.locator("#best-practice-list").innerText(), /Approved team learning/);
    await page.locator('#main-nav [data-view="team"]').click();
    await page.locator("#team-tab-members").click();
    const managerEmailInput = page.getByRole("textbox", { name: `WPP Production email for ${senderMember.name}`, exact: true });
    assert.equal(await managerEmailInput.inputValue(), "manager.one@wppproduction.com");
    const emailSave = page.waitForResponse((response) => response.url().endsWith(`/api/team/${senderMember.id}/wpp-email`) && response.request().method() === "PUT");
    await managerEmailInput.fill("manager.updated@wppproduction.com");
    await managerEmailInput.press("Tab");
    assert.equal((await emailSave).status(), 200);
    await page.waitForFunction((id) => document.querySelector(`[data-team-email="${id}"]`)?.value === "manager.updated@wppproduction.com"
      && state.team.find((member) => member.id === id)?.wppProductionEmail === "manager.updated@wppproduction.com", senderMember.id);
    await page.locator('#main-nav [data-view="kpi"]').click();
    assert.equal(await page.locator("#kpi-manager-tools").isVisible(), true);
    await page.locator('#kpi-issue-form [name="memberId"]').selectOption(kpiMemberId);
    await page.locator('#kpi-issue-form [name="date"]').fill("2026-10-03");
    await page.locator('#kpi-issue-form [name="note"]').fill("Browser evidence upload");
    await page.locator('#kpi-issue-form [name="attachments"]').setInputFiles([
      { name: "browser-proof.txt", mimeType: "text/plain", buffer: Buffer.from("Browser evidence one") },
      { name: "browser-proof-2.txt", mimeType: "text/plain", buffer: Buffer.from("Browser evidence two") }
    ]);
    await page.locator('#kpi-issue-form [type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#kpi-issues").textContent.includes("browser-proof-2.txt"));
    assert.match(await page.locator("#kpi-issues").innerText(), /Outlook application credentials are not configured/);
    assert.match(await page.locator("#kpi-issues").innerText(), /From: manager.updated@wppproduction.com/);
    assert.equal(await page.locator('#kpi-issue-form [name="attachments"]').inputValue(), "");
    const proofDownload = page.waitForEvent("download");
    await page.locator("#kpi-issues").getByRole("link", { name: "browser-proof.txt", exact: true }).click();
    assert.equal((await proofDownload).suggestedFilename(), "browser-proof.txt");
    await page.locator(`[data-kpi-review="${kpiMemberId}"]`).click();
    assert.equal(await page.locator("#kpi-feedback-criteria select").count(), 4);
    await page.locator('[data-close="kpi-review-dialog"]').click();
    const kpiDownload = page.waitForEvent("download");
    await page.locator("#kpi-export").click();
    assert.equal((await kpiDownload).suggestedFilename(), "quarterly-kpi.csv");
    await page.locator("#kpi-date").fill("2027-02-01");
    await page.locator("#kpi-refresh").click();
    await page.waitForFunction(() => document.querySelector("#kpi-load-status").textContent.includes("2027-01-01"));
    assert.match(await page.locator("#kpi-period-label").innerText(), /2027-01-01 to 2027-03-31/);
    await page.evaluate(() => refreshData());
    assert.match(await page.locator("#kpi-period-label").innerText(), /2027-01-01 to 2027-03-31/);
    await page.locator("#kpi-period").selectOption("monthly");
    await page.locator("#kpi-date").fill("2026-10-20");
    await page.locator("#kpi-refresh").click();
    await page.waitForFunction(() => document.querySelector("#kpi-load-status").textContent.includes("Loaded monthly"));
    await page.locator(`[data-kpi-publish="${kpiMemberId}"]`).click();
    await page.locator('#kpi-publish-form [name="note"]').fill("Manager publishes monthly performance evidence.");
    await page.locator('#kpi-publish-form [name="allowIncomplete"]').check();
    await page.locator('#kpi-publish-form [type="submit"]').click();
    await page.waitForSelector("#kpi-publish-dialog", { state: "hidden" });
    assert.match(await page.locator("#kpi-publications").innerText(), /Manager publishes monthly performance evidence/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
  assert.equal((await request("/api/execution/timer", { method: "POST", cookie: sourceLogin.cookie, body: timerInput })).response.status, 200);
  await stopServer();
  const reassignedData = readSavedData();
  const reassignedTask = reassignedData.workfrontTasks.find((task) => task.workfrontId === "OPS-T2");
  reassignedTask.assignmentNames = [];
  reassignedTask.assignees = "ROC | Developer";
  writeSavedData(reassignedData);
  await startServer();
  const reassignedLogin = await request("/api/auth/login", { method: "POST", body: { username: "designer.one", password: "another-secure-123" } });
  assert.equal((await request("/api/execution/timer", { method: "POST", cookie: reassignedLogin.cookie,
    body: { ...timerInput, action: "stop" } })).payload.timer.state, "stopped");
  assert.equal((await request("/api/execution/timer", { method: "POST", cookie: reassignedLogin.cookie, body: timerInput })).response.status, 403);
});
