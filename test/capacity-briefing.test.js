"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { TextEncoder } = require("node:util");
const fflate = require("fflate");
const readXlsx = require("read-excel-file/node");

function briefingContext() {
  const element = () => ({ value: "", innerHTML: "", textContent: "", style: {}, classList: { toggle() {} } });
  const context = vm.createContext({ document: { querySelector: element, querySelectorAll: () => [] }, window: { fflate }, URL, console, Intl, btoa, TextEncoder });
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  vm.runInContext(source.replace(/\nboot\(\);\s*$/, ""), context);
  const task = (id, overrides) => ({ workfrontId: id, projectRef: `P-${id}`, projectName: `Project ${id}`, taskName: "Build", taskStatus: "In Progress",
    productionTeamId: "design", assignmentNames: ["Designer One"], plannedHours: 10, actualHours: 0, percentComplete: 0,
    plannedCompletionDate: "2026-10-19", projectStatus: "Execution in Progress", ...overrides,
    materialExpectedDate: overrides?.materialExpectedDate ?? overrides?.plannedCompletionDate ?? "2026-10-19", ahtHours: overrides?.ahtHours ?? overrides?.plannedHours ?? 10 });
  context.snapshot = {
    user: { role: "manager", teamIds: [] }, roleCapabilities: { viewAht: true },
    departments: [{ id: "design", name: "Design Team" }, { id: "web", name: "Web Team" }],
    team: [
      { name: "Designer One", role: "executioner", teamIds: ["design"] },
      { name: "Designer Two", role: "executioner", teamIds: ["design"] },
      { name: "Designer Three", role: "executioner", teamIds: ["design"] },
      { name: "Lead", role: "teamManager", teamIds: ["design"] },
      { name: "Web Person", role: "executioner", teamIds: ["web"] }
    ],
    leaves: [{ assignee: "Designer Three", startDate: "2026-10-19", endDate: "2026-10-19", status: "Approved" },
      { assignee: "Designer Two", startDate: "2026-10-21", endDate: "2026-10-21", status: "Pending" }],
    holidays: [],
    projects: [], tasks: [],
    workfrontProjects: [
      { ref: "P-urgent-late", priority: "Urgent" }, { ref: "P-urgent-next", priority: "urgent" }, { ref: "P-today", priority: "Normal" }
    ],
    workfrontChangeRounds: [{ workfrontId: "CR-1", projectRef: "P-today", crId: "CR1", title: "Project today", sourceStatus: "Assigned to Execution",
      productionTeamId: "design", assignee: "Designer Two", expectedDeliveryDate: "2026-10-20T10:00:00.000Z" }],
    workfrontTasks: [
      task("today", { plannedHours: 8, percentComplete: 50 }),
      task("urgent-late", { plannedCompletionDate: "2026-10-16", plannedHours: 6, actualHours: 1 }),
      task("urgent-next", { plannedCompletionDate: "2026-10-20", taskName: "Bug Fixing", plannedHours: 3 }),
      task("later", { plannedCompletionDate: "2026-10-23", plannedHours: 12 }),
      task("done", { taskStatus: "Complete" }),
      task("web", { productionTeamId: "web" }),
      task("audit", { taskName: "Asset Audit" }),
      task("on-hold", { projectStatus: "On Hold" }),
      task("built", { projectStatus: "in QC" }),
      task("leave-task", { assignmentNames: ["Designer Three"], plannedCompletionDate: "2026-10-30", plannedHours: 4 }),
      task("material", { plannedCompletionDate: "2026-10-01", materialExpectedDate: "2026-10-21", plannedHours: 5 }),
      task("qc-bug", { taskName: "Bug Fixing", projectStatus: "in QC", plannedCompletionDate: "2026-10-22", plannedHours: 16, ahtHours: 2 })
    ]
  };
  vm.runInContext("applySnapshot(snapshot);", context);
  return context;
}

function capacityDashboardContext() {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { value: "", innerHTML: "", textContent: "", style: {}, classList: { toggle() {} } });
    return elements.get(selector);
  };
  const context = vm.createContext({ document: { querySelector: element, querySelectorAll: () => [] }, window: { fflate }, URL, console, Intl, btoa, TextEncoder });
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  vm.runInContext(source.replace(/\nboot\(\);\s*$/, ""), context);
  return context;
}

