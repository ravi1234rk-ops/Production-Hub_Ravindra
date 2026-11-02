"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const read = require("read-excel-file/node");
const { reportingDate, reportingWindow, slaReport, retainReportingHistory, kpiReport, kpiPeriodReport } = require("../operational-reports");
const { checklistWorkbook, checklistTemplate, roleTemplates, templates } = require("../execution-checklists");
const { qualityMatrix, processAdherence, hygieneFingerprint } = require("../workflow-reports");

test("report windows use Monday weeks, calendar periods and the 1 July reporting floor", () => {
  assert.deepEqual(reportingWindow("weekly", "2026-10-20"), { from: "2026-10-19", to: "2026-10-25", period: "weekly", anchor: "2026-10-20" });
  assert.equal(reportingWindow("monthly", "2026-10-20").to, "2026-10-31");
  assert.equal(reportingWindow("yearly", "2026-10-20").from, "2026-07-01");
  assert.deepEqual(reportingWindow("weekly", "2026-07-01"), { from: "2026-07-01", to: "2026-07-05", period: "weekly", anchor: "2026-07-01" });
  assert.equal(reportingWindow("quarterly", "2026-07-15").from, "2026-07-01");
  assert.equal(reportingWindow("ytd", "2027-03-02").to, "2027-03-02");
  assert.equal(reportingWindow("quarterly", "2027-02-01").to, "2027-03-31");
  assert.equal(reportingWindow("monthly", "2028-02-15").to, "2028-02-29");
  assert.deepEqual(reportingWindow("half-yearly", "2027-08-15"), { from: "2027-07-01", to: "2027-12-31", period: "half-yearly", anchor: "2027-08-15" });
});

test("checklists select only the channel worksheet for executioners and Graphics Audit for auditors", () => {
  assert.deepEqual(roleTemplates("executioner").map((template) => template.items.length), [15, 44, 13, 25]);
  assert.equal(checklistTemplate("iPDF", "auditor").items.length, 13);
  assert.ok(checklistTemplate("PPT/Gslide").items.every((item) => item.section === "Checklist"));
  assert.ok(checklistTemplate("Print", "auditor").items.every((item) => item.section === "Graphics Audit"));
});

test("monthly evidence uses QTD scores and half-year scores require every published final quarter", () => {
  const row = kpiReport(base())[0];
  const quarter = { ...row, scores: { productivity: 24, quality: 25, onTime: 10, process: 5, manager: 20 }, provisionalTotal: 84, confirmed: true };
  const monthly = kpiPeriodReport({ window: reportingWindow("monthly", "2027-04-20"), quarterRows: [quarter], periodRows: [row], publications: [] })[0];
  assert.equal(monthly.completed, row.completed);
  assert.equal(monthly.scores.quality, 25);
  const window = reportingWindow("half-yearly", "2027-04-20");
  const publications = [{ id: "Q1", memberId: row.memberId, period: "quarterly", from: "2027-01-01", to: "2027-03-31", version: 1, final: true, snapshot: quarter }];
  const rollup = () => kpiPeriodReport({ window, quarterRows: [], periodRows: [row], publications })[0];
  assert.equal(rollup().confirmed, false);
  assert.equal(rollup().provisionalTotal, null);
  publications.push({ ...publications[0], id: "Q2", from: "2027-04-01", to: "2027-06-30" });
  assert.equal(rollup().provisionalTotal, 84);
  publications.push({ ...publications[1], id: "Q2v2", version: 2, snapshot: { ...quarter, provisionalTotal: 90 } });
  assert.equal(rollup().provisionalTotal, 87);
  publications[2].recalledAt = "2027-07-01";
  assert.equal(rollup().provisionalTotal, 84);
  const truncated = kpiPeriodReport({ window: reportingWindow("yearly", "2026-10-20"), quarterRows: [], periodRows: [row],
    publications: [{ ...publications[0], from: "2026-10-01", to: "2026-12-31" }] })[0];
  assert.equal(truncated.confirmed, false);
  assert.equal(truncated.quarterCoverage.filter((item) => item.outsideCoverage).length, 2);
});

test("hygiene ignores unauthored task descriptions; manual evidence expires on source change", () => {
  const project = { ref: "P", materialExpectedDate: "2026-10-04", complexity: "Low", pages: 4, requestType: "New Build" };
  const task = { projectRef: "P", taskName: "Asset Audit", taskStatus: "In Progress", actualStartDate: "2026-10-02", description: "Complexity: Simple\nRequest type: New Build\nPage count: 4" };
  const checks = processAdherence([project], [task], [])[0].checks;
  assert.equal(checks.find((check) => check.rule === "Complexity").status, "Not verified");
  assert.equal(checks.find((check) => check.rule === "Page count").status, "Not verified");
  const manual = { projectRef: "P", fingerprint: hygieneFingerprint(project, [task]), verifiedAt: "2026-10-03", verifiedBy: "Auditor", note: "4 pages checked", checks: [{ rule: "Page count", status: "Manually verified" }] };
  const options = { verifications: [manual], rounds: [{ projectRef: "P", crId: "CR1", complexity: "High", entryDate: "2026-10-05" }] };
  const report = processAdherence([project], [task], [], options)[0];
  assert.equal(report.checks.find((check) => check.rule === "Page count").status, "Manually verified");
  assert.equal(report.checks.find((check) => check.rule.includes("CR complexity")).status, "Action required");
  assert.equal(processAdherence([{ ...project, pages: 5 }], [task], [], options)[0].checks.find((check) => check.rule === "Page count").status, "Not verified");
});

