"use strict";

const KPI_FEEDBACK_CRITERIA = [
  "Extra-mile contribution / cross-skilled resourcing",
  "Adherence to Manager action items with business impact",
  "Mandatory training completed on time (100% adherence)",
  "Leave / transport exceptions and in-office eight-hour adherence"
];
let selectedKpiWorkspace = null;
let selectedKpiUser = "";
let kpiLoadSequence = 0;
let weeklyQAPage = 1;

function operationalManager() { return ["manager", "teamManager"].includes(state.user?.role); }

function selectedWeeklyQA() {
  return state.operationsWorkspace?.weeklyQA?.reports.find((report) => report.id === $("#weekly-qa-select").value);
}

function bugEvidenceRows() {
  const { from, to } = qualityWindow();
  const member = $("#quality-member").value;
  return (state.operationsWorkspace?.weeklyQA?.bugs || []).filter((row) => {
    const dates = [row.date, ...(row.updates || []).map((update) => update.date ? localDate(new Date(update.date)) : "")].filter(Boolean);
    return (!member || row.assignmentNames.includes(member))
      && ($("#quality-period").value === "undated" ? !dates.length : dates.some((date) => date >= from && date <= to));
  });
}

function renderBugEvidence() {
  $("#bug-report-coverage").textContent = state.operationsWorkspace?.weeklyQA?.coverage || "Source evidence not loaded.";
  $("#bug-update-report").innerHTML = workflowTable(["Project / Bug Fixing task", "Worker / evidence", "Date / status", "Updates / rework details"], bugEvidenceRows().slice(0, 20).map((row) => [
    `${deliveryWorkfrontLink({ source: "workfront", id: row.id, ref: row.projectRef, type: "Bug Fixing", project: row.project })}<small>${workfrontProjectLink(row.project, row.title)}</small>`,
    `${escapeHTML(row.assignmentNames.join(", "))}<small>${escapeHTML(row.evidenceType)}</small>`,
    `${escapeHTML(row.date || "Undated")}<small>${escapeHTML(row.status)}</small>`,
    `${(row.updates || []).map((update) => `<details><summary>${escapeHTML(update.author || "Author unavailable")} · ${escapeHTML(update.date || "Date unavailable")}</summary><p class="audit-notes">${escapeHTML(update.text)}</p></details>`).join("") || "No readable Updates evidence"}
      <small>${escapeHTML(row.updatesStatus)}</small><small>${escapeHTML(row.note)}</small>`
  ]));
}

function renderWeeklyQA() {
  const workspace = state.operationsWorkspace?.weeklyQA || { reports: [], members: [] };
  fillOptions($("#weekly-qa-select"), workspace.reports.map((report) => [report.id, `${report.from} to ${report.to} · ${report.status} ${report.version ? `v${report.version}` : ""}${report.recalledAt ? " · Recalled" : ""}`]), "Choose weekly report");
  const report = selectedWeeklyQA();
  const canAdd = ["manager", "teamManager", "auditor"].includes(state.user.role) && (state.user.role === "manager" || state.user.teamIds.some((team) => ["design", "qa"].includes(team)));
  $("#weekly-qa-tools").classList.toggle("hidden", !canAdd);
  $("#weekly-qa-add").classList.toggle("hidden", !canAdd || report?.status !== "Draft");
  fillOptions($("#weekly-qa-row-form").elements.executor, workspace.members.map((member) => [member.name, member.name]), "Original Design executor");
  if (!report) {
    $("#weekly-qa-status").textContent = "Select a report. Drafts have no KPI effect.";
    $("#weekly-qa-source").textContent = "";
    for (const id of ["weekly-qa-actions", "weekly-qa-summary", "weekly-qa-rows"]) $(`#${id}`).innerHTML = "";
    $("#weekly-qa-page").textContent = "";
    $("#weekly-qa-previous").disabled = true;
    $("#weekly-qa-next").disabled = true;
    return;
  }
  const included = report.rows.filter((row) => !row.excluded);
  const matched = included.filter((row) => row.validation && row.sourceCheck.status === "Matched").length;
  const attention = included.length - matched;
  const ready = included.length > 0;
  $("#weekly-qa-status").textContent = `${report.from} to ${report.to} · ${report.status}${report.recalledAt ? " · Recalled" : ""} · ${attention
    ? `${attention} available for optional verification. ${report.status === "Draft" ? "Ready to publish without validation." : "Published results count in Quality KPI and FTR. Create a corrected draft if needed."}`
    : ready ? `All included rows matched.${report.status === "Draft" ? " Ready to publish." : ""}` : "No included rows."}`;
  workflowMetrics("#weekly-qa-summary", [["Design deliveries", included.filter((row) => !row.deliveryMissing).length],
    ["FTR passes", included.filter((row) => !row.bugCreated && !row.deliveryMissing).length],
    ["Quality issues / bugs", included.filter((row) => row.bugCreated).length], ["Manually matched", matched]]);
  $("#weekly-qa-actions").innerHTML = `<button type="button" class="button secondary" data-weekly-download>Download Design QA CSV</button>${operationalManager()
    ? (report.status === "Draft" ? `<button type="button" class="button secondary" data-weekly-match>Verify Workfront IDs (optional)</button><button type="button" class="button primary" data-weekly-action="publish" ${ready ? "" : "disabled"}>Publish week · apply to KPI</button>`
      : `<button type="button" class="button secondary" data-weekly-action="revise">Create corrected draft</button>${!report.recalledAt ? '<button type="button" class="button secondary" data-weekly-action="recall">Recall week</button>' : ""}`) : ""}`;
  $("#weekly-qa-source").textContent = `${report.sourceFile || "Manual QA report"} · ${report.note}${report.recalledAt ? ` · Recall: ${report.recallReason}` : ""} · All-team source: ${report.sourceTotals.deliveries} deliveries, ${report.sourceTotals.bugRows} bug rows, ${report.sourceTotals.unmatchedBugRows || 0} unmatched bug rows. ${report.sourceTotals.excludedOtherTeams} other-team rows excluded. Design bug-only rows: ${included.filter((row) => row.deliveryMissing).length}. Defects are informational, not KPI miss counts.`;
  const filter = $("#weekly-qa-filter").value;
  const visible = report.rows.filter((row) => filter === "all" || (filter === "excluded" ? row.excluded
    : !row.excluded && (filter === "matched" ? row.validation && row.sourceCheck.status === "Matched"
      : !row.validation || row.sourceCheck.status !== "Matched")));
  const pages = Math.max(1, Math.ceil(visible.length / 10));
  weeklyQAPage = Math.min(weeklyQAPage, pages);
  $("#weekly-qa-page").textContent = `${visible.length} QA rows · Page ${weeklyQAPage} / ${pages}`;
  $("#weekly-qa-previous").disabled = weeklyQAPage <= 1;
  $("#weekly-qa-next").disabled = weeklyQAPage >= pages;
  $("#weekly-qa-rows").innerHTML = visible.length ? workflowTable(["Workfront ID / project", "Executor", "QA result", "Match status", "Action"], visible.slice((weeklyQAPage - 1) * 10, weeklyQAPage * 10).map((row) => [
    `${workfrontProjectLink({ workfrontUrl: row.sourceCheck.projectUrl }, row.projectRef)}<small>${escapeHTML(row.sourceCheck.projectTitle || "Project not found in Workfront data")}</small>`,
    `${escapeHTML(row.executor || "Not identified")}<small>${escapeHTML(row.requestType)} ${escapeHTML(row.crId)}</small>`,
    `${row.deliveryMissing ? "Bug only · delivery missing" : row.bugCreated ? "Quality issue / bug · FTR failure" : "FTR pass"}<details><summary>QA details</summary><small>${escapeHTML(row.qaTaskId)} · ${escapeHTML(row.deliveredDate)}</small>${row.bugs.map((bug) => `<p>${escapeHTML(bug.bugDate)} · ${bug.totalBugs} defects · ${escapeHTML(bug.description)}</p>`).join("") || "No bugs reported"}</details>`,
    `${badge(row.excluded ? "Excluded" : row.validation && row.sourceCheck.status === "Matched" ? "Matched" : "Optional verification")}<small>${escapeHTML(row.excluded ? row.exclusionNote : row.sourceCheck.problems.join("; ") || (row.validation ? "" : "QA bulletin accepted without validation"))}</small>`,
    `${operationalManager() && report.status === "Draft" ? `<button type="button" class="mini-button" data-weekly-review="${escapeHTML(row.id)}">Verify / correct FTR / Bug</button> ` : ""}${state.roleCapabilities.viewHygiene ? `<button type="button" class="mini-button" data-weekly-hygiene="${escapeHTML(row.sourceCheck.projectRef || row.projectRef)}">Hygiene</button>` : ""}`
  ])) : '<p class="muted">No rows in this view. Choose All rows to see the full report.</p>';
}

