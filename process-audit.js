"use strict";

const writeExcelFile = require("write-excel-file/node");

const CATEGORIES = [
  "Actual Miss Confirmed",
  "High Workload / Competing Priorities",
  "Complex Asset / Additional Review Required",
  "Rework / Repeat Review",
  "Unplanned Operational Support / Ad hoc Activities",
  "Translation/Other Project Dependency",
  "Needs confirmation"
];
const STATUSES = ["Verified", "Inferred", "Needs confirmation"];
const SOURCES = ["Project Updates", "Issue", "System activity", "Source workbook"];
const REPORT_LIMIT = 8 * 1024 * 1024;
const WORKLOAD_TEAMS = ["Design Team", "Email Team", "Web Team", "Video Team"];

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function text(value, label, max = 1000, optional = false) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (!optional && !value.trim())) {
    invalid(`${label} must be ${optional ? "text" : "nonempty text"} of at most ${max} characters.`);
  }
  return value.trim();
}

function date(value, label, optional = false) {
  if (optional && value === "") return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) invalid(`${label} must be a valid YYYY-MM-DD date.`);
  return value;
}

function validMonth(value) {
  if (typeof value !== "string" || !/^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/.test(value)) invalid("Month must be YYYY-MM.");
  return value;
}

function isoTimestamp(value, label) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) invalid(`${label} must be ISO date-time with timezone.`);
  date(value.slice(0, 10), label);
  return value;
}

function link(value, label) {
  const result = text(value, label, 2000, true);
  if (!result) return "";
  let url;
  try { url = new URL(result); } catch { invalid(`${label} must be an HTTPS Workfront URL or empty.`); }
  if (url.protocol !== "https:" || url.username || url.password
    || !/(^|\.)workfront(?:\.adobe)?\.com$/i.test(url.hostname)) invalid(`${label} must be an HTTPS Workfront URL or empty.`);
  return result;
}

function metric(value, label, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000000 || (integer && !Number.isSafeInteger(value))) {
    invalid(`${label} must be a finite nonnegative ${integer ? "integer" : "number"} no greater than 1000000.`);
  }
  return value;
}

function validateReport(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Provide a JSON evidence report object.");
  if (Buffer.byteLength(JSON.stringify(input)) > REPORT_LIMIT) invalid("Report exceeds the 8 MiB JSON evidence limit.");
  const month = validMonth(input.month);
  if (input.workloadTeam !== undefined && !WORKLOAD_TEAMS.includes(input.workloadTeam)) invalid("Unsupported workload team.");
  const scope = input.workloadTeam ? { workloadTeam: input.workloadTeam } : {};
  const sourceFile = text(input.sourceFile, "Source file", 500);
  const generatedAt = text(input.generatedAt, "Generated timestamp", 40);
  isoTimestamp(generatedAt, "Generated timestamp");
  const coverageNote = text(input.coverageNote, "Coverage note", 12000);
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 5000) invalid("Report must contain 1–5000 rows.");
  const ids = new Set();
  let evidenceCount = 0;
  const rows = input.rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) invalid(`Row ${index + 1} must be an object.`);
    const projectId = text(row.projectId, "Project ID", 120);
    if (!/^[a-zA-Z0-9._-]+$/.test(projectId)) invalid("Project ID may contain only letters, numbers, dot, underscore or hyphen.");
    if (ids.has(projectId.toLowerCase())) invalid(`Duplicate Project ID: ${projectId}.`);
    ids.add(projectId.toLowerCase());
    const projectCreationDate = date(row.projectCreationDate, "Project creation date");
    if (!projectCreationDate.startsWith(`${month}-`)) invalid(`Project ${projectId} creation date must be in report month ${month}.`);
    const assetAuditCompletionDate = date(row.assetAuditCompletionDate, "Asset audit completion date", true);
    if (assetAuditCompletionDate && assetAuditCompletionDate < projectCreationDate) invalid(`Project ${projectId} audit completion precedes creation.`);
    if (!CATEGORIES.includes(row.reasonCategory)) invalid(`Project ${projectId} has an unsupported reason category.`);
    if (!STATUSES.includes(row.verificationStatus)) invalid(`Project ${projectId} has an unsupported verification status.`);
    if (!Array.isArray(row.evidence) || row.evidence.length > 50) invalid("Evidence must be an array of at most 50 items per project.");
    evidenceCount += row.evidence.length;
    if (evidenceCount > 20000) invalid("Report exceeds 20000 evidence items.");
    const evidence = row.evidence.map((entry) => {
      if (!entry || !SOURCES.includes(entry.source)) invalid("Evidence source must be Project Updates, Issue, System activity or Source workbook.");
      const evidenceDate = text(entry.date, "Evidence date", 40, true);
      if (evidenceDate) {
        if (evidenceDate.length === 10) date(evidenceDate, "Evidence date");
        else isoTimestamp(evidenceDate, "Evidence date");
      }
      return { source: entry.source, author: text(entry.author, "Evidence author", 300, true), date: evidenceDate,
        text: text(entry.text, "Evidence text", 12000), url: link(entry.url, "Evidence URL") };
    });
    if (row.verificationStatus === "Verified" && !evidence.length) invalid("Verified rows require evidence.");
    if (row.reasonCategory === "Actual Miss Confirmed" && (row.verificationStatus !== "Verified"
      || !evidence.some((entry) => entry.source !== "Source workbook"))) invalid("Actual Miss Confirmed requires Verified status and reviewed non-workbook evidence.");
    return {
      projectId, projectCreationDate, assetAuditCompletionDate,
      productionManagerName: text(row.productionManagerName, "Production manager name", 300, true),
      assetAuditorName: text(row.assetAuditorName, "Asset auditor name", 300, true),
      holdTime: metric(row.holdTime, "Hold time"), workingHoursDifference: metric(row.workingHoursDifference, "Working hours difference"),
      reasonCategory: row.reasonCategory, reason: text(row.reason, "Reason", 12000), verificationStatus: row.verificationStatus,
      sameDayProjectCount: metric(row.sameDayProjectCount, "Same-day project count", true),
      sameDayAuditorProjectCount: metric(row.sameDayAuditorProjectCount, "Same-day auditor project count", true),
      workfrontUrl: link(row.workfrontUrl, "Workfront URL"), updatesReadStatus: text(row.updatesReadStatus, "Updates read status", 1000),
      evidence, pendingClarification: text(row.pendingClarification, "Pending clarification", 4000, true),
      translationRequest: text(row.translationRequest, "Translation request", 4000, true)
    };
  });
  return { month, ...scope, sourceFile, generatedAt, coverageNote, rows };
}

