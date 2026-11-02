"use strict";

const { reportingDate, slaReport } = require("./operational-reports");
const key = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
const complete = (value) => /^(complete|completed)$/i.test(String(value || "").trim());
const complexityKey = (value) => ({ low: "simple", high: "complex" })[key(value)] || key(value);
const requestKey = (value) => /localiz/.test(key(value)) ? "localization" : /update|repurpose/.test(key(value)) ? "update" : key(value);

function hygieneFingerprint(project, tasks = [], audits = []) {
  return JSON.stringify([project.materialExpectedDate || "", project.pages || "", project.complexity || "", project.requestType || "",
    project.assetType || project.channel || "", project.plannedCompletionDate || project.dueDate || "",
    project.actualStartDate || "", project.actualCompletionDate || "", project.sourceStatus || project.status || "", project.userUpdates || [],
    tasks.filter((task) => key(task.projectRef) === key(project.ref) && /^asset audit$/i.test(task.taskName))
      .map((task) => [task.workfrontId, task.userUpdates || [], task.description || ""]),
    audits.filter((audit) => key(audit.projectRef) === key(project.ref) && !audit.crId)
      .map((audit) => [audit.id, audit.updatedAt || audit.createdAt, audit.auditStatus, audit.auditType, audit.pageCount, audit.complexity, audit.requestType, audit.etaDate, audit.channel])]);
}