function initializeWeeklyQA() {
  $("#weekly-qa-select").addEventListener("change", () => { weeklyQAPage = 1; renderWeeklyQA(); });
  $("#weekly-qa-filter").addEventListener("change", () => { weeklyQAPage = 1; renderWeeklyQA(); });
  $("#weekly-qa-previous").addEventListener("click", () => { weeklyQAPage = Math.max(1, weeklyQAPage - 1); renderWeeklyQA(); });
  $("#weekly-qa-next").addEventListener("click", () => { weeklyQAPage++; renderWeeklyQA(); });
  $("#weekly-qa-import-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      delete values.file;
      const file = form.elements.file.files[0];
      if (file) values.file = await fileAsBase64(file);
      const report = await api(file ? "/api/weekly-qa/import" : "/api/weekly-qa", { method: "POST", body: JSON.stringify(values) });
      await refreshData();
      $("#weekly-qa-select").value = report.id;
      renderWeeklyQA();
      showToast("QA draft created. Publish to apply Quality KPI and FTR; verification is optional.");
    } catch (error) { showToast(error.message, true); } finally { button.disabled = false; }
  });
  $("#weekly-qa-import-form").elements.from.addEventListener("change", (event) => {
    const date = new Date(`${event.target.value}T12:00:00`);
    if (!Number.isFinite(date.getTime())) return;
    date.setDate(date.getDate() + 6);
    $("#weekly-qa-import-form").elements.to.value = localDate(date);
  });
  const post = (formId, path, body, method = "POST") => $(`#${formId}`).addEventListener("submit", async (event) => {
    event.preventDefault();
    const report = selectedWeeklyQA();
    if (!report) return showToast("Select a weekly QA report.", true);
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const result = await api(`/api/weekly-qa/${report.id}/${path(form)}`, { method, body: JSON.stringify(body(form)) });
      await refreshData();
      if (formId === "weekly-qa-review-form") $("#weekly-qa-review-dialog").close();
      if (formId === "weekly-qa-action-form") {
        $("#weekly-qa-action-dialog").close();
        if (result.status === "Draft" && result.id !== report.id) $("#weekly-qa-select").value = result.id;
      }
      renderWeeklyQA();
      showToast("QA report saved.");
    } catch (error) { showToast(error.message, true); } finally { button.disabled = false; }
  });
  post("weekly-qa-row-form", () => "rows", (form) => ({ ...Object.fromEntries(new FormData(form)), bugCreated: form.elements.bugCreated.checked }));
  post("weekly-qa-review-form", (form) => `rows/${form.elements.rowId.value}`, (form) => ({
    ...Object.fromEntries(new FormData(form)), exclude: form.elements.exclude.checked, aliasConfirmed: form.elements.aliasConfirmed.checked,
    bugCreated: form.elements.bugCreated.value === "bug"
  }), "PUT");
  post("weekly-qa-action-form", (form) => form.elements.action.value, (form) => ({ note: form.elements.note.value }));
  $("#bug-report-export").addEventListener("click", () => downloadCSV("design-workfront-bug-evidence.csv", [
    ["Project", "Task / evidence", "Worker", "Date", "Status", "Updates", "Read coverage"], ...bugEvidenceRows().map((row) =>
      [row.projectRef, row.id, row.assignmentNames.join(", "), row.date, row.status, row.updates.map((update) => `${update.author} ${update.date}: ${update.text}`).join("\n"), row.updatesStatus])
  ]));
  document.addEventListener("click", (event) => {
    const match = event.target.closest("[data-weekly-match]");
    if (match) {
      match.disabled = true;
      api(`/api/weekly-qa/${selectedWeeklyQA().id}/match`, { method: "POST", body: "{}" })
        .then(async (result) => {
          await refreshData();
          renderWeeklyQA();
          showToast(`${result.matched} matched; ${result.needsAttention} need attention.`);
        }).catch((error) => showToast(error.message, true)).finally(() => { match.disabled = false; });
    }
    const hygiene = event.target.closest("[data-weekly-hygiene]");
    if (hygiene) {
      $("#hygiene-project").value = hygiene.dataset.weeklyHygiene;
      $("#hygiene-from").value = "";
      $("#hygiene-to").value = "";
      $("#hygiene-dated").value = "all";
      $("#hygiene-filter").value = "";
      setView("hygiene");
    }
    const action = event.target.closest("[data-weekly-action]");
    const review = event.target.closest("[data-weekly-review]");
    if (action) {
      const form = $("#weekly-qa-action-form");
      form.reset();
      form.elements.action.value = action.dataset.weeklyAction;
      if (action.dataset.weeklyAction === "publish") form.elements.note.value = "QA bulletin results applied to Quality KPI and FTR; manual verification is optional.";
      $("#weekly-qa-action-title").textContent = `${action.textContent} · ${selectedWeeklyQA().from}`;
      $("#weekly-qa-action-dialog").showModal();
    }
    if (review) {
      const report = selectedWeeklyQA();
      const row = report.rows.find((item) => item.id === review.dataset.weeklyReview);
      const form = $("#weekly-qa-review-form");
      form.reset();
      fillOptions(form.elements.executor, state.operationsWorkspace.weeklyQA.members.map((member) => [member.name, member.name]), "Select original executor");
      form.elements.rowId.value = row.id;
      form.elements.projectRef.value = row.sourceCheck.projectRef || row.projectRef;
      form.elements.executor.value = row.executor;
      form.elements.crId.value = row.crId || "";
      form.elements.bugCreated.value = row.bugCreated ? "bug" : "ftr";
      form.elements.exclude.checked = row.excluded === true;
      form.elements.aliasConfirmed.checked = row.validation?.aliasConfirmed === true;
      form.elements.note.value = row.exclusionNote || row.validation?.note || "Manual review of QA bulletin result.";
      $("#weekly-qa-review-cr").classList.toggle("hidden", !/^cr/i.test(row.requestType));
      $("#weekly-qa-review-source").textContent = `${row.projectRef} · ${row.sourceCheck.problems.join("; ") || "Check ID and executor, then save."}`;
      $("#weekly-qa-review-dialog").showModal();
      form.dispatchEvent(new Event("change"));
    }
    if (event.target.closest("[data-weekly-download]")) {
      const report = selectedWeeklyQA();
      downloadCSV(`Design-QA-${report.from}-v${report.version || "draft"}.csv`, [["Week", "Version", "Publication", "QA ID", "Project", "Original executor", "CR", "Evidence kind", "QA delivered", "Bugs", "Defects", "Validation", "Notes"],
        ...report.rows.map((row) => [report.from, report.version, report.recalledAt ? "Recalled" : report.status, row.qaTaskId, row.projectRef, row.executor, row.crId,
          row.deliveryMissing ? "Bug only / no delivery record" : "Delivery", row.deliveryMissing ? "" : row.deliveredDate, row.bugCreated, row.bugs.reduce((sum, bug) => sum + bug.totalBugs, 0), row.excluded ? "Excluded" : row.validation && row.sourceCheck.status === "Matched" ? "Validated" : row.sourceCheck.status, row.excluded ? row.exclusionNote : row.validation?.note || ""])]);
    }
  });
  const reviewForm = $("#weekly-qa-review-form");
  const updateReviewFields = () => {
    const row = selectedWeeklyQA()?.rows.find((item) => item.id === reviewForm.elements.rowId.value);
    const excluded = reviewForm.elements.exclude.checked;
    reviewForm.elements.executor.required = !excluded;
    reviewForm.elements.projectRef.required = !excluded;
    const alias = Boolean(row && (!row.originalExecutor || reviewForm.elements.executor.value !== row.executor || row.validation?.aliasConfirmed));
    $("#weekly-qa-review-alias").classList.toggle("hidden", excluded || !alias);
  };
  reviewForm.addEventListener("change", updateReviewFields);
  reviewForm.elements.exclude.addEventListener("change", () => {
    if (reviewForm.elements.exclude.checked) reviewForm.elements.note.value = "";
  });
}