test("capacity dashboard keeps auditors, approved leave and local data visible with Workfront capacity", () => {
  const context = capacityDashboardContext();
  const today = vm.runInContext("localDate()", context);
  context.snapshot = {
    roleCapabilities: { viewAht: true },
    team: [
      { name: "Auditor One", role: "auditor" },
      { name: "Designer One", role: "executioner" }
    ],
    tasks: [{ assignee: "Auditor One", status: "In Progress", plannedHours: 6, loggedHours: 2, startDate: today, etaDate: today }],
    leaves: [
      { assignee: "Auditor One", status: "Approved", startDate: today, endDate: today, type: "Annual leave", halfDay: "First half" },
      { assignee: "Designer One", status: "Pending", startDate: today, endDate: today, type: "Sick leave" }
    ],
    productionInsights: { totals: { open: 1, count: 1, plannedHours: 6, loggedHours: 2 }, byCategory: [] },
    operations: { assignedTasks: 1, resources: [
      { name: "Designer One", taskCount: 1, remainingHours: 8, unknownTasks: 0, dailyCapacity: 8, availableDate: today, availableTime: "17:00" }
    ], risks: [], unassignedTasks: 0 },
    workfrontTasks: [{}],
    capacityHoursPerDay: 8
  };
  vm.runInContext("applySnapshot(snapshot); renderCapacity();", context);
  const table = vm.runInContext('document.querySelector("#capacity-team-table").innerHTML', context);
  assert.match(table, /Auditor One<\/td><td>Auditor/);
  assert.match(table, /6\.0h<\/td><td>2\.0h/);
  assert.match(table, /On leave today · Annual leave · First half/);
  assert.match(table, /Not tracked for this role/);
  assert.match(table, /Pending: .*Sick leave/);
  assert.doesNotMatch(table, /On leave today · Sick leave/);
  assert.match(table, /Designer One<\/td><td>Executioner \/ Designer/);
  assert.match(table, /8\.0h<\/td><td>8h/);
});

test("capacity briefing sizes team capacity, due work, urgent work and today risk", () => {
  const context = briefingContext();
  const report = vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-19", productiveHours: 7 })', context);
  assert.equal(report.designers, 3);
  assert.equal(report.available, 2);
  assert.equal(report.capacityToday, 14);
  assert.equal(report.nextDate, "2026-10-20");
  assert.equal(report.backlog.count, 6);
  assert.equal(report.backlog.hours, 4 + 5 + 12 + 5 + 4);
  assert.equal(vm.runInContext('capacityBriefingTasks("design")', context).some((item) => item.type === "Bug fix"), false);
  assert.equal(report.onLeaveList.map((member) => `${member.name}:${member.tasks.map((item) => item.id).join("|")}`).join(","), "Designer Three:leave-task");
  const leaveActions = vm.runInContext('leaveActionTasks("2026-10-19")', context);
  assert.equal(leaveActions.count, 1);
  assert.equal(leaveActions.groups.map((group) => `${group.status}:${group.tasks.map((item) => item.id).join("|")}`).join(","), "In Progress:leave-task");
  assert.equal(report.backlog.unknown, 1);
  assert.equal(report.dueToday.hours, 4 + 5);
  assert.equal(report.dueToday.overdue, 1);
  assert.ok(report.urgentToday.hours <= report.dueToday.hours);
  assert.equal(report.dueToday.count, 2);
  assert.equal(report.backlog.projects, 5);
  assert.equal(report.backlog.crs, 1);
  assert.equal(report.backlogProjects.projects, 5);
  assert.equal(report.backlogProjects.crs, 0);
  assert.equal(Object.keys(report.dueNext.byType).sort().join(","), "CR");
  assert.equal(report.urgentToday.hours, 5);
  assert.equal(report.urgentToday.overdue, 1);
  assert.equal(report.urgentNext.hours, 0);
  assert.equal(report.todayRisk, 14 - (4 + 5));
  assert.equal(report.fiveDayCapacity, 14 + 21 * 4);
  assert.equal(report.leaveDays, 1);
  assert.equal(report.fiveDayTasks.count, 4);
  assert.equal(report.fiveDayProjectTasks.projects, 3);
  assert.equal(report.assetAudit, null);
  const material = vm.runInContext('capacityBriefingTasks("design")', context).find((item) => item.id === "material");
  assert.equal(material.due, "2026-10-21");
  assert.equal(material.dueSource, "material");
  assert.equal(report.urgentList.map((item) => item.ref).join(","), "P-urgent-late");
});

test("urgent capacity cards exclude CRs while totals, risk and the detailed urgent list retain them", () => {
  const context = briefingContext();
  vm.runInContext(`
    state.workfrontProjects.find((project) => project.ref === "P-today").priority = "Urgent";
    state.workfrontChangeRounds[0].ahtHours = 3;
    state.workfrontChangeRounds.push({ ...state.workfrontChangeRounds[0], workfrontId: "CR-overdue", crId: "CR2",
      expectedDeliveryDate: "2026-10-16T10:00:00.000Z", ahtHours: 2 });
    state.projects.push({ id: "local-urgent", ref: "LOCAL-URGENT", productionTeamId: "design", priority: "Urgent" });
    state.tasks.push({ id: "local-urgent-cr", projectId: "local-urgent", category: "CR", crId: "CR1",
      status: "In Progress", etaDate: "2026-10-19", plannedHours: 4, loggedHours: 0 });
  `, context);
  const report = vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-19" })', context);
  assert.equal(report.urgentToday.hours, 9);
  assert.equal(report.urgentToday.projects, 2);
  assert.equal(report.urgentToday.crs, 0);
  assert.equal(report.urgentToday.overdue, 1);
  assert.equal(report.urgentNext.hours, 0);
  assert.equal(report.urgentNext.count, 0);
  assert.equal(report.dueToday.hours, 15);
  assert.equal(report.dueToday.crs, 2);
  assert.equal(report.dueNext.hours, 3);
  assert.equal(report.dueNext.crs, 1);
  assert.equal(report.backlog.crs, 3);
  assert.equal(report.dueTodayProjects.projects, 2);
  assert.equal(report.dueNextProjects.projects, 0);
  assert.equal(report.todayRisk, report.capacityToday - 15);
  assert.equal(report.urgentList.filter((task) => task.type === "CR").length, 3);
  context.report = report;
  const html = vm.runInContext("capacityBriefingHtml(report, {})", context);
  assert.match(html, /Of which urgent projects/);
  const urgentCards = html.match(/<tr><td[^>]*><div[^>]*>Of which urgent projects[\s\S]*?<\/tr>/)?.[0];
  assert.ok(urgentCards);
  assert.doesNotMatch(urgentCards, /\bCRs?\b|non-project items/);
  assert.match(urgentCards, /2 projects · 1 overdue/);
  assert.match(urgentCards, /0 projects/);
  assert.match(html, /LOCAL-URGENT/);
});