test("historical event timestamps use the local reporting day rather than their UTC date prefix", () => {
  assert.equal(reportingDate(new Date(2026, 9, 1, 0, 15).toISOString()), "2026-10-01");
  assert.equal(reportingDate("2026-10-01"), "2026-10-01");
  assert.equal(reportingDate("not a date"), "");
});

test("hygiene uses explicit labelled page counts in known auditor Updates and ignores other authors", () => {
  const project = { ref: "P", complexity: "Complex", requestType: "Update", pages: 9, materialExpectedDate: "2026-10-20",
    userUpdates: [
      { id: "EARLY", author: "Auditor One", date: "2026-10-10", text: "Asset audit completed\nComplexity: Low\nRequest Type: New Build" },
      { id: "RESULT", author: "Auditor One", date: "2026-10-12", text: "Audit results\n**Complexity:** High\n**Request Type:** Update\nPages: 9" },
      { id: "UNTRUSTED", author: "Other", date: "2026-10-13", text: "Audit\nComplexity: Low\nRequest Type: New Build" }
    ] };
  const row = processAdherence([project], [], [], { auditorNames: ["Auditor One"] })[0];
  assert.equal(row.checks.find((check) => check.rule === "Complexity").status, "Corrected");
  assert.match(row.checks.find((check) => check.rule === "Request type").detail, /Project Updates.*RESULT/);
  assert.equal(row.checks.find((check) => check.rule === "Page count").status, "Corrected");
  assert.equal(row.date, "2026-10-12");
});

test("SLA separates late open/completed work and never treats missing source dates as on time", () => {
  const base = { ref: "P1", actualStartDate: "2026-10-01", projectedStartDate: "2026-10-12", dueDate: "2026-10-10", sourceStatus: "In QC" };
  assert.equal(slaReport([base], "2026-10-11")[0].daysLate, 1);
  assert.equal(slaReport([base], "2026-10-10")[0].status, "Within SLA");
  assert.equal(slaReport([{ ...base, sourceStatus: "Complete" }], "2026-10-11")[0].status, "Not verified");
  assert.equal(slaReport([{ ...base, sourceStatus: "Complete", actualCompletionDate: "2026-10-09" }])[0].status, "Delivered on time");
  assert.equal(slaReport([{ ...base, actualStartDate: "", projectedStartDate: "2026-10-01" }], "2026-10-09")[0].status, "Not verified");
  assert.equal(slaReport([{ ...base, actualStartDate: "" }], "2026-10-11")[0].status, "SLA missed");
  assert.equal(slaReport([{ ...base, actualStartDate: "2026-10-12" }])[0].status, "Not verified");
});

test("history retains disappeared work and imported completion evidence across incomplete active snapshots", () => {
  const data = { workfrontTasks: [{ workfrontId: "T1", taskStatus: "Complete", actualCompletionDate: "2026-10-02" }] };
  retainReportingHistory(data);
  data.workfrontTasks = [{ workfrontId: "T1", taskStatus: "New", actualCompletionDate: "" }, { workfrontId: "T2" }];
  retainReportingHistory(data);
  assert.equal(data.reportingHistory.tasks[0].actualCompletionDate, "2026-10-02");
  assert.equal(data.reportingHistory.tasks[0].taskStatus, "Complete");
  data.workfrontTasks = [];
  retainReportingHistory(data);
  assert.equal(data.reportingHistory.tasks.length, 2);
});

const member = { id: "U1", name: "A", teamIds: ["design"], role: "executioner" };
const build = { key: "workfront:T1", ref: "P1", names: ["A"], type: "Build", status: "Complete",
  completedAt: "2026-10-10", plannedCompletionDate: "2026-10-09" };
const base = () => ({ members: [member], deliveries: [build], quality: qualityMatrix([build], []), from: "2026-10-01", to: "2026-12-31" });

test("KPI counts assets rather than tasks and missing quality/Manager evidence prevents a final total", () => {
  const row = kpiReport(base())[0];
  assert.equal(row.completed, 1);
  assert.equal(row.scores.productivity, 30);
  assert.equal(row.scores.quality, null);
  assert.equal(row.scores.manager, null);
  assert.equal(row.provisionalTotal, null);
  assert.equal(row.deliveryMisses, 1);
});