function qualityWindow() {
  const anchor = $("#quality-date").value || localDate();
  const period = $("#quality-period").value;
  const day = new Date(`${anchor}T12:00:00`);
  const iso = (value) => localDate(value);
  let from = anchor;
  let to = anchor;
  if (period === "weekly") {
    day.setDate(day.getDate() - (day.getDay() + 6) % 7);
    from = iso(day);
    day.setDate(day.getDate() + 6);
    to = iso(day);
  } else if (["monthly", "quarterly", "yearly", "ytd"].includes(period)) {
    const month = period === "monthly" ? day.getMonth() : period === "quarterly" ? Math.floor(day.getMonth() / 3) * 3 : 0;
    from = iso(new Date(day.getFullYear(), month, 1));
    to = period === "ytd" ? anchor : iso(new Date(day.getFullYear(), month + (period === "monthly" ? 1 : period === "quarterly" ? 3 : 12), 0));
  } else if (period === "all") { from = "2026-07-01"; to = anchor; }
  return { from: from < "2026-07-01" ? "2026-07-01" : from, to };
}

function periodQualityRows() {
  const { from, to } = qualityWindow();
  const workspace = state.operationsWorkspace;
  const all = workspace?.quality?.rows || [];
  const member = $("#quality-member").value;
  fillOptions($("#quality-member"), [...new Set((workspace?.qualityDeliveries || []).flatMap((row) => row.names))].sort().map((name) => [name, name]), "All members in scope");
  const inPeriod = (row) => {
    const when = String(row.completedAt || row.confirmedAt || "").slice(0, 10);
    if ($("#quality-period").value === "undated") return !when;
    return when && when >= from && when <= to;
  };
  const memberMatches = (row) => !member || row.names.includes(member);
  const rows = all.filter((row) => memberMatches(row) && inPeriod(row));
  $("#quality-instances").innerHTML = workflowTable(["Assignment / project", "Member", "Source status", "Actual completion", "Entry date", "Due"],
    (workspace?.qualityDeliveries || []).filter((row) => row.source !== "local" && memberMatches(row) && inPeriod(row)).slice(0, 20).map((row) => [
      `${deliveryWorkfrontLink(row)}<small>${workfrontProjectLink(row.project, row.title)}</small>`, escapeHTML(row.names.join(", ")), escapeHTML(row.status),
      escapeHTML(row.completedAt || "Not recorded"), escapeHTML(row.entryDate || "Not recorded"), escapeHTML(row.due || row.plannedCompletionDate || "Not recorded")
    ]));
  const unknown = all.filter((row) => memberMatches(row) && !row.completedAt && !row.confirmedAt).length;
  const bugs = (workspace?.qualityDeliveries || []).filter((row) => /^bug fixing$/i.test(row.type)
    && String(row.completedAt || row.entryDate).slice(0, 10) >= from && String(row.completedAt || row.entryDate).slice(0, 10) <= to).length;
  $("#quality-coverage").textContent = `${from} to ${to} · ${unknown} deliveries lack completion/QA dates (use Undated). ${bugs} dated Bug Fixing tasks are review evidence, not automatic FTR failures. ${workspace?.coverage || "Historical evidence not loaded."}`;
  renderWeeklyQA();
  renderBugEvidence();
  return rows;
}

