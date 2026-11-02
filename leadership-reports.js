"use strict";

const writeXlsxFile = require("write-excel-file/node");
const { REPORTING_START } = require("./operational-reports");
const { qualityIdentity } = require("./qa-reports");
const { qualityMatrix } = require("./workflow-reports");

const TIME_ZONE = "Asia/Kolkata";
const key = (value) => String(value || "").trim().toLowerCase();
const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const percent = (part, total) => total > 0 ? round(part / total * 100) : null;
const complete = (row) => /^(complete|completed)$/i.test(row.status || "");
const baseIdentity = (row) => `${qualityIdentity(row.ref, row.crId)}${!row.crId && /^(cr(?:\s*\d+)?|change rounds?)$/i.test(row.type) ? ":unidentified-cr" : ""}`;
// A bulletin CR has no CR number; its QA task ID makes each bulletin CR delivery distinct.
const bulletinCR = (row) => Boolean(row.qaPublished && /:unidentified-cr:/.test(row.qualityIdentity || ""));
const deliveryIdentity = (row) => bulletinCR(row) ? row.qualityIdentity : baseIdentity(row);
function indiaDate(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? String(value) : "";
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(parsed);
}
function shiftDate(date, days) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
function dueWindows(now = new Date()) {
  const today = indiaDate(now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).format(now));
  const dueDay = hour >= 9 ? today : shiftDate(today, -1);
  const weekday = new Date(`${dueDay}T00:00:00Z`).getUTCDay();
  const monday = shiftDate(dueDay, -(weekday + 6) % 7);
  return [{ kind: "daily", from: shiftDate(dueDay, -1), to: shiftDate(dueDay, -1) },
    { kind: "weekly", from: shiftDate(monday, -7), to: shiftDate(monday, -1) }]
    .filter((window) => window.to >= REPORTING_START)
    .map((window) => ({ ...window, from: window.from < REPORTING_START ? REPORTING_START : window.from }));
}

// One delivery can have multiple executors and QA rows; never multiply the denominator.
function qualitySummary(rows) {
  const groups = new Map();
  for (const row of rows) {
    const id = deliveryIdentity(row);
    const group = groups.get(id) || [];
    group.push(row);
    groups.set(id, group);
  }
  const deliveries = [...groups.values()].map((group) => {
    const published = group.filter((row) => row.qaPublished);
    const evidence = (published.length ? published : group).map((row) => ({ ...row,
      completedAt: indiaDate(row.completionTimestamp || row.completedAt) }));
    const done = evidence.every((row) => complete(row) && row.completedAt);
    const identityMissing = !evidence[0].crId && /^(cr(?:\s*\d+)?|change rounds?)$/i.test(evidence[0].type);
    const identityAccepted = !identityMissing || evidence.every(bulletinCR);
    const confirmed = done && identityAccepted && evidence.every((row) => row.teamId === "design" ? row.qaPublished
      : row.confirmedBy && ["Pass", "Rework"].includes(row.outcome));
    const rework = confirmed && evidence.some((row) => row.rework || row.outcome === "Rework");
    const ftr = confirmed && !rework && evidence.every((row) => row.ftr === true && row.outcome === "Pass");
    const status = !identityAccepted ? "CR identity unverified" : !done ? "Completion unverified" : !confirmed ? "Awaiting verified QA"
      : rework ? "Rework confirmed" : ftr ? "First-time-right" : "First-pass status unverified";
    // Published bulletin deliveries belong to the bulletin's executors, not to other Workfront assignees.
    return { ...evidence[0], names: [...new Set(evidence.flatMap((row) => row.names || []))],
      completedAt: done ? evidence.map((row) => row.completedAt).sort().at(-1) : "",
      done, identityMissing, confirmed, ftr, rework, eligible: confirmed && (ftr || rework), qualityStatus: status };
  });
  const eligible = deliveries.filter((row) => row.eligible).length;
  const ftr = deliveries.filter((row) => row.ftr).length;
  return { deliveries, completed: deliveries.filter((row) => row.done).length, eligible, ftr,
    rework: deliveries.filter((row) => row.rework).length, pending: deliveries.filter((row) => !row.eligible).length,
    rate: percent(ftr, eligible) };
}

