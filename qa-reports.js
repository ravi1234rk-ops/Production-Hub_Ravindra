"use strict";

const { REPORTING_START, reportingDate } = require("./operational-reports");
const key = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
const identity = (ref, crId = "") => `${key(ref)}:${key(crId) || "build"}`;

function qaExecutorName(name, members) {
  if (key(name) === "ashish kr") {
    const matches = members.filter((member) => key(member.name) === "aashish kumar");
    return matches.length === 1 ? matches[0].name : name;
  }
  if (key(name) !== "ashish") return name;
  const matches = members.filter((member) => key(member.name).split(" ")[0] === "aashish");
  return matches.length === 1 ? matches[0].name : name;
}

function qaProjectMatch(projects, workfrontId) {
  const id = key(workfrontId);
  if (!id) return null;
  const matches = projects.filter((project) => [project.ref, project.workfrontId,
    project.workfrontUrl?.match(/\/project\/([a-f0-9]{32})(?:\/|$)/i)?.[1]].some((value) => key(value) === id));
  return matches.length === 1 ? matches[0] : null;
}

function parseQAWorkbook(sheets) {
  const table = (name, required) => {
    const sheet = sheets.find((item) => item.sheet === name);
    if (!sheet || required.some((header) => !sheet.data[0]?.includes(header))) throw new Error(`QA workbook requires the ${name} worksheet with columns: ${required.join(", ")}.`);
    const headers = sheet.data[0];
    return sheet.data.slice(1).filter((row) => row.some((value) => value !== null && value !== "")).map((row, index) => {
      const record = Object.fromEntries(headers.map((header, column) => [header, row[column]]));
      const text = (header) => String(record[header] ?? "").trim();
      const date = (header) => {
        const value = reportingDate(record[header]);
        if (!value || value < REPORTING_START) throw new Error(`${name} row ${index + 2}: ${header} must be a valid date from 1 July 2026.`);
        return value;
      };
      if (!text("QA Task ID") || !text("Workfront ID")) throw new Error(`${name} row ${index + 2}: QA Task ID and Workfront ID are required.`);
      const result = { qaTaskId: text("QA Task ID"), projectRef: text("Workfront ID"), channel: text("Channel"), requestType: text("Request Type"),
        sourceTeam: text("Team"), sourceStatus: text("Status"), deliveredDate: date("Delivered Date"), sourceRow: index + 2 };
      if (name === "Deliveries") {
        if (!text("Executor") || !/^(yes|no)$/i.test(text("Bug Created"))) throw new Error(`Deliveries row ${index + 2}: Executor and Yes/No Bug Created are required.`);
        return { ...result, executor: text("Executor"), bugCreated: /^yes$/i.test(text("Bug Created")) };
      }
      const totalBugs = Number(record["Total Bugs"]);
      if (!Number.isInteger(totalBugs) || totalBugs < 0) throw new Error(`Bugs row ${index + 2}: Total Bugs must be a non-negative integer.`);
      return { ...result, bugAssignee: text("Bug Assignee"), bugDate: date("Bug Created Date"), totalBugs,
        description: text("Bug Description"), categories: Object.fromEntries(["Observations", "Content", "Design", "Function", "Specs", "Asset Auditor"].map((label) => {
          const count = Number(record[label] || 0);
          if (!Number.isInteger(count) || count < 0) throw new Error(`Bugs row ${index + 2}: ${label} must be a non-negative integer.`);
          return [label, count];
        })) };
    });
  };
  const deliveries = table("Deliveries", ["QA Task ID", "Workfront ID", "Channel", "Request Type", "Executor", "Delivered Date", "Bug Created"]);
  const bugs = table("Bugs", ["QA Task ID", "Workfront ID", "Bug Assignee", "Bug Created Date", "Total Bugs", "Bug Description", "Delivered Date"]);
  if (!deliveries.length || deliveries.length > 10000 || bugs.length > 10000) throw new Error("QA workbook must contain 1–10,000 deliveries and at most 10,000 bug records.");
  const ids = deliveries.map((row) => row.qaTaskId);
  if (new Set(ids).size !== ids.length) throw new Error("QA Task IDs must be unique in Deliveries. Bug rounds can repeat a QA Task ID.");
  const unmatchedBugs = bugs.filter((bug) => !deliveries.some((row) => row.qaTaskId === bug.qaTaskId && row.projectRef === bug.projectRef));
  return { deliveries, bugs, unmatchedBugs };
}