function fillOptions(select, entries, placeholder = "") {
  const value = select.value;
  select.innerHTML = `${placeholder ? `<option value="">${escapeHTML(placeholder)}</option>` : ""}${entries.map(([id, label]) => `<option value="${escapeHTML(id)}">${escapeHTML(label)}</option>`).join("")}`;
  if ([...select.options].some((option) => option.value === value)) select.value = value;
}

function kpiWorkspace() {
  return selectedKpiWorkspace || state.operationsWorkspace;
}

function applyOperationalSnapshot() {
  if (selectedKpiUser !== state.user.id) { selectedKpiWorkspace = null; selectedKpiUser = state.user.id; kpiLoadSequence++; }
  if (selectedKpiWorkspace?.window?.period === state.operationsWorkspace?.window?.period
    && selectedKpiWorkspace?.window?.anchor === state.operationsWorkspace?.window?.anchor) selectedKpiWorkspace = state.operationsWorkspace;
}

function renderOperationalViews() {
  const workspace = state.operationsWorkspace;
  if (!workspace) return;
  renderSLA();
  renderKPI();
  const feedbackForm = $("#project-feedback-form");
  const assignments = (workspace.deliveries || []).filter((row) => operationalManager() || row.names.includes(state.user.name));
  feedbackForm.classList.toggle("hidden", state.user.role === "leadership");
  $("#non-productive-form").classList.toggle("hidden", state.user.role === "leadership");
  fillOptions(feedbackForm.elements.projectRef, [...new Map(assignments.map((row) => [row.ref, [row.ref, `${row.ref} · ${row.title}`]])).values()], "Choose project");
  const feedbackFilter = $("#feedback-filter").value;
  $("#project-feedback-list").innerHTML = workflowTable(["Project", "From", "Type", "Details", "Status / response"], (workspace.feedback || []).filter((entry) => !feedbackFilter || entry.category === feedbackFilter || entry.status === feedbackFilter).map((entry) => [
    escapeHTML(entry.projectRef), escapeHTML(entry.userName), escapeHTML(entry.category), escapeHTML(entry.message),
    `${escapeHTML(entry.status)}<p>${escapeHTML(entry.response)}</p>${operationalManager() ? `<button type="button" class="mini-button" data-feedback-response="${escapeHTML(entry.id)}">Respond</button>` : ""}`
  ]));
  $("#best-practice-list").innerHTML = workflowTable(["Best practice", "Solution / guidance", "Source project", "Approved by"], (workspace.bestPractices || []).map((entry) =>
    [escapeHTML(entry.practiceTitle), `${escapeHTML(entry.message)}<p>${escapeHTML(entry.response)}</p>`, escapeHTML(entry.projectRef), `${escapeHTML(entry.reviewedBy)} · ${escapeHTML(entry.updatedAt)}`]));
  fillOptions($("#activity-member"), [...new Map((workspace.activityLogs || []).map((log) => [log.userId, [log.userId, log.userName]])).values()], "All members in scope");
  const logs = (workspace.activityLogs || []).filter((log) => (!$("#activity-member").value || log.userId === $("#activity-member").value)
    && (!$("#activity-from").value || log.date >= $("#activity-from").value) && (!$("#activity-to").value || log.date <= $("#activity-to").value));
  workflowMetrics("#non-productive-summary", ["Training", "Meeting", "Other"].map((category) => [category, `${logs.filter((log) => log.category === category).reduce((sum, log) => sum + log.hours, 0).toFixed(2)}h`]));
  $("#non-productive-list").innerHTML = workflowTable(["Date", "Member", "Activity", "Hours", "Details"], logs.slice().sort((a, b) => b.date.localeCompare(a.date)).map((log) =>
    [escapeHTML(log.date), escapeHTML(log.userName), escapeHTML(log.category), Number(log.hours).toFixed(2), escapeHTML(log.note)]));
}