function auditBoilerEvidence(task) {
  const text = String(task?.text || task?.description || "").replace(/<[^>]*>/g, "\n").replace(/[*_]+/g, "");
  const read = (label) => text.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*(?:[:#-]\\s*|\\n\\s*)([^\\n]+)`, "i"))?.[1]?.trim() || "";
  const pages = read("(?:Page\\s*count|Number\\s*of\\s*pages|Total\\s*pages|Pages)");
  const rawDate = read("(?:Material\\s*expected(?:\\s*delivery)?\\s*date|Expected\\s*delivery\\s*date|ETA(?:\\s*date)?)");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && Number.isFinite(Date.parse(rawDate))
    && new Date(rawDate).toISOString().slice(0, 10) === rawDate ? rawDate : "";
  return { complexity: read("Complexity"), requestType: read("Request\\s*type"),
    pages: /^\d+$/.test(pages) && Number.isSafeInteger(Number(pages)) && Number(pages) > 0 ? Number(pages) : "", rawPages: pages,
    materialExpectedDate: date, rawDate, primaryMaterial: read("(?:Primary\\s*material|Channel)") };
}

function processAdherence(projects, tasks, audits, { verifications = [], rounds = [], auditorNames = [] } = {}) {
  return projects.map((project) => {
    const checks = [];
    const projectTasks = tasks.filter((task) => key(task.projectRef) === key(project.ref));
    const auditTask = projectTasks.filter((task) => /^asset audit$/i.test(task.taskName) && (complete(task.taskStatus) || /in progress/i.test(task.taskStatus)))
      .sort((a, b) => String(b.actualStartDate || b.lastUpdateDate || b.detailSyncedAt).localeCompare(String(a.actualStartDate || a.lastUpdateDate || a.detailSyncedAt)))[0];
    const manual = verifications.filter((entry) => !entry.invalidatedAt && key(entry.projectRef) === key(project.ref)).sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))[0];
    const updates = [...(project.userUpdates || []).map((update) => ({ ...update, location: "Project Updates" })),
      ...projectTasks.filter((task) => /^asset audit$/i.test(task.taskName)).flatMap((task) =>
        (task.userUpdates || []).map((update) => ({ ...update, location: "Asset Audit task Updates" })))];
    const auditorUpdates = updates.filter((update) => auditorNames.some((name) => key(name) === key(update.author))
      && (update.location === "Asset Audit task Updates" || /\baudit\b/i.test(update.text)) && !/\bpre[-\s]?audit\b|\bCR\s*\d+\b/i.test(update.text))
      .map((update) => ({ ...update, boiler: auditBoilerEvidence(update) }))
      .filter((update) => Object.values(update.boiler).some(Boolean))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const auditUpdate = auditorUpdates[0];
    const audit = audits.filter((item) => key(item.projectRef) === key(project.ref) && !item.crId && item.auditType === "Audit" && item.auditStatus === "Pass")
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))[0];
    const fingerprint = hygieneFingerprint(project, tasks, audits);
    const reportDate = reportingDate(manual?.fingerprint === fingerprint ? manual.verifiedAt : "")
      || reportingDate(auditUpdate?.date || audit?.createdAt || auditTask?.actualStartDate || auditTask?.actualCompletionDate || project.lastUpdateDate || project.entryDate);
    const add = (rule, ok, detail, verified = true, values = {}) => {
      const override = manual?.fingerprint === fingerprint && manual.checks?.find((check) => check.rule === rule);
      checks.push({ rule, status: override ? override.status : !verified ? "Not verified" : ok ? "Corrected" : "Action required",
        detail: override ? `${detail}; manual evidence: ${manual.note} (${manual.verifiedBy})` : detail,
        date: reportDate, evidenceSource: override ? "Manual verification" : values.evidenceSource || "Workfront / local evidence", ...values });
      if (override) checks.at(-1).evidenceSource = "Manual verification";
    };
    const source = (field, localField = field) => {
      const rawField = field === "materialExpectedDate" ? "rawDate" : field === "pages" ? "rawPages" : field;
      const update = auditorUpdates.find((entry) => entry.boiler[rawField]);
      if (update) {
        const expected = update.boiler[field];
        return { expected, rawValue: update.boiler[rawField],
          evidenceSource: `${expected ? "Auditor result" : "Ambiguous auditor value"} in ${update.location}`,
          evidence: `${update.location} · ${update.author} · ${update.date || "Date unavailable"} · ${update.id || "ID unavailable"}` };
      }
      return audit?.[localField]
        ? { expected: audit[localField], evidenceSource: "Locally saved asset audit result", evidence: `Local asset audit · ${audit.createdAt || "Date unavailable"} · ${audit.id || ""}` }
        : { expected: "", evidenceSource: "Missing audited evidence", evidence: "No comparable auditor value; recheck imported Updates or record a local audit result." };
    };
    const material = source("materialExpectedDate", "etaDate");
    const actualDate = reportingDate(project.materialExpectedDate);
    add("Material expected delivery", Boolean(actualDate) && (!material.expected || actualDate === material.expected),
      `Workfront: ${actualDate || "Missing"}; audited: ${material.expected || "No comparable audited delivery date"}${material.rawValue && !material.expected ? `; boilerplate date "${material.rawValue}" is ambiguous` : ""} (${material.evidence})`,
      Boolean(material.expected) || !actualDate, { actual: actualDate, ...material });
    for (const [field, label, normalize, localField] of [["primaryMaterial", "Primary material", key, "channel"], ["pages", "Page count", Number, "pageCount"], ["complexity", "Complexity", complexityKey, "complexity"], ["requestType", "Request type", requestKey, "requestType"]]) {
      const comparison = source(field, localField);
      const expected = comparison.expected;
      const actual = field === "primaryMaterial" ? project.assetType || project.channel : project[field];
      add(label, Boolean(actual) && normalize(actual) === normalize(expected),
        `Workfront: ${actual || "Missing"}; audited: ${expected || (comparison.rawValue ? `Ambiguous value: ${comparison.rawValue}` : "Not verified")} (${comparison.evidence})`, Boolean(expected), { actual: actual || "", ...comparison });
    }
    const sla = slaReport([project])[0];
    const planned = reportingDate(project.plannedCompletionDate || project.dueDate);
    const dateMismatch = Boolean(planned && actualDate && planned !== actualDate);
    add("Planned completion / SLA", !dateMismatch && sla.status !== "SLA missed",
      `Planned: ${planned || "Missing"}; material expected: ${actualDate || "Missing"}; ${dateMismatch ? "Delivery dates do not match; " : ""}${sla.status}${sla.detail ? `; ${sla.detail}` : ""}`,
      dateMismatch || sla.status === "SLA missed" || Boolean(planned && actualDate && sla.status !== "Not verified"),
      { actual: planned, expected: actualDate, slaStatus: sla.status, evidenceSource: "Workfront Project Details / SLA" });
    if (projectTasks.some((task) => key(task.taskName) === "build" && complete(task.taskStatus))) {
      const qa = projectTasks.filter((task) => key(task.taskName) === "qa audit");
      add("QA Audit assignment / status", qa.some((task) => (task.assignmentNames || []).some((name) => key(name) === "puneet srivastava") && key(task.taskStatus) === "new"),
        qa.length ? qa.map((task) => `${(task.assignmentNames || []).join(", ") || "Unassigned"} / ${task.taskStatus}`).join("; ") : "QA Audit task missing");
    }
    const rank = (value) => ({ simple: 1, medium: 2, complex: 3 })[complexityKey(value)] || 0;
    for (const round of rounds.filter((item) => key(item.projectRef) === key(project.ref))) {
      const latestAudit = audits.filter((item) => key(item.projectRef) === key(project.ref) && key(item.crId) === key(round.crId))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      const complexity = latestAudit?.complexity || round.complexity;
      const rule = `CR complexity · ${round.crId}`;
      add(rule, rank(complexity) <= rank(project.complexity),
        `CR ${round.crId}: ${complexity || "Missing"}; project: ${project.complexity || "Missing"}. Higher CR complexity requires project-detail review.`,
        Boolean(rank(complexity) && rank(project.complexity)));
      checks.at(-1).date = reportingDate(latestAudit?.createdAt || round.entryDate) || reportDate;
    }
    return { ref: project.ref, title: project.title, teamId: project.productionTeamId, date: reportDate, checks,
      status: checks.some((check) => check.status === "Action required") ? "Action required" : checks.some((check) => check.status === "Not verified") ? "Not verified"
        : checks.some((check) => check.status === "Manually verified") ? "Manually verified" : "Corrected" };
  });
}