test("capacity briefing lists Current Urgent projects and separates NEXO/RICH projects as urgent", () => {
  const context = briefingContext();
  vm.runInContext(`
    state.workfrontProjects.push(
      { ref: "CURRENT-URGENT", title: "Current urgent project", sourceStatus: "Current", productionTeamId: "design",
        priority: "Urgent", materialExpectedDate: "2026-10-19" },
      { ref: "NEXO-LOW", title: "NEXO campaign", sourceStatus: "Execution in Progress", productionTeamId: "design",
        priority: "Low", materialExpectedDate: "2026-10-19" },
      { ref: "RICH-NORMAL", title: "RICH project", sourceStatus: "Current", productionTeamId: "design",
        priority: "Normal", materialExpectedDate: "2026-10-20" }
    );
    state.workfrontTasks.push({
      workfrontId: "NEXO-BUILD", projectRef: "NEXO-LOW", projectName: "NEXO campaign", taskName: "Build",
      taskStatus: "In Progress", productionTeamId: "design", assignmentNames: ["Designer One"], plannedHours: 4,
      actualHours: 0, percentComplete: 0, ahtHours: 4, materialExpectedDate: "2026-10-19",
      projectStatus: "Execution in Progress"
    });
  `, context);
  const report = vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-19" })', context);
  assert.ok(report.priorityUrgentList.some((item) => item.ref === "CURRENT-URGENT" && item.status === "Current"));
  assert.ok(report.namedUrgentList.some((item) => item.ref === "NEXO-LOW" && item.priority === "Low"));
  assert.ok(report.namedUrgentList.some((item) => item.ref === "RICH-NORMAL" && item.priority === "Normal"));
  assert.equal(report.urgentToday.projects, 2);
  assert.equal(report.urgentToday.hours, 9);
  context.report = report;
  const html = vm.runInContext("capacityBriefingHtml(report, {})", context);
  assert.match(html, /URGENT TASK LIST · PRIORITY/);
  assert.match(html, /ALSO URGENT · NEXO \/ RICH PROJECTS/);
  assert.match(html, /CURRENT-URGENT/);
  assert.match(html, /NEXO-LOW/);
  assert.match(html, /RICH-NORMAL/);
});

test("task-only RICH project 6621050 is listed once without inventing production workload or delivery dates", () => {
  const context = briefingContext();
  const baseline = vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-19" })', context);
  vm.runInContext(`
    for (const taskName of ["Asset Audit", "Build", "Build", "Bug Fixing"]) {
      state.workfrontTasks.push({ workfrontId: "6621050-" + taskName, projectRef: "6621050",
        projectName: "RICH | FR_Ophtha_Vabysmo_Banner_PROD", taskName, taskStatus: "New",
        productionTeamId: "design", assignmentNames: [], materialExpectedDate: "", plannedCompletionDate: "2026-10-19" });
    }
  `, context);
  const report = vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-19" })', context);
  const matches = report.namedUrgentList.filter((item) => item.ref === "6621050");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].status, "New");
  assert.equal(matches[0].due, "");
  assert.equal(matches[0].remaining, null);
  assert.equal(report.backlog.count, baseline.backlog.count);
  assert.equal(report.backlog.hours, baseline.backlog.hours);
  assert.equal(report.todayRisk, baseline.todayRisk);
  context.report = report;
  assert.match(vm.runInContext("capacityBriefingHtml(report)", context), /6621050/);
  const rows = vm.runInContext("capacityBriefingSourceRows(report)", context).filter((row) => row[5] === "6621050");
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1], "Workfront task");
  assert.equal(rows[0][15], "Urgent list only; excluded from capacity work figures");
});