function renderSLA() {
  const rows = (state.operationsWorkspace?.sla || []).filter((row) => hygieneInRange(row.planned) && hygieneProjectMatches(row));
  workflowMetrics("#sla-summary", ["SLA missed", "Within SLA", "Delivered on time", "Not verified"].map((status) => [status, rows.filter((row) => row.status === status).length]));
  $("#sla-list").innerHTML = workflowTable(["Project", "Actual start (Project Details)", "Planned completion", "Actual completion", "SLA", "Days late"], rows.map((row) => [
    escapeHTML(`${row.ref} · ${row.title}`), escapeHTML(row.start || "Missing"), escapeHTML(row.planned || "Missing"),
    escapeHTML(row.completed || "Not recorded"), `${badge(row.status)}<small>${escapeHTML(row.detail || "")}</small>`, row.daysLate
  ]));
}

function renderKPI() {
  const workspace = kpiWorkspace();
  const rows = workspace?.kpis || [];
  const score = (value, max) => value === null || value === undefined ? "Not verified" : `${value}/${max}`;
  const window = workspace?.window;
  $("#kpi-period-label").textContent = `${window?.period || "quarterly"} · ${window?.from || "2026-07-01"} to ${window?.to || ""} · ${window?.period === "monthly" ? "Monthly evidence; scores use quarter-to-date (not monthly miss thresholds)." : ["half-yearly", "yearly"].includes(window?.period) ? "Scores average published final quarterly reports; missing quarters remain incomplete." : "Approved quarterly thresholds."} · ${workspace?.coverage || "Evidence not loaded."}`;
  workflowMetrics("#kpi-summary", [["Members", rows.length], ["Manager confirmed", rows.filter((row) => row.confirmed).length],
    ["Verified completed assets / audits", rows.reduce((sum, row) => sum + row.completed, 0)], ["Unknown completion dates", rows.reduce((sum, row) => sum + row.unknownCompletionDates, 0)]]);
  $("#kpi-list").innerHTML = workflowTable(["Member / role", "Completed / benchmark", "Productivity /30", "Quality /30", "On-time /10", "Process /10", "Manager /20", "Total /100", "Hours / utilization", "Review"], rows.map((row) => [
    `${escapeHTML(row.name)}<small>${escapeHTML(row.role)}</small>`, `${row.completed} / ${row.benchmark || "Not verified"}`,
    `${score(row.scores.productivity, 30)}<small>${row.productivityPercent === null ? "" : `${row.productivityPercent.toFixed(1)}% of peer benchmark`} · Rating ${row.ratings.productivity ?? "Not verified"}/5</small>`,
    `${score(row.scores.quality, 30)}<small>${row.qualityMisses} validated / automatic misses; FTR ${row.ftr} · Rating ${row.ratings.quality ?? "Not verified"}/5</small>`,
    `${score(row.scores.onTime, 10)}<small>${row.deliveryMisses} delivery / audit-delay misses${row.role === "auditor" ? ` · ${row.overdueAudits} open overdue audits` : ""}</small>`,
    `${score(row.scores.process, 10)}<small>${row.processMisses} recorded misses</small>`, `${score(row.scores.manager, 20)}<small>Rating ${row.ratings.manager ?? "Not reviewed"}/5</small>`,
    `${score(row.provisionalTotal, 100)}<small>${row.confirmed ? "Confirmed" : "Provisional"} · Overall ${row.review?.overallRating ?? "Not reviewed"}/5</small>`,
    `${row.hours.toFixed(2)}h productive<small>${row.nonProductiveHours.toFixed(2)}h non-productive · ${(row.hours + row.nonProductiveHours).toFixed(2)}h total recorded · Target: 150h/month (informational)</small>`,
    `${escapeHTML(row.status)}${row.review?.note ? `<small>${escapeHTML(row.review.note)} · ${escapeHTML(row.review.reviewedBy)}</small>` : ""}${operationalManager() ? `${["monthly", "quarterly"].includes(window.period) ? `<button type="button" class="mini-button" data-kpi-review="${escapeHTML(row.memberId)}">Review ${window.period === "monthly" ? "QTD" : "quarter"} KPI</button>` : ""}<button type="button" class="mini-button" data-kpi-publish="${escapeHTML(row.memberId)}">Publish ${escapeHTML(window.period)}</button>` : ""}`
  ]));
  const publications = (workspace?.publications || []).filter((item) => item.period === window.period && item.from === window.from && item.to === window.to);
  $("#kpi-publications").innerHTML = workflowTable(["Member", "Version / status", "Published", "Note", "Actions"], publications.slice().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).map((item) => [
    escapeHTML(item.memberName), `v${item.version} · ${item.recalledAt ? "Recalled" : item.final ? "Final" : "Provisional"}${item.recalledAt ? `<small>${escapeHTML(item.recallReason)}</small>` : ""}`,
    `${escapeHTML(item.publishedAt)}<small>${escapeHTML(item.publishedBy)}</small>`, escapeHTML(item.note),
    `<button type="button" class="mini-button" data-kpi-download="${escapeHTML(item.id)}">Download published report</button>${operationalManager() && !item.recalledAt ? `<button type="button" class="mini-button" data-kpi-recall="${escapeHTML(item.id)}">Recall</button>` : ""}`
  ]));
  $("#kpi-manager-tools").classList.toggle("hidden", !operationalManager());
  $("#reporting-history-tools").classList.toggle("hidden", !state.roleCapabilities.manageWorkspace);
  const form = $("#kpi-issue-form");
  fillOptions(form.elements.memberId, (workspace?.members || []).map((member) => [member.id, member.name]), "Choose member");
  updateKpiAssignmentOptions();
  $("#kpi-issues").innerHTML = workflowTable(["Date", "Member", "Category", "Project", "Evidence", "Outlook notification", "Status"], (workspace?.issues || []).filter((issue) => !window || issue.date >= window.from && issue.date <= window.to).map((issue) => [
    escapeHTML(issue.date), escapeHTML(issue.memberName), escapeHTML(issue.category), escapeHTML(issue.projectRef || "General"),
    `${escapeHTML(issue.note)}${(issue.attachments || []).map((file) => `<p><a href="/api/kpi-issues/${encodeURIComponent(issue.id)}/attachments/${encodeURIComponent(file.id)}" download>${escapeHTML(file.name)}</a> <small>${(file.size / 1024).toFixed(1)} KB</small></p>`).join("")}`,
    `${escapeHTML(issue.emailNotification?.message || "Not requested (existing issue).")}${issue.emailNotification?.sender ? `<small>From: ${escapeHTML(issue.emailNotification.sender)}</small>` : ""}${issue.emailNotification?.recipient ? `<small>To: ${escapeHTML(issue.emailNotification.recipient)}</small>` : ""}`,
    `${escapeHTML(issue.status)}${issue.reason ? `<p>${escapeHTML(issue.reason)}</p>` : ""}${operationalManager() && issue.status !== "Withdrawn" ? ` <button type="button" class="mini-button" data-kpi-withdraw="${escapeHTML(issue.id)}">Withdraw</button>` : ""}`
  ]));
}

