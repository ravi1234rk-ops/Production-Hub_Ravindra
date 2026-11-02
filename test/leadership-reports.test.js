"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const readXlsxFile = require("read-excel-file/node");
const { unzipSync, strFromU8 } = require("fflate");
const { indiaDate, dueWindows, qualitySummary, availableHours, buildReport, reportTotals, bulletin, reportWorkbook } = require("../leadership-reports");

const window = { kind: "weekly", from: "2026-10-19", to: "2026-10-25" };
const departments = [{ id: "design", name: "Design Team" }, { id: "email", name: "Email Team" }];
const row = (overrides = {}) => ({ ref: "D1", type: "Build", crId: "", teamId: "design", names: ["A"],
  status: "Complete", completedAt: "2026-10-23", plannedCompletionDate: "2026-10-23", outcome: "Pass", ftr: true, rework: false,
  qaPublished: true, confirmedBy: "Published QA", ...overrides });

test("India schedule prepares previous day and previous Monday–Sunday at 09:00, including startup catch-up and reporting floor", () => {
  assert.equal(indiaDate("2026-10-25T19:00:00Z"), "2026-10-26");
  assert.equal(indiaDate(undefined), "");
  assert.equal(indiaDate("2026-10-32"), "");
  assert.deepEqual(dueWindows(new Date("2026-10-26T03:29:59Z")), [
    { kind: "daily", from: "2026-10-24", to: "2026-10-24" },
    { kind: "weekly", from: "2026-10-12", to: "2026-10-18" }
  ]);
  assert.deepEqual(dueWindows(new Date("2026-10-26T03:30:00Z")), [
    { kind: "daily", from: "2026-10-25", to: "2026-10-25" }, window
  ]);
  assert.deepEqual(dueWindows(new Date("2026-10-28T10:00:00Z"))[1], window);
  assert.deepEqual(dueWindows(new Date("2026-07-01T10:00:00Z")), []);
  assert.deepEqual(dueWindows(new Date("2026-07-06T10:00:00Z"))[1], { kind: "weekly", from: "2026-07-01", to: "2026-07-05" });
  assert.deepEqual(dueWindows(new Date("2026-10-05T10:00:00Z"))[1], { kind: "weekly", from: "2026-09-28", to: "2026-10-04" });
});

test("FTR deduplicates multiple executors and excludes unpublished, missing dates, uncertain first-pass decisions and unidentified CRs", () => {
  const summary = qualitySummary([
    row(), row({ names: ["B"] }),
    row({ ref: "D2", outcome: "Rework", rework: true, ftr: false }),
    row({ ref: "D3", qaPublished: false }),
    row({ ref: "E1", teamId: "email", qaPublished: false, firstTime: true, confirmedBy: "QA" }),
    row({ ref: "E2", teamId: "email", qaPublished: false, ftr: false }),
    row({ ref: "D4", completedAt: "" }),
    row({ ref: "D5", status: "In Progress" }),
    row({ ref: "D6", type: "CR" })
  ]);
  assert.equal(summary.deliveries.length, 8);
  assert.equal(summary.eligible, 3);
  assert.equal(summary.ftr, 2);
  assert.equal(summary.rework, 1);
  assert.equal(summary.pending, 5);
  assert.equal(summary.rate, 66.67);
  assert.deepEqual(summary.deliveries[0].names, ["A", "B"]);
  assert.equal(summary.deliveries.at(-1).qualityStatus, "CR identity unverified");
  assert.equal(qualitySummary([row({ qaPublished: false })]).rate, null);
  assert.equal(qualitySummary([row({ completedAt: undefined })]).eligible, 0, "missing dates must never default to today");
  assert.equal(qualitySummary([row(), row({ type: "CR" })]).deliveries.length, 2, "an unidentified CR is not the project's Build");
  const contradictory = qualitySummary([row(), row({ names: ["B"], outcome: "Rework", rework: true, ftr: false })]);
  assert.equal(contradictory.eligible, 1);
  assert.equal(contradictory.ftr, 0);
  assert.equal(contradictory.rework, 1);
});

