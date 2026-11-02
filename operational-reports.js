"use strict";

const REPORTING_START = "2026-07-01";
const key = (value) => String(value || "").trim().toLowerCase();
function date(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return String(value);
  const parsed = value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString("en-CA") : "";
}
const closed = (status) => /^(complete|completed)$/i.test(status || "");

function mergeReportingRecord(previous, current) {
  const merged = { ...previous, ...current };
  for (const field of ["actualCompletionDate", "actualStartDate", "completionDate", "projectedStartDate", "plannedStartDate", "entryDate"]) {
    if (!current[field] && previous?.[field]) merged[field] = previous[field];
  }
  if ((previous?.actualCompletionDate || previous?.completionDate) && !current.actualCompletionDate && !current.completionDate) {
    for (const field of ["taskStatus", "sourceStatus"]) if (closed(previous[field])) merged[field] = previous[field];
  }
  return merged;
}

function reportingWindow(period = "monthly", anchor = new Date().toLocaleDateString("en-CA")) {
  const endDay = new Date(`${anchor}T12:00:00`);
  let from = anchor;
  let to = anchor;
  const iso = (day) => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  if (period === "weekly") {
    endDay.setDate(endDay.getDate() - (endDay.getDay() + 6) % 7);
    from = iso(endDay);
    endDay.setDate(endDay.getDate() + 6);
    to = iso(endDay);
  } else if (["monthly", "quarterly", "half-yearly", "yearly", "ytd"].includes(period)) {
    const month = period === "quarterly" ? Math.floor(endDay.getMonth() / 3) * 3
      : period === "half-yearly" ? Math.floor(endDay.getMonth() / 6) * 6 : period === "monthly" ? endDay.getMonth() : 0;
    from = iso(new Date(endDay.getFullYear(), month, 1));
    to = period === "ytd" ? anchor : iso(new Date(endDay.getFullYear(), month + (period === "monthly" ? 1 : period === "quarterly" ? 3 : period === "half-yearly" ? 6 : 12), 0));
  }

  return { from: from < REPORTING_START ? REPORTING_START : from, to, period, anchor };
}

function kpiPeriodReport({ window, quarterRows, periodRows, publications }) {
    if (window.period === "quarterly") return quarterRows;
    if (window.period === "monthly") return periodRows.map((row) => {
      const quarter = quarterRows.find((item) => item.memberId === row.memberId);
      return { ...row, scores: quarter.scores, ratings: quarter.ratings, provisionalTotal: quarter.provisionalTotal,
        review: quarter.review, confirmed: quarter.confirmed, scoreEvidence: quarter.evidence, evidence: JSON.stringify([row.evidence, quarter.evidence]),
        status: `${quarter.status} · quarter-to-date score; monthly evidence shown`, scoreBasis: "Quarter-to-date" };
    });
    const quarters = [];
    const anchor = new Date(`${window.anchor}T12:00:00`);
    const cursor = new Date(anchor.getFullYear(), window.period === "half-yearly" ? Math.floor(anchor.getMonth() / 6) * 6 : 0, 1, 12);
    while (date(cursor) <= window.to) {
      const quarter = { ...reportingWindow("quarterly", date(cursor)), from: date(cursor) };
      quarters.push(quarter);
      cursor.setMonth(cursor.getMonth() + 3, 1);
    }
    return periodRows.map((row) => {
      const reports = quarters.map((quarter) => publications.filter((publication) => publication.memberId === row.memberId
        && publication.period === "quarterly" && publication.from === quarter.from && publication.to === quarter.to && !publication.recalledAt)
        .sort((a, b) => b.version - a.version)[0]);
      const complete = reports.length > 0 && reports.every((report) => report?.final && report.snapshot.confirmed);
      const average = (values) => values.length && values.every((value) => value !== null && value !== undefined)
        ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : null;
      const scores = Object.fromEntries(["productivity", "quality", "onTime", "process", "manager"].map((component) => [component,
        complete ? average(reports.map((report) => report.snapshot.scores[component])) : null]));
      return { ...row, scores, ratings: { productivity: null, manager: null, quality: null }, review: null,
        provisionalTotal: complete ? average(reports.map((report) => report.snapshot.provisionalTotal)) : null,
        confirmed: complete, status: complete ? "Roll-up of published quarterly reviews" : `Incomplete: ${reports.filter((report) => report?.final).length}/${quarters.length} final quarters published`,
        evidence: JSON.stringify([row.evidence, reports.map((report) => report?.id || null)]),
        scoreBasis: "Published quarterly average", quarterCoverage: quarters.map((quarter, index) => ({ from: quarter.from, to: quarter.to,
          outsideCoverage: quarter.from < REPORTING_START, publicationId: reports[index]?.id || null })) };
    });
  }