function availableHours(member, from, to, holidays, leaves, dailyHours) {
  let hours = 0;
  for (let day = from; day <= to; day = shiftDate(day, 1)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if ([0, 6].includes(weekday) || holidays.some((holiday) => holiday.date === day)) continue;
    const away = leaves.filter((leave) => leave.status === "Approved" && key(leave.assignee) === key(member.name)
      && leave.startDate <= day && leave.endDate >= day);
    if (away.some((leave) => !leave.halfDay)) continue;
    hours += dailyHours * Math.max(0, 1 - new Set(away.map((leave) => leave.halfDay)).size / 2);
  }
  return hours;
}

function buildReport({ window, departments, members, deliveries, qualityRows, logs, activityLogs, holidays, leaves,
  capacityHoursPerDay, now = new Date(), source = {} }) {
  const indiaDelivery = (row) => ({ ...row, completedAt: indiaDate(row.completionTimestamp || row.completedAt),
    plannedCompletionDate: indiaDate(row.plannedTimestamp || row.plannedCompletionDate) });
  deliveries = deliveries.map(indiaDelivery);
  qualityRows = qualityRows.map(indiaDelivery);
  const inPeriod = (value) => {
    const day = indiaDate(value);
    return day && day >= window.from && day <= window.to;
  };
  const teams = [...departments, { id: "shared", name: "Shared capacity" }, { id: "unmapped", name: "Unmapped / needs review" }]
    .map((team) => ({ id: team.id, name: team.id === "email" ? "Email + eDetailer Team" : team.name, capacityHours: 0, productiveHours: 0, attributableHours: 0,
      trainingHours: 0, meetingHours: 0, otherHours: 0, tasksCompleted: 0, deliveriesCompleted: 0,
      unbucketedTasks: 0,
      onTime: 0, late: 0, slaUnknown: 0, benchmarkHours: 0, pairedActualHours: 0, pairedDeliveries: 0, missingBenchmarks: 0,
      members: [], production: [], effort: [], qualityRows: [] }));
  const byTeam = new Map(teams.map((team) => [team.id, team]));
  const roster = new Map(members.map((member) => [key(member.name), member]));
  const memberTeam = (member) => {
    const ids = [...new Set(member?.teamIds || [])].filter((id) => byTeam.has(id) && !["shared", "unmapped"].includes(id));
    return ids.length === 1 ? ids[0] : ids.length > 1 ? "shared" : "unmapped";
  };
  const memberRows = new Map();
  for (const member of members) {
    const teamId = memberTeam(member);
    const row = { name: member.name, role: member.role, capacityHours: round(availableHours(member, window.from, window.to, holidays, leaves, capacityHoursPerDay)),
      productiveHours: 0, trainingHours: 0, meetingHours: 0, otherHours: 0 };
    memberRows.set(key(member.name), row);
    byTeam.get(teamId).members.push(row);
    byTeam.get(teamId).capacityHours += row.capacityHours;
  }
  const deliveryById = new Map(deliveries.map((row) => [String(row.id), row]));
  const uniqueLogs = [...new Map(logs.map((log, index) => [log.id || `row:${index}`, log])).values()];
  for (const log of uniqueLogs.filter((entry) => inPeriod(entry.date) && Number(entry.hours) > 0)) {
    const member = roster.get(key(log.userName));
    const task = deliveryById.get(String(log.taskId));
    const projectTask = !task && log.projectRef ? deliveries.find((row) => key(row.ref) === key(log.projectRef)) : null;
    const team = byTeam.get(task?.teamId || log.teamId || projectTask?.teamId) || byTeam.get("unmapped");
    const hours = Number(log.hours);
    team.productiveHours += hours;
    if (member && memberTeam(member) === team.id) team.attributableHours += hours;
    const person = memberRows.get(key(log.userName));
    if (person) person.productiveHours += hours;
    team.effort.push({ date: log.date, name: log.userName || "Unmapped", ref: log.projectRef || task?.ref || "",
      type: log.taskCategory || task?.type || "Unknown", hours, note: log.note || "" });
  }
  for (const log of activityLogs.filter((entry) => inPeriod(entry.date))) {
    const member = roster.get(key(log.userName));
    const team = byTeam.get(memberTeam(member));
    const field = log.category === "Training" ? "trainingHours" : log.category === "Meeting" ? "meetingHours" : "otherHours";
    team[field] += Number(log.hours || 0);
    const person = memberRows.get(key(log.userName));
    if (person) person[field] += Number(log.hours || 0);
  }
  const taskIds = new Set();
  for (const row of deliveries.filter((row) => complete(row) && !row.completedAt)) {
    const id = `${row.source}:${row.id}`;
    if (taskIds.has(id)) continue;
    taskIds.add(id);
    (byTeam.get(row.teamId) || byTeam.get("unmapped")).unbucketedTasks++;
  }
  for (const row of deliveries.filter((row) => complete(row) && inPeriod(row.completedAt))) {
    const id = `${row.source}:${row.id}`;
    if (taskIds.has(id)) continue;
    taskIds.add(id);
    (byTeam.get(row.teamId) || byTeam.get("unmapped")).tasksCompleted++;
  }
  const qualityIds = new Set(qualityRows.map(baseIdentity));
  const quality = qualitySummary([...qualityRows, ...qualityMatrix(deliveries, []).rows
    .filter((row) => !qualityIds.has(baseIdentity(row)))]);
  for (const row of quality.deliveries.filter((row) => row.done && !row.identityMissing && inPeriod(row.completedAt))) {
    const team = byTeam.get(row.teamId) || byTeam.get("unmapped");
    team.deliveriesCompleted++;
    const planned = indiaDate(row.plannedCompletionDate);
    const sla = !planned ? "Unknown" : row.completedAt > planned ? "Late" : "On time";
    team[sla === "Unknown" ? "slaUnknown" : sla === "Late" ? "late" : "onTime"]++;
    const matching = deliveries.filter((item) => deliveryIdentity(item) === deliveryIdentity(row)
      && /^(build|cr(?:\s*\d+)?|change rounds?)$/i.test(item.type));
    const productionTasks = matching.filter((item) => item.source !== "cr");
    const benchmarkTasks = productionTasks.length ? productionTasks : matching;
    const allLocal = benchmarkTasks.length > 0 && benchmarkTasks.every((item) => item.source === "local");
    const benchmarkKnown = benchmarkTasks.length > 0 && benchmarkTasks.every((item) => Number.isFinite(item.hours) && item.hours > 0)
      && (allLocal || new Set(benchmarkTasks.map((item) => item.hours)).size === 1);
    const benchmark = benchmarkKnown ? allLocal ? benchmarkTasks.reduce((sum, item) => sum + item.hours, 0) : benchmarkTasks[0].hours : null;
    const ids = new Set(matching.map((item) => String(item.id)));
    const effort = uniqueLogs.filter((log) => (ids.has(String(log.taskId))
      || key(log.projectRef) === key(row.ref) && /^(build|cr(?:\s*\d+)?)$/i.test(log.taskCategory)
      && key(log.crId || (/^cr\s*\d+$/i.test(log.taskCategory) ? log.taskCategory.replace(/\s+/g, "") : "")) === key(row.crId))
      && indiaDate(log.date) && indiaDate(log.date) <= window.to);
    const actual = effort.some((log) => Number(log.hours) > 0) ? effort.reduce((sum, log) => sum + Number(log.hours || 0), 0) : null;
    if (benchmark !== null && actual !== null) {
      team.benchmarkHours += benchmark;
      team.pairedActualHours += actual;
      team.pairedDeliveries++;
    } else team.missingBenchmarks++;
    team.production.push({ ref: row.ref, title: row.title, crId: row.crId, names: row.names, completedAt: row.completedAt,
      sla, quality: row.qualityStatus, benchmark, actual });
  }
  for (const row of quality.deliveries) {
    if (inPeriod(row.completedAt || row.confirmedAt || row.entryDate)) (byTeam.get(row.teamId) || byTeam.get("unmapped")).qualityRows.push(row);
  }
  for (const team of teams) {
    team.ftr = qualitySummary(team.qualityRows);
    delete team.ftr.deliveries;
    delete team.qualityRows;
    team.utilisation = ["shared", "unmapped"].includes(team.id) ? null : percent(team.attributableHours, team.capacityHours);
    team.effortIndex = percent(team.benchmarkHours, team.pairedActualHours);
    for (const [field, value] of Object.entries(team)) if (typeof value === "number") team[field] = round(value);
    for (const row of team.members) {
      row.utilisation = percent(row.productiveHours, row.capacityHours);
      for (const [field, value] of Object.entries(row)) if (typeof value === "number") row[field] = round(value);
    }
  }
  return { ...window, generatedAt: now.toISOString(), timeZone: TIME_ZONE, source, teams,
    coverage: "Imported historical/current records and saved dated logs only. Cumulative Workfront Actual Hours are not assigned to a day. Missing logs do not prove no work. Deliveries count each Build or identified CR once, not each executor. Published Design QA bulletin results count without mandatory validation; manual corrections remain available. Other teams require confirmed QA and first-pass evidence. No bugs is not proof of FTR without a QA result. Shared-member capacity stays in the Shared pool; team utilisation uses only that team's dedicated-member effort and capacity. Overall utilisation uses all recorded effort and unique roster capacity. Benchmark comparison covers only completed deliveries with both a benchmark and dated actual effort (all logged effort through period end, not just effort in this period). Imported per-asset benchmarks are not multiplied by duplicate task rows. Roster/assignments are current, not historical headcount. Reporting starts 1 July 2026; the first week may be partial." };
}

