"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { processAdherence, executionDeliveries, qualityMatrix } = require("../workflow-reports");

test("adherence reports mismatches and becomes corrected only when Workfront matches audited evidence", () => {
  const project = { ref: "P1", title: "Email", productionTeamId: "email", pages: 2, complexity: "High", requestType: "Localization" };
  const audit = { projectRef: "P1", auditType: "Audit", auditStatus: "Pass", pageCount: 3, complexity: "Simple", requestType: "Update/Repurpose", createdAt: "2026-10-20" };
  const tasks = [{ projectRef: "P1", taskName: "Build", taskStatus: "Complete" }, { projectRef: "P1", taskName: "QA Audit", taskStatus: "In Progress", assignmentNames: ["Role / team"] }];
  let report = processAdherence([project], tasks, [audit])[0];
  assert.equal(report.checks.filter((check) => check.status === "Action required").length, 5);
  report = processAdherence([{ ...project, assetType: "Email", materialExpectedDate: "2026-10-21", dueDate: "2026-10-21",
    actualStartDate: "2026-10-20", actualCompletionDate: "2026-10-21", sourceStatus: "Complete", pages: 3, complexity: "Low", requestType: "Updates" }],
    [tasks[0], { ...tasks[1], taskStatus: "New", assignmentNames: ["Puneet Srivastava"] }], [{ ...audit, channel: "Email", etaDate: "2026-10-21" }])[0];
  assert.equal(report.status, "Corrected");
  assert.ok(report.checks.every((check) => check.status === "Corrected"));
  assert.equal(processAdherence([project], [], [])[0].checks.filter((check) => check.status === "Not verified").length, 5);
});

test("adherence prefers authored task/project boilerplate per field over newer local results and preserves explicit ambiguity", () => {
  const project = { ref: "P", assetType: "Poster", materialExpectedDate: "2026-10-21", dueDate: "2026-10-21",
    actualStartDate: "2026-10-20", actualCompletionDate: "2026-10-21", sourceStatus: "Complete", pages: 4, complexity: "High", requestType: "Updates",
    userUpdates: [{ id: "PROJECT", author: "Auditor", date: "2026-10-20", text: "Asset Audit\nPrimary Material: Poster\nComplexity: High\nRequest type: Updates\nPage count: 4\nMaterial expected delivery date: 2026-10-21" }] };
  const audit = { id: "LOCAL", projectRef: "P", auditType: "Audit", auditStatus: "Pass", createdAt: "2026-10-24",
    pageCount: 99, complexity: "Simple", requestType: "New Build", channel: "Email", etaDate: "2026-10-25" };
  const tasks = [{ projectRef: "P", taskName: "Asset Audit", userUpdates: [
    { id: "TASK", author: "Auditor", date: "2026-10-21", text: "Page count: 5" },
    { id: "OTHER", author: "Executor", date: "2026-10-22", text: "Complexity: Low\nPage count: 4" }] }];
  const options = { auditorNames: ["Auditor"] };
  const check = (row, rule) => row.checks.find((item) => item.rule === rule);
  const result = () => processAdherence([project], tasks, [audit], options)[0];
  assert.equal(check(result(), "Complexity").status, "Corrected");
  assert.match(check(result(), "Complexity").detail, /PROJECT/);
  assert.equal(check(result(), "Page count").status, "Action required");
  assert.equal(check(result(), "Page count").expected, 5);
  assert.match(check(result(), "Page count").evidenceSource, /task Updates/);
  assert.equal(check(result(), "Planned completion / SLA").status, "Corrected");
  project.pages = 5;
  assert.equal(result().status, "Corrected");
  tasks[0].userUpdates.push({ id: "AMBIGUOUS", author: "Auditor", date: "2026-10-23", text: "Material expected delivery date: 10/11/26\nPage count: 5 or 6" });
  assert.equal(check(result(), "Material expected delivery").status, "Not verified");
  assert.equal(check(result(), "Page count").status, "Not verified");
  assert.match(check(result(), "Page count").detail, /5 or 6/);
  assert.equal(result().status, "Not verified");
});

test("adherence local fallback is field-specific and manual outcomes expire for changed authored audit evidence", () => {
  const { hygieneFingerprint } = require("../workflow-reports");
  const project = { ref: "P", pages: 3, complexity: "Low", requestType: "Update", materialExpectedDate: "2026-10-21",
    userUpdates: [{ id: "A", author: "Auditor", date: "2026-10-20", text: "Asset audit\nComplexity: High" }] };
  const audit = { id: "LOCAL", projectRef: "P", auditType: "Audit", auditStatus: "Pass", createdAt: "2026-10-21", pageCount: 3, requestType: "Updates" };
  const options = { auditorNames: ["Auditor"], verifications: [{ projectRef: "P", fingerprint: hygieneFingerprint(project, [], [audit]), verifiedAt: "2026-10-22", verifiedBy: "Manager",
    note: "Reviewed complexity manually", checks: [{ rule: "Complexity", status: "Manually verified" }] }] };
  const check = (rule) => processAdherence([project], [], [audit], options)[0].checks.find((item) => item.rule === rule);
  assert.equal(check("Complexity").status, "Manually verified");
  assert.equal(check("Page count").status, "Corrected");
  assert.match(check("Page count").evidenceSource, /Locally saved/);
  project.userUpdates[0].text = "Asset audit\nComplexity: Medium";
  assert.equal(check("Complexity").status, "Action required");
  assert.match(check("Complexity").detail, /Medium/);
  options.verifications[0].fingerprint = hygieneFingerprint(project, [], [audit]);
  options.verifications[0].invalidatedAt = "2026-10-23";
  assert.equal(check("Complexity").status, "Action required");
});

