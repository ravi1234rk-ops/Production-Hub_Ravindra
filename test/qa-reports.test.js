"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { qaExecutorName, qaProjectMatch, parseQAWorkbook, qaSourceValidation, qaPublishedRows, qaQualityRows, bugUpdateReport } = require("../qa-reports");
const { kpiReport } = require("../operational-reports");

const sheets = () => [
  { sheet: "Deliveries", data: [["QA Task ID", "Workfront ID", "Channel", "Request Type", "Executor", "Delivered Date", "Bug Created"],
    ["QA-1", "P1", "Print", "D1", "Designer", "2026-10-13", "Yes"], ["QA-2", "P2", "Print", "CR", "Designer", "2026-10-14", "No"]] },
  { sheet: "Bugs", data: [["QA Task ID", "Workfront ID", "Bug Assignee", "Bug Created Date", "Total Bugs", "Bug Description", "Delivered Date"],
    ["QA-1", "P1", "Other worker", "2026-10-12", 45, "Design defects", "2026-10-13"],
    ["QA-1", "P1", "Other worker", "2026-10-13", 3, "Recheck", "2026-10-13"],
    ["QA-MISSING", "P3", "Other worker", "2026-10-17", 1, "Not delivered this week", "2026-10-19"]] }
];
const context = () => ({ projects: [{ ref: "P1", productionTeamId: "design", executorName: "Designer", qaTotalErrors: "48", qaRounds: "2", dueDate: "2026-10-14" },
  { ref: "P2", productionTeamId: "design" }], tasks: [], rounds: [], members: [{ id: "U", name: "Designer", role: "executioner", teamIds: ["design"] }] });
const reportRow = () => ({ id: "R", projectRef: "P1", executor: "Designer", originalExecutor: "Designer", requestType: "D1",
  qaTaskId: "QA-1", deliveredDate: "2026-10-13", bugCreated: true, bugs: [{ bugDate: "2026-10-12", totalBugs: 45 }, { bugDate: "2026-10-13", totalBugs: 3 }] });

test("QA bulletin Ashish maps to the unique Aashish roster member in existing reports and KPI without changing source names", () => {
  const c = context();
  c.members = [{ ...c.members[0], name: "Aashish" }];
  assert.equal(qaExecutorName(" Ashish ", c.members), "Aashish");
  assert.equal(qaExecutorName("ASHISH", [{ name: "Aashish Kumar" }]), "Aashish Kumar");
  assert.equal(qaExecutorName("Ashish Kumar", c.members), "Ashish Kumar");
  assert.equal(qaExecutorName("Ashish", []), "Ashish");
  assert.equal(qaExecutorName("Ashish", [{ name: "Aashish A" }, { name: "Aashish B" }]), "Ashish");
  const source = { ...reportRow(), executor: "Ashish", originalExecutor: "Ashish" };
  const rows = qaPublishedRows([{ id: "QA", from: "2026-10-12", to: "2026-10-18", status: "Published", version: 1, rows: [source] }], c);
  assert.equal(rows[0].executor, "Aashish");
  assert.equal(rows[0].originalExecutor, "Ashish");
  assert.equal(source.executor, "Ashish");
  const quality = { rows: qaQualityRows(rows, c.projects) };
  assert.equal(kpiReport({ members: c.members, deliveries: [], quality, requirePublishedDesignQA: true,
    from: "2026-10-01", to: "2026-12-31" })[0].qualityMisses, 1);
});

test("QA matches exact Workfront project IDs and references, never names, partial IDs or ambiguous references", () => {
  const c = context();
  c.projects[0].workfrontId = "a".repeat(32);
  c.projects[0].workfrontUrl = `https://laroche.my.workfront.adobe.com/project/${"b".repeat(32)}/overview`;
  for (const value of ["P1", " P1 ", "A".repeat(32), "b".repeat(32)]) {
    assert.equal(qaProjectMatch(c.projects, value)?.ref, "P1");
    assert.equal(qaSourceValidation({ ...reportRow(), projectRef: value }, c).status, "Matched");
  }
  assert.equal(qaProjectMatch(c.projects, "P"), null);
  assert.equal(qaProjectMatch(c.projects, ""), null);
  assert.equal(qaProjectMatch([...c.projects, { ...c.projects[0], workfrontId: "other" }], "P1"), null);
});