function deliveryKey(source, id) {
  return `${source}:${id}`;
}

function executionDeliveries(snapshot) {
  const projects = snapshot.workfrontProjects || [];
  const rows = (snapshot.workfrontTasks || []).map((task) => {
    const project = projects.find((item) => key(item.ref) === key(task.projectRef));
    const crTask = /^(cr(?:\s*\d+)?|change rounds?)$/i.test(task.taskName);
    const crId = task.crId || (/^cr\s*\d+$/i.test(task.taskName) ? task.taskName.replace(/\s+/g, "") : "");
    const round = crId && (snapshot.workfrontChangeRounds || []).find((item) => key(item.projectRef) === key(task.projectRef) && key(item.crId) === key(crId));
    return { key: deliveryKey("workfront", task.workfrontId), source: "workfront", id: task.workfrontId, ref: task.projectRef,
      title: project?.title || task.projectName, type: task.taskName, crId, names: task.assignmentNames || [], workfrontUrl: task.workfrontUrl,
      teamId: task.productionTeamId || project?.productionTeamId, status: task.executionStatus || task.taskStatus, progress: task.executionProgress ?? task.percentComplete ?? 0,
      completedAt: complete(task.executionStatus || task.taskStatus) ? reportingDate(task.actualCompletionDate) : "",
      completionTimestamp: complete(task.executionStatus || task.taskStatus) ? task.actualCompletionDate || "" : "",
      plannedTimestamp: task.plannedCompletionDate || "",
      entryDate: reportingDate(task.entryDate || task.createdAt), plannedCompletionDate: reportingDate(task.plannedCompletionDate),
      due: crTask ? reportingDate(round?.expectedDeliveryDate || task.expectedDeliveryDate) : project?.materialExpectedDate || "",
      projectStatus: project?.sourceStatus || "", hours: task.ahtHours ?? null, project };
  });
  for (const round of snapshot.workfrontChangeRounds || []) {
    rows.push({ key: deliveryKey("cr", round.workfrontId), source: "cr", id: round.workfrontId, ref: round.projectRef,
      title: round.title, type: "CR", crId: round.crId, names: round.assignee ? [round.assignee] : [], teamId: round.productionTeamId || projects.find((item) => key(item.ref) === key(round.projectRef))?.productionTeamId, workfrontUrl: round.workfrontUrl,
      status: round.executionStatus || round.sourceStatus, progress: round.executionProgress ?? 0, due: reportingDate(round.expectedDeliveryDate), hours: round.ahtHours ?? null,
      completedAt: complete(round.executionStatus || round.sourceStatus) ? reportingDate(round.actualCompletionDate || round.completionDate) : "", entryDate: reportingDate(round.entryDate),
      completionTimestamp: complete(round.executionStatus || round.sourceStatus) ? round.actualCompletionDate || round.completionDate || "" : "",
      plannedTimestamp: round.expectedDeliveryDate || "",
      plannedCompletionDate: reportingDate(round.expectedDeliveryDate),
      project: projects.find((item) => key(item.ref) === key(round.projectRef)) });
  }
  for (const task of snapshot.tasks || []) {
    const project = (snapshot.projects || []).find((item) => item.id === task.projectId);
    if (rows.some((row) => key(row.ref) === key(project?.ref) && key(row.type) === key(task.category) && key(row.crId) === key(task.crId))) continue;
    rows.push({ key: deliveryKey("local", task.id), source: "local", id: task.id, ref: project?.ref || task.projectRef,
      title: project?.title, type: task.category, crId: task.crId || "", names: task.assignee ? [task.assignee] : [], teamId: project?.productionTeamId,
      status: task.status, progress: task.progress, due: project?.materialExpectedDate || task.etaDate || "", hours: task.plannedHours, project });
    const added = rows.at(-1);
    added.completedAt = complete(task.status) ? task.actualCompletionDate || "" : "";
    added.completionTimestamp = added.completedAt;
    added.plannedTimestamp = task.etaDate || task.dueDate || "";
    added.entryDate = reportingDate(task.createdAt);
    added.plannedCompletionDate = task.etaDate || task.dueDate || "";
  }
  return rows;
}