function updateKpiAssignmentOptions() {
  const form = $("#kpi-issue-form");
  const workspace = kpiWorkspace();
  const member = workspace?.members?.find((entry) => entry.id === form.elements.memberId.value);
  const quality = workspace?.quality?.rows || [];
  const rows = (workspace?.deliveries || []).filter((row) => row.names.includes(member?.name));
  fillOptions(form.elements.deliveryKey, rows.map((row) => {
    const canonical = quality.find((item) => item.ref === row.ref && (item.crId || "") === (row.crId || "") && !/^bug fixing$/i.test(row.type));
    return [canonical?.key || row.key, `${row.ref} · ${row.type} ${row.crId || ""}`];
  }), "General / non-project issue");
}

async function reloadKPI() {
  const sequence = ++kpiLoadSequence;
  const userId = state.user.id;
  $("#kpi-load-status").textContent = "Loading…";
  try {
    const result = await api(`/api/operations?date=${encodeURIComponent($("#kpi-date").value || localDate())}&period=${encodeURIComponent($("#kpi-period").value)}`);
    if (sequence !== kpiLoadSequence || userId !== state.user.id) return;
    selectedKpiWorkspace = result;
    selectedKpiUser = userId;
    renderKPI();
    $("#kpi-load-status").textContent = `Loaded ${result.window.period}: ${result.window.from} to ${result.window.to}`;
  } catch (error) {
    if (sequence === kpiLoadSequence) $("#kpi-load-status").textContent = `Load failed: ${error.message}. Previous report retained.`;
    throw error;
  }
}

function renderActivityDetails(startDate, endDate) {
  const panel = $("#utilization-activity-details");
  if (!panel) return;
  panel.innerHTML = workflowTable(["Date", "Member", "Activity", "Hours", "Details"],
    (state.operationsWorkspace?.activityLogs || []).filter((log) => log.date >= startDate && log.date <= endDate)
      .map((log) => [escapeHTML(log.date), escapeHTML(log.userName), escapeHTML(log.category), Number(log.hours).toFixed(2), escapeHTML(log.note)]));
}

function openKPIReview(memberId) {
  const row = kpiWorkspace().kpis.find((item) => item.memberId === memberId);
  const form = $("#kpi-review-form");
  form.reset();
  form.elements.memberId.value = memberId;
  form.elements.date.value = kpiWorkspace().window.anchor;
  form.elements.period.value = kpiWorkspace().window.period;
  $("#kpi-review-member").textContent = `${row.name} · ${kpiWorkspace().window.period === "monthly" ? "Quarter-to-date scoring: " : "Quarter scoring: "}${kpiWorkspace().scoreWindow.from} to ${kpiWorkspace().window.period === "monthly" ? kpiWorkspace().asOf : kpiWorkspace().window.to}`;
  $("#kpi-feedback-criteria").innerHTML = KPI_FEEDBACK_CRITERIA.map((label, index) => `<label>${escapeHTML(label)}<select data-kpi-criterion="${index}"><option value="">Not reviewed</option><option value="true">Met (5)</option><option value="false">Not met (0)</option></select></label>`).join("");
  $$("#kpi-feedback-criteria select").forEach((select, index) => { select.value = row.review?.feedback[index] === null || row.review?.feedback[index] === undefined ? "" : String(row.review.feedback[index]); });
  for (const field of ["qualityVerified", "processVerified", "deliveryVerified", "coverageConfirmed", "finalized"]) form.elements[field].checked = row.review?.[field] || false;
  form.elements.note.value = row.review?.note || "";
  form.elements.overallRating.value = row.review?.overallRating || "";
  $("#kpi-review-dialog").showModal();
}