test("task-only named urgent fallback respects team, status, existing production work and NEXO review exclusions", () => {
  const context = briefingContext();
  vm.runInContext(`
    const build = { taskName: "Build", taskStatus: "New", productionTeamId: "design", assignmentNames: [] };
    state.workfrontTasks.push(
      { ...build, projectRef: "OPEN-NEXO", projectName: "NEXO campaign" },
      { ...build, projectRef: "DONE-RICH", projectName: "RICH done", taskStatus: "Complete" },
      { ...build, projectRef: "OTHER-RICH", projectName: "RICH other", productionTeamId: "web" },
      { ...build, projectRef: "PENDING-RICH", projectName: "RICH pending", projectStatus: "Pending Clarification" },
      { ...build, projectRef: "REVIEW-NEXO", projectName: "NEXO review" },
      { projectRef: "REVIEW-NEXO", taskName: "Engagement Lead Review", taskStatus: "In Progress" },
      { ...build, projectRef: "PRODUCTION-RICH", projectName: "RICH production", projectStatus: "Execution in Progress",
        ahtHours: 2, materialExpectedDate: "2026-10-19" }
    );
  `, context);
  const report = vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-19" })', context);
  assert.equal(report.namedUrgentList.map((item) => item.ref).sort().join(","), "OPEN-NEXO,PRODUCTION-RICH");
  assert.equal(report.sourceUrgentProjects.map((item) => item.ref).join(","), "OPEN-NEXO");
  assert.equal(report.sourceTasks.filter((item) => item.ref === "PRODUCTION-RICH").length, 1);
});

test("pending clarification briefing cards show counts and Excel source export includes project and CR rows", async () => {
  const context = briefingContext();
  vm.runInContext(`
    state.workfrontProjects.push({ ref: "PENDING-P", title: 'Pending "project"', sourceStatus: "Pending Clarification",
      productionTeamId: "design", priority: "High" });
    state.workfrontChangeRounds.push({ workfrontId: "PENDING-CR", projectRef: "PENDING-P", crId: "CR-7",
      title: "Clarification CR", sourceStatus: "Pending Clarification", productionTeamId: "design", assignee: "Designer One" });
  `, context);
  const report = vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-19" })', context);
  assert.equal(report.pendingClarification.projects.length, 1);
  assert.equal(report.pendingClarification.changeRounds.length, 1);
  assert.equal(report.backlog.count, 6);
  context.report = report;
  const html = vm.runInContext("capacityBriefingHtml(report, {})", context);
  assert.match(html, /Pending clarification · projects/);
  assert.match(html, /Pending clarification · CRs/);
  assert.doesNotMatch(html, /Pending clarification · project focus/);
  assert.doesNotMatch(html, /Pending &quot;project&quot;|Clarification CR/);
  assert.match(html, /1 <span[^>]*>project<\/span>/);
  assert.match(html, /1 <span[^>]*>CR<\/span>/);
  report.pendingClarification.changeRounds.push({ ...report.pendingClarification.changeRounds[0], id: "second-pending-cr" });
  assert.match(vm.runInContext("capacityBriefingHtml(report, {})", context), /2 <span[^>]*>CRs<\/span>/);
  report.pendingClarification.changeRounds.pop();
  const csv = vm.runInContext("capacityBriefingSourceCsv(report)", context);
  assert.match(csv, /Separate pending clarification project card; excluded from capacity work figures/);
  assert.match(csv, /Separate pending clarification CR card; excluded from capacity work figures/);
  assert.match(csv, /"Pending ""project"""/);
  context.report = report;
  const eml = vm.runInContext('capacityBriefingEmailMessage(report, {}, "leadership@example.com")', context);
  assert.match(eml, /Content-Type: multipart\/mixed/);
  assert.match(eml, /Content-Disposition: attachment; filename="Design-Team-capacity-briefing-source-2026-10-19\.csv"/);
  const attachment = eml.split("\r\n\r\n").at(-1).split("\r\n--capacity-briefing-")[0].replace(/\r\n/g, "");
  assert.match(Buffer.from(attachment, "base64").toString("utf8"), /Separate pending clarification CR card; excluded from capacity work figures/);
  const workbook = vm.runInContext("capacityBriefingXlsx(report)", context);
  const sheet = (await readXlsx(Buffer.from(workbook))).find((item) => item.sheet === "Briefing Source Data");
  assert.equal(sheet.data[0][0], "Record category");
  assert.ok(sheet.data.some((row) => row[0] === "Pending clarification" && row[4] === "Project" && row[5] === "PENDING-P"));
  assert.ok(sheet.data.some((row) => row[0] === "Pending clarification" && row[4] === "CR" && row[6] === "CR-7"));
});