function qaSourceValidation(row, { projects, tasks, rounds, members }) {
  const project = qaProjectMatch(projects, row.projectRef);
  const projectRef = project?.ref || row.projectRef;
  const isCR = /^cr/i.test(row.requestType);
  const cr = isCR && row.crId ? rounds.find((item) => key(item.projectRef) === key(projectRef) && key(item.crId) === key(row.crId)) : null;
  const member = members.find((item) => key(item.name) === key(row.executor));
  const build = tasks.filter((task) => key(task.projectRef) === key(projectRef) && /^build$/i.test(task.taskName));
  const names = isCR ? [cr?.assignee].filter(Boolean) : [project?.executorName, project?.executor2Name, project?.executorSourceName,
    project?.executor2SourceName, ...build.flatMap((task) => task.assignmentNames || [])].filter(Boolean);
  const problems = [];
  if (!/^(D1|CR)$/i.test(row.requestType)) problems.push("QA request type must be D1 or CR");
  if (!isCR && row.crId) problems.push("A project/D1 row cannot identify a CR; select CR and validate its assignment");
  if (!project) problems.push("Project absent from available Workfront history");
  else if (project.productionTeamId !== "design") problems.push("Workfront project is not Design");
  if (!member || !member.teamIds?.includes("design") || member.role !== "executioner") problems.push("Original executor is not a Design executioner");
  if (isCR && !row.crId) problems.push("Identify the individual CR; the QA report says CR without a CR number");
  if (isCR && row.crId && !cr) problems.push("Individual CR not found in Workfront history");
  if (!names.some((name) => key(name) === key(row.executor))) problems.push("Original executor is not corroborated by Workfront Executor name / Build assignment / CR assignment");
  if (row.validation && row.validation.fingerprint !== qaFingerprint(row, { project, names, cr })) problems.push("Workfront evidence changed; revalidate");
  return { status: problems.length ? "Needs review" : "Matched", problems, projectRef: project?.ref || "", projectTitle: project?.title || "", projectUrl: project?.workfrontUrl || "",
    executorNames: names, qaName: project?.qaName || "", errors: project?.qaTotalErrors ?? "", qcRounds: project?.qaRounds ?? "",
    fingerprint: qaFingerprint(row, { project, names, cr }) };
}

function qaFingerprint(row, { project, names, cr }) {
  return JSON.stringify([row.projectRef, row.crId || "", row.executor, row.deliveredDate, row.bugCreated, row.deliveryMissing || false,
    row.qaTaskId, row.requestType, row.bugs, project?.productionTeamId, project?.executorName, names.slice().sort(),
    project?.qaTotalErrors, project?.qaRounds, project?.qaFirstRound, cr?.workfrontId]);
}

function qaPublishedRows(reports, context) {
  const latest = new Map();
  for (const report of reports.filter((item) => item.status === "Published" && !item.recalledAt)) {
    const previous = latest.get(report.from);
    if (!previous || previous.version < report.version) latest.set(report.from, report);
  }
  return [...latest.values()].flatMap((report) => report.rows.filter((row) => !row.excluded)
    .map((row) => ({ ...row, executor: qaExecutorName(row.executor, context.members),
      projectRef: qaProjectMatch(context.projects, row.projectRef)?.ref || row.projectRef,
      reportId: report.id, from: report.from, to: report.to })));
}