function initializeQuarterSelector(prefix) {
  const date = $(`#${prefix}-date`);
  const period = $(`#${prefix}-period`);
  const select = $(`#${prefix}-quarter`);
  const today = localDate();
  const options = [];
  for (const cursor = new Date(2026, 6, 1, 12); localDate(cursor) <= today; cursor.setMonth(cursor.getMonth() + 3)) {
    const quarter = Math.floor(cursor.getMonth() / 3) + 1;
    const end = localDate(new Date(cursor.getFullYear(), cursor.getMonth() + 3, 0, 12));
    const months = ["Jan–Mar", "Apr–Jun", "Jul–Sep", "Oct–Dec"];
    options.push([end < today ? end : today, `Q${quarter} ${cursor.getFullYear()} (${months[quarter - 1]})`]);
  }
  fillOptions(select, options.reverse(), "Choose quarter");
  const sync = () => {
    select.value = options.find(([anchor]) => anchor.slice(0, 4) === date.value.slice(0, 4)
      && Math.floor((Number(anchor.slice(5, 7)) - 1) / 3) === Math.floor((Number(date.value.slice(5, 7)) - 1) / 3))?.[0] || "";
  };
  sync();
  date.addEventListener("change", sync);
  select.addEventListener("change", () => {
    if (!select.value) return;
    date.value = select.value;
    period.value = "quarterly";
    period.dispatchEvent(new Event("change"));
    date.dispatchEvent(new Event("change"));
    if (prefix === "kpi") reloadKPI().catch((error) => showToast(error.message, true));
  });
}