test("pending clarification named-urgent projects stay count-only and appear once in the source report", () => {
  const context = briefingContext();
  const baseline = vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-19" })', context);
  vm.runInContext(`
    state.workfrontProjects.push(
      { ref: "PENDING-NEXO", title: "NEXO awaiting answers", sourceStatus: "Pending Clarification", productionTeamId: "design", priority: "Urgent" },
      { ref: "PENDING-RICH", title: "RICH awaiting answers", sourceStatus: "Pending Clarification", productionTeamId: "design" },
      { ref: "OTHER-TEAM", title: "Other team pending", sourceStatus: "Pending Clarification", productionTeamId: "web" }
    );
    state.projects.push({ id: "local-pending", ref: "LOCAL-PENDING", title: "Local pending project",
      status: "Pending Clarification", productionTeamId: "design" });
    state.tasks.push({ id: "local-pending-build", projectId: "local-pending", category: "Build", status: "In Progress",
      assignee: "Designer One", plannedHours: 12, loggedHours: 0, etaDate: "2026-10-19" });
  `, context);
  const report = vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-19" })', context);
  assert.equal(report.pendingClarification.projects.length, 2);
  assert.equal(report.backlog.count, baseline.backlog.count);
  assert.equal(report.backlog.hours, baseline.backlog.hours);
  assert.equal(report.todayRisk, baseline.todayRisk);
  assert.equal(report.urgentList.length, baseline.urgentList.length);
  context.report = report;
  const html = vm.runInContext("capacityBriefingHtml(report)", context);
  assert.doesNotMatch(html, /NEXO awaiting answers|RICH awaiting answers|Other team pending|Local pending project/);
  const rows = vm.runInContext("capacityBriefingSourceRows(report)", context);
  for (const ref of ["PENDING-NEXO", "PENDING-RICH"]) {
    const matches = rows.filter((row) => row[5] === ref);
    assert.equal(matches.length, 1);
    assert.equal(matches[0][0], "Pending clarification");
  }
  assert.equal(rows.some((row) => row[5] === "OTHER-TEAM"), false);
});

test("NEXO projects in Engagement Lead Review are excluded from all briefing work and exports", () => {
  const context = briefingContext();
  const baseline = vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-19" })', context);
  vm.runInContext(`
    for (const [ref, status] of [["NEXO-BUILD", "Execution in Progress"], ["NEXO-PROJECT", "Current"], ["NEXO-PENDING", "Pending Clarification"]]) {
      state.workfrontProjects.push({ ref, title: "NEXO " + ref, sourceStatus: status, productionTeamId: "design", priority: "Urgent" });
      state.workfrontTasks.push({ projectRef: " " + ref.toLowerCase() + " ", taskName: " Engagement  Lead Review ",
        taskStatus: " IN PROGRESS ", productionTeamId: "leadership" });
    }
    state.workfrontTasks.push({ workfrontId: "nexo-build", projectRef: "NEXO-BUILD", projectName: "NEXO build", taskName: "Build",
      taskStatus: "In Progress", projectStatus: "Execution in Progress", productionTeamId: "design", assignmentNames: ["Designer Three"],
      ahtHours: 12, materialExpectedDate: "2026-10-19" });
    state.workfrontChangeRounds.push({ workfrontId: "nexo-cr", projectRef: "NEXO-BUILD", crId: "CR-9", title: "NEXO CR",
      sourceStatus: "In Progress", productionTeamId: "design", ahtHours: 3, expectedDeliveryDate: "2026-10-19" },
      { workfrontId: "nexo-pending-cr", projectRef: "NEXO-PENDING", crId: "CR-10", title: "NEXO pending CR",
        sourceStatus: "Pending Clarification", productionTeamId: "design" });
    state.projects.push({ id: "local-nexo", ref: "NEXO-BUILD", title: "NEXO local", productionTeamId: "design", status: "In Progress" });
    state.tasks.push({ id: "local-nexo-cr", projectId: "local-nexo", category: "CR", crId: "CR-11", status: "In Progress",
      plannedHours: 2, etaDate: "2026-10-19" });
  `, context);
  const report = vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-19" })', context);
  for (const key of ["backlog", "dueToday", "dueNext", "urgentToday", "urgentNext", "fiveDayTasks", "onLeaveList"]) {
    assert.equal(JSON.stringify(report[key]), JSON.stringify(baseline[key]), key);
  }
  assert.equal(report.todayRisk, baseline.todayRisk);
  assert.equal(report.urgentList.length, baseline.urgentList.length);
  assert.equal(report.pendingClarification.projects.length, 0);
  assert.equal(report.pendingClarification.changeRounds.length, 0);
  context.report = report;
  assert.doesNotMatch(vm.runInContext("capacityBriefingHtml(report)", context), /NEXO (?:NEXO|build|CR|local)/);
  assert.doesNotMatch(vm.runInContext("capacityBriefingSourceCsv(report)", context), /NEXO-BUILD|NEXO-PROJECT|NEXO-PENDING/);
});