function teamWorkloadCounts(projects, tasks, team, creationDate, auditorName) {
  if (!WORKLOAD_TEAMS.includes(team)) invalid("Unsupported workload team.");
  date(creationDate, "Workload creation date");
  const eligible = new Set(projects.filter((project) => project.team === team && project.creationDate === creationDate)
    .map((project) => String(project.projectId)));
  const auditor = auditorName.trim().toLowerCase();
  const assigned = new Set(tasks.filter((task) => /^asset audit$/i.test(task.name)
    && eligible.has(String(task.projectId))
    && task.assignmentNames.some((name) => name.trim().toLowerCase() === auditor)).map((task) => String(task.projectId)));
  return { sameDayProjectCount: eligible.size, sameDayAuditorProjectCount: assigned.size };
}

function summarize(report) {
  return {
    month: report.month, generatedAt: report.generatedAt, importedAt: report.importedAt,
    ...(report.workloadTeam ? { workloadTeam: report.workloadTeam } : {}),
    rowCount: report.rows.length,
    categories: Object.fromEntries(CATEGORIES.map((category) => [category, report.rows.filter((row) => row.reasonCategory === category).length])),
    statuses: Object.fromEntries(STATUSES.map((status) => [status, report.rows.filter((row) => row.verificationStatus === status).length]))
  };
}

function findingSummary(row, team = "") {
  const scope = team || "Related team";
  const dependencies = [
    row.pendingClarification && !/^(?:no\b|none\b)/i.test(row.pendingClarification) ? "Clarification issue recorded." : "",
    row.translationRequest && !/^(?:no\b|none\b)/i.test(row.translationRequest) ? "Translation dependency recorded." : ""
  ].filter(Boolean).join(" ");
  if (row.reasonCategory === "High Workload / Competing Priorities") {
    return `${scope}: ${row.sameDayProjectCount} projects created on ${row.projectCreationDate}; ${row.sameDayAuditorProjectCount} currently assigned to ${row.assetAuditorName || "the auditor"}. Competing priorities are inferred, not a confirmed delay cause.${dependencies ? ` ${dependencies}` : ""}`;
  }
  const finding = row.reason.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "Reason needs confirmation.";
  const detail = row.verificationStatus === "Verified" && row.reasonCategory === "Translation/Other Project Dependency"
    ? "Dependency evidenced; its share of the hours variance is not measured."
    : row.verificationStatus === "Verified" ? "Supported by reviewed evidence."
      : row.verificationStatus === "Inferred" ? "Provisional cause; confirmation required." : "Insufficient evidence to confirm the cause.";
  return `${finding} ${detail}${dependencies ? ` ${dependencies}` : ""}`;
}