function deliveryPeriod(row, from, to) {
  const when = date(row.completedAt || row.confirmedAt || row.entryDate);
  return Boolean(when && when >= from && when <= to);
}

function slaReport(projects, today = new Date().toLocaleDateString("en-CA")) {
  return projects.map((project) => {
    const start = date(project.actualStartDate);
    const planned = date(project.plannedCompletionDate || project.dueDate);
    const completed = date(project.actualCompletionDate);
    const done = closed(project.sourceStatus || project.status);
    let status = "Within SLA";
    if (!planned || start && start > planned || done && !completed) status = "Not verified";
    else if ((completed || today) > planned) status = "SLA missed";
    else if (!start) status = "Not verified";
    else if (done) status = "Delivered on time";
    return { ref: project.ref, title: project.title, start, planned, completed, status,
      detail: !start ? "Actual Start Date missing in Project Details; any known completion-date breach is still reported." : "",
      daysLate: status === "SLA missed" ? Math.round((new Date(`${completed || today}T12:00:00`) - new Date(`${planned}T12:00:00`)) / 86400000) : 0 };
  });
}

function retainReportingHistory(data) {
  data.reportingHistory ||= {};
  for (const [name, field] of [["projects", "workfrontProjects"], ["tasks", "workfrontTasks"], ["rounds", "workfrontChangeRounds"]]) {
    const records = new Map((data.reportingHistory[name] || []).map((record) => [record.workfrontId, record]));
    for (const record of data[field] || []) records.set(record.workfrontId, mergeReportingRecord(records.get(record.workfrontId), record));
    data.reportingHistory[name] = [...records.values()];
  }
}

function countMisses(issues, category, automatic) {
  const ids = new Set(automatic);
  for (const issue of issues.filter((item) => item.category === category && item.status !== "Withdrawn")) {
    ids.add(issue.deliveryKey || `issue:${issue.id}`);
  }
  return ids.size;
}

function qualityScore(misses) { return misses <= 2 ? 30 : misses === 3 ? 25 : misses === 4 ? 15 : 0; }
function productivityScore(percent) { return percent >= 90 ? 30 : percent >= 85 ? 24 : percent >= 70 ? 18 : percent >= 40 ? 12 : 6; }

