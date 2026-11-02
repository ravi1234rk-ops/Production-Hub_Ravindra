"use strict";

let leadershipReport = null;
let leadershipRequestSequence = 0;
let leadershipListSequence = 0;
let leadershipAvailableTeams = [];
let leadershipPreparationError = "";
let leadershipPreferredTeam = "";
const reportPercent = (value) => value === null || value === undefined ? "N/A" : `${Number(value).toFixed(1)}%`;

function leadershipUrl(action = "") {
  const team = $("#leadership-report-team").value;
  return `/api/leadership-reports/${encodeURIComponent($("#leadership-report-select").value)}${action ? `/${action}` : ""}${team ? `?team=${encodeURIComponent(team)}` : ""}`;
}

function leadershipControls(ready) {
  for (const id of ["leadership-xlsx", "leadership-copy", "leadership-print", "leadership-review", "leadership-refresh"]) $(`#${id}`).disabled = !ready;
  $("#leadership-review").classList.toggle("hidden", !["manager", "teamManager"].includes(state.user?.role));
  $("#leadership-refresh").classList.toggle("hidden", state.user?.role !== "manager");
}

async function loadLeadershipReports(kind = "") {
  if (!state.roleCapabilities.viewManagerReports) return;
  const sequence = ++leadershipListSequence;
  leadershipRequestSequence++;
  leadershipControls(false);
  leadershipReport = null;
  $("#leadership-report-content").innerHTML = "";
  $("#leadership-bulletin").value = "";
  $("#leadership-report-status").textContent = "Loading prepared reports...";
  $("#leadership-error").textContent = "";
  try {
    if (state.user?.role === "manager") await api("/api/leadership-reports/prepare", { method: "POST", body: "{}" });
    const listing = await api("/api/leadership-reports");
    if (sequence !== leadershipListSequence) return;
    $("#leadership-schedule").textContent = listing.schedule;
    leadershipPreparationError = listing.error || "";
    $("#leadership-error").textContent = listing.error || "";
    const select = $("#leadership-report-select");
    const previous = select.value;
    select.innerHTML = '<option value="">Choose report</option>' + listing.reports.map((report) =>
      `<option value="${escapeHTML(report.id)}">${escapeHTML(`${report.kind === "weekly" ? "Weekly utilisation / performance / FTR" : "Daily production / effort"} · ${report.from} to ${report.to} · v${report.version} · ${report.reviewed ? "Reviewed" : "Draft"}`)}</option>`).join("");
    select.value = kind ? listing.reports.find((report) => report.kind === kind)?.id || ""
      : listing.reports.some((report) => report.id === previous) ? previous : listing.reports[0]?.id || "";
    leadershipAvailableTeams = [];
    $("#leadership-report-team").innerHTML = '<option value="">Leadership summary / all permitted teams</option>';
    await loadSelectedLeadershipReport();
  } catch (error) {
    if (sequence === leadershipListSequence) $("#leadership-error").textContent = error.message;
  }
}

async function loadSelectedLeadershipReport() {
  const sequence = ++leadershipRequestSequence;
  leadershipReport = null;
  leadershipControls(false);
  $("#leadership-action-form").classList.add("hidden");
  $("#leadership-report-content").innerHTML = "";
  $("#leadership-bulletin").value = "";
  if (!$("#leadership-report-select").value) {
    $("#leadership-report-status").textContent = "No prepared reports yet. The app prepares the latest due periods at startup and checks every minute.";
    return;
  }
  $("#leadership-report-status").textContent = "Loading prepared snapshot...";
  $("#leadership-error").textContent = leadershipPreparationError;
  try {
    const report = await api(leadershipUrl());
    if (sequence !== leadershipRequestSequence) return;
    leadershipReport = report;
    if (!leadershipAvailableTeams.length) {
      leadershipAvailableTeams = report.teams.map((team) => ({ id: team.id, name: team.name }));
      const global = ["manager", "leadership"].includes(state.user?.role);
      $("#leadership-report-team").innerHTML = (global ? '<option value="">Leadership summary / all permitted teams</option>' : "") +
        leadershipAvailableTeams.map((team) => `<option value="${escapeHTML(team.id)}">${escapeHTML(team.name)}</option>`).join("");
      const ownTeam = leadershipAvailableTeams.find((team) => team.id === leadershipPreferredTeam)
        || leadershipAvailableTeams.find((team) => (state.user.teamIds || []).includes(team.id));
      const selected = ownTeam?.id || (global ? "" : leadershipAvailableTeams[0]?.id || "");
      $("#leadership-report-team").value = selected;
      if (selected) {
        await loadSelectedLeadershipReport();
        return;
      }
    }
    renderLeadershipReport();
    leadershipControls(true);
  } catch (error) {
    if (sequence !== leadershipRequestSequence) return;
    $("#leadership-error").textContent = error.message;
    $("#leadership-report-status").textContent = "Report unavailable.";
  }
}