function qualityMatrix(deliveries, results) {
  const groups = new Map();
  for (const row of deliveries.filter((item) => /^(build|cr(?:\s*\d+)?|change rounds?)$/i.test(item.type)
    && (item.crId || /^build$/i.test(item.type) || !deliveries.some((other) => key(other.ref) === key(item.ref)
      && other.crId && /^(cr(?:\s*\d+)?|change rounds?)$/i.test(other.type))))) {
    const groupKey = `${key(row.ref)}:${/^build$/i.test(row.type) ? "build" : "cr"}:${key(row.crId)}`;
    const group = groups.get(groupKey) || [];
    group.push(row);
    groups.set(groupKey, group);
  }
  const rows = [...groups.values()].map((group) => {
    const allComplete = group.every((item) => complete(item.status));
    const representative = group.find((item) => !complete(item.status)) || group[0];
    const dates = group.map((item) => item.completedAt).filter(Boolean).sort();
    const timestamps = group.map((item) => item.completionTimestamp || item.completedAt).filter(Boolean)
      .sort((a, b) => new Date(a) - new Date(b));
    const deadlines = group.map((item) => item.plannedCompletionDate).filter(Boolean).sort();
    const row = { ...representative, names: [...new Set(group.flatMap((item) => item.names))],
      key: group[0].key,
      completedAt: allComplete && dates.length === group.length ? dates.at(-1) : "",
      completionTimestamp: allComplete && timestamps.length === group.length ? timestamps.at(-1) : "",
      plannedCompletionDate: deadlines.length === group.length ? deadlines.at(-1) : "" };
    const history = results.filter((result) => group.some((item) => result.deliveryKey === item.key)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const outcome = history[0];
    const bugs = deliveries.filter((bug) => /^bug fixing$/i.test(bug.type) && key(bug.ref) === key(row.ref)
      && (row.crId ? key(bug.crId) === key(row.crId) : !bug.crId));
    return { ...row, outcome: outcome?.result || "Awaiting QA", confirmedBy: outcome?.confirmedBy || "",
      confirmedAt: reportingDate(outcome?.date || outcome?.createdAt),
      reworkDates: [...bugs.map((bug) => reportingDate(bug.entryDate || bug.completedAt)).filter(Boolean),
        ...history.filter((result) => result.result === "Rework").map((result) => reportingDate(result.date || result.createdAt))],
      rework: history.some((result) => result.result === "Rework"),
      bugCount: bugs.length, ftr: outcome?.result === "Pass" && outcome.firstTime === true && !history.some((result) => result.result === "Rework") };
  });
  const confirmed = rows.filter((row) => row.outcome !== "Awaiting QA");
  return { rows, confirmed: confirmed.length, ftr: rows.filter((row) => row.ftr).length,
    rework: rows.filter((row) => row.rework).length,
    pending: rows.length - confirmed.length };
}

module.exports = { processAdherence, executionDeliveries, qualityMatrix, hygieneFingerprint, auditBoilerEvidence };