function filterRows(rows, { search = "", category = "", status = "" } = {}) {
  if (category && !CATEGORIES.includes(category)) invalid("Unsupported category filter.");
  if (status && !STATUSES.includes(status)) invalid("Unsupported status filter.");
  if (typeof search !== "string" || search.length > 500) invalid("Search must contain at most 500 characters.");
  const query = search.toLowerCase().trim();
  return rows.filter((row) => (!category || row.reasonCategory === category) && (!status || row.verificationStatus === status)
    && (!query || [row.projectId, row.productionManagerName, row.assetAuditorName, row.reason, row.pendingClarification, row.translationRequest, ...row.evidence.map((entry) => entry.text)].join(" ").toLowerCase().includes(query)));
}

// All external text is explicitly typed String; no imported value is an Excel formula.
function cells(values, header = false) {
  return values.map((value) => ({ value: value ?? "", type: typeof value === "number" ? Number : String,
    wrap: true, alignVertical: "top",
    ...(header ? { fontWeight: "bold", backgroundColor: "#E8EEF5" } : {}) }));
}

function worksheet(sheet, rows, widths) {
  return { sheet, data: rows.map((values, index) => cells(values, index === 0)),
    columns: widths.map((width) => ({ width })), stickyRowsCount: 1 };
}

async function reportWorkbook(report, rows = report.rows) {
  const countScope = report.workloadTeam ? `${report.workloadTeam} · ` : "";
  const headers = ["Project ID", "Project Creation Date", "Asset Audit Completion Date", "Production Manager Name", "Asset Auditor Name", "Hold Time", "Working Hrs Difference", "Reason for Delay",
    "Reason Category", "Verification Status", `${countScope}Same-day Project Count`, `${countScope}Same-day Auditor Project Count`, "Pending Clarification", "Translation Request", "Updates Read Status", "Workfront URL"];
  const hygiene = [headers, ...rows.map((row) => [row.projectId, row.projectCreationDate, row.assetAuditCompletionDate,
    row.productionManagerName, row.assetAuditorName, row.holdTime, row.workingHoursDifference, findingSummary(row, report.workloadTeam),
    row.reasonCategory, row.verificationStatus, row.sameDayProjectCount, row.sameDayAuditorProjectCount,
    row.pendingClarification, row.translationRequest, row.updatesReadStatus, row.workfrontUrl])];
  const evidence = [["Project ID", "Source", "Author", "Date", "Evidence", "URL"],
    ...rows.flatMap((row) => [
      [row.projectId, "Reviewed assessment", "", report.generatedAt, row.reason, row.workfrontUrl],
      ...row.evidence.map((entry) => [row.projectId, entry.source, entry.author, entry.date, entry.text, entry.url])])];
  const summary = summarize({ ...report, rows });
  const notes = [["Monthly Process Audit", "Report details / definitions"], ["Month", report.month], ["Source file", report.sourceFile], ["Generated at", report.generatedAt],
    ["Imported at", report.importedAt || ""], ["Coverage", report.coverageNote], ["Rows exported (role scope and filters)", rows.length],
    ["Workload team scope", report.workloadTeam || "Not specified by source report; no team-only scope is assumed."],
    ["Verification definitions", "Verified: reviewed source evidence; Inferred: contextual inference, not confirmed cause; Needs confirmation: insufficient or unread evidence."],
    ["Hold time / working hours", "Hold Time is the unchanged source value; the source workbook does not specify its unit. Working Hrs Difference is the imported hours value, not automatically recalculated, and does not alone prove a miss. Hold time is not silently deducted."],
    ["Counts", `${report.workloadTeam ? `Both same-day counts include only ${report.workloadTeam} projects; other production teams are excluded. ` : ""}Same-day counts are source-report context, not proof of personal workload or competing priorities. Current assignments do not establish historical assignments. Counts may include projects outside the exported rows, within the stated workload team.`],
    ["Limitations", "Reasons are externally reviewed evidence assessments, not automatic classifications. Actual Miss Confirmed is never inferred automatically. Missing completion dates remain blank. This report does not alter Process Adherence, SLA or KPI."],
    ["Export scope", "Hygiene and Evidence contain only authorized rows matching active filters. Coverage text is source-wide for manager and otherwise redacted."],
    ...Object.entries(summary.categories).map(([label, count]) => [`Category: ${label}`, count]),
    ...Object.entries(summary.statuses).map(([label, count]) => [`Verification: ${label}`, count])];
  return writeExcelFile([
    worksheet("Hygiene", hygiene, [18, 22, 25, 28, 28, 15, 24, 85, 48, 22, 23, 28, 65, 65, 45, 65]),
    worksheet("Evidence", evidence, [18, 24, 28, 28, 100, 70]),
    worksheet("Summary", notes, [48, 120])
  ]).toBuffer();
}

module.exports = { CATEGORIES, STATUSES, REPORT_LIMIT, validateReport, validMonth, summarize, filterRows, reportWorkbook, teamWorkloadCounts, findingSummary };