function reportTotals(teams) {
  const fields = ["capacityHours", "productiveHours", "attributableHours", "trainingHours", "meetingHours", "otherHours", "tasksCompleted",
    "deliveriesCompleted", "unbucketedTasks", "onTime", "late", "slaUnknown", "benchmarkHours", "pairedActualHours", "pairedDeliveries", "missingBenchmarks"];
  const totals = Object.fromEntries(fields.map((field) => [field, round(teams.reduce((sum, team) => sum + team[field], 0))]));
  totals.ftr = Object.fromEntries(["completed", "eligible", "ftr", "rework", "pending"].map((field) =>
    [field, teams.reduce((sum, team) => sum + team.ftr[field], 0)]));
  totals.ftr.rate = percent(totals.ftr.ftr, totals.ftr.eligible);
  totals.utilisation = percent(totals.productiveHours, totals.capacityHours);
  totals.effortIndex = percent(totals.benchmarkHours, totals.pairedActualHours);
  return totals;
}

function bulletin(report) {
  const totals = reportTotals(report.teams);
  const pct = (value) => value === null ? "N/A" : `${value}%`;
  return `${report.kind === "weekly" ? "Weekly utilisation, performance & FTR" : "Daily production & effort"} | ${report.from} to ${report.to} | IST
Prepared ${report.generatedAt} | ${report.teams.every((team) => team.reviewedAt) ? "Reviewed" : "Draft — review before sharing"} | v${report.version}

Leadership summary
- ${totals.deliveriesCompleted} deliveries; ${totals.tasksCompleted} completed tasks (different measures).
- Productive effort: ${totals.productiveHours}h / ${totals.capacityHours}h capacity; utilisation ${pct(totals.utilisation)}.
- Non-production: Training ${totals.trainingHours}h; Meeting ${totals.meetingHours}h; Other ${totals.otherHours}h.
- SLA: ${totals.onTime} on time; ${totals.late} late; ${totals.slaUnknown} unknown.
- FTR: ${totals.ftr.ftr}/${totals.ftr.eligible} verified first-pass decisions (${pct(totals.ftr.rate)}); ${totals.ftr.pending} unverified.
- ${totals.unbucketedTasks} completed tasks lack dates in the available archive; these cannot be attributed to this period.
- Benchmark / actual effort: ${totals.benchmarkHours}h / ${totals.pairedActualHours}h on ${totals.pairedDeliveries} paired deliveries; ${totals.missingBenchmarks} without paired data.

${report.teams.map((team) => `${team.name}: ${team.deliveriesCompleted} deliveries | ${team.productiveHours}h effort | ${team.capacityHours}h dedicated capacity | attributable utilisation ${pct(team.utilisation)} | FTR ${team.ftr.ftr}/${team.ftr.eligible} (${pct(team.ftr.rate)}) | ${team.ftr.pending} unverified | ${team.late} late | ${team.reviewedAt ? `Reviewed by ${team.reviewedBy}` : "Draft"}`).join("\n")}

Coverage / caveats
${report.coverage}
Source sync: ${report.source.status || "Unknown"}; last success: ${report.source.lastSuccessAt || "Not recorded"}. Prepared automatically; not emailed.`;
}