test("QA bulletin Ashish Kr maps specifically to designer Aashish Kumar for existing reports and KPI", () => {
  const c = context();
  c.members = [{ ...c.members[0], name: "Aashish Kumar" }, { ...c.members[0], id: "U2", name: "Aashish Sharma" }];
  assert.equal(qaExecutorName(" Ashish  Kr ", c.members), "Aashish Kumar");
  assert.equal(qaExecutorName("ASHISH KR", c.members), "Aashish Kumar");
  assert.equal(qaExecutorName("Ashish Kr", [c.members[1]]), "Ashish Kr");
  const source = { ...reportRow(), executor: "Ashish Kr", originalExecutor: "Ashish Kr" };
  const rows = qaPublishedRows([{ id: "QA", from: "2026-10-12", to: "2026-10-18", status: "Published", version: 1, rows: [source] }], c);
  assert.equal(rows[0].executor, "Aashish Kumar");
  assert.equal(rows[0].originalExecutor, "Ashish Kr");
  assert.equal(source.executor, "Ashish Kr");
  const result = kpiReport({ members: c.members, deliveries: [], quality: { rows: qaQualityRows(rows, c.projects) },
    requirePublishedDesignQA: true, from: "2026-10-01", to: "2026-12-31" });
  assert.equal(result.find((row) => row.name === "Aashish Kumar").qualityMisses, 1);
  assert.equal(result.find((row) => row.name === "Aashish Sharma").qualityMisses, 0);
});

test("QA workbook preserves rounds, defect counts and unmatched bug rows without fabricating original executors", () => {
  const parsed = parseQAWorkbook(sheets());
  assert.equal(parsed.deliveries.length, 2);
  assert.equal(parsed.bugs.length, 3);
  assert.equal(parsed.unmatchedBugs.length, 1);
  assert.equal(parsed.bugs[0].totalBugs, 45);
  assert.equal(parsed.deliveries[0].executor, "Designer");
  assert.equal(parsed.bugs[0].bugAssignee, "Other worker");
  const bad = sheets(); bad[1].data[1][4] = -1;
  assert.throws(() => parseQAWorkbook(bad), /non-negative/);
  const duplicate = sheets(); duplicate[0].data.push(duplicate[0].data[1]);
  assert.throws(() => parseQAWorkbook(duplicate), /unique/);
});

test("QA validation requires Design original executor and an identified source CR, and expires on source change", () => {
  const row = reportRow();
  const c = context();
  assert.equal(qaSourceValidation(row, c).status, "Matched");
  assert.equal(qaSourceValidation({ ...row, executor: "Other worker" }, c).status, "Needs review");
  assert.match(qaSourceValidation({ ...row, requestType: "CR" }, c).problems.join(" "), /individual CR/);
  c.rounds.push({ workfrontId: "ISSUE", projectRef: "P1", crId: "CR1", assignee: "Designer" });
  assert.equal(qaSourceValidation({ ...row, requestType: "CR", crId: "CR1" }, c).status, "Matched");
  row.validation = { fingerprint: qaSourceValidation(row, c).fingerprint, by: "Manager" };
  c.projects[0].executorName = "Different executor";
  assert.match(qaSourceValidation(row, c).problems.join("; "), /changed|corroborated/);
});

test("QA workbook accepts July bug and delivery dates, and rejects dates before July", () => {
  const workbook = sheets();
  workbook[0].data[1][5] = "2026-07-01";
  workbook[0].data[2][5] = "2026-07-05";
  workbook[1].data[1][3] = "2026-07-01";
  workbook[1].data[1][6] = "2026-07-01";
  const parsed = parseQAWorkbook(workbook);
  assert.equal(parsed.deliveries[0].deliveredDate, "2026-07-01");
  assert.equal(parsed.bugs[0].bugDate, "2026-07-01");
  workbook[1].data[1][3] = "2026-06-30";
  assert.throws(() => parseQAWorkbook(workbook), /valid date from 1 July 2026/);
});

test("latest non-recalled publications drive quality without mandatory validation; bug rounds do not multiply KPI misses", () => {
  const c = context();
  const row = reportRow();
  row.validation = { by: "Manager", fingerprint: qaSourceValidation(row, c).fingerprint };
  const report = { id: "V1", from: "2026-10-12", to: "2026-10-18", status: "Published", version: 1, rows: [row] };
  const reports = [report, { ...report, id: "DRAFT", status: "Draft", version: 0 }];
  assert.equal(qaPublishedRows(reports, c).length, 1);
  const rows = qaQualityRows(qaPublishedRows(reports, c), c.projects);
  assert.equal(rows[0].names[0], "Designer");
  assert.equal(rows[0].defectCount, 48);
  assert.equal(rows[0].bugCount, 2);
  const args = { members: c.members, deliveries: [], quality: { rows }, requirePublishedDesignQA: true, from: "2026-10-01", to: "2026-12-31" };
  assert.equal(kpiReport(args)[0].qualityMisses, 1);
  assert.equal(kpiReport(args)[0].scores.quality, 30);
  reports.push({ ...report, id: "V2", version: 2 });
  assert.equal(qaPublishedRows(reports, c)[0].reportId, "V2");
  reports[2].recalledAt = "2026-10-20";
  assert.equal(qaPublishedRows(reports, c)[0].reportId, "V1");
  const twice = qaQualityRows([...qaPublishedRows(reports, c), { ...row, reportId: "NEXT-WEEK", bugs: [{ bugDate: "2026-10-19", totalBugs: 10 }] }], c.projects);
  assert.equal(kpiReport({ ...args, quality: { rows: twice } })[0].qualityMisses, 1);
  assert.equal(kpiReport({ ...args, quality: { rows: [{ ...rows[0], qaPublished: false }] } })[0].qualityMisses, 0);
  assert.equal(kpiReport({ ...args, quality: { rows: [{ ...rows[0], qaPublished: false }] } })[0].scores.quality, null);
  c.projects[0].qaRounds = "3";
  assert.equal(qaPublishedRows(reports, c).length, 1);
});