test("bulletin CRs without CR numbers count per QA task, while other unidentified CRs stay unverified", () => {
  const cr = (task, overrides = {}) => row({ ref: "C1", type: "CR", qualityIdentity: `c1:build:unidentified-cr:${task}`, ...overrides });
  const summary = qualitySummary([
    cr("QA-1"), cr("QA-2", { outcome: "Rework", rework: true, ftr: false }), cr("QA-3", { names: ["B"] }), cr("QA-3", { names: ["C"] }),
    row({ ref: "C2", type: "CR" })
  ]);
  assert.equal(summary.deliveries.length, 4, "same QA task across executors is one delivery");
  assert.equal(summary.eligible, 3);
  assert.equal(summary.ftr, 2);
  assert.equal(summary.rework, 1);
  assert.equal(summary.deliveries.at(-1).qualityStatus, "CR identity unverified");
  assert.equal(qualitySummary([cr("QA-1", { qaPublished: false })]).eligible, 0);
  const bulletinOwned = qualitySummary([row({ names: ["Bulletin"] }), row({ names: ["Workfront only"], qaPublished: false, confirmedBy: "" })]);
  assert.deepEqual(bulletinOwned.deliveries[0].names, ["Bulletin"], "other Workfront assignees are not credited with a bulletin delivery");
  const unattributed = qualitySummary([row({ names: [], qaExecutor: "Hema Rawat" })]);
  assert.equal(unattributed.eligible, 1, "a published bulletin delivery counts even when its executor is not rostered");
  assert.equal(unattributed.ftr, 1);
});

test("capacity excludes weekends, holidays and approved full/half leave without duplicating overlapping leave", () => {
  const member = { name: "A" };
  const leaves = [{ assignee: "A", status: "Approved", startDate: "2026-10-20", endDate: "2026-10-20", halfDay: "First half" },
    { assignee: "A", status: "Approved", startDate: "2026-10-21", endDate: "2026-10-21" },
    { assignee: "A", status: "Pending", startDate: "2026-10-22", endDate: "2026-10-22" }];
  assert.equal(availableHours(member, window.from, window.to, [{ date: "2026-10-19" }], leaves, 8), 20);
  leaves.push({ ...leaves[0] });
  assert.equal(availableHours(member, window.from, window.to, [{ date: "2026-10-19" }], leaves, 8), 20);
  leaves.push({ ...leaves[0], halfDay: "Second half" });
  assert.equal(availableHours(member, window.from, window.to, [{ date: "2026-10-19" }], leaves, 8), 16);
});

function sampleReport() {
  const deliveries = [
    { ...row(), source: "workfront", id: "T1", hours: 8 },
    { ...row(), source: "workfront", id: "T2", hours: 8, names: ["B"] },
    { ...row({ ref: "E1", teamId: "email", qaPublished: false }), source: "workfront", id: "E-T1", hours: null },
    { ref: "D1", type: "QA Audit", teamId: "design", source: "workfront", id: "QA1", status: "Complete", completedAt: "2026-10-23", names: ["QA"] }
  ];
  return { ...buildReport({ window, departments,
    members: [{ name: "A", role: "executioner", teamIds: ["design"] }, { name: "B", role: "executioner", teamIds: ["email"] },
      { name: "Shared", role: "auditor", teamIds: ["design", "email"] }],
    deliveries, qualityRows: [row(), row({ names: ["B"] }), row({ ref: "E1", teamId: "email", qaPublished: false, confirmedBy: "" })],
    logs: [
      { id: "OLD", taskId: "T1", userName: "A", projectRef: "D1", date: "2026-10-18", hours: 2 },
      { id: "L1", taskId: "T1", userName: "A", projectRef: "D1", date: "2026-10-23", hours: 6 },
      { id: "L1", taskId: "T1", userName: "A", projectRef: "D1", date: "2026-10-23", hours: 6 },
      { id: "L2", taskId: "T2", userName: "Shared", projectRef: "D1", date: "2026-10-23", hours: 2 },
      { id: "L3", taskId: "E-T1", userName: "B", projectRef: "E1", date: "2026-10-23", hours: 3 },
      { id: "L4", taskId: "MISSING", userName: "Unknown", date: "2026-10-23", hours: 1 }
    ],
    activityLogs: [{ userName: "A", category: "Meeting", date: "2026-10-23", hours: 1 },
      { userName: "Shared", category: "Training", date: "2026-10-23", hours: 2 }],
    holidays: [], leaves: [], capacityHoursPerDay: 8, now: new Date("2026-10-26T04:00:00Z"),
    source: { status: "success", lastSuccessAt: "2026-10-26T03:00:00Z" }
  }), id: "weekly-2026-10-19-2026-10-25", version: 1 };
}