test("NEXO review exclusion is status-specific, uses Gantt tasks and leaves RICH projects unchanged", () => {
  for (const [name, status, taskName, excluded] of [
    ["NEXO campaign", "In Progress", "Engagement Lead Review", true],
    ["NEXO campaign", "New", "Engagement Lead Review", false],
    ["NEXO campaign", "Complete", "Engagement Lead Review", false],
    ["NEXO campaign", "In Progress", "Internal Review", false],
    ["RICH campaign", "In Progress", "Engagement Lead Review", false]
  ]) {
    const context = briefingContext();
    context.projectName = name;
    context.reviewStatus = status;
    context.reviewTaskName = taskName;
    vm.runInContext(`
      state.workfrontTasks.push({ workfrontId: "review-build", projectRef: "REVIEW-PROJECT", projectName,
        taskName: "Build", taskStatus: "New", projectStatus: "Execution in Progress", productionTeamId: "design",
        assignmentNames: [], ahtHours: 2, materialExpectedDate: "2026-10-19" });
      state.workfrontGanttTasks = [{ projectRef: "REVIEW-PROJECT", taskName: reviewTaskName, taskStatus: reviewStatus }];
    `, context);
    const report = vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-19" })', context);
    assert.equal(report.sourceTasks.some((item) => item.ref === "REVIEW-PROJECT"), !excluded, `${name}: ${taskName} / ${status}`);
    assert.equal(report.namedUrgentList.some((item) => item.ref === "REVIEW-PROJECT"), !excluded);
  }
});

test("urgent capacity cards are empty when all urgent work consists of CRs", () => {
  const context = briefingContext();
  vm.runInContext(`
    state.workfrontTasks = [];
    state.workfrontProjects.find((project) => project.ref === "P-today").priority = "Urgent";
    state.workfrontChangeRounds[0].ahtHours = 3;
  `, context);
  const report = vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-19" })', context);
  assert.equal(report.urgentToday.count, 0);
  assert.equal(report.urgentNext.count, 0);
  assert.equal(report.backlog.crs, 1);
  assert.equal(report.dueNext.hours, 3);
  assert.equal(report.urgentList.length, 1);
});

test("capacity briefing email HTML is self-contained, escaped and includes notes", () => {
  const context = briefingContext();
  context.snapshot.workfrontTasks[0].projectName = "<script>alert(1)</script>";
  vm.runInContext("applySnapshot(snapshot);", context);
  const html = vm.runInContext(`capacityBriefingHtml(capacityBriefing({ teamId: "design", date: "2026-10-19" }),
    { actions: "Move Designer Two to urgent work\\n\\nExtend shift", support: "One freelancer", proposed: { "urgent-late": "2026-10-20" } })`, context);
  assert.match(html, /Design Capacity &amp; Delivery Briefing/);
  assert.match(html, /TODAY HEADROOM|TODAY RISK/);
  assert.match(html, /<li[^>]*>Move Designer Two to urgent work<\/li><li[^>]*>Extend shift<\/li>/);
  assert.match(html, /One freelancer/);
  assert.match(html, /Tue,? 20 Oct/);
  assert.match(html, /Total project due today/);
  assert.match(html, /\d+ projects?/);
  assert.doesNotMatch(html, /\d+ projects? · \d+ CRs?/);
  assert.match(html, /Pending clarification · CRs/);
  assert.doesNotMatch(html, /Cut-off|2:30pm|deliverable/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /class=/);
});

test("bug fixing effort is capped at 15% of the project's Build effort", () => {
  const { bugFixEffortHours } = require("../server");
  assert.equal(bugFixEffortHours(28, 160), 24);
  assert.equal(bugFixEffortHours(2, 160), 2);
  assert.equal(bugFixEffortHours(null, 40), 6);
  assert.equal(bugFixEffortHours(3, null), 3);
});

test("capacity briefing moves holiday reporting and material dates to the next working day", () => {
  const context = briefingContext();
  context.snapshot.holidays = [{ date: "2026-10-20", name: "Dussehra" }];
  context.snapshot.workfrontTasks.push({ projectStatus: "Awaiting Execution", ahtHours: 2, workfrontId: "festival", projectRef: "P-festival", projectName: "Festival", taskName: "Build", taskStatus: "New",
    productionTeamId: "design", assignmentNames: [], plannedHours: 2, actualHours: 0, percentComplete: 0, plannedCompletionDate: "2026-10-01", materialExpectedDate: "2026-10-20" });
  vm.runInContext("applySnapshot(snapshot);", context);
  const report = vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-20" })', context);
  assert.equal(report.reportDate, "2026-10-21");
  assert.equal(report.nextDate, "2026-10-22");
  assert.equal(report.requestedHoliday.name, "Dussehra");
  const festival = vm.runInContext('capacityBriefingTasks("design")', context).find((item) => item.id === "festival");
  assert.equal(festival.due, "2026-10-21");
  assert.equal(festival.movedFrom, "2026-10-20");
  assert.equal(festival.movedHoliday, "Dussehra");
  const html = vm.runInContext('capacityBriefingHtml(capacityBriefing({ teamId: "design", date: "2026-10-20" }), {})', context);
  assert.match(html, /Dussehra — next working day used/);
  assert.doesNotMatch(html, /ON LEAVE/);
  assert.match(vm.runInContext('dateWithHoliday("2026-10-20")', context), /holiday-flag[^>]*>Holiday · Dussehra/);
});

