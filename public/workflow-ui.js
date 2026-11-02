"use strict";

function workflowTable(headers, rows) {
  return rows.length ? `<table><thead><tr>${headers.map((header) => `<th>${escapeHTML(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>` : '<p class="muted">No records in your scope.</p>';
}

function workflowMetrics(selector, entries) {
  $(selector).innerHTML = entries.map(([label, value]) => `<div class="metric-card"><span class="metric-label">${escapeHTML(label)}</span><strong class="metric-value">${escapeHTML(value)}</strong></div>`).join("");
}

function deliveryDeadline(row, now = new Date()) {
  if (!row.due) return { label: "Delivery date not provided", late: false };
  const end = new Date(`${String(row.due).slice(0, 10)}T23:59:59`);
  const hours = (end - now) / 3600000;
  return { late: hours < 0, label: hours < 0 ? `Overdue by ${Math.ceil(-hours)} hrs` : `${Math.floor(hours)} hrs left to send to QC` };
}

function deliveryWorkfrontLink(row, label = `${row.ref} · ${row.type} ${row.crId || ""}`) {
  if (["workfront", "cr"].includes(row.source) && /^[a-f0-9]{32}$/i.test(row.id || "")) {
    const kind = row.source === "cr" ? "issue" : "task";
    return `<a href="https://laroche.my.workfront.adobe.com/${kind}/${escapeHTML(row.id)}/overview" target="_blank" rel="noopener noreferrer">${escapeHTML(label)}</a>`;
  }
  return workfrontProjectLink(row.project || {}, label);
}

function renderWorkflowViews() {
  if (!state.user) return;
  if (state.roleCapabilities.viewExecution) renderExecutionWork();
  if (state.roleCapabilities.viewQuality) renderQuality();
  if (state.roleCapabilities.viewHygiene) renderHygiene();
  if (typeof renderProcessAudit === "function") renderProcessAudit();
  if (state.roleCapabilities.viewAudits) { renderAuditCRQueue(); renderAuditClocks(); }
  if (typeof renderOperationalViews === "function") renderOperationalViews();
}

function executionLoggedHours(row) {
  return [...state.workLogs, ...(state.sourceWorkLogs || [])].filter((log) => log.taskId === row.id).reduce((sum, log) => sum + Number(log.hours || 0), 0);
}

function renderExecutionWork() {
  const all = state.execution?.deliveries || [];
  const open = all.filter((row) => !/^(complete|completed|archived|cancelled|canceled)$/i.test(row.status));
  const search = $("#execution-search").value.trim().toLowerCase();
  const rows = ($("#execution-status").value === "all" ? all : open).filter((row) =>
    [row.ref, row.title, row.type, row.crId, row.status].join(" ").toLowerCase().includes(search)
    && (!$("#execution-type").value || ($("#execution-type").value === "CR" ? /^cr/i.test(row.type) : row.type === $("#execution-type").value)))
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  workflowMetrics("#execution-summary", [["Assigned projects", new Set(open.map((row) => row.ref)).size], ["Open assignments", open.length],
    ["Overdue assignments", open.filter((row) => deliveryDeadline(row).late).length],
    ["Open AHT benchmark", open.some((row) => row.hours !== null && row.hours !== undefined) ? `${open.reduce((sum, row) => sum + Number(row.hours || 0), 0).toFixed(2)}h` : "Not available"],
    ["Time logged today", `${[...state.workLogs, ...state.sourceWorkLogs].filter((log) => log.date === localDate()).reduce((sum, log) => sum + Number(log.hours), 0).toFixed(2)}h`]]);
  const timer = state.execution?.timer;
  const active = all.find((row) => row.key === timer?.deliveryKey);
  $("#execution-timer").innerHTML = timer && timer.state !== "stopped"
    ? `<strong>${escapeHTML(active?.ref || timer.delivery?.ref || "")} ${escapeHTML(active?.type || timer.delivery?.type || "")} · ${escapeHTML(timer.state)}</strong> <span id="execution-elapsed"></span>
      <div class="view-actions"><button type="button" class="button secondary" data-timer-action="hold" data-delivery-key="${escapeHTML(timer.deliveryKey)}" ${timer.state !== "running" ? "disabled" : ""}>Hold</button>
      <button type="button" class="button secondary" data-timer-action="stop" data-delivery-key="${escapeHTML(timer.deliveryKey)}">Stop</button></div>
      <p class="muted">Timer is saved on the server and survives refreshes. Stop does not mark the assignment complete.${!active ? " This assignment has changed; hold or stop to save your elapsed time." : ""}</p>`
    : '<p class="muted">No running timer. Pick an assignment below to start.</p>';
  $("#execution-list").innerHTML = rows.length ? rows.map((row) => {
    const deadline = deliveryDeadline(row);
    const running = timer?.deliveryKey === row.key && timer.state === "running";
    const held = timer?.deliveryKey === row.key && timer.state === "held";
    const closed = /^(complete|completed|archived|cancelled|canceled)$/i.test(row.status);
    return `<article class="panel execution-card ${deadline.late && !closed ? "execution-overdue" : ""}">
      <div class="audit-card-top"><strong>${deliveryWorkfrontLink(row)}</strong>${badge(row.status)}</div>
      <h3>${workfrontProjectLink(row.project, row.title)}</h3><p>${escapeHTML(row.projectStatus || row.project?.sourceStatus || "")}</p>
      <p class="${deadline.late ? "overdue-label" : "muted"}">Due: ${escapeHTML(row.due || "Not provided")} · ${escapeHTML(deadline.label)}</p>
      <p class="muted">Progress ${Number(row.progress || 0)}% · AHT benchmark ${row.hours === null || row.hours === undefined ? "not available" : `${Number(row.hours).toFixed(2)}h`} · Logged ${executionLoggedHours(row).toFixed(2)}h</p>
      <div class="view-actions">${!closed ? `<button type="button" class="button primary" data-timer-action="start" data-delivery-key="${escapeHTML(row.key)}" ${running ? "disabled" : ""}>${held ? "Resume" : "Start"}</button>
      <button type="button" class="button secondary" data-timer-action="hold" data-delivery-key="${escapeHTML(row.key)}" ${!running ? "disabled" : ""}>Hold</button>
      <button type="button" class="button secondary" data-timer-action="stop" data-delivery-key="${escapeHTML(row.key)}" ${!running && !held ? "disabled" : ""}>Stop</button>` : ""}
      <button type="button" class="button secondary" data-execution-progress="${escapeHTML(row.key)}">Update progress</button>
      <button type="button" class="button secondary" data-execution-checklist="${escapeHTML(row.key)}">Checklist / QA handoff</button></div></article>`;
  }).join("") : '<p class="muted">No assignments match. Only work assigned to your name is shown.</p>';
  updateExecutionElapsed();
}

function updateExecutionElapsed() {
  const timer = state.execution?.timer;
  const element = $("#execution-elapsed");
  if (!timer || !element) return;
  const ms = Number(timer.elapsedMs || 0) + (timer.state === "running" ? Math.max(0, Date.now() - new Date(timer.startedAt).getTime()) : 0);
  const seconds = Math.floor(ms / 1000);
  element.textContent = `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function qualityRows() {
  if (typeof periodQualityRows === "function") return periodQualityRows();
  return state.execution?.quality?.rows || [];
}

let qualityPage = 1;
function renderQuality() {
  const rows = qualityRows();
  const eligible = rows.filter((row) => row.eligible).length;
  const ftr = rows.filter((row) => row.eligible && row.ftr).length;
  const rework = rows.filter((row) => row.eligible && row.rework).length;
  const pending = rows.length - eligible;
  const rate = eligible ? `${(ftr / eligible * 100).toFixed(1)}%` : "N/A";
  workflowMetrics("#quality-summary", [["Verified FTR", rate], ["First-pass decisions", `${ftr} / ${eligible}`],
    ["Rework confirmed", rework], ["Needs verification", pending]]);
  const { from, to } = typeof qualityWindow === "function" ? qualityWindow() : { from: "", to: "" };
  $("#quality-week-bulletin").textContent = `${from} to ${to}: ${ftr} first-time-right out of ${eligible} verified decisions (${rate}); ${rework} confirmed rework; ${pending} unverified. ${eligible ? "" : "No verified denominator — not a 0% or 100% result."}`;
  const names = [...new Set(rows.flatMap((row) => row.names))].sort();
  const unmappedNames = [...new Set(rows.filter((row) => !row.names.length).map((row) => row.qaExecutor || "Unnamed executor"))].sort();
  const matrixRow = (label, own) => [label, own.length, own.filter((row) => row.eligible).length, own.filter((row) => row.eligible && row.ftr).length,
    own.filter((row) => row.eligible && row.rework).length, own.filter((row) => !row.eligible).length];
  $("#quality-matrix").innerHTML = `<p class="muted">Up to 20 members shown. Filter by member above for an individual view; do not sum shared member counts. Bulletin deliveries by executors outside the production roster count in the team FTR above and are listed as bulletin only.</p>` + workflowTable(["Team member", "Deliveries", "Verified decisions", "FTR", "Rework", "Unverified"], [
    ...names.slice(0, 20).map((name) => matrixRow(escapeHTML(name), rows.filter((row) => row.names.includes(name)))),
    ...unmappedNames.map((name) => matrixRow(`${escapeHTML(name)} <small>bulletin only</small>`, rows.filter((row) => !row.names.length && (row.qaExecutor || "Unnamed executor") === name)))
  ]);
  const outcome = $("#quality-outcome").value;
  const search = $("#quality-search").value.trim().toLowerCase();
  const filtered = rows.filter((row) => (outcome === "all" || (outcome === "ftr" ? row.eligible && row.ftr : !row.eligible || row.rework))
    && (!search || `${row.ref} ${row.title} ${row.crId}`.toLowerCase().includes(search)));
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  qualityPage = Math.min(qualityPage, pages);
  $("#quality-page").textContent = `${filtered.length} deliveries · Page ${qualityPage} / ${pages}`;
  $("#quality-previous").disabled = qualityPage <= 1;
  $("#quality-next").disabled = qualityPage >= pages;
  $("#quality-list").innerHTML = workflowTable(["Delivery", "Assignee", "Completed", "Verified result", "Bug evidence", "QA confirmation"], filtered.slice((qualityPage - 1) * 10, qualityPage * 10).map((row) => [
    `${deliveryWorkfrontLink(row)}<small>${workfrontProjectLink(row.project, row.title)}</small>`, escapeHTML(row.names.join(", ") || (row.qaExecutor ? `${row.qaExecutor} (not on roster)` : "Not mapped")),
    escapeHTML(row.completedAt || (/^(complete|completed)$/i.test(row.status) ? "Date not verified" : row.status)),
    `<span class="quality-signal ${row.eligible && row.ftr ? "quality-good" : row.eligible && row.rework ? "quality-bad" : "quality-unknown"}">${escapeHTML(row.qualityStatus || "Needs verification")}</span>`, Number(row.bugCount || 0),
    `${escapeHTML(row.confirmedBy || "Not confirmed")}${state.roleCapabilities.confirmQuality && row.teamId !== "design" && !row.qaPublished ? ` <button type="button" class="mini-button" data-quality-result="${escapeHTML(row.key)}">Confirm QA</button>` : ""}`
  ]));
}

function hygieneInRange(date) {
  const mode = $("#hygiene-dated").value;
  if (!date) return mode !== "dated";
  return mode !== "undated" && (!$("#hygiene-from").value || date >= $("#hygiene-from").value)
    && (!$("#hygiene-to").value || date <= $("#hygiene-to").value);
}

function hygieneProjectMatches(row) {
  const projectFilter = $("#hygiene-project").value.trim().toLowerCase();
  if (!projectFilter) return true;
  const project = state.workfrontProjects.find((item) => item.ref === row.ref);
  return [row.ref, project?.workfrontId, project?.workfrontUrl?.match(/\/project\/([a-f0-9]{32})(?:\/|$)/i)?.[1]]
    .some((value) => String(value || "").toLowerCase() === projectFilter) || String(row.title || "").toLowerCase().includes(projectFilter);
}

function hygieneRows() {
  return (state.hygiene || []).filter((project) => hygieneInRange(project.date) && hygieneProjectMatches(project))
    .filter((project) => !$("#hygiene-filter").value || project.status === $("#hygiene-filter").value);
}

function hygieneCell(row, rule) {
  const check = row.checks.find((item) => item.rule === rule);
  if (!check) return '<span class="muted">Not verified</span>';
  const status = check.status === "Corrected" ? "Match" : check.status === "Action required" ? "Mismatch"
    : check.status === "Manually verified" ? "Manually verified" : "Doubtful";
  return `<strong>${escapeHTML(check.actual || "Not provided")}</strong><br><span>${escapeHTML(status)}</span>
    ${check.slaStatus ? `<br>${escapeHTML(check.slaStatus)}` : ""}
    <details><summary>Comparison / source</summary><p>${escapeHTML(check.detail)}</p><p>${escapeHTML(check.evidenceSource)}</p></details>`;
}

function renderHygiene() {
  const rows = hygieneRows();
  workflowMetrics("#hygiene-summary", ["Action required", "Corrected", "Manually verified", "Not verified"].map((status) => [status, rows.filter((row) => row.status === status).length]));
  const headers = ["Project Name", "Primary Material", "Material Expected date", "Plan completion date (SLA)", "Request Type", "Complexity", "Page count", "Status / actions"];
  $("#hygiene-list").innerHTML = rows.length ? `<table><thead><tr>${headers.map((header) => `<th>${escapeHTML(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => {
    const color = row.status === "Action required" ? "mismatch" : row.status === "Not verified" ? "doubtful" : "match";
    return `<tr class="adherence-${color}" data-adherence-ref="${escapeHTML(row.ref)}"><td>${workfrontProjectLink(state.workfrontProjects.find((project) => project.ref === row.ref), `${row.ref} · ${row.title}`)}
      <small>Evidence date: ${escapeHTML(row.date || "Undated")}</small></td>
      ${["Primary material", "Material expected delivery", "Planned completion / SLA", "Request type", "Complexity", "Page count"].map((rule) => `<td>${hygieneCell(row, rule)}</td>`).join("")}
      <td>${escapeHTML(color === "match" ? row.status === "Manually verified" ? "Manually verified" : "Match" : color === "mismatch" ? "Mismatch" : "Doubtful")}
      <button type="button" class="mini-button" data-hygiene-verify="${escapeHTML(row.ref)}">Edit verification</button>
      <button type="button" class="mini-button" data-hygiene-recheck="${escapeHTML(row.ref)}">Recheck details</button>
      <details><summary>All checks</summary>${row.checks.map((check) => `<p><strong>${escapeHTML(check.rule)} · ${escapeHTML(check.status)}</strong><br>${escapeHTML(check.detail)}<br>${escapeHTML(check.evidenceSource)}</p>`).join("")}</details></td></tr>`;
  }).join("")}</tbody></table>` : '<p class="muted">No records: no projects match these filters.</p>';
}

function renderAuditCRQueue() {
  const eligibleNames = new Set(state.team.filter((member) => ["manager", "teamManager", "auditor"].includes(member.role)).map((member) => member.name.toLowerCase()));
  const rows = state.workfrontChangeRounds.filter((round) => eligibleNames.has(String(round.assignee || "").toLowerCase())
    && !round.acceptanceDate && !round.completionDate && !/^(complete|completed|cancelled|canceled|archived)$/i.test(round.sourceStatus));
  $("#audit-cr-queue").innerHTML = workflowTable(["CR / Project", "Assigned to", "Status", "Delivery", "Action"], rows.map((round) => [
    escapeHTML(`${round.projectRef} · ${round.crId} · ${round.title}`), escapeHTML(round.assignee), badge(round.sourceStatus),
    escapeHTML(String(round.expectedDeliveryDate || "").slice(0, 10) || "Not provided"),
    state.audits.some((audit) => audit.projectRef === round.projectRef && audit.crId === round.crId && audit.auditStatus === "Pass")
      ? `Recorded locally · ETA ${escapeHTML(state.audits.find((audit) => audit.projectRef === round.projectRef && audit.crId === round.crId && audit.auditStatus === "Pass").etaDate || "Not recorded")}`
      : `<button type="button" class="mini-button" data-audit-cr="${escapeHTML(round.workfrontId)}">Record CR audit</button>`
  ]));
}

function renderAuditClocks() {
  const sessions = state.auditSessions || [];
  const clock = (session) => {
    const own = session.userId === state.user.id;
    const elapsed = Number(session.elapsedMs || 0) + (session.state === "running" ? Math.max(0, Date.now() - new Date(session.startedAt)) : 0);
    return `<strong>${escapeHTML(session.projectRef)} ${escapeHTML(session.crId)} · ${escapeHTML(session.userName)} · ${escapeHTML(session.state)}</strong>
      <span data-audit-elapsed="${escapeHTML(session.id)}">${(elapsed / 3600000).toFixed(2)}h</span>
      ${own && session.state !== "stopped" ? `<div class="view-actions">${session.state === "held" ? "start" : "hold"}:
      <button type="button" class="button secondary" data-audit-clock="${session.state === "held" ? "start" : "hold"}" data-audit-ref="${escapeHTML(session.projectRef)}" data-audit-cr-id="${escapeHTML(session.crId)}">${session.state === "held" ? "Resume" : "Hold"}</button>
      <button type="button" class="button secondary" data-audit-clock="stop" data-audit-ref="${escapeHTML(session.projectRef)}" data-audit-cr-id="${escapeHTML(session.crId)}">Stop &amp; save hours</button></div>` : ""}`;
  };
  $("#audit-clock-list").innerHTML = `<h3>Audit time log</h3><p class="muted">Actual Start / Hold / Stop time, not the planned execution start. Saving an audit stops its clock. Close does not pause it. Stop before leaving for a break.</p>`
    + (sessions.length ? sessions.slice().sort((a, b) => String(b.firstStartedAt).localeCompare(String(a.firstStartedAt))).map((session) => `<div class="panel">${clock(session)}<small>Started: ${escapeHTML(session.firstStartedAt)} · Ended: ${escapeHTML(session.endedAt || "Active")}</small></div>`).join("") : "<p>No audit time sessions recorded.</p>");
  const own = sessions.find((session) => session.userId === state.user.id && session.state !== "stopped");
  const graphicDelivery = (state.execution?.deliveries || []).find((row) => row.ref === $("#audit-form").elements.projectRef.value && /^asset audit$/i.test(row.type) && row.names.includes(state.user.name));
  $("#full-audit-clock").innerHTML = (own ? clock(own) : '<p class="muted">Actual audit work clock; planned Start date/time below controls delivery ETA only.</p><button type="button" class="button secondary" id="start-full-audit-clock">Start audit clock</button>')
    + (state.user.role === "auditor" && graphicDelivery ? `<button type="button" class="button secondary" data-execution-checklist="${escapeHTML(graphicDelivery.key)}">Graphics Audit checklist (.xlsx)</button>` : "");
  const round = state.workfrontChangeRounds.find((item) => item.workfrontId === $("#cr-audit-form").elements.roundId.value);
  $("#cr-audit-clock").innerHTML = round && own?.projectRef === round.projectRef && own.crId === round.crId ? clock(own)
    : round ? `<button type="button" class="button secondary" data-audit-clock="start" data-audit-ref="${escapeHTML(round.projectRef)}" data-audit-cr-id="${escapeHTML(round.crId)}">Start CR audit clock</button>` : "";
}

async function auditClockAction(action, projectRef, crId = "") {
  try {
    await api("/api/audit-sessions", { method: "POST", body: JSON.stringify({ action, projectRef, crId }) });
    await refreshData();
    showToast(`Audit clock ${action === "start" ? "started" : action === "hold" ? "paused; hours saved" : "stopped; hours saved"}.`);
  } catch (error) { showToast(error.message, true); }
}

function executionChecklistItems(items) {
  const simple = state.user.role !== "auditor";
  $("#execution-checklist-items").innerHTML = items.map((item) => {
    const result = item.result || (item.done ? "Done" : "Pending");
    const control = simple
      ? `<label class="checkbox-line"><input type="checkbox" data-check-done ${result === "Done" ? "checked" : ""}> Done</label>${["N.A.", "In Progress"].includes(result) ? `<small data-check-legacy>Saved as ${escapeHTML(result)}; kept until you tick Done.</small>` : ""}`
      : `<label>Self QA<select data-check-result>${["Pending", "Done", "N.A."].map((option) => `<option ${option === result ? "selected" : ""}>${option}</option>`).join("")}</select></label>`;
    return `<div class="execution-checklist-row" data-check-id="${escapeHTML(item.id || "")}" data-section="${escapeHTML(item.section || "")}" data-detail="${escapeHTML(item.detail || "")}" data-initial-result="${escapeHTML(result)}">
    <div><small>${escapeHTML(item.section || "Additional check")}</small><textarea data-check-label rows="3" maxlength="4000" required ${item.id ? "readonly" : ""}>${escapeHTML(item.label)}</textarea>${item.detail ? `<details><summary>Guidance</summary>${escapeHTML(item.detail)}</details>` : ""}</div>
    ${control}
    <label>${simple ? "Notes (optional)" : "Comment"}<textarea data-check-comment rows="2" maxlength="2000" ${simple ? "" : 'placeholder="Required for N.A."'}>${escapeHTML(item.comment || "")}</textarea></label></div>`;
  }).join("");
}

function checklistRowResult(row) {
  const box = row.querySelector("[data-check-done]");
  if (!box) return row.querySelector("[data-check-result]").value;
  const initial = row.dataset.initialResult || "Pending";
  return box.checked === (initial === "Done") ? initial : box.checked ? "Done" : "Pending";
}

function handoffDocumentRow(doc = {}) {
  return `<div class="form-grid" data-document-row><label>File name<input data-document-name maxlength="240" value="${escapeHTML(doc.name || "")}" required></label><label>HTTPS file URL<input data-document-link type="url" pattern="https://.*" maxlength="2000" value="${escapeHTML(doc.link || "")}" required></label><button type="button" class="mini-button" data-remove-document>Remove file</button></div>`;
}

function openExecutionChecklist(key) {
  const delivery = state.execution.deliveries.find((row) => row.key === key);
  if (!delivery) return showToast("Assignment not found. Refresh and try again.", true);
  const form = $("#execution-checklist-form");
  form.reset();
  form.elements.deliveryKey.value = key;
  const saved = state.execution.checklists.find((item) => item.deliveryKey === key);
  const asset = String(delivery.project?.assetType || delivery.project?.channel || "").toLowerCase();
  const type = /ppt|gslide|powerpoint/.test(asset) ? "PPT/Gslide" : /banner/.test(asset) ? "Banner" : /ipdf/.test(asset) ? "iPDF" : asset === "print" ? "Print" : "";
  const template = state.operationsWorkspace?.checklistTemplates?.find((item) => state.user.role === "auditor"
    ? item.assetType === "Graphics Audit" && item.forAssetType === type : item.assetType === type);
  $("#execution-checklist-source").textContent = template ? `Approved source: ${template.source}. ${state.user.role === "auditor" ? "Complete every checkpoint; N.A. requires an explanation." : "Tick each checkpoint when it is done; notes are optional. Previously saved N.A. / In Progress states are kept until you tick Done."} Download as XLSX to upload to Workfront.` : "No approved asset checklist supplied for this channel. Add checks as required; this is not an approved channel checklist.";
  $("#execution-checklist-project").textContent = `${delivery.ref} · ${delivery.title} · ${delivery.type} ${delivery.crId || ""}`;
  const items = template ? [...template.items.map((item) => ({ ...item, ...saved?.items.find((check) => check.id === item.id), label: item.label, detail: item.detail })),
    ...(saved?.items.filter((item) => !item.id) || [])]
    : saved?.items || ["Source requirements reviewed", "Content and dimensions verified", "Functional checks completed", "Visual self-QC completed", "Output and handoff documents linked"].map((label) => ({ label, done: false }));
  executionChecklistItems(items);
  $("#execution-handoff-preview").classList.add("hidden");
  for (const field of ["functionalLink", "styleLink", "checklistLink", "observations"]) form.elements[field].value = saved?.[field] ?? delivery.handoff?.[field] ?? "";
  for (const field of ["inputDocuments", "outputDocuments"]) $(`#handoff-${field}`).innerHTML = (saved?.[field] ?? delivery.handoff?.[field] ?? []).map(handoffDocumentRow).join("");
  $("#execution-checklist-dialog").showModal();
}

function checklistPayload() {
  const form = $("#execution-checklist-form");
  const payload = Object.fromEntries(new FormData(form));
  payload.items = [...$("#execution-checklist-items").querySelectorAll(".execution-checklist-row")].map((row) => ({
    id: row.dataset.checkId, section: row.dataset.section, detail: row.dataset.detail,
    label: row.querySelector("[data-check-label]").value.trim(), result: checklistRowResult(row),
    done: checklistRowResult(row) === "Done", comment: row.querySelector("[data-check-comment]").value.trim()
  }));
  for (const field of ["inputDocuments", "outputDocuments"]) {
    payload[field] = [...$(`#handoff-${field}`).querySelectorAll("[data-document-row]")].map((row) => ({
      name: row.querySelector("[data-document-name]").value.trim(), link: row.querySelector("[data-document-link]").value.trim()
    }));
  }
  return payload;
}

async function saveExecutionChecklist() {
  const form = $("#execution-checklist-form");
  if (!form.reportValidity()) throw new Error("Complete the required checklist fields.");
  const payload = checklistPayload();
  await api("/api/execution/checklist", { method: "PUT", body: JSON.stringify(payload) });
  await refreshData();
  return payload;
}

function downloadWorkflowFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function executionHandoff(delivery, checklist) {
  const docs = (items) => items.length ? items.map((doc) => `<div>${safeTemplateLink(doc.name, doc.link)}</div>`).join("") : "Not provided";
  const complete = checklist.items.length > 0 && checklist.items.every((item) => item.result === "Done" || item.done || item.result === "N.A." && item.comment);
  return `<html><body style="font-family:Arial,sans-serif;max-width:600px">
    <p>Hello <a href="https://experience.adobe.com/#/@fhoffmann-larocheag/so:laroche-Production/workfront/user/6880aed90002f6521d12835ccf157230">@Puneet Srivastava</a></p>
    <p>${complete ? "Development has been completed" : "Development handoff draft"} for the ${delivery.crId ? "CR" : "project"} – <strong>${escapeHTML(delivery.title || delivery.ref)} ${escapeHTML(delivery.crId || "")}</strong></p>
    <p><strong>Self QC Status: ${complete ? "Done" : "Pending"}</strong></p><hr>
    <p><strong>Input Document:</strong></p>${docs(checklist.inputDocuments)}
    <p><strong>Functional Document:</strong> ${checklist.functionalLink ? safeTemplateLink("Functional document", checklist.functionalLink) : "NA"}</p>
    <p><strong>Style Guide Document:</strong> ${checklist.styleLink ? safeTemplateLink("Style guide", checklist.styleLink) : "NA"}</p>
    <p><strong>Output Document:</strong></p>${docs(checklist.outputDocuments)}<hr>
    <p><strong>Observations#</strong></p><ul>${checklist.observations.split("\n").filter(Boolean).map((line) => `<li>${escapeHTML(line)}</li>`).join("") || "<li>Not provided</li>"}</ul><hr>
    <p><strong>Checklist Link#</strong> ${checklist.checklistLink ? safeTemplateLink("Attached", checklist.checklistLink) : "Upload the downloaded checklist to Workfront and add its URL."}</p></body></html>`;
}

function initializeWorkflowUI() {
  for (const id of ["quality-outcome", "quality-search", "quality-member", "quality-period", "quality-date"]) {
    $(`#${id}`).addEventListener(id === "quality-search" ? "input" : "change", () => { qualityPage = 1; renderQuality(); });
  }
  $("#quality-previous").addEventListener("click", () => { qualityPage = Math.max(1, qualityPage - 1); renderQuality(); });
  $("#quality-next").addEventListener("click", () => { qualityPage++; renderQuality(); });
  $("#quality-last-week").addEventListener("click", async () => {
    if (state.roleCapabilities.viewManagerReports) {
      setView("manager-reports");
      await loadLeadershipReports("weekly");
      $("#leadership-report-panel").scrollIntoView({ behavior: "smooth" });
    } else {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
      const date = new Date(`${today}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7 - 7);
      $("#quality-date").value = date.toISOString().slice(0, 10);
      $("#quality-period").value = "weekly";
      qualityPage = 1;
      renderQuality();
    }
  });
  if (typeof initializeProcessAuditUI === "function") initializeProcessAuditUI();
  if (typeof initializeOperationalUI === "function") initializeOperationalUI();
  $("#execution-search").addEventListener("input", renderExecutionWork);
  $("#execution-type").addEventListener("change", renderExecutionWork);
  $("#execution-status").addEventListener("change", renderExecutionWork);
  $("#hygiene-filter").addEventListener("change", renderHygiene);
  $("#hygiene-project").addEventListener("input", () => { renderHygiene(); renderSLA(); });
  $("#hygiene-export").addEventListener("click", () => downloadCSV("process-adherence.csv",
    [["Project", "Name", "Primary Material", "Material Expected date", "Plan completion date", "SLA", "Request Type", "Complexity", "Page count", "Status", "Evidence"],
      ...hygieneRows().map((row) => {
        const value = (rule) => row.checks.find((check) => check.rule === rule);
        return [row.ref, row.title, ...["Primary material", "Material expected delivery", "Planned completion / SLA"].map((rule) => value(rule)?.actual || ""),
          value("Planned completion / SLA")?.slaStatus || "", ...["Request type", "Complexity", "Page count"].map((rule) => value(rule)?.actual || ""),
          row.status, row.checks.map((check) => `${check.rule}: ${check.status}; ${check.detail}; ${check.evidenceSource}`).join("\n")];
      })]));
  $("#quality-export").addEventListener("click", () => downloadCSV("quality-ftr.csv", [["Project", "Type", "CR", "Assignee", "Verified status", "In FTR denominator", "FTR", "Bug evidence", "Confirmed by"], ...qualityRows().map((row) => [row.ref, row.type, row.crId, row.names.join(", ") || row.qaExecutor || "", row.qualityStatus, row.eligible, row.ftr, row.bugCount, row.confirmedBy])]));
  document.addEventListener("click", async (event) => {
    const recheck = event.target.closest("[data-hygiene-recheck]");
    if (recheck) {
      recheck.disabled = true;
      try {
        await api("/api/hygiene-verifications", { method: "POST", body: JSON.stringify({ action: "recheck", projectRef: recheck.dataset.hygieneRecheck }) });
        await refreshData(true);
        renderHygiene();
        showToast("Rechecked imported Workfront details. For remote corrections, sync Workfront first.");
      } catch (error) { showToast(error.message, true); } finally { recheck.disabled = false; }
    }
    const timer = event.target.closest("[data-timer-action]");
    const checklist = event.target.closest("[data-execution-checklist]");
    const qa = event.target.closest("[data-quality-result]");
    const cr = event.target.closest("[data-audit-cr]");
    const clockButton = event.target.closest("[data-audit-clock]");
    if (clockButton) await auditClockAction(clockButton.dataset.auditClock, clockButton.dataset.auditRef, clockButton.dataset.auditCrId);
    if (event.target.closest("#start-full-audit-clock")) {
      const form = $("#audit-form");
      await auditClockAction("start", form.elements.projectRef.value, form.elements.crId.value);
    }
    if (checklist) openExecutionChecklist(checklist.dataset.executionChecklist);
    if (qa) {
      const form = $("#quality-result-form");
      form.reset();
      form.elements.deliveryKey.value = qa.dataset.qualityResult;
      form.elements.date.value = localDate();
      $("#quality-result-dialog").showModal();
    }
    if (cr) {
      const round = state.workfrontChangeRounds.find((item) => item.workfrontId === cr.dataset.auditCr);
      const project = state.workfrontProjects.find((item) => item.ref === round?.projectRef);
      if (!round || !project) return showToast("CR project details are not loaded. Sync Workfront first.", true);
      const form = $("#cr-audit-form");
      form.reset();
      form.elements.roundId.value = round.workfrontId;
      form.elements.startDate.value = localDate();
      $("#cr-audit-label").textContent = `${round.projectRef} · ${round.crId} · ${round.title}`;
      $("#cr-audit-result").textContent = "";
      $("#cr-audit-dialog").showModal();
      renderAuditClocks();
      await auditClockAction("start", round.projectRef, round.crId);
    }
    const addDocument = event.target.closest("[data-add-document]");
    if (addDocument) {
      const list = $(`#handoff-${addDocument.dataset.addDocument}`);
      if (list.querySelectorAll("[data-document-row]").length >= 20) return showToast("At most 20 files in each section.", true);
      list.insertAdjacentHTML("beforeend", handoffDocumentRow());
    }
    event.target.closest("[data-remove-document]")?.closest("[data-document-row]").remove();
    if (!timer) return;
    timer.disabled = true;
    try {
      await api("/api/execution/timer", { method: "POST", body: JSON.stringify({ action: timer.dataset.timerAction, deliveryKey: timer.dataset.deliveryKey }) });
      await refreshData();
      showToast(`Timer ${timer.dataset.timerAction === "start" ? "started" : timer.dataset.timerAction === "hold" ? "held; time saved" : "stopped; time saved"}.`);
    } catch (error) { showToast(error.message, true); timer.disabled = false; }
  });
  $("#execution-checklist-add").addEventListener("click", () => {
    const items = checklistPayload().items;
    if (items.length >= 100) return showToast("A checklist can contain at most 100 checks.", true);
    executionChecklistItems([...items, { label: "", done: false }]);
  });
  $("#execution-checklist-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try { await saveExecutionChecklist(); showToast("Checklist saved."); } catch (error) { showToast(error.message, true); }
  });
  $("#execution-checklist-download").addEventListener("click", async () => {
    try {
      const payload = await saveExecutionChecklist();
      const response = await fetch(`/api/execution/checklist.xlsx?deliveryKey=${encodeURIComponent(payload.deliveryKey)}`);
      if (!response.ok) throw new Error((await response.json()).error || "Checklist download failed.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${state.execution.deliveries.find((item) => item.key === payload.deliveryKey).ref}-checklist.xlsx`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { showToast(error.message, true); }
  });
  $("#execution-handoff-copy").addEventListener("click", async () => {
    try {
      const payload = await saveExecutionChecklist();
      const row = state.execution.deliveries.find((item) => item.key === payload.deliveryKey);
      const preview = $("#execution-handoff-preview");
      preview.innerHTML = executionHandoff(row, payload);
      preview.classList.remove("hidden");
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") throw new Error("Rich clipboard is unavailable. Select the visible handoff and copy it manually for Workfront.");
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([preview.innerHTML], { type: "text/html" }),
        "text/plain": new Blob([preview.innerText], { type: "text/plain" }) })]);
      showToast("Formatted handoff copied. Paste it into Workfront.");
    } catch (error) { showToast(error.message, true); }
  });
  $("#execution-handoff-download").addEventListener("click", async () => {
    try {
      const payload = await saveExecutionChecklist();
      const row = state.execution.deliveries.find((item) => item.key === payload.deliveryKey);
      const subject = `QA handoff - ${row.ref} ${row.crId || ""}`.replace(/[\r\n]/g, " ");
      const html = executionHandoff(row, payload);
      downloadWorkflowFile(`${row.ref}-QA-handoff.eml`, `X-Unsent: 1\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${btoa(unescape(encodeURIComponent(html))).match(/.{1,76}/g).join("\r\n")}`, "message/rfc822");
    } catch (error) { showToast(error.message, true); }
  });
  $("#quality-result-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api("/api/quality-results", { method: "POST", body: JSON.stringify({ deliveryKey: form.elements.deliveryKey.value,
        result: form.elements.result.value, firstTime: form.elements.firstTime.checked, note: form.elements.note.value, date: form.elements.date.value }) });
      $("#quality-result-dialog").close();
      await refreshData();
      showToast("QA result recorded.");
    } catch (error) { showToast(error.message, true); }
  });
  $("#cr-audit-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const audit = await api("/api/cr-audits", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      await refreshData();
      $("#cr-audit-result").textContent = `Audit recorded. CR execution ETA: ${audit.etaDate} (${audit.tatDays} business day(s)). Audit clock stopped.`;
      showToast(`CR audit saved. ETA ${audit.etaDate}.`);
    } catch (error) { showToast(error.message, true); } finally { button.disabled = false; }
  });
  for (const name of ["complexity", "startDate"]) $("#cr-audit-form").elements[name].addEventListener("change", () => {
    const form = $("#cr-audit-form");
    if (form.elements.startDate.value) $("#cr-audit-result").textContent = `Planned execution ETA: ${addBusinessDays(form.elements.startDate.value, form.elements.complexity.value === "Complex" ? 3 : 1)} (weekends and holidays excluded).`;
  });
  setInterval(() => {
    updateExecutionElapsed();
    $$("[data-audit-elapsed]").forEach((element) => {
      const session = state.auditSessions?.find((item) => item.id === element.dataset.auditElapsed);
      if (session) element.textContent = `${((session.elapsedMs + (session.state === "running" ? Math.max(0, Date.now() - new Date(session.startedAt)) : 0)) / 3600000).toFixed(3)}h`;
    });
  }, 1000);
}
