"use strict";

const processAuditCategories = [
  "Actual Miss Confirmed", "High Workload / Competing Priorities", "Complex Asset / Additional Review Required",
  "Rework / Repeat Review", "Unplanned Operational Support / Ad hoc Activities", "Translation/Other Project Dependency", "Needs confirmation"
];
let processAuditTab = "adherence";
let processAuditReport = null;
let processAuditLoadedKey = "";
let processAuditRequest = 0;

function processAuditFilters() {
  return { search: $("#process-audit-search").value, category: $("#process-audit-category").value, status: $("#process-audit-status").value };
}

function processAuditVisibleRows() {
  const { search, category, status } = processAuditFilters();
  const query = search.toLowerCase().trim();
  return (processAuditReport?.rows || []).filter((row) => (!category || row.reasonCategory === category)
    && (!status || row.verificationStatus === status) && (!query || [row.projectId, row.productionManagerName,
      row.assetAuditorName, row.reason, row.pendingClarification, row.translationRequest, ...row.evidence.map((entry) => entry.text)].join(" ").toLowerCase().includes(query)));
}

function processAuditLink(url, label) {
  return /^https:\/\/[^/]*workfront(?:\.adobe)?\.com\//i.test(url || "")
    ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)}</a>` : escapeHTML(label);
}

function renderProcessAuditRows() {
  const rows = processAuditVisibleRows();
  const all = processAuditReport?.rows || [];
  $("#process-audit-download").disabled = !processAuditReport;
  $("#process-audit-coverage").textContent = processAuditReport
    ? `${processAuditReport.workloadTeam || "Related team"} workload only. Same-day intake is not verified backlog or a bulk-request flag. Source: ${processAuditReport.sourceFile}.`
    : "Select a saved month, or import a reviewed JSON evidence report. Missing/unread evidence never automatically becomes Actual Miss Confirmed.";
  workflowMetrics("#process-audit-summary", [["Rows in your scope", all.length], ["Matching filters", rows.length],
    ...["Verified", "Inferred", "Needs confirmation"].map((status) => [`Status: ${status}`, rows.filter((row) => row.verificationStatus === status).length])]);
  $("#process-audit-list").innerHTML = workflowTable(
    ["Project ID", "Created / audit completed", "Asset auditor", "Hold / working-hours difference", "Category / status", "Finding", `${processAuditReport?.workloadTeam ? `${processAuditReport.workloadTeam} only: ` : ""}Same-day projects / auditor`, "Evidence"],
    rows.map((row) => [
      processAuditLink(row.workfrontUrl, row.projectId), `${escapeHTML(row.projectCreationDate)}<br>${escapeHTML(row.assetAuditCompletionDate || "Not provided")}`,
      escapeHTML(row.assetAuditorName || "Unassigned"), `${escapeHTML(row.holdTime)} / ${escapeHTML(row.workingHoursDifference)}`,
      `${escapeHTML(row.reasonCategory)}<br>${escapeHTML(row.verificationStatus)}`,
      escapeHTML(row.finding || "Finding unavailable. Reload the report."),
      `${row.sameDayProjectCount} / ${row.sameDayAuditorProjectCount}`,
      `<details><summary>${row.evidence.length} source item(s)</summary><details><summary>Original reviewed assessment</summary><p>${escapeHTML(row.reason)}</p></details><p>${escapeHTML(row.pendingClarification || "No clarification issue recorded")}</p>
        <p>${escapeHTML(row.translationRequest || "No translation request recorded")}</p><p>${escapeHTML(row.updatesReadStatus)}</p>${row.evidence.map((entry) =>
        `<p><strong>${escapeHTML(entry.source)}</strong> · ${escapeHTML(entry.author || "Author not recorded")} · ${escapeHTML(entry.date || "Date not recorded")}<br>${escapeHTML(entry.text)}<br>${processAuditLink(entry.url, entry.url ? "Open source" : "")}</p>`).join("")}</details>`,
    ]));
}

async function loadProcessAudit() {
  const month = $("#process-audit-month").value;
  const request = ++processAuditRequest;
  processAuditReport = null;
  renderProcessAuditRows();
  if (!month) return;
  const metadata = (state.processAuditMonths || []).find((item) => item.month === month);
  processAuditLoadedKey = `${state.user?.id || state.user?.name}:${month}:${metadata?.importedAt || ""}`;
  if (!metadata) {
    $("#process-audit-message").textContent = "No saved report for this month in your scope.";
    return;
  }
  $("#process-audit-message").textContent = "Loading monthly report…";
  try {
    const report = await api(`/api/process-audit-reports/${month}`);
    if (request !== processAuditRequest) return;
    processAuditReport = report;
    $("#process-audit-message").textContent = `${report.rows.length} reviewed report row(s) loaded in your scope. Filters also apply to the XLSX download.`;
    renderProcessAuditRows();
  } catch (error) {
    if (request === processAuditRequest) {
      processAuditLoadedKey = "";
      $("#process-audit-message").textContent = error.message;
    }
  }
}

function renderProcessAudit() {
  const allowed = Boolean(state.roleCapabilities.viewHygiene);
  $("#process-audit-import").classList.toggle("hidden", !allowed || !["manager", "teamManager"].includes(state.user?.role));
  if (!allowed) {
    processAuditReport = null;
    processAuditLoadedKey = "";
    processAuditRequest++;
    return;
  }
  const months = state.processAuditMonths || [];
  const selected = $("#process-audit-saved").value;
  $("#process-audit-saved").innerHTML = '<option value="">Select a saved month</option>' + months.map((item) =>
    `<option value="${escapeHTML(item.month)}">${escapeHTML(item.month)} · ${item.rowCount} rows in scope</option>`).join("");
  $("#process-audit-saved").value = months.some((item) => item.month === selected) ? selected : "";
  if (!$("#process-audit-month").value) $("#process-audit-month").value = months[0]?.month || new Date().toISOString().slice(0, 7);
  const month = $("#process-audit-month").value;
  const metadata = months.find((item) => item.month === month);
  const key = `${state.user?.id || state.user?.name}:${month}:${metadata?.importedAt || ""}`;
  if (state.view === "hygiene" && processAuditTab === "audit" && key !== processAuditLoadedKey) void loadProcessAudit();
}

function initializeProcessAuditUI() {
  $("#process-audit-category").innerHTML += processAuditCategories.map((category) => `<option>${escapeHTML(category)}</option>`).join("");
  for (const tab of ["adherence", "audit"]) {
    $(`#hygiene-${tab}-tab`).addEventListener("click", () => {
      processAuditTab = tab;
      for (const name of ["adherence", "audit"]) {
        $(`#hygiene-${name}-panel`).classList.toggle("hidden", name !== tab);
        $(`#hygiene-${name}-tab`).setAttribute("aria-selected", String(name === tab));
        $(`#hygiene-${name}-tab`).classList.toggle("primary", name === tab);
        $(`#hygiene-${name}-tab`).classList.toggle("secondary", name !== tab);
      }
      renderProcessAudit();
    });
  }
  $("#process-audit-month").addEventListener("change", () => { $("#process-audit-confirm").checked = false; void loadProcessAudit(); });
  $("#process-audit-saved").addEventListener("change", () => {
    if (!$("#process-audit-saved").value) return;
    $("#process-audit-month").value = $("#process-audit-saved").value;
    $("#process-audit-confirm").checked = false;
    void loadProcessAudit();
  });
  $("#process-audit-search").addEventListener("input", renderProcessAuditRows);
  for (const id of ["process-audit-category", "process-audit-status"]) $(`#${id}`).addEventListener("change", renderProcessAuditRows);
  $("#process-audit-import").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#process-audit-import-button");
    button.disabled = true;
    try {
      const file = $("#process-audit-file").files[0];
      if (!file || !/\.json$/i.test(file.name) || file.size > 8 * 1024 * 1024) throw new Error("Choose a JSON evidence report (.json), maximum 8 MiB. Excel input is not supported.");
      if (!$("#process-audit-confirm").checked) throw new Error("Confirm whole-month replacement before importing.");
      let report;
      try { report = JSON.parse(await file.text()); } catch { throw new Error("The evidence report must contain valid JSON."); }
      if (report?.month !== $("#process-audit-month").value) throw new Error("JSON report month must match the selected month.");
      const result = await api("/api/process-audit-reports", { method: "POST", body: JSON.stringify({ report, replaceExisting: true }) });
      $("#process-audit-confirm").checked = false;
      $("#process-audit-file").value = "";
      processAuditLoadedKey = "";
      await refreshData(true);
      await loadProcessAudit();
      showToast(`Saved ${result.rowCount} Process Audit rows for ${result.month}.`);
    } catch (error) {
      $("#process-audit-message").textContent = error.message;
      showToast(error.message, true);
    } finally { button.disabled = false; }
  });
  $("#process-audit-download").addEventListener("click", async () => {
    const month = $("#process-audit-month").value;
    try {
      const response = await fetch(`/api/process-audit-reports/${month}/xlsx?${new URLSearchParams(processAuditFilters())}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error((await response.json()).error || "XLSX download failed.");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `process-audit-${month}.xlsx`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { showToast(error.message, true); }
  });
}