function leadershipCardBriefing(report) {
  const totals = report.totals;
  const scope = report.teams.length === 1 ? report.teams[0].name : "Leadership summary";
  const hours = (value) => `${Number(value).toFixed(1)}h`;
  const cards = [
    ["Production completed", totals.deliveriesCompleted, `${totals.tasksCompleted} completed tasks`],
    ["Productive effort", hours(totals.productiveHours), `${hours(totals.capacityHours)} available capacity${report.teams.length === 1 && report.teams[0].id === "email" ? " · Email + eDetailer shared pool (counted once)" : ""}`],
    ["Utilisation", reportPercent(report.teams.length === 1 ? report.teams[0].utilisation : totals.utilisation),
      report.teams.length === 1 ? `${hours(totals.attributableHours)} dedicated-team effort / capacity` : "Recorded productive effort / capacity"],
    ["Non-production", hours(totals.trainingHours + totals.meetingHours + totals.otherHours), `Training ${hours(totals.trainingHours)} · Meetings ${hours(totals.meetingHours)} · Other ${hours(totals.otherHours)}`],
    ["First-time-right", reportPercent(totals.ftr.rate), `${totals.ftr.ftr}/${totals.ftr.eligible} verified decisions · ${totals.ftr.pending} unverified`],
    ["Delivery SLA", `${totals.onTime} on time`, `${totals.late} late · ${totals.slaUnknown} unknown`],
    ["Benchmark / actual", `${hours(totals.benchmarkHours)} / ${hours(totals.pairedActualHours)}`, `${totals.pairedDeliveries} comparable deliveries`],
    ["Follow-up", `${totals.ftr.rework} rework`, `${totals.unbucketedTasks} archive tasks missing completion dates`]
  ];
  return `<div class="leadership-card-briefing"><h3>${escapeHTML(scope)} · ${report.kind === "weekly" ? "Weekly utilisation, performance & FTR" : "Daily production & effort"}</h3>
    <p>${escapeHTML(report.from)} to ${escapeHTML(report.to)} · IST · Shared by ${escapeHTML(state.user.name)}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:680px;font-family:Segoe UI,Arial,sans-serif;">${cards.map(([label, value, foot], index) =>
      `${index % 2 === 0 ? "<tr>" : ""}<td width="50%" valign="top" style="border:1px solid #cfd6e0;padding:12px;background:#fff;color:#111827;"><div style="font-size:11px;font-weight:700;color:#4f46e5;text-transform:uppercase;">${escapeHTML(label)}</div><div style="font-size:26px;font-weight:700;margin:6px 0;">${escapeHTML(String(value))}</div><div style="font-size:12px;color:#4b5563;">${escapeHTML(foot)}</div></td>${index % 2 === 1 ? "</tr>" : ""}`).join("")}</table></div>`;
}

function renderLeadershipReport() {
  const report = leadershipReport;
  if (!report) return;
  const reviewed = report.teams.every((team) => team.reviewedAt);
  $("#leadership-report-status").textContent = `${reviewed ? "Reviewed" : "Draft — review before sharing"} · v${report.version} · Prepared ${report.generatedAt}`;
  $("#leadership-bulletin").value = `Shared by ${state.user.name} · ${report.teams.length === 1 ? report.teams[0].name : "Leadership summary"}\n\n${report.bulletin}`;
  const teams = workflowTable(["Team / pool", "Deliveries", "Effort", "Dedicated capacity", "Attributable utilisation", "FTR", "Late", "Review"], report.teams.map((team) => [
    escapeHTML(team.name), team.deliveriesCompleted, `${team.productiveHours}h`, `${team.capacityHours}h`,
    `${reportPercent(team.utilisation)} (${team.attributableHours}h)`,
    `${team.ftr.ftr}/${team.ftr.eligible} · ${reportPercent(team.ftr.rate)}`, team.late,
    escapeHTML(team.reviewedAt ? `${team.reviewedBy} · ${team.reviewedAt}` : "Draft")
  ]));
  const production = report.teams.flatMap((team) => team.production.map((row) => ({ ...row, team: team.name })));
  const effort = report.teams.flatMap((team) => team.effort.map((row) => ({ ...row, team: team.name })));
  $("#leadership-report-content").innerHTML = `${leadershipCardBriefing(report)}
    <p>${reviewed ? "Reviewed" : "Draft — review before sharing"} · v${report.version} · Prepared ${escapeHTML(report.generatedAt)}</p>
    <details><summary>Team breakdown / review status</summary><div class="table-wrap">${teams}</div></details>
    <details><summary>Completed deliveries (${production.length}; preview up to 20)</summary><div class="table-wrap">${workflowTable(["Team", "Project / CR", "Completed", "SLA", "Quality", "Benchmark / actual"],
      production.slice(0, 20).map((row) => [escapeHTML(row.team), escapeHTML(`${row.ref} ${row.crId || ""}`), escapeHTML(row.completedAt),
        escapeHTML(row.sla), escapeHTML(row.quality), `${row.benchmark ?? "N/A"}h / ${row.actual ?? "N/A"}h`]))}</div></details>
    <details><summary>Daily effort evidence (${effort.length}; preview up to 20)</summary><div class="table-wrap">${workflowTable(["Team", "Date", "Member", "Project", "Type", "Hours"],
      effort.slice(0, 20).map((row) => [escapeHTML(row.team), escapeHTML(row.date), escapeHTML(row.name), escapeHTML(row.ref), escapeHTML(row.type), row.hours]))}</div></details>
    <details><summary>Reporting rules / source coverage</summary><p class="muted">${escapeHTML(report.coverage)}</p></details><p class="muted">Source: ${escapeHTML(report.source.status || "Unknown")} · Last successful sync: ${escapeHTML(report.source.lastSuccessAt || "Not recorded")}. Excel contains all evidence rows and per-member capacity/effort.</p>`;
}