test("unvalidated QA bulletin bugs fail FTR and count once in KPI; manual result corrections and exclusions apply", () => {
  const c = context();
  const row = reportRow();
  const report = { id: "QA", from: "2026-10-12", to: "2026-10-18", status: "Published", version: 1, rows: [row] };
  const quality = () => qaQualityRows(qaPublishedRows([report], c), c.projects);
  const misses = () => kpiReport({ members: c.members, deliveries: [], quality: { rows: quality() },
    requirePublishedDesignQA: true, from: "2026-10-01", to: "2026-12-31" })[0];
  assert.equal(quality()[0].rework, true);
  assert.equal(quality()[0].ftr, false);
  assert.equal(require("../leadership-reports").qualitySummary(quality()).rework, 1);
  assert.equal(misses().qualityMisses, 1);
  assert.match(quality()[0].confirmedBy, /Published QA bulletin/);
  row.bugCreated = false;
  assert.equal(quality()[0].ftr, true);
  assert.equal(require("../leadership-reports").qualitySummary(quality()).ftr, 1);
  assert.equal(misses().qualityMisses, 0);
  row.excluded = true;
  assert.equal(quality().length, 0);
});

test("bug evidence includes named Design assignments and executor requests, not other teams or system activity", () => {
  const project = { ...context().projects[0], userUpdates: [{ id: "C1", author: "Designer", date: "2026-10-13", text: "Please assign rework / Bug Fixing to me" },
    { id: "C2", author: "Unrelated person", date: "2026-10-13", text: "bug fixing request" }] };
  const rows = bugUpdateReport([{ workfrontId: "B1", taskName: "Bug Fixing", projectRef: "P1", productionTeamId: "design", assignmentNames: ["Worker"], userUpdates: [{ text: "Fix reviewed", author: "Worker" }] },
    { taskName: "Bug Fixing", productionTeamId: "design", assignmentNames: [] }, { taskName: "Bug Fixing", productionTeamId: "email", assignmentNames: ["Other"] }], [project]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].updates[0].text, "Fix reviewed");
  assert.equal(rows[1].evidenceType, "Executor project update");
});

test("bulletin CRs count as their own verified deliveries by QA task, distinct from the Build", () => {
  const c = context();
  const rows = qaQualityRows([reportRow(), { ...reportRow(), qaTaskId: "QA-CR", requestType: "CR" }], c.projects);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].type, "CR");
  assert.notEqual(rows[0].key, rows[1].key);
  assert.notEqual(rows[0].qualityIdentity, rows[1].qualityIdentity);
  const summary = require("../leadership-reports").qualitySummary(rows);
  assert.equal(summary.eligible, 2);
  assert.equal(summary.ftr, 0);
  assert.equal(summary.rework, 2);
  assert.equal(summary.pending, 0);
  const twoCRs = require("../leadership-reports").qualitySummary(qaQualityRows([
    { ...reportRow(), qaTaskId: "QA-CR1", requestType: "CR", bugCreated: false },
    { ...reportRow(), qaTaskId: "QA-CR2", requestType: "CR", bugCreated: false, executor: "Other" }], c.projects));
  assert.equal(twoCRs.eligible, 2, "each bulletin CR QA task is its own delivery");
  assert.equal(twoCRs.ftr, 2);
  assert.equal(kpiReport({ members: c.members, deliveries: [], quality: { rows },
    requirePublishedDesignQA: true, from: "2026-10-01", to: "2026-12-31" })[0].qualityMisses, 2);
});

test("bug-only evidence cannot invent completion/FTR and responsibility stays per validated executor", () => {
  const c = context();
  const row = { ...reportRow(), deliveryMissing: true, deliveredDate: "2026-10-19", validation: { by: "Manager" } };
  const bugOnly = qaQualityRows([row], c.projects)[0];
  assert.equal(bugOnly.completedAt, "");
  assert.equal(bugOnly.ftr, false);
  const original = { ...row, deliveryMissing: false, deliveredDate: "2026-10-13" };
  assert.equal(qaQualityRows([row, original], c.projects)[0].completedAt, "2026-10-13");
  assert.equal(qaQualityRows([original, row], c.projects)[0].completedAt, "2026-10-13");
  const second = { ...original, executor: "Other designer", bugCreated: false, bugs: [] };
  const quality = { rows: qaQualityRows([original, second], c.projects) };
  const result = kpiReport({ members: [...c.members, { ...c.members[0], id: "U2", name: "Other designer" }], deliveries: [],
    quality, requirePublishedDesignQA: true, from: "2026-10-01", to: "2026-12-31" });
  assert.equal(result[0].qualityMisses, 1);
  assert.equal(result[1].qualityMisses, 0);
  assert.equal(result[1].ftr, 1);
});