test("campaigns use the 4-hour end-to-end SLA when no AHT matrix row exists", () => {
  const { validationMatrixEstimate, bugFixEffortHours } = require("../server");
  const estimate = validationMatrixEstimate("Campaign", "New Build", "High", 4, "Build");
  assert.equal(estimate.productionHours, 4);
  assert.equal(estimate.qaHours, 0);
  assert.equal(validationMatrixEstimate("Campaign", "", "", 0, "Build").productionHours, 4);
  assert.equal(bugFixEffortHours(null, estimate.productionHours), 0.6);
});

test("half-day leave counts as half a day of capacity", () => {
  const context = briefingContext();
  context.snapshot.leaves.push({ assignee: "Designer One", startDate: "2026-10-19", endDate: "2026-10-19", status: "Approved", type: "Personal leave", halfDay: "Second half" });
  vm.runInContext("applySnapshot(snapshot);", context);
  const report = vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-19", productiveHours: 7 })', context);
  assert.equal(report.capacityToday, 7 + 3.5);
  assert.equal(report.available, 2);
  assert.equal(report.halfDayToday, 1);
  assert.equal(report.leaveDays, 1.5);
  assert.equal(vm.runInContext('isScheduledWorkday("2026-10-19", "Designer One")', context), true);
  const halfDay = report.onLeaveList.find((member) => member.name === "Designer One");
  assert.match(halfDay.leaveType, /Half day · Second half/);
  assert.match(vm.runInContext('capacityBriefingHtml(capacityBriefing({ teamId: "design", date: "2026-10-19" }), {})', context), /1 half day/);
});

test("email briefing counts asset audit projects split into Audit and Pre-Audit", () => {
  const context = briefingContext();
  const project = (ref, sourceStatus, auditAhtHours) => ({ ref, sourceStatus, productionTeamId: "email", auditAhtHours });
  context.snapshot.workfrontProjects.push(project("A1", "Pre-Audit", 1.5), project("A2", "Current", 2), project("A3", "Audit Ongoing", null),
    project("A4", "Pre-Audit", 1), project("A5", "Pending Clarification", 3), project("A6", "Pre-Audit Complete", 3), project("A7", "Awaiting Execution", 3),
    { ...project("W1", "Current", 4), productionTeamId: "web" });
  // A2 is half audited; A4 has no Asset Audit task yet but still counts.
  context.snapshot.workfrontTasks.push({ workfrontId: "t-A2", projectRef: "A2", taskName: "Asset Audit", taskStatus: "In Progress", productionTeamId: "email", assignmentNames: [], percentComplete: 50 });
  context.snapshot.departments.push({ id: "email", name: "Email Team" });
  vm.runInContext("applySnapshot(snapshot);", context);
  const report = vm.runInContext('capacityBriefing({ teamId: "email", date: "2026-10-19" })', context);
  assert.equal(report.assetAudit.count, 4);
  assert.equal(report.assetAudit.unknown, 1);
  assert.deepEqual({ ...report.assetAudit.preAudit }, { count: 2, hours: 2.5 });
  assert.deepEqual({ ...report.assetAudit.audit }, { count: 2, hours: 1 });
  const html = vm.runInContext('capacityBriefingHtml(capacityBriefing({ teamId: "email", date: "2026-10-19" }), {})', context);
  assert.match(html, /Asset audit — total projects/);
  assert.match(html, />4 <span[^>]*>projects</);
  assert.match(html, /Audit: 2 · Pre-Audit: 2/);
  assert.match(html, /Audit: 1\.0h · Pre-Audit: 2\.5h/);
  assert.doesNotMatch(vm.runInContext('capacityBriefingHtml(capacityBriefing({ teamId: "design", date: "2026-10-19" }), {})', context), /Asset audit/);
});


test("workfront template planned hours are not used as capacity effort", () => {
  const context = briefingContext();
  context.snapshot.workfrontTasks.push({ projectStatus: "Awaiting Execution", workfrontId: "template", projectRef: "P-template", taskName: "Build", taskStatus: "New", productionTeamId: "design",
    assignmentNames: [], plannedHours: 64, ahtHours: null, percentComplete: 0, materialExpectedDate: "2026-10-19" });
  vm.runInContext("applySnapshot(snapshot);", context);
  const item = vm.runInContext('capacityBriefingTasks("design")', context).find((row) => row.id === "template");
  assert.equal(item.remaining, null);
  const html = vm.runInContext('capacityBriefingHtml(capacityBriefing({ teamId: "design", date: "2026-10-19" }), {})', context);
  assert.match(html, /1 without AHT estimate/);
});