test("KPI feedback, quality and process scores follow approved thresholds and linked issues deduplicate auto misses", () => {
  const args = base();
  args.quality = qualityMatrix([build, { ...build, key: "bug", type: "Bug Fixing" }], []);
  args.issues = [{ id: "I1", memberId: "U1", category: "Quality", date: "2026-10-10", deliveryKey: build.key }];
  args.reviews = [{ memberId: "U1", from: args.from, to: args.to, feedback: [true, true, false, true],
    qualityVerified: true, processVerified: true, deliveryVerified: true }];
  let row = kpiReport(args)[0];
  assert.equal(row.qualityMisses, 1);
  assert.equal(row.scores.quality, 30);
  assert.equal(row.scores.manager, 15);
  assert.equal(row.ratings.manager, 4);
  for (let index = 0; index < 5; index++) args.issues.push({ id: `P${index}`, memberId: "U1", category: "Process adherence", date: "2026-10-10" });
  row = kpiReport(args)[0];
  assert.equal(row.scores.process, 5);
  args.reviews[0].finalized = true;
  args.reviews[0].coverageConfirmed = true;
  args.reviews[0].overallRating = 4;
  args.reviews[0].evidence = row.evidence;
  assert.equal(kpiReport(args)[0].confirmed, true);
  args.issues.push({ id: "P6", memberId: "U1", category: "Process adherence", date: "2026-10-10" });
  assert.equal(kpiReport(args)[0].confirmed, false, "changed evidence invalidates confirmation even when the score band stays unchanged");
});

test("auditor KPI uses completed Asset Audits and Manager-validated audit-quality evidence", () => {
  const audit = { ...build, type: "Asset Audit" };
  const args = { ...base(), members: [{ ...member, role: "auditor" }], deliveries: [audit, { ...audit, key: "duplicate" }], quality: { rows: [] } };
  let row = kpiReport(args)[0];
  assert.equal(row.completed, 1);
  assert.equal(row.scores.quality, null);
  args.reviews = [{ memberId: "U1", from: args.from, to: args.to, qualityVerified: true }];
  assert.equal(kpiReport(args)[0].scores.quality, 30);
});

test("productive utilization excludes Training/Meeting hours", () => {
  const row = kpiReport({ ...base(), workLogs: [{ userId: "U1", date: "2026-10-10", hours: 2 }],
    nonProductiveLogs: [{ userId: "U1", date: "2026-10-10", hours: 3 }] })[0];
  assert.equal(row.hours, 2);
  assert.equal(row.nonProductiveHours, 3);
});

test("productivity uses the confirmed boundary bands and only same-team, same-role peers", () => {
  for (const [count, score] of [[18, 30], [17, 24], [14, 18], [8, 12], [7, 6]]) {
    const peers = [{ ...member, id: "U2", name: "B" }, { ...member, id: "U3", name: "Other team", teamIds: ["email"] }];
    const deliveries = [[count, "A"], [20, "B"], [50, "Other team"]].flatMap(([total, name]) => Array.from({ length: total }, (_, index) => ({
      ...build, ref: `${name}${index}`, key: `${name}${index}`, names: [name]
    })));
    const row = kpiReport({ ...base(), members: [member, ...peers], deliveries, quality: qualityMatrix(deliveries, []) })[0];
    assert.equal(row.benchmark, 20);
    assert.equal(row.scores.productivity, score);
  }
});

test("an empty workload cannot earn quality or productivity points", () => {
  const row = kpiReport({ ...base(), deliveries: [], quality: { rows: [] } })[0];
  assert.equal(row.scores.productivity, null);
  assert.equal(row.scores.quality, null);
  assert.equal(row.provisionalTotal, null);
});

test("approved asset templates keep all workbook checkpoints without importing prefilled answers", () => {
  assert.deepEqual(templates.map((item) => [item.assetType, item.items.length]), [["Banner", 28], ["iPDF", 57], ["Print", 26], ["PPT/Gslide", 40]]);
  assert.equal(checklistTemplate("Google Slides").assetType, "PPT/Gslide");
  assert.equal(checklistTemplate("Email"), null);
  for (const template of templates) {
    assert.equal(new Set(template.items.map((item) => item.id)).size, template.items.length);
    assert.ok(template.items.every((item) => !item.done && !item.result));
  }
  assert.ok(checklistTemplate("iPDF").items.some((item) => item.label.includes("1.0 or 2.0")));
});

test("XLSX download round-trips asset checks, N.A. comments, Unicode text, and metadata without formulas", async () => {
  const buffer = await checklistWorkbook({ ref: "P1", title: "Test", crId: "CR1", project: { assetType: "Print" } },
    { items: [{ ...templates[2].items[0], result: "N.A.", comment: "Not applicable – confirmed", label: "=HYPERLINK(\"bad\")" }],
      inputDocuments: [{ name: "Brief", link: "https://example.com" }], observations: "Checked" }, "Member");
  assert.equal(buffer.subarray(0, 2).toString(), "PK");
  const sheets = await read(buffer);
  assert.deepEqual(sheets.map((sheet) => sheet.sheet), ["Project info", "Asset checklist"]);
  assert.equal(sheets[1].data[1][1], '=HYPERLINK("bad")');
  assert.equal(sheets[1].data[1][3], "N.A.");
  assert.match(sheets[1].data[1][4], /confirmed/);
});