function kpiReport({ members, deliveries, quality, issues = [], reviews = [], workLogs = [], nonProductiveLogs = [], requirePublishedDesignQA = false, from, to, reviewTo = to, reviewPeriod = "quarterly", today = new Date().toLocaleDateString("en-CA") }) {
  const inPeriod = (value) => date(value) >= from && date(value) <= to;
  const counts = members.map((member) => {
    const assigned = deliveries.filter((row) => row.names.some((name) => key(name) === key(member.name)));
    const audit = member.role === "auditor";
    const completed = audit
      ? [...new Map(assigned.filter((row) => /^asset audit$/i.test(row.type) && closed(row.status) && inPeriod(row.completedAt))
        .map((row) => [`${key(row.ref)}:${key(row.crId)}`, row])).values()]
      : quality.rows.filter((row) => row.names.includes(member.name) && row.completedAt && inPeriod(row.completedAt));
    return { member, assigned, completed };
  });
  return counts.map(({ member, assigned, completed }) => {
    const ownIssues = issues.filter((issue) => issue.memberId === member.id && inPeriod(issue.date) && issue.status !== "Withdrawn");
    const review = reviews.find((item) => item.memberId === member.id && item.from === from && item.to === reviewTo && (item.period || "quarterly") === reviewPeriod);
    const peers = counts.filter((other) => other.member.role === member.role && (member.teamIds || []).some((team) => other.member.teamIds?.includes(team)));
    const benchmark = Math.max(0, ...peers.map((other) => other.completed.length));
    const percent = benchmark ? completed.length / benchmark * 100 : null;
    const ownQuality = quality.rows.filter((row) => row.names.includes(member.name) && (deliveryPeriod(row, from, to) || row.reworkDates?.some(inPeriod)));
    const designQA = requirePublishedDesignQA && member.role === "executioner" && member.teamIds?.includes("design");
    const missKey = (row) => row ? row.qualityIdentity || `${key(row.ref)}:${key(row.crId) || "build"}` : "";
    const autoQuality = member.role === "auditor" ? [] : ownQuality.filter((row) => row.rework && (!designQA || row.teamId !== "design" || row.qaPublished)).map((row) => designQA ? missKey(row) : row.key);
    const qualityIssues = designQA ? ownIssues.map((issue) => {
      const delivery = [...quality.rows, ...deliveries].find((row) => row.key === issue.deliveryKey);
      return { ...issue, deliveryKey: delivery ? missKey(delivery) : issue.deliveryKey };
    }) : ownIssues;
    const qualityMisses = countMisses(qualityIssues, "Quality", autoQuality);
    const late = completed.filter((row) => row.plannedCompletionDate && date(row.completedAt) > date(row.plannedCompletionDate));
    const overdueAudits = member.role === "auditor" ? assigned.filter((row) => /^asset audit$/i.test(row.type) && !closed(row.status)
      && row.plannedCompletionDate && inPeriod(row.plannedCompletionDate) && date(row.plannedCompletionDate) < today) : [];
    const deliveryMisses = countMisses(ownIssues, "On-time Delivery", [...late, ...overdueAudits].map((row) => row.key));
    const processMisses = countMisses(ownIssues, "Process adherence", []);
    const feedback = review?.feedback || [];
    const managerScore = feedback.length === 4 && feedback.every((value) => typeof value === "boolean") ? feedback.filter(Boolean).length * 5 : null;
    const scores = {
      productivity: percent === null ? null : productivityScore(percent),
      quality: !completed.length || designQA && ownQuality.some((row) => row.teamId === "design" && (row.completedAt || row.rework) && !row.qaPublished) || designQA && !ownQuality.length
        || member.role === "auditor" && !review?.qualityVerified || ownQuality.some((row) => row.outcome === "Awaiting QA" && !row.rework) && !review?.qualityVerified ? null : qualityScore(qualityMisses),
      onTime: completed.some((row) => !row.plannedCompletionDate) && !review?.deliveryVerified ? null : deliveryMisses > 1 ? 0 : 10,
      process: review?.processVerified ? processMisses < 5 ? 10 : processMisses <= 10 ? 5 : 0 : null,
      manager: managerScore
    };
    const provisionalTotal = Object.values(scores).every((value) => value !== null) ? Object.values(scores).reduce((a, b) => a + b, 0) : null;
    const hours = workLogs.filter((log) => (log.userId === member.id || key(log.userName) === key(member.name)) && inPeriod(log.date)).reduce((sum, log) => sum + Number(log.hours || 0), 0);
    const nonProductiveHours = nonProductiveLogs.filter((log) => log.userId === member.id && inPeriod(log.date)).reduce((sum, log) => sum + log.hours, 0);
    const unknownCompletionDates = assigned.filter((row) => (member.role === "auditor" ? /^asset audit$/i.test(row.type) : /^(build|cr(?:\s*\d+)?|change rounds?)$/i.test(row.type)) && closed(row.status) && !row.completedAt).length;
    const evidence = JSON.stringify({ completed: completed.map((row) => [row.key, row.completedAt, row.plannedCompletionDate]), unknownCompletionDates,
      issues: ownIssues.map((issue) => [issue.id, issue.deliveryKey, issue.category, issue.note]),
      quality: ownQuality.map((row) => [row.key, row.outcome, row.confirmedAt, row.ftr, row.bugCount, Boolean(row.qaPublished)]),
      qualityMisses, deliveryMisses, processMisses, scores, benchmark, hours, nonProductiveHours });
    const confirmed = Boolean(review?.finalized && review.coverageConfirmed && review.qualityVerified && review.processVerified && review.deliveryVerified
      && review.overallRating >= 1 && review.overallRating <= 5 && review.evidence === evidence && provisionalTotal !== null && unknownCompletionDates === 0);
    return { memberId: member.id, name: member.name, role: member.role, teamIds: member.teamIds,
      completed: completed.length, benchmark, productivityPercent: percent, ftr: ownQuality.filter((row) => row.ftr).length,
      overdueAudits: overdueAudits.length,
      qualityMisses, deliveryMisses, processMisses, hours, nonProductiveHours, scores, provisionalTotal, confirmed,
      ratings: { productivity: scores.productivity === null ? null : scores.productivity >= 25 ? 5 : scores.productivity >= 19 ? 4 : scores.productivity >= 13 ? 3 : scores.productivity >= 7 ? 2 : 1,
        manager: managerScore === null ? null : managerScore >= 17 ? 5 : managerScore >= 13 ? 4 : managerScore >= 9 ? 3 : managerScore >= 5 ? 2 : 1,
        quality: scores.quality === null ? null : qualityMisses <= 2 ? 5 : qualityMisses === 3 ? 4 : qualityMisses === 4 ? 3 : qualityMisses === 5 ? 2 : 1 },
      review: review || null, evidence, status: confirmed ? "Manager confirmed" : review?.finalized ? "Review changed evidence" : "Provisional / evidence review required",
      unknownCompletionDates };
  });
}

module.exports = { REPORTING_START, reportingDate: date, reportingWindow, deliveryPeriod, slaReport, retainReportingHistory, mergeReportingRecord, kpiReport, kpiPeriodReport };