test("workfront builds count only in production and CRs use their own delivery date", () => {
  const context = briefingContext();
  const base = { taskName: "Build", taskStatus: "New", productionTeamId: "design", assignmentNames: [], ahtHours: 5, percentComplete: 0, materialExpectedDate: "2026-10-19" };
  context.snapshot.workfrontTasks.push({ ...base, workfrontId: "pre-audit", projectRef: "P-pre", projectStatus: "Pre-Audit Complete" },
    { ...base, workfrontId: "current", projectRef: "P-cur", projectStatus: "Current" },
    { ...base, workfrontId: "no-project", projectRef: "P-none", projectStatus: "" },
    { ...base, workfrontId: "awaiting", projectRef: "P-await", projectStatus: "Awaiting Execution", materialExpectedDate: "", plannedCompletionDate: "2026-10-01" });
  context.snapshot.workfrontChangeRounds[0].materialExpectedDate = "2026-09-29";
  vm.runInContext("applySnapshot(snapshot);", context);
  const tasks = vm.runInContext('capacityBriefingTasks("design")', context);
  assert.deepEqual(["pre-audit", "current", "no-project"].filter((id) => tasks.some((item) => item.id === id)), []);
  const awaiting = tasks.find((item) => item.id === "awaiting");
  assert.equal(awaiting.due, "", "planned completion is not used for Workfront builds");
  const cr = tasks.find((item) => item.id === "CR-1");
  assert.equal(cr.due, "2026-10-20");
  assert.equal(cr.dueSource, "cr");
});

test("Email + eDetailer briefing combines workload and counts shared developer capacity once", () => {
  const context = briefingContext();
  context.snapshot.departments.push({ id: "email", name: "Email Team" });
  context.snapshot.team.push({ name: "Email Developer", role: "executioner", teamIds: ["email"], shiftStart: "09:00", shiftEnd: "18:00" });
  const base = { taskName: "Build", taskStatus: "New", productionTeamId: "email", assignmentNames: [], percentComplete: 0, projectStatus: "Execution in Progress" };
  context.snapshot.workfrontTasks.push({ ...base, workfrontId: "mail", projectRef: "P-mail", assetType: "Email", ahtHours: 5, materialExpectedDate: "2026-10-19" },
    { ...base, workfrontId: "edet", projectRef: "P-edet", assetType: "eDetailer", ahtHours: 120, materialExpectedDate: "2027-01-21" });
  vm.runInContext("applySnapshot(snapshot);", context);
  const report = vm.runInContext('capacityBriefing({ teamId: "email", date: "2026-10-19" })', context);
  assert.equal(report.team, "Email + eDetailer Team");
  assert.equal(report.backlog.hours, 125);
  assert.equal(report.capacityToday, 7);
  assert.equal(report.fiveDayCapacity, 35);
  assert.equal(report.eDetailer.backlog.hours, 120);
  assert.equal(report.eDetailer.backlog.projects, 1);
  assert.equal(report.eDetailer.nextDue, "2027-01-21");
  const html = vm.runInContext('capacityBriefingHtml(capacityBriefing({ teamId: "email", date: "2026-10-19" }), {})', context);
  assert.match(html, /eDetailer backlog \(included in totals\)/);
  assert.match(html, /Shared Email \+ eDetailer capacity \(counted once\)/);
  context.snapshot.workfrontTasks.find((row) => row.workfrontId === "edet").materialExpectedDate = "2026-10-19";
  vm.runInContext("applySnapshot(snapshot);", context);
  const combined = vm.runInContext('capacityBriefing({ teamId: "email", date: "2026-10-19" })', context);
  assert.equal(combined.dueTodayProjects.hours, 125);
  assert.equal(combined.fiveDayProjectTasks.hours, 125);
  assert.equal(combined.todayRisk, 7 - 125);
  context.report = combined;
  assert.match(vm.runInContext("capacityBriefingSourceCsv(report)", context), /Included in Email \+ eDetailer totals/);
  assert.equal(vm.runInContext('capacityBriefing({ teamId: "design", date: "2026-10-19" })', context).eDetailer, null);
});

test("capacity briefing calls Email, eDetailer and Web members developers and Design and Video members designers", () => {
  const context = briefingContext();
  for (const [teamId, label] of [["email", "developer"], ["edetailer", "developer"], ["web", "developer"], ["design", "designer"], ["video", "designer"]]) {
    for (const available of [0, 1, 2]) {
      const html = vm.runInContext(`capacityBriefingHtml({
        ...capacityBriefing({ teamId: "${teamId}", date: "2026-10-19" }), available: ${available}
      })`, context);
      assert.match(html, new RegExp(`${available} available ${label}${available === 1 ? "" : "s"} ×`));
      assert.doesNotMatch(html, new RegExp(`available ${label === "developer" ? "designer" : "developer"}`));
    }
  }
});

test("tomorrow's report skips weekends and holidays and is marked as an advance report", () => {
  const context = briefingContext();
  context.snapshot.holidays = [{ date: "2026-10-20", name: "Dussehra" }];
  vm.runInContext("applySnapshot(snapshot);", context);
  assert.equal(vm.runInContext('tomorrowBriefingDate("2026-10-19")', context), "2026-10-21");
  assert.equal(vm.runInContext('tomorrowBriefingDate("2026-10-23")', context), "2026-10-26");
  const html = vm.runInContext('capacityBriefingHtml({ ...capacityBriefing({ teamId: "design", date: "2026-10-21" }), preparedOn: "2026-10-19" }, {})', context);
  assert.match(html, /Advance report · prepared Mon,? 19 Oct/);
});