async function reportWorkbook(report) {
  const rows = [
    ["Team", "Deliveries", "Tasks completed", "Capacity h", "Productive h", "Attributable effort h", "Utilisation %", "Training h", "Meeting h", "Other h",
      "SLA on time", "SLA late", "SLA unknown", "FTR", "Verified denominator", "FTR %", "Unverified", "Benchmark h", "Paired actual h", "Paired deliveries", "Review", "Undated completed tasks (all archive)"],
    ...report.teams.map((team) => [team.name, team.deliveriesCompleted, team.tasksCompleted, team.capacityHours, team.productiveHours, team.attributableHours,
      team.utilisation, team.trainingHours, team.meetingHours, team.otherHours, team.onTime, team.late, team.slaUnknown, team.ftr.ftr,
      team.ftr.eligible, team.ftr.rate, team.ftr.pending, team.benchmarkHours, team.pairedActualHours, team.pairedDeliveries, team.reviewedAt ? `Reviewed by ${team.reviewedBy}` : "Draft", team.unbucketedTasks])
  ];
  const totals = reportTotals(report.teams);
  rows.push(["Scoped total", totals.deliveriesCompleted, totals.tasksCompleted, totals.capacityHours, totals.productiveHours, totals.attributableHours, totals.utilisation,
    totals.trainingHours, totals.meetingHours, totals.otherHours, totals.onTime, totals.late, totals.slaUnknown, totals.ftr.ftr, totals.ftr.eligible, totals.ftr.rate,
    totals.ftr.pending, totals.benchmarkHours, totals.pairedActualHours, totals.pairedDeliveries, "Overall utilisation includes shared/unmapped effort", totals.unbucketedTasks]);
  const production = [["Team", "Project", "Title", "CR", "Executors", "Completed (IST)", "SLA", "Quality", "Benchmark h", "Actual h"],
    ...report.teams.flatMap((team) => team.production.map((row) => [team.name, row.ref, row.title, row.crId, row.names.join(", "), row.completedAt, row.sla, row.quality, row.benchmark, row.actual]))];
  const effort = [["Team", "Date", "Member", "Project", "Type", "Hours", "Note"],
    ...report.teams.flatMap((team) => team.effort.map((row) => [team.name, row.date, row.name, row.ref, row.type, row.hours, row.note]))];
  const people = [["Capacity pool", "Member", "Role", "Capacity h", "Productive h", "Utilisation %", "Training h", "Meeting h", "Other h"],
    ...report.teams.flatMap((team) => team.members.map((row) => [team.name, row.name, row.role, row.capacityHours, row.productiveHours, row.utilisation, row.trainingHours, row.meetingHours, row.otherHours]))];
  const metadata = [["Report", `${report.kind} ${report.from} to ${report.to}`], ["Prepared (UTC)", report.generatedAt], ["Time zone", TIME_ZONE],
    ["Version", report.version], ["Source sync", report.source.status || "Unknown"], ["Last successful sync", report.source.lastSuccessAt || "Not recorded"],
    ["Coverage", report.coverage], ...report.teams.map((team) => [`${team.name} review`, team.reviewedAt ? `${team.reviewedBy} · ${team.reviewedAt} · ${team.reviewNote}` : "Draft"])];
  const sheets = [rows, production, effort, people, metadata].map((sheet) => sheet.map((row, index) => row.map((value) => ({
    type: typeof value === "number" ? Number : String, value: value === null || value === undefined ? "" : value,
    wrap: true, alignVertical: "top", ...(index === 0 ? { fontWeight: "bold", backgroundColor: "#E8EEF5" } : {})
  }))));
  return writeXlsxFile(sheets.map((data, index) => ({ data, sheet: ["Summary", "Production", "Effort", "People", "Read me"][index],
    columns: data[0].map((_, column) => ({ width: column === 0 ? 28 : 22 })), stickyRowsCount: 1 }))).toBuffer();
}

module.exports = { TIME_ZONE, indiaDate, shiftDate, dueWindows, qualitySummary, availableHours, buildReport, reportTotals, bulletin, reportWorkbook };