test("quality does not assume FTR from completed status, and a later QA pass cannot erase recorded rework", () => {
  const build = { key: "workfront:B1", ref: "P1", type: "Build", crId: "", names: ["A"], status: "Complete" };
  const cr = { key: "cr:C1", ref: "P1", type: "CR", crId: "CR1", names: ["A"] };
  let report = qualityMatrix([build, cr], []);
  assert.equal(report.ftr, 0);
  assert.equal(report.pending, 2);
  report = qualityMatrix([build, cr], [{ deliveryKey: cr.key, result: "Pass", firstTime: true, confirmedBy: "QA", createdAt: "2026-10-20" }]);
  assert.equal(report.ftr, 1);
  const bug = { key: "workfront:BUG", ref: "P1", type: "Bug Fixing", crId: "CR1" };
  report = qualityMatrix([build, cr, bug], [{ deliveryKey: cr.key, result: "Pass", firstTime: true, confirmedBy: "QA", createdAt: "2026-10-20" }]);
  assert.equal(report.ftr, 1, "a Bug Fixing assignment is review evidence, not a confirmed first-pass failure");
  assert.equal(report.rework, 0);
  assert.equal(report.rows.find((row) => row.key === build.key).bugCount, 0);
  report = qualityMatrix([build, cr], [
    { deliveryKey: cr.key, result: "Rework", createdAt: "2026-10-19" },
    { deliveryKey: cr.key, result: "Pass", firstTime: true, confirmedBy: "QA", createdAt: "2026-10-20" }
  ]);
  assert.equal(report.ftr, 0);
  assert.equal(report.rework, 1);
  assert.equal(report.confirmed, 1);
});

test("execution deliveries map material dates for Builds, own dates for CRs, and deduplicate mirrored local work", () => {
  const project = { ref: "P1", title: "Title", sourceStatus: "In QC", materialExpectedDate: "2026-10-21" };
  const rows = executionDeliveries({ workfrontProjects: [project],
    workfrontTasks: [{ workfrontId: "B1", projectRef: "P1", taskName: "Build", assignmentNames: ["A"] }],
    workfrontChangeRounds: [{ workfrontId: "C1", projectRef: "P1", title: "CR", crId: "CR1", assignee: "A", expectedDeliveryDate: "2026-10-22T09:00:00Z" }],
    projects: [{ ...project, id: "LP1" }], tasks: [{ id: "LB1", projectId: "LP1", category: "Build", assignee: "A" }] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].due, "2026-10-21");
  assert.equal(rows[1].due, "2026-10-22");
  assert.deepEqual(rows[1].names, ["A"]);
});

test("CR task deadlines use their own CR delivery, not the historic project material date; QA tasks remain visible", () => {
  const rows = executionDeliveries({ workfrontProjects: [{ ref: "P1", materialExpectedDate: "2025-01-01" }],
    workfrontTasks: ["CR1", "CR", "QA Audit"].map((taskName) => ({ workfrontId: taskName, projectRef: "P1", taskName, assignmentNames: ["A"] })),
    workfrontChangeRounds: [{ workfrontId: "C1", projectRef: "P1", crId: "CR1", expectedDeliveryDate: "2026-10-22", assignee: "A" }] });
  assert.equal(rows.find((row) => row.type === "CR1").due, "2026-10-22");
  assert.equal(rows.find((row) => row.key === "workfront:CR").due, "");
  assert.ok(rows.some((row) => row.type === "QA Audit"));
  assert.equal(qualityMatrix(rows, []).rows.length, 1, "count the individual CR once, not its task mirrors or QA tasks");
});

test("a project with an unfinished Build task is not counted completed; all completion dates must be verified", () => {
  const first = { key: "B1", ref: "P1", type: "Build", names: ["A"], status: "Complete", completedAt: "2026-10-02", plannedCompletionDate: "2026-10-03" };
  const second = { ...first, key: "B2", status: "In Progress", completedAt: "" };
  assert.equal(qualityMatrix([first, second], []).rows[0].completedAt, "");
  assert.equal(qualityMatrix([first, { ...second, status: "Complete" }], []).rows[0].completedAt, "");
  const row = qualityMatrix([first, { ...second, status: "Complete", completedAt: "2026-10-04" }], []).rows[0];
  assert.equal(row.completedAt, "2026-10-04");
});