function initializeLeadershipReportsUI() {
  $("#leadership-reload").addEventListener("click", () => loadLeadershipReports());
  $("#leadership-report-select").addEventListener("change", () => {
    loadSelectedLeadershipReport();
  });
  $("#leadership-report-team").addEventListener("change", () => {
    leadershipPreferredTeam = $("#leadership-report-team").value;
    loadSelectedLeadershipReport();
  });
  $("#leadership-xlsx").addEventListener("click", async () => {
    const button = $("#leadership-xlsx");
    button.disabled = true;
    const id = leadershipReport.id;
    const team = $("#leadership-report-team").value;
    try {
      const response = await fetch(leadershipUrl("xlsx"), { credentials: "same-origin" });
      if (!response.ok) throw new Error((await response.json()).error || "Report download failed.");
      downloadWorkflowFile(`${id}${team ? `-${team}` : ""}.xlsx`, await response.blob(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    } catch (error) { $("#leadership-error").textContent = error.message; } finally { button.disabled = !leadershipReport; }
  });
  $("#leadership-copy").addEventListener("click", async () => {
    try {
      if (navigator.clipboard.write && typeof ClipboardItem !== "undefined") {
        const html = `${leadershipCardBriefing(leadershipReport)}<p>${leadershipReport.teams.every((team) => team.reviewedAt) ? "Reviewed" : "Draft — review before sharing"} · v${leadershipReport.version} · Prepared ${escapeHTML(leadershipReport.generatedAt)}</p>
          <p>Source: ${escapeHTML(leadershipReport.source.status || "Unknown")} · Last sync: ${escapeHTML(leadershipReport.source.lastSuccessAt || "Not recorded")}. N/A means insufficient evidence. Team capacity excludes shared pools. Excel contains full supporting evidence.</p>`;
        await navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([$("#leadership-bulletin").value], { type: "text/plain" })
        })]);
      } else {
        await navigator.clipboard.writeText($("#leadership-bulletin").value);
      }
      showToast("Email bulletin copied. Review before sharing.");
    } catch (error) {
      $("#leadership-bulletin").closest("details").open = true;
      $("#leadership-bulletin").select();
      showToast(`Clipboard unavailable; copy the selected bulletin manually. ${error.message}`, true);
    }
  });
  $("#leadership-print").addEventListener("click", () => {
    document.body.classList.add("print-leadership");
    window.print();
  });
  window.addEventListener("afterprint", () => document.body.classList.remove("print-leadership"));
  for (const action of ["review", "refresh"]) {
    $(`#leadership-${action}`).addEventListener("click", () => {
      const form = $("#leadership-action-form");
      form.reset();
      form.elements.action.value = action;
      form.classList.remove("hidden");
      form.elements.note.focus();
    });
  }
  $("#leadership-action-cancel").addEventListener("click", () => $("#leadership-action-form").classList.add("hidden"));
  $("#leadership-action-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await api(leadershipUrl(form.elements.action.value), { method: "POST",
        body: JSON.stringify({ version: leadershipReport.version, note: form.elements.note.value }) });
      form.classList.add("hidden");
      await loadSelectedLeadershipReport();
      showToast("Report action saved.");
    } catch (error) { $("#leadership-error").textContent = error.message; } finally { button.disabled = false; }
  });
}