function initializeOperationalUI() {
  initializeWeeklyQA();
  for (const id of ["quality-date", "kpi-date"]) $( `#${id}`).value = localDate();
  initializeQuarterSelector("quality");
  initializeQuarterSelector("kpi");
  for (const id of ["non-productive-form", "kpi-issue-form"]) {
    const input = $(`#${id}`).elements.date;
    input.value = localDate();
    input.max = localDate();
  }
  $("#quality-period").addEventListener("change", renderQuality);
  $("#quality-date").addEventListener("change", renderQuality);
  $("#quality-member").addEventListener("change", renderQuality);
  for (const id of ["hygiene-from", "hygiene-to", "hygiene-dated"]) $(`#${id}`).addEventListener("change", () => { renderHygiene(); renderSLA(); });
  for (const id of ["feedback-filter", "activity-member", "activity-from", "activity-to"]) $(`#${id}`).addEventListener("change", renderOperationalViews);
  $("#reporting-history-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const file = await fileAsBase64(form.elements.file.files[0]);
      const result = await api("/api/operations/history", { method: "POST", body: JSON.stringify({ type: form.elements.type.value, file }) });
      await refreshData();
      await reloadKPI();
      showToast(`${result.imported} historical ${result.type} imported. Active queues unchanged.`);
    } catch (error) { showToast(error.message, true); } finally { button.disabled = false; }
  });
  $("#kpi-refresh").addEventListener("click", () => reloadKPI().catch((error) => showToast(error.message, true)));
  $("#kpi-issue-form").elements.memberId.addEventListener("change", updateKpiAssignmentOptions);
  $("#sla-export").addEventListener("click", () => downloadCSV("project-sla.csv", [["Project", "Title", "Actual start", "Planned completion", "Actual completion", "SLA", "Days late"],
    ...(state.operationsWorkspace?.sla || []).filter((row) => hygieneInRange(row.planned) && hygieneProjectMatches(row)).map((row) => [row.ref, row.title, row.start, row.planned, row.completed, row.status, row.daysLate])]));
  $("#kpi-export").addEventListener("click", () => downloadCSV(`${kpiWorkspace().window.period}-kpi.csv`, [["From", "To", "Member", "Role", "Completed", "Productivity /30", "Quality /30", "On time /10", "Process /10", "Manager /20", "Total /100", "Status"],
    ...(kpiWorkspace()?.kpis || []).map((row) => [kpiWorkspace().window.from, kpiWorkspace().window.to, row.name, row.role, row.completed,
      row.scores.productivity, row.scores.quality, row.scores.onTime, row.scores.process, row.scores.manager, row.provisionalTotal, row.status])]));
  const submit = (id, endpoint, method = "POST", extra = () => ({}), afterSave = () => {}) => {
    $(`#${id}`).addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        const values = { ...Object.fromEntries(new FormData(form)), ...await extra(form) };
        const result = await api(typeof endpoint === "function" ? endpoint(values) : endpoint, { method, body: JSON.stringify(values) });
        await refreshData();
        await afterSave(form);
        showToast(result.emailNotification ? `Issue saved. ${result.emailNotification.message}` : "Saved.",
          !!result.emailNotification && result.emailNotification.status !== "accepted");
      } catch (error) { showToast(error.message, true); } finally { button.disabled = false; }
    });
  };
  submit("project-feedback-form", "/api/project-feedback", "POST", () => ({}), (form) => { form.elements.message.value = ""; });
  submit("non-productive-form", "/api/non-productive-logs", "POST", (form) => ({ hours: Number(form.elements.hours.value) }), (form) => { form.elements.hours.value = ""; form.elements.note.value = ""; });
  submit("execution-progress-form", "/api/execution/progress", "POST", (form) => ({ progress: Number(form.elements.progress.value) }), () => $("#execution-progress-dialog").close());
  submit("kpi-issue-form", "/api/kpi-issues", "POST", async (form) => {
    const files = [...form.elements.attachments.files];
    if (files.length > 10) throw new Error("Upload at most 10 evidence files.");
    if (files.some((file) => !file.size || file.size > 5 * 1024 * 1024)) throw new Error("Each evidence file must be non-empty and at most 5 MB.");
    if (files.reduce((sum, file) => sum + file.size, 0) > 10 * 1024 * 1024) throw new Error("Combined evidence files must be at most 10 MB.");
    return { attachments: await Promise.all(files.map(fileAsBase64)) };
  }, async (form) => { form.elements.note.value = ""; form.elements.attachments.value = ""; await reloadKPI(); });
  submit("feedback-response-form", (values) => `/api/project-feedback/${values.id}`, "PUT", (form) => ({ bestPractice: form.elements.bestPractice.checked }), () => $("#feedback-response-dialog").close());
  submit("kpi-publish-form", "/api/kpi-publications", "POST", (form) => ({ allowIncomplete: form.elements.allowIncomplete.checked }), async () => { $("#kpi-publish-dialog").close(); await reloadKPI(); });
  submit("kpi-recall-form", (values) => `/api/kpi-publications/${values.id}`, "PUT", () => ({}), async () => { $("#kpi-recall-dialog").close(); await reloadKPI(); });
  submit("hygiene-verify-form", "/api/hygiene-verifications", "POST", () => ({
    checks: $$("#hygiene-verify-checks select").filter((select) => select.value).map((select) => ({ rule: select.dataset.rule, status: select.value }))
  }), () => $("#hygiene-verify-dialog").close());
  submit("kpi-withdraw-form", (values) => `/api/kpi-issues/${values.id}`, "PUT", () => ({}), async () => { $("#kpi-withdraw-dialog").close(); await reloadKPI(); });
  submit("kpi-review-form", "/api/kpi-reviews", "PUT", (form) => ({
    feedback: $$("#kpi-feedback-criteria select").map((select) => select.value === "" ? null : select.value === "true"),
    ...Object.fromEntries(["qualityVerified", "processVerified", "deliveryVerified", "coverageConfirmed", "finalized"].map((field) => [field, form.elements[field].checked]))
  }), async () => { $("#kpi-review-dialog").close(); await reloadKPI(); });
  document.addEventListener("click", (event) => {
    const review = event.target.closest("[data-kpi-review]");
    const feedback = event.target.closest("[data-feedback-response]");
    const withdraw = event.target.closest("[data-kpi-withdraw]");
    const progress = event.target.closest("[data-execution-progress]");
    const publish = event.target.closest("[data-kpi-publish]");
    const recall = event.target.closest("[data-kpi-recall]");
    const download = event.target.closest("[data-kpi-download]");
    const verify = event.target.closest("[data-hygiene-verify]");
    if (verify) {
      const form = $("#hygiene-verify-form");
      form.reset();
      form.elements.projectRef.value = verify.dataset.hygieneVerify;
      $("#hygiene-verify-project").textContent = verify.dataset.hygieneVerify;
      const project = state.hygiene.find((row) => row.ref === verify.dataset.hygieneVerify);
      $("#hygiene-verify-checks").innerHTML = ["Primary material", "Material expected delivery", "Planned completion / SLA", "Request type", "Complexity", "Page count"]
        .map((rule) => `<label>${escapeHTML(rule)}<small>${escapeHTML(project?.checks.find((check) => check.rule === rule)?.detail || "No evidence")}</small><select data-rule="${escapeHTML(rule)}"><option value="">Keep current check</option><option>Manually verified</option><option>Action required</option><option>Not verified</option></select></label>`).join("");
      $("#hygiene-verify-dialog").showModal();
    }
    if (publish) {
      const form = $("#kpi-publish-form");
      form.reset();
      form.elements.memberId.value = publish.dataset.kpiPublish;
      form.elements.date.value = kpiWorkspace().window.anchor;
      form.elements.period.value = kpiWorkspace().window.period;
      $("#kpi-publish-label").textContent = `${kpiWorkspace().kpis.find((row) => row.memberId === publish.dataset.kpiPublish).name} · ${kpiWorkspace().window.from} to ${kpiWorkspace().window.to}`;
      $("#kpi-publish-dialog").showModal();
    }
    if (recall) {
      $("#kpi-recall-form").reset();
      $("#kpi-recall-form").elements.id.value = recall.dataset.kpiRecall;
      $("#kpi-recall-dialog").showModal();
    }
    if (download) {
      const report = kpiWorkspace().publications.find((item) => item.id === download.dataset.kpiDownload);
      const row = report.snapshot;
      downloadCSV(`KPI-${report.memberName}-${report.period}-v${report.version}.csv`, [
        ["Member", "Period", "From", "To", "As of", "Version", "Publication status", "Productivity /30", "Quality /30", "On time /10", "Process /10", "Manager /20", "Total /100", "Completed", "FTR", "Quality misses", "Delivery misses", "Process misses", "Productive hours", "Non-productive hours", "Evidence status", "Overall rating", "Note", "Published by", "Published at", "Recall reason"],
        [report.memberName, report.period, report.from, report.to, report.asOf, report.version, report.recalledAt ? "Recalled" : report.final ? "Final" : "Provisional",
          row.scores.productivity, row.scores.quality, row.scores.onTime, row.scores.process, row.scores.manager, row.provisionalTotal, row.completed, row.ftr,
          row.qualityMisses, row.deliveryMisses, row.processMisses, row.hours, row.nonProductiveHours, row.status, row.review?.overallRating || "",
          report.note, report.publishedBy, report.publishedAt, report.recallReason || ""]
      ]);
    }
    if (progress) {
      const row = state.execution.deliveries.find((item) => item.key === progress.dataset.executionProgress);
      const form = $("#execution-progress-form");
      form.reset();
      form.elements.deliveryKey.value = row.key;
      form.elements.date.value = localDate();
      form.elements.date.max = localDate();
      form.elements.progress.value = row.progress || 0;
      form.elements.status.value = ["Not Started", "In Review", "On Hold"].includes(row.status) ? row.status : "In Progress";
      $("#execution-progress-title").textContent = `${row.ref} · ${row.type} ${row.crId || ""}`;
      $("#execution-progress-dialog").showModal();
    }
    if (review) openKPIReview(review.dataset.kpiReview);
    if (feedback) {
      const entry = state.operationsWorkspace.feedback.find((item) => item.id === feedback.dataset.feedbackResponse);
      const form = $("#feedback-response-form");
      form.elements.id.value = entry.id;
      form.elements.response.value = entry.response || "";
      form.elements.status.value = entry.status === "Open" ? "Reviewed" : entry.status;
      form.elements.bestPractice.checked = Boolean(entry.bestPractice);
      form.elements.practiceTitle.value = entry.practiceTitle || "";
      $("#feedback-response-dialog").showModal();
    }
    if (withdraw) {
      $("#kpi-withdraw-form").reset();
      $("#kpi-withdraw-form").elements.id.value = withdraw.dataset.kpiWithdraw;
      $("#kpi-withdraw-dialog").showModal();
    }
  });
}