test("team/leadership totals use distinct production, dated effort, dedicated/shared capacity and like-for-like paired benchmarks", () => {
  const report = sampleReport();
  const design = report.teams.find((team) => team.id === "design");
  assert.equal(design.deliveriesCompleted, 1);
  assert.equal(design.tasksCompleted, 3);
  assert.equal(design.productiveHours, 8);
  assert.equal(design.attributableHours, 6);
  assert.equal(design.capacityHours, 40);
  assert.equal(design.utilisation, 15);
  assert.equal(design.benchmarkHours, 8, "do not multiply an asset benchmark by duplicate imported task rows");
  assert.equal(design.pairedActualHours, 10, "paired actual includes earlier logged effort, not just this week's hours");
  assert.equal(design.ftr.eligible, 1);
  assert.equal(design.ftr.ftr, 1);
  assert.equal(design.meetingHours, 1);
  assert.equal(report.teams.find((team) => team.id === "shared").capacityHours, 40);
  assert.equal(report.teams.find((team) => team.id === "shared").trainingHours, 2);
  assert.equal(report.teams.find((team) => team.id === "email").missingBenchmarks, 1);
  const totals = reportTotals(report.teams);
  assert.equal(totals.capacityHours, 120);
  assert.equal(totals.productiveHours, 12);
  assert.equal(totals.utilisation, 10);
  assert.equal(totals.deliveriesCompleted, 2);
  assert.equal(totals.ftr.rate, 100);
  assert.equal(totals.ftr.pending, 1);
});

test("Email + eDetailer leadership report includes both workloads against one developer pool", () => {
  const deliveries = ["Email", "eDetailer"].map((assetType, index) => ({
    ...row({ ref: `MAIL-${index}`, teamId: "email", names: ["Developer"], qaPublished: false }),
    assetType, source: "workfront", id: `TASK-${index}`, hours: 2
  }));
  const report = buildReport({ window, departments, members: [{ name: "Developer", role: "executioner", teamIds: ["email"] }],
    deliveries, qualityRows: [], logs: deliveries.map((task) => ({ id: task.id, taskId: task.id,
      userName: "Developer", projectRef: task.ref, date: "2026-10-23", hours: 2 })),
    activityLogs: [], holidays: [], leaves: [], capacityHoursPerDay: 8 });
  const email = report.teams.find((team) => team.id === "email");
  assert.equal(email.name, "Email + eDetailer Team");
  assert.equal(email.capacityHours, 40);
  assert.equal(email.members.length, 1);
  assert.equal(email.deliveriesCompleted, 2);
  assert.equal(email.productiveHours, 4);
  assert.equal(email.utilisation, 10);
});

test("daily date buckets honour India midnight and never distribute cumulative actual hours across days", () => {
  const report = buildReport({ window: { kind: "daily", from: "2026-10-23", to: "2026-10-23" }, departments,
    members: [], deliveries: [{ ...row(), completedAt: "2026-10-22", completionTimestamp: "2026-10-22T20:00:00Z", id: "T", source: "workfront", actualHours: 100 }],
    qualityRows: [row({ completedAt: "2026-10-22", completionTimestamp: "2026-10-22T20:00:00Z" })], logs: [{ id: "L", taskId: "T", date: "2026-10-22T20:00:00Z", hours: 2 }],
    activityLogs: [], holidays: [], leaves: [], capacityHoursPerDay: 8 });
  assert.equal(report.teams[0].productiveHours, 2);
  assert.equal(report.teams[0].capacityHours, 0);
  assert.equal(report.teams[0].utilisation, null);
  assert.equal(report.teams[0].deliveriesCompleted, 1);
  assert.equal(report.teams[0].production[0].completedAt, "2026-10-23");
});

test("Excel and copyable bulletin share metrics, retain coverage, and never execute formula-like source text", async () => {
  const report = sampleReport();
  report.teams[0].production[0].title = '=HYPERLINK("https://example.invalid")';
  const buffer = await reportWorkbook(report);
  const sheets = await readXlsxFile(buffer);
  assert.deepEqual(sheets.map((sheet) => sheet.sheet), ["Summary", "Production", "Effort", "People", "Read me"]);
  assert.equal(sheets[0].data[1][1], 1);
  assert.equal(sheets[0].data[1][5], 6);
  assert.equal(sheets[0].data[1][6], 15);
  assert.equal(sheets[1].data[1][2], '=HYPERLINK("https://example.invalid")');
  assert.equal(sheets[2].data.length, 5);
  const zip = unzipSync(buffer);
  for (let i = 1; i <= 5; i++) assert.doesNotMatch(strFromU8(zip[`xl/worksheets/sheet${i}.xml`]), /<f[ >]/);
  const text = bulletin(report);
  assert.match(text, /2 deliveries; 4 completed tasks/);
  assert.match(text, /12h \/ 120h capacity; utilisation 10%/);
  assert.match(text, /Draft/);
  assert.match(text, /not emailed/);
});