function qaQualityRows(rows, projects) {
  const grouped = new Map();
  for (const row of rows) {
    const id = `${identity(row.projectRef, row.crId)}${/^cr/i.test(row.requestType) && !row.crId ? `:unidentified-cr:${row.qaTaskId}` : ""}:${key(row.executor)}`;
    const previous = grouped.get(id);
    if (!previous) grouped.set(id, { ...row, bugs: [...row.bugs] });
    else {
      previous.bugCreated ||= row.bugCreated;
      if (previous.deliveryMissing && !row.deliveryMissing) previous.deliveredDate = row.deliveredDate;
      else if (!previous.deliveryMissing && !row.deliveryMissing) previous.deliveredDate = [previous.deliveredDate, row.deliveredDate].sort().at(-1);
      previous.deliveryMissing = Boolean(previous.deliveryMissing && row.deliveryMissing);
      previous.bugs.push(...row.bugs);
    }
  }
  return [...grouped.values()].map((row) => {
    const project = projects.find((item) => key(item.ref) === key(row.projectRef));
    const isCR = Boolean(row.crId) || /^cr/i.test(row.requestType);
    const qualityIdentity = `${identity(row.projectRef, row.crId)}${isCR && !row.crId ? `:unidentified-cr:${row.qaTaskId}` : ""}`;
    return { key: `qa:${qualityIdentity}:${key(row.executor)}`, qualityIdentity,
      source: "qa", ref: row.projectRef, crId: row.crId || "", type: isCR ? "CR" : "Build",
      teamId: "design", title: project?.title || row.projectRef, project, names: [row.executor],
      status: row.deliveryMissing ? "Rework reported" : "Complete", completedAt: row.deliveryMissing ? "" : row.deliveredDate,
      confirmedAt: row.deliveryMissing ? row.bugs.map((bug) => bug.bugDate).sort().at(-1) : row.deliveredDate, entryDate: row.deliveredDate,
      plannedCompletionDate: isCR ? row.expectedDeliveryDate || "" : project?.dueDate || "",
      outcome: row.bugCreated ? "Rework" : "Pass", rework: row.bugCreated, ftr: !row.bugCreated && !row.deliveryMissing,
      deliveryMissing: Boolean(row.deliveryMissing), qaExecutor: row.executor,
      bugCount: row.bugs.length, defectCount: row.bugs.reduce((sum, bug) => sum + bug.totalBugs, 0),
      confirmedBy: `Published QA bulletin${row.validation?.by ? ` · manually verified by ${row.validation.by}` : ""}`, qaPublished: true,
      reworkDates: row.bugs.map((bug) => bug.bugDate), reportId: row.reportId };
  });
}

function bugUpdateReport(tasks, projects) {
  const rows = tasks.filter((task) => /^bug fixing$/i.test(task.taskName) && task.productionTeamId === "design"
    && task.assignmentNames?.length).map((task) => {
    const project = projects.find((item) => key(item.ref) === key(task.projectRef));
    return { id: task.workfrontId, projectRef: task.projectRef, title: project?.title || task.projectName, project,
      crId: task.crId || "", assignmentNames: task.assignmentNames, status: task.taskStatus,
      date: reportingDate(task.entryDate || task.actualStartDate), updates: task.userUpdates || [],
      updatesStatus: task.updatesStatus || "Project/task Updates not read yet", evidenceType: "Named Bug Fixing assignment",
      note: "Assignment identifies the rework worker, not automatic fault attribution. Manager validation is required for Quality KPI." };
  });
  for (const project of projects.filter((item) => item.productionTeamId === "design")) {
    const executors = [project.executorName, ...tasks.filter((task) => key(task.projectRef) === key(project.ref) && /^build$/i.test(task.taskName))
      .flatMap((task) => task.assignmentNames || [])].filter(Boolean);
    for (const update of project.userUpdates || []) {
      if (!/\b(rework|bug\s*fix(?:ing)?|defects?)\b/i.test(update.text)) continue;
      if (!update.author || !executors.some((name) => key(update.author) === key(name))) continue;
      rows.push({ id: `update:${project.ref}:${update.id}`, projectRef: project.ref, title: project.title, project,
        crId: "", assignmentNames: [update.author], status: "Rework mentioned in project Updates", date: reportingDate(update.date),
        updates: [update], updatesStatus: project.updatesStatus, evidenceType: "Executor project update",
        note: "A request/mention is evidence for review, not automatically a confirmed defect or FTR failure." });
    }
  }
  return rows;
}

module.exports = { qaExecutorName, qaProjectMatch, parseQAWorkbook, qaSourceValidation, qaPublishedRows, qaQualityRows, bugUpdateReport, qualityIdentity: identity };
