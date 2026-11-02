"use strict";

const PRODUCTION_TASK_PATTERN = /^(build|cr(?:\s*\d+)?|change rounds?|bug fixing)$/i;
const EXECUTIONER_VIEWS = ["my-work", "quality", "kpi", "feedback", "worklog", "gantt", "team"];
const state = { user: null, projects: [], tasks: [], audits: [], workLogs: [], ganttLogs: [], team: [], users: [], departments: [], marketMatrix: [], holidays: [], leaves: [], changeRounds: [], workfrontProjects: [], workfrontChangeRounds: [], workfrontTasks: [], workfrontGanttTasks: [], workfrontSync: null, workfrontAutomation: null, workfrontLogin: null, workfrontDataset: "projects", workfrontPage: 1, aht: null, performance: null, productionInsights: null, capacityHoursPerDay: 8, complexityMultipliers: null, roleCapabilities: {}, view: "overview", pollErrorShown: false, ganttScale: "day", drill: null };
const WORKFRONT_CHANNELS = ["Banner", "Campaign", "eDetailer", "Email", "Illustration", "iPDF", "Landing Page", "Outbound WhatsApp [Not Yet Launched]", "Poster", "PPT/Gslide", "Print", "Social Media Post", "Video", "Website"];
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const AHT_MATRIX_EDITABLE_FIELDS = [
  ["pcTriageMinutes", "PC triage"],
  ["channelLeadMinutes", "Channel lead"],
  ["designerMinutes", "Designer"],
  ["buildMinutes", "Build"],
  ["qaLeadMinutes", "QA lead"],
  ["qaMinutes", "QA"],
  ["pcCloseMinutes", "PC close"],
  ["crPcPlusMinutes", "CR PC+"],
  ["crBuildMinutes", "CR build"],
  ["crQaMinutes", "CR QA"]
];
const ROLE_LABELS = {
  manager: "Manager",
  teamManager: "Team Manager",
  leadership: "Leadership",
  auditor: "Auditor",
  executioner: "Executioner / Designer"
};
let toastTimer;
let marketMatrixDraft = [];
let holidaysDraft = [];
let refreshSequence = 0;
const shownAssignmentAlerts = new Set();

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function workfrontProjectLink(project, label = project?.title || "—") {
  const candidate = String(project?.workfrontUrl || "");
  let href = "";
  try {
    const url = new URL(candidate);
    const trustedHost = url.hostname === "experience.adobe.com" || url.hostname.endsWith(".my.workfront.adobe.com");
    if (url.protocol === "https:" && trustedHost && /\/project\/[A-Za-z0-9_-]+(?:\/|$|[?#])/i.test(`${url.pathname}${url.hash}`)) {
      href = url.href;
    }
  } catch {
    href = "";
  }
  const bug = typeof projectHasDesignBug === "function" && projectHasDesignBug(project) ? ' <span class="bug-label">BUG</span>' : "";
  return (href
    ? `<a class="workfront-project-link" href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)}</a>`
    : escapeHTML(label)) + bug;
}

function workfrontProjectPriority(record) {
  const ref = normalizeWorkfrontStatus(record?.projectRef || record?.ref
    || state.projects.find((project) => project.id === record?.projectId)?.ref);
  const parent = state.workfrontProjects.find((project) => normalizeWorkfrontStatus(project.ref) === ref);
  return String(parent?.priority ?? record?.projectPriority ?? "").trim();
}

function workfrontPriorityLabel(record) {
  const parent = state.workfrontProjects.find((project) => normalizeWorkfrontStatus(project.ref) === normalizeWorkfrontStatus(record?.projectRef || record?.ref));
  const title = parent?.priorityPolicy || "Read-only priority from Workfront Project Details";
  return `<small class="workfront-project-priority" title="${escapeHTML(title)}">Project priority: ${escapeHTML(workfrontProjectPriority(record) || "Not provided")}</small>`;
}

function workfrontRecordTeam(record) {
  const parent = state.workfrontProjects.find((project) =>
    normalizeWorkfrontStatus(project.ref) === normalizeWorkfrontStatus(record.projectRef || record.ref));
  const departmentId = record.productionTeamId || parent?.productionTeamId;
  return state.departments.find((department) => department.id === departmentId)?.name
    || record.workfrontTeam || parent?.workfrontTeam || "Unmapped";
}

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateLabel(value) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? escapeHTML(value) : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function holidayOn(value) {
  const date = String(value || "").slice(0, 10);
  return date ? (state.holidays || []).find((holiday) => holiday.date === date) || null : null;
}

function holidayFlag(value) {
  const holiday = holidayOn(value);
  return holiday ? ` <span class="holiday-flag" title="${escapeHTML(`${holiday.name || "Holiday"} — business holiday`)}">Holiday${holiday.name ? ` · ${escapeHTML(holiday.name)}` : ""}</span>` : "";
}

function dateWithHoliday(value) {
  return `${dateLabel(value)}${holidayFlag(value)}`;
}

function showToast(message, isError = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...options, headers, credentials: "same-origin" });
  if (response.status === 401 && !url.startsWith("/api/auth/")) {
    showAuth(false);
    throw new Error("Your session expired. Please sign in again.");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

function setAuthMode(setupRequired) {
  $("#auth-title").textContent = setupRequired ? "Create your workspace" : "Welcome back";
  $("#auth-copy").textContent = setupRequired
    ? "Set up the Manager account. This account can create logins and configure your workspace."
    : "Sign in to access your shared project workspace.";
  $("#auth-name-wrap").classList.toggle("hidden", !setupRequired);
  $("#auth-name-wrap input").required = setupRequired;
  $("#auth-form [name=password]").autocomplete = setupRequired ? "new-password" : "current-password";
  $("#auth-submit").textContent = setupRequired ? "Create Manager account" : "Sign in";
  $("#auth-footnote").textContent = setupRequired
    ? "The first account is the workspace Manager."
    : "Your role and team / department access are assigned by your workspace Manager.";
  $("#auth-form").dataset.mode = setupRequired ? "setup" : "login";
}

function showAuth(setupRequired) {
  state.user = null;
  setAuthMode(setupRequired);
  $("#app-shell").classList.add("hidden");
  $("#auth-screen").classList.remove("hidden");
}

function showApp() {
  $("#auth-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  $("#user-name").textContent = state.user.name;
  const assignedDepartments = (state.departments || []).filter((department) => (state.user.teamIds || []).includes(department.id)).map((department) => department.name);
  const scopeLabel = state.user.role === "manager" ? "All departments · Admin"
    : state.user.role === "leadership" ? "All departments · Read only"
      : assignedDepartments.length ? assignedDepartments.join(", ") : "Department access pending";
  $("#user-role").textContent = `${ROLE_LABELS[state.user.role] || state.user.role} · ${scopeLabel}`;
  $("#user-avatar").textContent = state.user.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  $("#welcome-title").textContent = `Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}, ${state.user.name.split(/\s+/)[0]}`;
  $("#today-label").textContent = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date());
  $('[data-view="aht"]').innerHTML = `<span>◷</span> ${state.roleCapabilities.viewAht ? "AHT & capacity" : "My performance"}`;
  $$("[data-capability]").forEach((element) => {
    element.classList.toggle("hidden", !state.roleCapabilities[element.dataset.capability]
      || element.classList.contains("view") && element.id !== `view-${state.view}`);
  });
  $("#backup-button").classList.toggle("hidden", !state.roleCapabilities.manageWorkspace);
  $('[data-view="projects"]').classList.add("hidden");
  $('[data-view="gantt"]').classList.remove("hidden");
  if (state.user.role === "executioner") {
    $$(".nav-link").forEach((button) => button.classList.toggle("hidden", !EXECUTIONER_VIEWS.includes(button.dataset.view)));
    $$("[data-team-tab]").forEach((button) => button.classList.toggle("hidden", button.dataset.teamTab !== "leave"));
    setTeamTab("leave");
    if (!EXECUTIONER_VIEWS.includes(state.view)) setView("my-work");
  }
  if (state.view === "audits" && !state.roleCapabilities.viewAudits) setView("overview");
  setTeamTab(state.user.role === "executioner" ? "leave" : state.teamTab || "members");
  setCapacityTab(state.capacityTab || "report", { render: false });
  renderAll();
  if (!$("#leave-form").elements.startDate.value) {
    $("#leave-form").elements.startDate.value = localDate();
    $("#leave-form").elements.endDate.value = localDate();
  }
}

function applySnapshot(snapshot) {
  state.user = snapshot.user;
  state.users = snapshot.users || [];
  state.team = snapshot.team || [];
  state.departments = snapshot.departments || [];
  state.unmappedWorkfrontAssignees = snapshot.unmappedWorkfrontAssignees || [];
  state.projects = snapshot.projects || [];
  state.tasks = snapshot.tasks || [];
  state.audits = snapshot.audits || [];
  state.workLogs = snapshot.workLogs || [];
  state.marketMatrix = snapshot.marketMatrix || [];
  state.holidays = snapshot.holidays || [];
  state.leaves = snapshot.leaves || [];
  state.changeRounds = snapshot.changeRounds || [];
  state.workfrontProjects = snapshot.workfrontProjects || [];
  state.workfrontChangeRounds = snapshot.workfrontChangeRounds || [];
  state.workfrontTasks = snapshot.workfrontTasks || [];
  state.workfrontGanttTasks = snapshot.workfrontGanttTasks || [];
  state.workfrontSync = snapshot.workfrontSync || null;
  state.workfrontAutomation = snapshot.workfrontAutomation || null;
  state.workfrontLogin = snapshot.workfrontLogin || null;
  state.ganttLogs = snapshot.ganttLogs || [];
  state.aht = snapshot.aht || null;
  state.performance = snapshot.performance || null;
  state.productionInsights = snapshot.productionInsights || null;
  state.capacityHoursPerDay = snapshot.capacityHoursPerDay || 8;
  state.complexityMultipliers = snapshot.complexityMultipliers || null;
  state.roleCapabilities = snapshot.roleCapabilities || {};
  state.operations = snapshot.operations || null;
  state.notifications = snapshot.notifications || [];
  state.sourceWorkLogs = snapshot.sourceWorkLogs || [];
  state.execution = snapshot.execution || { deliveries: [], quality: { rows: [] }, checklists: [] };
  state.hygiene = snapshot.hygiene || [];
  state.processAuditMonths = snapshot.processAuditMonths || [];
  state.auditSessions = snapshot.auditSessions || [];
  state.operationsWorkspace = snapshot.operationsWorkspace || { deliveries: [], quality: { rows: [] }, kpis: [], issues: [], members: [], feedback: [], activityLogs: [], sla: [], checklistTemplates: [] };
  if (typeof applyOperationalSnapshot === "function") applyOperationalSnapshot();
}

async function refreshData(quiet = false) {
  const sequence = ++refreshSequence;
  try {
    const snapshot = await api("/api/data");
    if (sequence !== refreshSequence) return;
    const position = { top: window.scrollY, left: window.scrollX };
    $(".main-content").style.minHeight = `${position.top + window.innerHeight}px`;
    applySnapshot(snapshot);
    state.pollErrorShown = false;
    showApp();
    window.scrollTo({ ...position, behavior: "instant" });
    $("#last-updated").innerHTML = '<span class="online-dot"></span> Live team data';
  } catch (error) {
    if (!quiet || !state.pollErrorShown) showToast(error.message, true);
    state.pollErrorShown = true;
    if (!quiet) throw error;
  }
}

function renderOperations() {
    const ops = state.operations;
    const unread = (state.notifications || []).filter((entry) => !entry.readAt).length;
    $("#assignment-alert-button").textContent = `Assignments${unread ? ` (${unread} new)` : ""}`;
    $("#assignment-alert-button").classList.toggle("hidden", state.user.role !== "executioner");
    const riskButton = $("#today-risk-button");
    riskButton.classList.toggle("hidden", !state.roleCapabilities.viewAht);
    if (state.roleCapabilities.viewAht) {
      const teamId = briefingTeamDefault();
      const { todayRisk, team } = capacityBriefing({ teamId, date: localDate() });
      riskButton.classList.toggle("risk-negative", todayRisk < 0);
      riskButton.textContent = `${todayRisk < 0 ? "▲ Today risk" : "Today headroom"} ${todayRisk < 0 ? "−" : "+"}${formatBriefingHours(Math.abs(todayRisk))} hrs`;
      riskButton.title = `${team}: today's capacity minus work due today and overdue Urgent work. Open the capacity report.`;
    }
    $("#assignment-alert-list").innerHTML = state.notifications?.length ? state.notifications.map((entry) => `<article class="${entry.readAt ? "compact-item" : "ops-unread"}"><strong>${escapeHTML(entry.message)}</strong><small>${escapeHTML(new Date(entry.createdAt).toLocaleString())}</small>${entry.readAt ? "" : `<button type="button" class="mini-button" data-read-notification="${escapeHTML(entry.id)}">Mark read</button>`}</article>`).join("") : emptyState("No assignment alerts", "New assignments to your roster name will appear here and remain until read.");
    const newAlerts = (state.notifications || []).filter((entry) => !entry.readAt && !shownAssignmentAlerts.has(entry.id));
    for (const entry of state.notifications || []) shownAssignmentAlerts.add(entry.id);
    if (newAlerts.length) showToast(`${newAlerts.length} new assignment${newAlerts.length === 1 ? "" : "s"}. Open Assignments for details.`);
    const gdBannerAlert = $("#gd-banner-overdue-alert");
    const canViewGdBannerAlert = state.user.role === "manager"
      || state.user.role === "teamManager" && (state.user.teamIds || []).includes("design");
    const gdBannerOverdues = canViewGdBannerAlert ? ops?.gdBannerOverdues || [] : [];
    gdBannerAlert.classList.toggle("hidden", !gdBannerOverdues.length);
    $("#gd-banner-overdue-list").innerHTML = gdBannerOverdues.length
      ? `<table><thead><tr><th>Project</th><th>Status</th><th>Actual start</th><th>Material expected</th></tr></thead><tbody>${gdBannerOverdues.map((project) => `<tr><td>${workfrontProjectLink(project, `${project.ref} · ${project.title}`)}</td><td>${badge(project.sourceStatus || "Active")} <span class="risk-tag gd-banner-overdue-tag">Overdue · GD Banner rule</span></td><td>${project.actualStartDate ? escapeHTML(new Date(project.actualStartDate).toLocaleString()) : "—"}</td><td>${dateWithHoliday(project.materialExpectedDate)}</td></tr>`).join("")}</tbody></table>`
      : "";
    $("#ops-capacity").innerHTML = ops ? `<p class="muted">${ops.unassignedTasks} active tasks have no roster executioner. Backlog combines local and Workfront workload without counting matching work twice. Multi-person source work reserves full effort per person; individual shares are unknown. Daily capacity is not free capacity.</p><table><thead><tr><th>Resource</th><th>Tasks</th><th>Remaining workload</th><th>Capacity today</th><th>Backlog / availability</th></tr></thead><tbody>${ops.resources.map((member) => `<tr><td>${escapeHTML(member.name)}</td><td>${member.taskCount}</td><td>${member.remainingHours.toFixed(1)}h${member.unknownTasks ? ` + ${member.unknownTasks} unknown` : ""}</td><td>${member.dailyCapacity}h</td><td>${member.unknownTasks ? "Cannot confirm: missing hours" : `${member.backlogDays} productive days queued`}${member.away ? " · Approved leave" : ""}</td></tr>`).join("")}</tbody></table>` : emptyState("Capacity not loaded", "Refresh the app to fetch the latest scoped workload.");
  }

let timelineDetailKey = "";

function timelineDetailCard() {
  return timelineDetailCard.element || $("#timeline-hover");
}

function hideTimelineDetail() {
  timelineDetailKey = "";
  const card = timelineDetailCard();
  if (card) card.hidden = true;
  for (const row of document.querySelectorAll?.('[data-hover-task][aria-expanded="true"]') || []) row.setAttribute("aria-expanded", "false");
}

function showTimelineHover(row) {
    const [source, id] = row.dataset.hoverTask.split(":");
    const task = source === "local" ? state.tasks.find((item) => item.id === id)
      : source === "cr" ? state.workfrontChangeRounds.find((item) => item.workfrontId === id)
        : [...state.workfrontTasks, ...(state.workfrontGanttTasks || [])].find((item) => item.id === id || item.workfrontId === id);
    if (!task) return;
    const project = source === "local" ? state.projects.find((item) => item.id === task.projectId) : state.workfrontProjects.find((item) => item.ref === task.projectRef);
    const card = timelineDetailCard();
    const taskName = task.category || task.taskName || (source === "cr" ? task.crId : "");
    const crWindow = ganttCrWindow({ ...task, changeRound: source === "cr" });
    const startDate = crWindow ? ganttDate(crWindow.acceptanceDate) : task.plannedStartDate || task.startDate;
    const endDate = crWindow ? ganttDate(crWindow.expectedDeliveryDate) : task.plannedCompletionDate || task.etaDate;
    card.innerHTML = `<button type="button" class="text-button timeline-detail-close" data-close-timeline-detail aria-label="Close task details">Close ✕</button><strong>${escapeHTML(task.projectRef || project?.ref)} · ${escapeHTML(taskName)}</strong><small>${escapeHTML(project?.title || task.projectName || task.title)}</small><small>Project status: ${escapeHTML(project?.sourceStatus || project?.status || task.projectStatus || "Unavailable")}</small><small>Task: ${escapeHTML(task.taskStatus || task.sourceStatus || task.status)}${task.executionStatus ? ` · Execution log: ${escapeHTML(task.executionStatus)}` : ""}</small><small>Planned: ${dateLabel(startDate)} – ${dateLabel(endDate)}</small>${crWindow ? `<small>CR SLA: Acceptance ${escapeHTML(ganttDateTimeLabel(crWindow.acceptanceDate))} → Material expected ${escapeHTML(ganttDateTimeLabel(crWindow.expectedDeliveryDate))}</small>` : ""}<small>${escapeHTML(ganttEffort(task).label)}</small><small>Actual completion: ${dateLabel(task.actualCompletionDate || task.completionDate)}</small><small>App work logged: ${Number(task.executionLoggedHours ?? task.loggedHours ?? 0).toFixed(1)}h</small>${source === "cr" ? "" : workfrontSourceDetails(task)}<small>Project activity: ${escapeHTML(project?.latestSystemActivity || "Unavailable")}</small>`;
    // Inline below the row so the details push the timeline down instead of covering it.
    if (typeof row.after === "function") row.after(card);
    for (const other of document.querySelectorAll?.('[data-hover-task][aria-expanded="true"]') || []) other.setAttribute("aria-expanded", "false");
    timelineDetailKey = row.dataset.hoverTask;
    row.setAttribute?.("aria-expanded", "true");
    card.hidden = false;
  }
function statusClass(status) {
  return `status-${String(status).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`;
}

function badge(status) {
  return `<span class="status-pill ${statusClass(status)}">${escapeHTML(status)}</span>`;
}

function metricCard([label, value, foot, color], view, key, drillValue = "", enabled = true) {
  const drillLabel = `${label} details`;
  return `<button type="button" class="metric-card metric-card-action ${color}" data-drill-view="${escapeHTML(view)}" data-drill-key="${escapeHTML(key)}" data-drill-value="${escapeHTML(drillValue)}" data-drill-label="${escapeHTML(drillLabel)}" aria-label="${escapeHTML(`${label}: ${value}. ${foot}. Show details.`)}" title="${escapeHTML(`Show ${label.toLowerCase()} details`)}" ${enabled ? "" : "disabled"}>
    <span class="metric-label">${escapeHTML(label)}</span><strong class="metric-value">${escapeHTML(value)}</strong><span class="metric-foot">${escapeHTML(foot)}</span><span class="metric-drill-hint" aria-hidden="true">View details →</span>
  </button>`;
}

function renderDrillNotice(selector, view) {
  const container = $(selector);
  if (!container) return;
  const drill = state.drill?.view === view ? state.drill : null;
  container.innerHTML = drill
    ? `<div class="drill-notice" role="status"><span>Showing <strong>${escapeHTML(drill.label)}</strong></span><button type="button" class="text-button" data-clear-drill>Clear drill-through</button></div>`
    : "";
}

function projectEffort(project) {
  return Number(project.plannedHours) || Number(project.pages || 0) * Number(project.complexity || 1) * (state.aht?.teamAverage || 1.3);
}

function isOpen(project) {
  return !["Completed", "Archived"].includes(project.status);
}

function emptyState(title, detail) {
  return `<div class="empty-state"><strong>${escapeHTML(title)}</strong><p>${escapeHTML(detail)}</p></div>`;
}

function renderAll() {
  const scrollTop = window.scrollY;
  const scrollLeft = window.scrollX;
  const timelineScroll = $("#gantt-chart").scrollLeft;
  const collapsedGroups = new Set($$("#gantt-chart details[data-timeline-group]").filter((group) => !group.open).map((group) => group.dataset.timelineGroup));
  $(".main-content").style.minHeight = `${scrollTop + window.innerHeight}px`;
  renderDashboard();
  if (typeof renderWorkflowViews === "function") renderWorkflowViews();
  renderManagerReports();
  renderProjects();
  renderAudits();
  renderChangeRounds();
  renderTeam();
  renderGantt();
  renderAht();
  renderCapacity();
  if (state.view === "capacity" && (state.capacityTab || "report") === "report") renderCapacityBriefing();
  renderLeaves();
  renderHolidays();
  renderLeaveRisk();
  renderTeamUtilization();
  renderWorkfront();
  populateSelects();
  renderOperations();
  $("#gantt-chart").scrollLeft = timelineScroll;
  $$("#gantt-chart details[data-timeline-group]").forEach((group) => { if (collapsedGroups.has(group.dataset.timelineGroup)) group.open = false; });
  $("#project-nav-count").textContent = state.tasks.filter((task) => task.status !== "Completed" && task.status !== "Archived").length;
  $("#audit-nav-count").textContent = state.audits.length;
  window.scrollTo({ top: scrollTop, left: scrollLeft, behavior: "instant" });
}

const OVERVIEW_PROJECT_STATUSES = /^(current|pre-audit|audit ongoing|execution in progress|awaiting(?: for)? execution|in qc)$/i;
const PRIORITY_PROJECT_STATUSES = /^(current|execution in progress|awaiting(?: for)? execution|in qc)$/i;

function projectHasDesignBug(project) {
  return project && /^in qc$/i.test(project.status || project.sourceStatus || "") && state.workfrontTasks.some((task) =>
    normalizeWorkfrontStatus(task.projectRef) === normalizeWorkfrontStatus(project.ref) && /^bug fixing$/i.test(task.taskName)
    && !/^(complete|completed|cancelled)$/i.test(task.executionStatus || task.taskStatus || "")
    && productionTaskNames(task).some((name) => state.team.some((member) => member.name === name && (member.teamIds || []).includes("design"))));
}

function renderDashboard() {
  const today = localDate();
  const limit = new Date(`${today}T00:00:00`);
  limit.setDate(limit.getDate() + 7);
  const allProjects = state.workfrontProjects.length
    ? state.workfrontProjects.map((project) => ({ ...project, source: "workfront", status: project.sourceStatus })) : state.projects;
  const gdBannerOverdueRefs = new Set((state.operations?.gdBannerOverdues || []).map((project) => normalizeWorkfrontStatus(project.ref)));
  const activeProject = (project) => OVERVIEW_PROJECT_STATUSES.test(project.status || project.sourceStatus || "");
  const upcoming = allProjects.filter((project) => activeProject(project) && project.dueDate && project.dueDate >= today && project.dueDate <= localDate(limit)).length;
  const overdue = allProjects.filter((project) => activeProject(project)
    && (project.dueDate && project.dueDate < today || gdBannerOverdueRefs.has(normalizeWorkfrontStatus(project.ref)))).length;
  const allLogs = [...state.workLogs, ...(state.sourceWorkLogs || [])];
  const todayHours = allLogs.filter((entry) => entry.date === today).reduce((sum, entry) => sum + Number(entry.hours || 0), 0);
  const attention = state.audits.filter((audit) => ["Fail", "Not Ready"].includes(audit.auditStatus)).length;
  const openCount = allProjects.filter(activeProject).length;
  const awayToday = new Set(state.leaves.filter((leave) => leaveCoversDate(leave, today)).map((leave) => leave.assignee)).size;
  const leaveThisWeek = new Set(state.leaves.filter((leave) => leave.startDate <= localDate(limit) && leave.endDate >= today).map((leave) => leave.assignee)).size;
  const metrics = [
    ["Open projects", openCount, `${allProjects.length} local + Workfront projects`, "accent-blue"],
    ["Due this week", upcoming, overdue ? `${overdue} overdue` : "Across active work", overdue ? "accent-orange" : "accent-green"],
    ["Hours logged today", `${todayHours.toFixed(1)}h`, `${allLogs.filter((entry) => entry.date === today).length} team updates`, "accent-blue"],
    ["Audits needing attention", attention, "Failed or not ready", attention ? "accent-red" : "accent-green"],
    ["Team leave", awayToday ? `${awayToday} away` : "No one away", `${leaveThisWeek} team member${leaveThisWeek === 1 ? "" : "s"} away this week`, awayToday ? "accent-orange" : "accent-green"]
  ];
  $("#metric-grid").innerHTML = [
    metricCard(metrics[0], state.workfrontProjects.length ? "workfront" : "projects", "open"),
    metricCard(metrics[1], state.workfrontProjects.length ? "workfront" : "projects", "due-week"),
    metricCard(metrics[2], state.roleCapabilities.viewManagerReports ? "team-utilization" : "worklog", state.roleCapabilities.viewManagerReports ? "today-logged" : "personal-logs"),
    metricCard(metrics[3], "audits", "attention", "", state.roleCapabilities.viewAudits),
    metricCard(metrics[4], "leaves", "today")
  ].join("");

  const priority = [...allProjects].filter((project) => PRIORITY_PROJECT_STATUSES.test(project.status || project.sourceStatus || "")).sort((a, b) => {
    const priorityRank = (item) => {
      const priority = normalizeWorkfrontStatus(workfrontProjectPriority(item));
      const rank = ["urgent", "high", "normal", "low", "none"].indexOf(priority);
      return rank < 0 ? (item.requestType === "Rush" ? 0 : 2) : rank;
    };
    return priorityRank(a) - priorityRank(b) || (a.dueDate || "9999").localeCompare(b.dueDate || "9999");
  }).slice(0, 7);
  $("#priority-projects").innerHTML = priority.length ? `<table><thead><tr><th>Project</th><th>Project priority</th><th>Status</th><th>Material expected</th><th>Completion</th></tr></thead><tbody>${priority.map((project) => {
    const isGdBannerOverdue = gdBannerOverdueRefs.has(normalizeWorkfrontStatus(project.ref));
    return `<tr><td>${project.source === "workfront" ? workfrontProjectLink(project, `${project.ref} · ${project.title}`) : escapeHTML(`${project.ref} · ${project.title}`)}</td><td>${escapeHTML(workfrontProjectPriority(project) || "Not provided")}</td><td>${badge(project.status || project.sourceStatus || "Unavailable")}${isGdBannerOverdue ? '<small class="risk-tag gd-banner-overdue-tag">Overdue · GD Banner rule</small>' : ""}</td><td>${dateWithHoliday(project.materialExpectedDate)}</td><td>${dateWithHoliday(project.dueDate)}</td></tr>`;
  }).join("")}</tbody></table>` : emptyState("No accessible projects", "Run Workfront sync or add a local project.");

  const workload = state.operations ? state.operations.resources.map((member) => ({ name: member.name, projects: member.taskCount, effort: member.remainingHours, leaveToday: member.away, unknown: member.unknownTasks })) : state.team.map((member) => {
    const active = state.projects.filter((project) => isOpen(project) && project.assignee === member.name);
    const leaveToday = state.leaves.some((leave) => leave.assignee === member.name && leaveCoversDate(leave, today));
    return { name: member.name, projects: active.length, effort: active.reduce((sum, project) => sum + projectEffort(project), 0), leaveToday };
  }).sort((a, b) => b.effort - a.effort || a.name.localeCompare(b.name));
  const maxEffort = Math.max(1, ...workload.map((item) => item.effort));
  $("#team-workload").innerHTML = workload.length ? workload.slice(0, 8).map((item) => `
    <button type="button" class="workload-row workload-row-action" data-go="gantt"><span class="workload-name" title="${escapeHTML(item.name)}">${escapeHTML(item.name)}${item.leaveToday ? '<small class="leave-today">Away today</small>' : ""}</span><span class="workload-bar"><span style="width:${Math.min(100, item.effort / maxEffort * 100)}%"></span></span><span class="workload-meta">${item.effort.toFixed(1)}h · ${item.projects}${item.unknown ? " · unknown effort" : ""}</span></button>
  `).join("") : emptyState("No team members", "Add team members to see workload.");

  const recentAudits = [...state.audits].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);
  $("#recent-audits").innerHTML = recentAudits.length ? recentAudits.map((audit) => `
    <button type="button" class="compact-item compact-item-action" data-drill-view="audits" data-drill-key="reference" data-drill-value="${escapeHTML(audit.projectRef)}" data-drill-label="${escapeHTML(`${audit.projectRef} audit records`)}"><span><strong>${escapeHTML(audit.projectRef)} · ${escapeHTML(audit.auditType)}</strong><small>${escapeHTML(audit.auditor)} · ${dateLabel(audit.createdAt.slice(0, 10))}</small></span><span class="compact-meta">${badge(audit.auditStatus)}</span></button>
  `).join("") : emptyState("No audits recorded", "Pre-audit and final checks will appear here.");
  const recentWork = [...state.workLogs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);
  if (!$("#recent-worklogs")) {
    const panel = document.createElement("section");
    panel.className = "panel";
    panel.innerHTML = '<div class="panel-heading"><div><h2>Recent work updates</h2><p class="muted">Latest progress and time logs</p></div></div><div id="recent-worklogs" class="compact-list"></div>';
    $(".dashboard-grid").append(panel);
  }
  $("#recent-worklogs").innerHTML = recentWork.length ? recentWork.map((entry) => `
    <button type="button" class="compact-item compact-item-action" data-drill-view="projects" data-drill-key="reference" data-drill-value="${escapeHTML(entry.projectRef)}" data-drill-label="${escapeHTML(`${entry.projectRef} project`)}"><span><strong>${escapeHTML(entry.projectRef)} · ${escapeHTML(entry.phase)}</strong><small>${escapeHTML(entry.userName)} · ${dateLabel(entry.date)}</small></span><span class="compact-meta"><strong>${Number(entry.hours).toFixed(1)}h</strong><small>${Number(entry.progress)}%</small></span></button>
  `).join("") : emptyState("No work logged", "Team progress updates will appear here.");
}

function projectTable(projects, showActions = true) {
  return `<div class="table-wrap"><table><thead><tr><th>Project</th><th>Designer</th><th>Type</th><th>Progress</th><th>Due date</th><th>Status</th>${showActions ? "<th>Actions</th>" : ""}</tr></thead><tbody>${projects.map((project) => `
    <tr>
      <td class="project-title-cell"><strong title="${escapeHTML(project.title)}">${escapeHTML(project.title)}</strong><small class="ref-cell">${escapeHTML(project.ref)}${project.market ? ` · ${escapeHTML(project.market)}` : ""}</small>${workfrontPriorityLabel(project)}</td>
      <td class="assignee-cell">${escapeHTML(project.assignee)}</td>
      <td><span class="type-pill">${escapeHTML(project.taskType)}</span></td>
      <td class="progress-cell"><div class="progress-caption"><span>${Number(project.progress)}%</span><span>${projectEffort(project).toFixed(1)}h planned</span></div><div class="progress-track"><div class="progress-fill" style="width:${Math.max(0, Math.min(100, Number(project.progress)))}%"></div></div></td>
      <td class="${isOpen(project) && project.dueDate < localDate() ? "overdue" : ""}">${dateWithHoliday(project.dueDate)}${linkedMaterialLabel(project)}</td>
      <td>${badge(project.status)}</td>
      ${showActions ? `<td><div class="row-actions">${state.roleCapabilities.manageProjects ? `<button class="mini-button" data-action="edit-project" data-id="${escapeHTML(project.id)}">Edit</button>${isOpen(project) ? `<button class="mini-button" data-action="open-allocation" data-id="${escapeHTML(project.id)}">Assign</button>` : ""}` : state.roleCapabilities.selfAssign && !project.assignee && isOpen(project) ? `<button class="mini-button" data-action="claim-task" data-id="${escapeHTML(project.id)}">Self-assign</button>` : ""}${isOpen(project) && (project.assignee === state.user.name || state.roleCapabilities.manageProjects) ? `<button class="mini-button" data-action="log-work" data-id="${escapeHTML(project.id)}">Log work</button>` : ""}</div></td>` : ""}
    </tr>`).join("")}</tbody></table></div>`;
}

function renderProjects() {
  const query = $("#project-search").value.trim().toLowerCase();
  const status = $("#status-filter").value;
  const assignee = $("#assignee-filter").value;
  const drill = state.drill?.view === "projects" ? state.drill : null;
  const today = localDate();
  const weekLimit = new Date(`${today}T00:00:00`);
  weekLimit.setDate(weekLimit.getDate() + 7);
  const weekEnd = localDate(weekLimit);
  renderDrillNotice("#projects-drill-notice", "projects");
  const filtered = [...state.projects].filter((project) => {
    const searchable = `${project.ref} ${project.title} ${project.assignee} ${project.market} ${project.taskType}`.toLowerCase();
    let matchesDrill = true;
    if (drill?.key === "open") matchesDrill = isOpen(project);
    if (drill?.key === "due-week") matchesDrill = isOpen(project) && project.dueDate >= today && project.dueDate <= weekEnd;
    if (drill?.key === "overdue") matchesDrill = isOpen(project) && project.dueDate && project.dueDate < today;
    if (drill?.key === "completed") matchesDrill = project.status === "Completed";
    if (drill?.key === "active-by-me") matchesDrill = isOpen(project) && project.assignee === state.user.name;
    if (drill?.key === "assignee") matchesDrill = project.assignee === drill.value;
    if (drill?.key === "department") matchesDrill = project.productionTeamId === drill.value;
    if (drill?.key === "reference") matchesDrill = project.ref.toLowerCase() === drill.value.toLowerCase();
    return matchesDrill && (!query || searchable.includes(query)) && (!status || project.status === status) && (!assignee || project.assignee === assignee);
  }).sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
  $("#projects-table").innerHTML = filtered.length ? projectTable(filtered) : emptyState("No matching projects", "Adjust the filters or add a project.");
}

function renderAudits() {
  renderAuditSlaQueues();
  const query = $("#audit-search").value.trim().toLowerCase();
  const type = $("#audit-type-filter").value;
  const status = $("#audit-status-filter").value;
  const drill = state.drill?.view === "audits" ? state.drill : null;
  renderDrillNotice("#audits-drill-notice", "audits");
  const audits = [...state.audits].filter((audit) => {
    const searchable = [audit.projectRef, audit.projectName, audit.auditor, audit.observations, audit.dependencies].join(" ").toLowerCase();
    let matchesDrill = true;
    if (drill?.key === "attention") matchesDrill = ["Fail", "Not Ready"].includes(audit.auditStatus);
    if (drill?.key === "pre-audit-open") matchesDrill = audit.auditType === "Pre-Audit" && audit.auditStatus !== "Pass";
    if (drill?.key === "audit-open") matchesDrill = audit.auditType === "Audit" && audit.auditStatus !== "Pass";
    if (drill?.key === "reference") matchesDrill = audit.projectRef.toLowerCase() === drill.value.toLowerCase();
    return matchesDrill && (!query || searchable.includes(query)) && (!type || audit.auditType === type) && (!status || audit.auditStatus === status);
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $("#audits-list").innerHTML = audits.length ? audits.map((audit) => {
    const documents = audit.documents || (audit.fileLink ? [{ name: audit.fileName || "Input document", link: audit.fileLink }] : []);
    const file = documents.length ? documents.map((document) => safeTemplateLink(document.name, document.link)).join(" · ") : "No input documents linked";
    return `<article class="audit-card">
      <div class="audit-card-top"><span class="type-pill">${escapeHTML(audit.auditType)}</span>${badge(audit.auditStatus)}</div>
      <h3><button type="button" class="record-drill-link" data-drill-view="audits" data-drill-key="reference" data-drill-value="${escapeHTML(audit.projectRef)}" data-drill-label="${escapeHTML(`${audit.projectRef} audit records`)}">${escapeHTML(audit.projectName || audit.projectRef)}</button></h3><div class="audit-ref">Project ID ${escapeHTML(audit.projectRef)}${audit.crId ? ` · ${escapeHTML(audit.crId)}` : ""}</div>
      <div class="audit-card-meta"><span>Auditor · ${escapeHTML(audit.auditor)}</span><span>Priority · ${escapeHTML(audit.priority)}</span><span>Market · ${escapeHTML(audit.market || "—")}</span><span>Channel · ${escapeHTML(audit.channel || "—")}</span><span>TAT · ${escapeHTML(audit.calculatedTat || "—")}</span><span>Source · ${escapeHTML(audit.sourceFile)}</span><span>ETA · ${dateLabel(audit.etaDate)}${audit.etaTime ? ` ${escapeHTML(audit.etaTime)}` : ""}</span>${audit.primaryDpm ? `<span>Primary DPM · ${escapeHTML(audit.primaryDpm)}</span>` : ""}${audit.backupDpm ? `<span>Backup · ${escapeHTML(audit.backupDpm)}</span>` : ""}</div>
      ${audit.observations ? `<div class="audit-notes">${escapeHTML(audit.observations)}</div>` : ""}
      ${audit.capacityEstimate ? `<div class="audit-notes">${auditCapacityLabel(audit.capacityEstimate)}</div>` : ""}
      <div class="audit-card-bottom"><span>${file}${audit.allocation ? ` · Allocated to ${escapeHTML(audit.allocation.assignee)}` : ""}</span><span>${dateLabel(audit.createdAt.slice(0, 10))}</span></div>
      ${!audit.crId && audit.auditType === "Audit" && audit.auditStatus === "Pass" && state.projects.some((project) => project.ref.toLowerCase() === audit.projectRef.toLowerCase()) ? `<div class="audit-card-bottom"><button class="mini-button" data-action="allocate-task" data-id="${escapeHTML(audit.id)}">${audit.allocation ? "Update allocation" : "Allocate task"}</button><span></span></div>` : ""}
    </article>`;
  }).join("") : emptyState("No audits found", "Record a pre-audit or final asset check.");
}

function formatSlaDuration(milliseconds) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function workfrontSourceDetails(record) {
  const changed = record.lastStatusChanged ? new Date(record.lastStatusChanged) : null;
  return `<div class="muted">${workfrontPriorityLabel(record)}<div>Material expected: ${record.materialExpectedDate ? dateWithHoliday(record.materialExpectedDate) : "Not provided"}${record.taskName && record.materialExpectedDate ? ` (${escapeHTML(record.materialDateSource || "source not recorded")})` : ""}</div>${record.taskName ? `<div>Delegations: ${escapeHTML(record.delegations || (record.detailSyncedAt ? "None reported" : "Not checked yet"))}</div><div>Pending since status change: ${changed && !Number.isNaN(changed.getTime()) ? escapeHTML(formatPendingAge(changed)) : "Unavailable in loaded activity"}</div>` : ""}<div title="${escapeHTML(record.latestSystemActivityDate || "")}">Latest system activity: ${escapeHTML(record.latestSystemActivity || "Not available")}</div><div>Details checked: ${record.detailSyncedAt ? escapeHTML(new Date(record.detailSyncedAt).toLocaleString()) : "Not checked yet"}</div></div>`;
}

function workfrontTaskIsAssigned(task) {
  if (Array.isArray(task.assignmentNames)) return task.assignmentNames.length > 0;
  return Boolean(String(task.assignees || "").trim()) && normalizeWorkfrontStatus(task.assignees) !== "unassigned";
}

function linkedMaterialLabel(project) {
  const source = state.workfrontProjects.find((item) => normalizeWorkfrontStatus(item.ref) === normalizeWorkfrontStatus(project?.ref));
  return `<small>Material expected: ${source?.materialExpectedDate ? `${dateWithHoliday(source.materialExpectedDate)} (Workfront project)` : "No source date available"}</small>`;
}

function renderAuditSlaQueues() {
  const renderQueue = (projects, holdHours, action, emptyMessage) => projects.length
    ? projects.map((project) => {
      const updateTimestamp = project.lastUpdateDate || project.lastStatusChanged;
      const updateLabel = project.lastUpdateDate ? "Last update" : "Last status change";
      const updated = updateTimestamp ? new Date(updateTimestamp) : null;
      const hasUpdate = updated && !Number.isNaN(updated.getTime());
      const elapsed = hasUpdate ? Math.max(0, Date.now() - updated.getTime()) : 0;
      const overdue = hasUpdate && elapsed > holdHours * 60 * 60 * 1000;
      const slaText = !hasUpdate ? "Last status change unavailable" : overdue
        ? `Overdue by ${formatSlaDuration(elapsed - holdHours * 60 * 60 * 1000)}`
        : `${formatSlaDuration(holdHours * 60 * 60 * 1000 - elapsed)} remaining`;
      const actionButton = state.roleCapabilities.manageAudits
        ? `<button type="button" class="mini-button" data-action="${action}" ${action === "quick-audit" ? `data-workfront-id="${escapeHTML(project.workfrontId)}"` : `data-ref="${escapeHTML(project.ref)}"`}>${action === "quick-preaudit" ? "Start pre-audit" : "Start asset audit"}</button>`
        : `<span class="muted">Read only</span>`;
      return `<article class="audit-sla-card ${overdue ? "overdue" : ""}"><div class="audit-sla-project">${workfrontProjectLink(project, `${project.ref} · ${project.title}`)}<small>${escapeHTML(project.sourceStatus || "Unknown")} · ${escapeHTML(project.channel || project.assetType || "—")}</small>${workfrontPriorityLabel(project)}</div><div class="audit-sla-age"><span class="${overdue ? "overdue-label" : ""}">${escapeHTML(slaText)}</span><small>${hasUpdate ? `${updateLabel} ${escapeHTML(updated.toLocaleString())} · ${formatPendingAge(updated)} elapsed` : "Update the Workfront record to calculate hold time"}</small></div>${actionButton}</article>`;
    }).join("")
    : emptyState("Queue clear", emptyMessage);
  const preAudit = state.workfrontProjects.filter((project) => project.productionStage === "Awaiting Audit"
    && normalizeWorkfrontStatus(project.sourceStatus) === "pre-audit" && !isClientBlockedWorkfrontProject(project));
  const currentAssets = state.workfrontProjects.filter((project) => project.productionStage === "Awaiting Audit"
    && normalizeWorkfrontStatus(project.sourceStatus) === "current" && !isClientBlockedWorkfrontProject(project));
  $("#audit-preaudit-queue").innerHTML = renderQueue(preAudit, 24, "quick-preaudit", "No imported projects are awaiting pre-audit.");
  $("#audit-current-queue").innerHTML = renderQueue(currentAssets, 4, "quick-current-audit", "No Current assets are awaiting audit.");
}

function renderChangeRounds() {
  const rounds = [...state.changeRounds].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $("#change-rounds-list").innerHTML = rounds.length ? rounds.map((round) => `
    <article class="change-round-row">
      <div><strong>${escapeHTML(round.crId)}</strong><small>${escapeHTML(round.complexity)} complexity</small></div>
      <div><strong>${escapeHTML(round.projectTitle)}</strong><small>Project ID ${escapeHTML(round.projectRef)}</small></div>
      <div><strong>Landed</strong><small>${dateLabel(round.landedDate)} ${escapeHTML(round.landedTime)}</small></div>
      <div class="cr-eta"><strong>Capacity ETA</strong><small>${dateLabel(round.capacityEtaDate || round.etaDate)} ${escapeHTML(round.capacityEtaTime || round.etaTime)}</small></div>
      <div><strong>Scheduled</strong><small>${escapeHTML(round.task?.assignee || state.tasks.find((task) => task.id === round.taskId)?.assignee || "Unassigned")}</small></div>
      <div><strong>Recorded by</strong><small>${escapeHTML(round.createdBy)}</small></div>
    </article>`).join("") : emptyState("No change rounds recorded", "Add a CR to calculate its business-day ETA.");
}

function renderTeam() {
  const totalOpen = state.projects.filter((project) => isOpen(project) && (state.roleCapabilities.manageProjects || project.assignee === state.user.name)).length;
  const allHours = state.performance?.hours ?? state.workLogs.reduce((sum, entry) => sum + Number(entry.hours || 0), 0);
  const completed = state.projects.filter((project) => project.status === "Completed").length;
  $("#team-summary").innerHTML = [
    ["Team members", state.team.length, "Available for assignments", "accent-blue"],
    [state.roleCapabilities.manageProjects ? "Open assignments" : "My open assignments", totalOpen, state.roleCapabilities.manageProjects ? "Across all team members" : "Excludes unassigned tasks available to claim", "accent-orange"],
    ["Hours logged", `${allHours.toFixed(1)}h`, `${completed} projects completed`, "accent-green"]
  ].map((metric, index) => metricCard(
    metric,
    index === 0 ? "team" : index === 1 ? "projects" : state.roleCapabilities.viewManagerReports ? "team-utilization" : "worklog",
    index === 0 ? "members" : index === 1 ? "open" : state.roleCapabilities.viewManagerReports ? "all-time-logged" : "personal-logs"
  )).join("");
  renderDrillNotice("#team-drill-notice", "team");
  $("#department-cards").innerHTML = (state.departments || []).map((department) => {
    const members = state.team.filter((member) => (member.teamIds || []).includes(department.id));
    return `<button type="button" class="department-card department-card-action" data-drill-view="projects" data-drill-key="department" data-drill-value="${escapeHTML(department.id)}" data-drill-label="${escapeHTML(`${department.name} projects`)}"><span class="department-card-heading"><strong>${escapeHTML(department.name)}</strong><span>${members.length} member${members.length === 1 ? "" : "s"}</span></span><small>${department.assetTypes.map(escapeHTML).join(" · ")}</small>${department.id === "qa" ? '<small class="qa-department-note">QA membership can view all production departments.</small>' : ""}</button>`;
  }).join("");
  $("#team-list").innerHTML = state.team.length ? state.team.map((member) => {
    const active = state.projects.filter((project) => isOpen(project) && project.assignee === member.name);
    const shift = `${member.shiftStart || "12:30"}|${member.shiftEnd || "21:30"}`;
    const shifts = [
      ["11:30|20:30", "11:30 AM–8:30 PM"],
      ["12:30|21:30", "12:30 PM–9:30 PM"],
      ["11:30|21:30", "11:30 AM–9:30 PM"]
    ];
    const shiftSelect = state.roleCapabilities.manageWorkspace ? `<label class="team-shift">Shift<select aria-label="Shift for ${escapeHTML(member.name)}" data-team-shift="${escapeHTML(member.id)}">${shifts.map(([value, label]) => `<option value="${value}" ${shift === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>` : `<small>${escapeHTML(shifts.find(([value]) => value === shift)?.[1] || shift)} shift</small>`;
    const account = state.users.find((user) => user.name.toLowerCase() === member.name.toLowerCase());
    const teamSelect = state.roleCapabilities.manageWorkspace
      ? `<label class="team-departments">Team / Dept<select multiple size="3" data-team-departments="${escapeHTML(member.id)}">${(state.departments || []).map((department) => `<option value="${escapeHTML(department.id)}" ${(member.teamIds || []).includes(department.id) ? "selected" : ""}>${escapeHTML(department.name)}</option>`).join("")}</select></label>`
      : `<small class="team-membership">${(member.teamIds || []).map((id) => state.departments.find((department) => department.id === id)?.name).filter(Boolean).map(escapeHTML).join(", ") || "No department assigned"}</small>`;
    const workfrontIds = (member.workfrontIds || []).join(", ");
    const workfrontField = state.roleCapabilities.manageWorkspace
      ? `<label class="team-workfront">Workfront ID / name<input type="text" maxlength="600" list="workfront-assignee-options" placeholder="Auto-matched by name" aria-label="Workfront ID or name for ${escapeHTML(member.name)}" data-team-workfront="${escapeHTML(member.id)}" value="${escapeHTML(workfrontIds)}"></label>`
      : workfrontIds ? `<small class="team-membership">Workfront: ${escapeHTML(workfrontIds)}</small>` : "";
    const emailField = state.roleCapabilities.manageWorkspace
      ? `<label class="team-workfront">WPP Production email<input type="email" maxlength="254" placeholder="member@wppproduction.com" aria-label="WPP Production email for ${escapeHTML(member.name)}" data-team-email="${escapeHTML(member.id)}" value="${escapeHTML(member.wppProductionEmail || "")}"></label>`
      : `<small class="team-membership">WPP Production: ${escapeHTML(member.wppProductionEmail || "Not set")}</small>`;
    const executorField = state.roleCapabilities.manageWorkspace && account?.role === "auditor"
      ? `<label class="team-workfront"><span>Also an executor</span><input type="checkbox" aria-label="Count ${escapeHTML(member.name)} as an executor in Quality, FTR and KPI reports" data-team-report-executor="${escapeHTML(member.id)}" ${member.reportExecutor ? "checked" : ""}><small>Quality, FTR and KPI only; not Capacity</small></label>`
      : account?.role === "auditor" && member.reportExecutor ? `<small class="team-membership">Also an executor (Quality / FTR / KPI)</small>` : "";
    return `<div class="team-person"><div class="avatar">${escapeHTML(member.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase())}</div><div class="team-person-info"><button type="button" class="team-person-drill" data-drill-view="projects" data-drill-key="assignee" data-drill-value="${escapeHTML(member.name)}" data-drill-label="${escapeHTML(`${member.name} projects`)}">${escapeHTML(member.name)}</button><small>${escapeHTML(ROLE_LABELS[account?.role || member.role] || (account || member.role ? account?.role || member.role : "No login"))} · ${active.length} active project${active.length === 1 ? "" : "s"}</small></div>${teamSelect}${workfrontField}${emailField}${executorField}${shiftSelect}<span class="team-effort">${active.reduce((sum, project) => sum + projectEffort(project), 0).toFixed(1)}h</span></div>`;
  }).join("") : emptyState("No team members yet", "Add designers to assign projects.");
  const unmapped = state.roleCapabilities.manageWorkspace ? state.unmappedWorkfrontAssignees || [] : [];
  $("#workfront-assignee-options").innerHTML = unmapped.map((name) => `<option value="${escapeHTML(name)}"></option>`).join("");
  $("#workfront-mapping-note").classList.toggle("hidden", !unmapped.length);
  $("#workfront-mapping-note").textContent = unmapped.length
    ? `${unmapped.length} Workfront assignee name${unmapped.length === 1 ? " is" : "s are"} not matched to a team member: ${unmapped.join(", ")}. Add the Workfront ID / name to a member to map their Build, CR, Bug Fixing and QA tasks.`
    : "";
  $("#accounts-list").innerHTML = state.users.length ? state.users.map((user) => {
    const departments = (user.teamIds || []).map((id) => state.departments.find((department) => department.id === id)?.name).filter(Boolean);
    const scope = user.role === "manager" ? "All departments · Admin" : user.role === "leadership" ? "All departments · Read only" : departments.join(", ") || "No department assigned";
    return `<div class="account-item"><span><strong>${escapeHTML(user.name)}</strong> <small>@${escapeHTML(user.username)} · ${escapeHTML(scope)}</small></span><div class="account-access"><select aria-label="Role for ${escapeHTML(user.name)}" data-account-role="${escapeHTML(user.id)}"><option value="executioner" ${user.role === "executioner" ? "selected" : ""}>Executioner / Designer</option><option value="auditor" ${user.role === "auditor" ? "selected" : ""}>Auditor</option><option value="teamManager" ${user.role === "teamManager" ? "selected" : ""}>Team Manager</option><option value="manager" ${user.role === "manager" ? "selected" : ""}>Manager · Admin</option><option value="leadership" ${user.role === "leadership" ? "selected" : ""}>Leadership · Read-only</option></select><button class="mini-button" type="button" data-save-account-role="${escapeHTML(user.id)}">Save access</button></div></div>`;
  }).join("") : "";
}

function renderAht() {
  renderWorkLogView();
  if (!state.roleCapabilities.viewAht) return;
  if (!state.aht) return;
  $("#aht-summary").innerHTML = [
    ["Team average", `${state.aht.teamAverage.toFixed(2)}h / unit`, state.aht.completedUnits ? `${state.aht.completedUnits} completed units · ${state.aht.loggedHours}h logged` : "No completed work history yet", "accent-blue"],
    ["Completed projects", state.aht.completedProjects, "Used to calculate observed AHT", "accent-green"],
    ["Fallback estimate", `${state.aht.baselineHoursPerUnit.toFixed(1)}h / unit`, state.aht.completedUnits ? "Team-wide actual average for task types with no history" : "Transparent starter baseline until hours are logged", "accent-orange"]
  ].map((metric, index) => metricCard(metric, index === 1 ? "projects" : "aht", index === 1 ? "completed" : "matrix")).join("");
  renderDrillNotice("#aht-drill-notice", "aht");
  const matrix = state.aht.validationMatrix;
  const canEdit = state.roleCapabilities.manageWorkspace;
  const groupedRows = new Map();
  for (const row of [...matrix.records, ...matrix.addOns]) {
    if (!groupedRows.has(row.channel)) groupedRows.set(row.channel, []);
    groupedRows.get(row.channel).push(row);
  }
  const groups = [...groupedRows].map(([channel, rows], groupIndex) => {
    const body = rows.map((row) => {
      const rowLabel = `${row.requestType} ${row.complexity || row.additionalLabel || ""} ${row.unitLabel || ""}`.trim();
      const timingCells = AHT_MATRIX_EDITABLE_FIELDS.map(([field, label]) => {
        const hours = Number(row[field] || 0) / 60;
        const cell = canEdit
          ? `<input class="aht-matrix-input" type="number" min="0" max="1000" step="0.05" value="${hours.toFixed(2)}" data-aht-row="${row.rowNumber}" data-aht-field="${field}" aria-label="${escapeHTML(`${channel} ${rowLabel} ${label} hours`)}">`
          : `<span>${hours.toFixed(2)}h</span>`;
        return `<td>${cell}</td>`;
      }).join("");
      const notes = canEdit
        ? `<input class="aht-matrix-note" type="text" maxlength="2000" value="${escapeHTML(row.notes || "")}" data-aht-row="${row.rowNumber}" data-aht-field="notes" aria-label="${escapeHTML(`${channel} ${rowLabel} notes`)}">`
        : escapeHTML(row.notes || "");
      return `<tr><td><strong>${escapeHTML(row.requestType)}</strong><small>${escapeHTML(row.complexity || row.additionalLabel || "Additional unit")} · ${escapeHTML(row.unitLabel || "")}</small></td>${timingCells}<td><strong>${Number(row.overallHours || 0).toFixed(2)}h</strong></td><td>${notes}</td></tr>`;
    }).join("");
    const addOnCount = rows.filter((row) => row.additionalLabel).length;
    return `<details class="aht-channel-group" ${groupIndex === 0 ? "open" : ""}><summary><strong>${escapeHTML(channel)}</strong><span>${rows.length - addOnCount} base rows${addOnCount ? ` · ${addOnCount} add-on${addOnCount === 1 ? "" : "s"}` : ""}</span></summary><div class="table-wrap"><table class="aht-matrix-table"><thead><tr><th>Request / complexity / units</th>${AHT_MATRIX_EDITABLE_FIELDS.map(([, label]) => `<th>${escapeHTML(label)} h</th>`).join("")}<th>Overall</th><th>Notes</th></tr></thead><tbody>${body}</tbody></table></div></details>`;
  }).join("");
  $("#aht-matrix-save").classList.toggle("hidden", !canEdit);
  $("#aht-validation-matrix").innerHTML = groups;
}

async function saveAhtMatrix() {
  if (!state.roleCapabilities.manageWorkspace) return;
  const sourceRows = new Map(
    [...state.aht.validationMatrix.records, ...state.aht.validationMatrix.addOns].map((row) => [String(row.rowNumber), row])
  );
  const overrides = {};
  for (const input of $$("#aht-validation-matrix [data-aht-row][data-aht-field]")) {
    const { ahtRow, ahtField } = input.dataset;
    const source = sourceRows.get(ahtRow);
    if (!source) continue;
    let value;
    if (ahtField === "notes") {
      value = input.value.trim();
      if (value !== String(source.notes || "")) (overrides[ahtRow] ||= {})[ahtField] = value;
      continue;
    }
    const hours = Number(input.value);
    if (!Number.isFinite(hours) || hours < 0 || hours > 1000) {
      input.focus();
      showToast("AHT values must be between 0 and 1,000 hours.", true);
      return;
    }
    value = hours * 60;
    if (Math.abs(value - Number(source[ahtField] || 0)) > 0.001) (overrides[ahtRow] ||= {})[ahtField] = value;
  }
  if (!Object.keys(overrides).length) {
    showToast("No AHT matrix changes to save.");
    return;
  }
  const button = $("#aht-matrix-save");
  button.disabled = true;
  try {
    await api("/api/aht-matrix", { method: "PUT", body: JSON.stringify({ overrides }) });
    await refreshData();
    showToast("AHT planning matrix saved.");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

function renderWorkLogView() {
  $("#personal-log-panel").classList.toggle("hidden", state.roleCapabilities.viewAht);
  if (!state.roleCapabilities.viewAht) renderPersonalTaskLogs();
}

function renderPersonalTaskLogs() {
  const period = $("#personal-log-period").value || "day";
  const grouped = new Map();
  for (const log of [...state.workLogs, ...(state.sourceWorkLogs || [])]) {
    const date = new Date(`${log.date}T00:00:00`);
    let key = log.date;
    if (period === "week") {
      date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      key = `Week of ${localDate(date)}`;
    } else if (period === "month") key = log.date.slice(0, 7);
    else if (period === "year") key = log.date.slice(0, 4);
    const group = grouped.get(key) || { key, hours: 0, entries: 0, tasks: new Set() };
    group.hours += Number(log.hours || 0);
    group.entries += 1;
    group.tasks.add(`${log.taskCategory || "Build"} ${log.crId || log.projectRef}`);
    grouped.set(key, group);
  }
  const rows = [...grouped.values()].sort((a, b) => b.key.localeCompare(a.key));
  $("#personal-log-table").innerHTML = rows.length
    ? `<table><thead><tr><th>Period</th><th>Logged hours</th><th>Entries</th><th>Tasks</th></tr></thead><tbody>${rows.map((group) => `<tr><td>${escapeHTML(group.key)}</td><td>${group.hours.toFixed(1)}h</td><td>${group.entries}</td><td>${escapeHTML([...group.tasks].join(", "))}</td></tr>`).join("")}</tbody></table>`
    : emptyState("No task time logged", "Your daily, weekly, monthly and yearly totals will appear here.");
}

function leaveCoversDate(leave, date) {
  return leave.startDate <= date && date <= leave.endDate;
}

function holidayDateConflicts(date) {
  const open = (project) => !/^(completed?|archived|cancell?ed|closed)$/i.test(String(project.status || project.sourceStatus || "").trim());
  const seen = new Set();
  return [...(state.workfrontProjects || []), ...(state.projects || [])].filter(open).flatMap((project) => {
    const kinds = [project.dueDate === date ? "Delivery" : "", String(project.materialExpectedDate || "").slice(0, 10) === date ? "Material expected" : ""].filter(Boolean);
    const key = normalizeWorkfrontStatus(project.ref || project.id);
    if (!kinds.length || seen.has(key)) return [];
    seen.add(key);
    return [{ project, kinds }];
  });
}

function renderHolidays() {
  const target = $("#holiday-calendar");
  if (!target) return;
  const today = localDate();
  const canEdit = state.roleCapabilities.manageHolidays;
  const holidays = [...(state.holidays || [])].sort((a, b) => a.date.localeCompare(b.date));
  target.innerHTML = holidays.length ? `<table><thead><tr><th>Holiday</th><th>Date</th><th>Next working day</th><th>Projects with delivery / material date on this holiday</th>${canEdit ? "<th></th>" : ""}</tr></thead><tbody>${holidays.map((holiday) => {
    const conflicts = holidayDateConflicts(holiday.date);
    const list = conflicts.length ? `<div class="holiday-conflicts">${conflicts.slice(0, 12).map(({ project, kinds }) => `<span class="holiday-flag">${project.source === "workfront" || project.workfrontId ? workfrontProjectLink(project, project.ref) : escapeHTML(project.ref || project.title)} · ${escapeHTML(kinds.join(" + "))}</span>`).join("")}${conflicts.length > 12 ? `<span class="muted">+${conflicts.length - 12} more</span>` : ""}</div>` : '<span class="muted">None</span>';
    return `<tr class="${holiday.date < today ? "holiday-past" : ""}"><td><strong>${escapeHTML(holiday.name || "Holiday")}</strong></td><td>${escapeHTML(briefingDateLabel(holiday.date, true))}</td><td>${escapeHTML(briefingDateLabel(nextBriefingDays(holiday.date, 1)[0]))}</td><td>${list}</td>${canEdit ? `<td><button type="button" class="text-button" data-delete-holiday="${escapeHTML(holiday.date)}" aria-label="Remove ${escapeHTML(holiday.name || holiday.date)}">Remove</button></td>` : ""}</tr>`;
  }).join("")}</tbody></table>` : emptyState("No holidays configured", canEdit ? "Add business holidays so capacity and delivery dates skip them." : "A Manager or Team Manager can add business holidays.");
}

async function saveHolidays(holidays, message) {
  try {
    const result = await api("/api/holidays", { method: "PUT", body: JSON.stringify({ holidays }) });
    state.holidays = result.holidays;
    renderAll();
    showToast(message);
    return true;
  } catch (error) {
    showToast(error.message, true);
    return false;
  }
}

function renderLeaves() {
  const today = localDate();
  const allLeaves = [...state.leaves].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.assignee.localeCompare(b.assignee));
  const approved = allLeaves.filter((leave) => leave.status === "Approved");
  const pending = allLeaves.filter((leave) => leave.status === "Pending");
  const awayToday = new Set(approved.filter((leave) => leaveCoversDate(leave, today)).map((leave) => leave.assignee)).size;
  const upcoming = approved.filter((leave) => leave.endDate >= today).length;
  const shifted = approved.reduce((sum, leave) => sum + (leave.impacts || []).filter((impact) => impact.beforeStartDate !== impact.afterStartDate || impact.beforeEtaDate !== impact.afterEtaDate).length, 0);
  $("#leave-summary").innerHTML = [
    ["Away today", awayToday, "Approved leave only", awayToday ? "accent-orange" : "accent-green"],
    ["Upcoming approved leave", upcoming, "Pending requests do not reduce capacity", "accent-blue"],
    [state.roleCapabilities.manageTeamLeave ? "Awaiting approval" : "My pending requests", state.roleCapabilities.manageTeamLeave ? pending.length : pending.filter((leave) => leave.assignee === state.user.name).length, `${shifted} task date changes from approved leave`, pending.length ? "accent-orange" : "accent-green"]
  ].map((metric, index) => metricCard(metric, "leaves", ["today", "upcoming", "pending"][index])).join("");
  const drill = state.drill?.view === "leaves" ? state.drill : null;
  renderDrillNotice("#leaves-drill-notice", "leaves");
  const leaves = allLeaves.filter((leave) => {
    if (drill?.key === "today") return leave.status === "Approved" && leaveCoversDate(leave, today);
    if (drill?.key === "upcoming") return leave.status === "Approved" && leave.endDate >= today;
    if (drill?.key === "pending") return leave.status === "Pending";
    return true;
  });
  $("#leave-list").innerHTML = leaves.length
    ? `<table><thead><tr><th>Team member</th><th>Leave dates</th><th>Type / status</th><th>Schedule impact</th><th>Request note</th><th>Decision</th></tr></thead><tbody>${leaves.map((leave) => {
      const impacts = (leave.impacts || []).filter((impact) => impact.beforeStartDate !== impact.afterStartDate || impact.beforeEtaDate !== impact.afterEtaDate);
      const impactText = impacts.length
        ? impacts.map((impact) => `${escapeHTML(impact.title)}: ${dateLabel(impact.beforeStartDate)} → ${dateLabel(impact.afterStartDate)}${impact.beforeEtaDate !== impact.afterEtaDate ? ` (ETA ${dateLabel(impact.beforeEtaDate)} → ${dateLabel(impact.afterEtaDate)})` : ""}`).join("<br>")
        : leave.status === "Pending" ? "No capacity impact until approved" : "Approved; no existing task dates changed";
      const decision = state.roleCapabilities.manageTeamLeave && leave.status === "Pending"
        ? `<button type="button" class="mini-button" data-leave-decision="approve" data-leave-id="${escapeHTML(leave.id)}">Approve</button> <button type="button" class="text-button" data-leave-decision="decline" data-leave-id="${escapeHTML(leave.id)}">Decline</button>`
        : state.roleCapabilities.manageTeamLeave || leave.status === "Pending" && leave.assignee === state.user.name
          ? `<button type="button" class="text-button" data-leave-delete="${escapeHTML(leave.id)}">Cancel</button>` : leave.status === "Approved" ? `Approved${leave.approvedBy ? ` by ${escapeHTML(leave.approvedBy)}` : ""}` : leave.status === "Declined" ? `Declined${leave.decidedBy ? ` by ${escapeHTML(leave.decidedBy)}` : ""}` : "—";
      return `<tr><td><strong>${escapeHTML(leave.assignee)}</strong></td><td>${escapeHTML(dateLabel(leave.startDate))}${leave.startDate !== leave.endDate ? ` – ${escapeHTML(dateLabel(leave.endDate))}` : ""}${leave.halfDay ? `<small class="leave-impact-count">${escapeHTML(leaveDurationLabel(leave))}</small>` : ""}</td><td>${escapeHTML(leave.type)}<small class="leave-impact-count">${escapeHTML(leave.status || "Pending")}</small></td><td>${impactText}${leave.status === "Approved" && impacts.length ? `<small class="leave-impact-count">${impacts.length} task${impacts.length === 1 ? "" : "s"} rescheduled</small>` : ""}</td><td>${escapeHTML(leave.note || "—")}</td><td>${decision}</td></tr>`;
    }).join("")}</tbody></table>`
    : emptyState("No leave requests", state.roleCapabilities.manageTeamLeave ? "Team requests appear here. Pending requests do not change schedules or capacity until approved." : "Apply for leave here. Only manager-approved requests are added to the shared calendar.");
}

function renderLeaveRisk() {
  const container = $("#leave-risk-report");
  if (!container || !state.roleCapabilities.viewManagerReports) return;
  const today = localDate();
  const approvedLeaves = state.leaves.filter((leave) => leave.status === "Approved" && leave.endDate >= today);
  const projects = new Map(state.projects.map((project) => [project.id, project]));
  const riskRows = state.tasks.filter((task) => !["Completed", "Archived"].includes(task.status)).map((task) => {
    const project = projects.get(task.projectId);
    const dueDate = task.etaDate || project?.dueDate || "";
    const overdue = Boolean(dueDate && dueDate < today);
    const nearDue = Boolean(dueDate && dueDate >= today && businessDaysInRange(today, dueDate, task.assignee) <= 2);
    const criticalPriority = ["High", "Urgent"].includes(task.priority);
    const leaveMatches = approvedLeaves.filter((leave) => {
      if (leave.assignee !== task.assignee) return false;
      const impact = (leave.impacts || []).find((item) => item.taskId === task.id);
      const plannedStart = impact?.beforeStartDate || task.startDate;
      const plannedEta = impact?.beforeEtaDate || task.etaDate;
      return plannedStart && plannedEta && plannedStart <= leave.endDate && plannedEta >= leave.startDate;
    });
    const leaveOverlap = leaveMatches.length > 0;
    if (!leaveOverlap && !overdue && !nearDue && !criticalPriority) return null;
    return {
      task, project,
      leaveNames: new Set(leaveMatches.map((leave) => leave.assignee)),
      leaveRanges: leaveMatches.map((leave) => `${dateLabel(leave.startDate)} – ${dateLabel(leave.endDate)}`),
      leaveOverlap, overdue, nearDue, criticalPriority
    };
  }).filter(Boolean).sort((a, b) => {
    const aRank = Number(a.overdue) + Number(a.criticalPriority) + Number(a.leaveOverlap) + Number(a.nearDue);
    const bRank = Number(b.overdue) + Number(b.criticalPriority) + Number(b.leaveOverlap) + Number(b.nearDue);
    return bRank - aRank || String(a.task.etaDate || "").localeCompare(String(b.task.etaDate || ""));
  });
  const rowHtml = riskRows.map(({ task, project, leaveNames, leaveRanges, leaveOverlap, overdue, nearDue, criticalPriority }) => {
    const departmentId = project?.productionTeamId || "";
    const candidates = state.team.filter((member) => {
      if (member.name === task.assignee || member.role !== "executioner") return false;
      if (departmentId && departmentId !== "unassigned" && !(member.teamIds || []).includes("qa") && !(member.teamIds || []).includes(departmentId)) return false;
      return !state.leaves.some((leave) => leave.status === "Approved" && leave.assignee === member.name
        && leave.startDate <= (task.etaDate || leave.endDate) && leave.endDate >= (task.startDate || today));
    }).map((member) => {
      const open = state.tasks.filter((item) => item.assignee === member.name && !["Completed", "Archived"].includes(item.status));
      const remainingHours = open.reduce((sum, item) => sum + Math.max(0, Number(item.plannedHours || 0) - Number(item.loggedHours || 0)), 0);
      return { member, openCount: open.length, remainingHours };
    }).sort((a, b) => a.remainingHours - b.remainingHours || a.openCount - b.openCount || a.member.name.localeCompare(b.member.name));
    const recommendation = candidates[0];
    const riskLabels = [
      overdue ? "Overdue" : "",
      criticalPriority ? `${task.priority} priority` : "",
      nearDue ? "Due within 2 business days" : "",
      leaveOverlap ? "Schedule overlaps leave" : ""
    ].filter(Boolean).map((label) => `<span class="risk-tag">${escapeHTML(label)}</span>`).join(" ");
    const action = state.roleCapabilities.manageProjects && recommendation
      ? `<button type="button" class="mini-button" data-action="leave-reassign-task" data-id="${escapeHTML(task.id)}" data-assignee="${escapeHTML(recommendation.member.name)}">Reassign to ${escapeHTML(recommendation.member.name)}</button><small>${recommendation.openCount} open · ${recommendation.remainingHours.toFixed(1)}h remaining</small>`
      : recommendation ? `<span>${escapeHTML(recommendation.member.name)} · ${recommendation.remainingHours.toFixed(1)}h remaining</span>` : `<span class="muted">No eligible replacement</span>`;
    return `<tr class="leave-risk-row ${overdue || criticalPriority ? "leave-risk-critical" : ""}"><td><strong>${escapeHTML(project?.ref || task.projectRef || "—")}</strong><small>${escapeHTML(project?.title || task.title)}</small></td><td>${escapeHTML(task.category)} ${task.crId ? escapeHTML(task.crId) : ""}</td><td>${escapeHTML(task.assignee)}</td><td>${[...leaveNames].map(escapeHTML).join(", ") || "—"}<small>${[...new Set(leaveRanges)].join("<br>") || "No leave overlap"}</small></td><td>${task.etaDate ? dateLabel(task.etaDate) : "—"}<small>${riskLabels}</small></td><td>${action}</td></tr>`;
  }).join("");
  container.innerHTML = riskRows.length
    ? `<table><thead><tr><th>Project / task</th><th>Work type</th><th>Current assignee</th><th>Approved leave</th><th>Capacity ETA / risk</th><th>Eligible replacement</th></tr></thead><tbody>${rowHtml}</tbody></table>`
    : emptyState("No leave-related delivery risks", "No active assignments currently overlap approved leave or meet the overdue, high-priority, or near-due criteria.");
}

function renderWorkfront() {
  const sync = state.workfrontSync;
  const teams = Object.entries(sync?.projectDepartments || {}).map(([team, count]) => `${escapeHTML(team)} ${count}`).join(" · ") || "No department assignments yet";
  const lastSync = sync?.syncedAt ? new Date(sync.syncedAt) : null;
  const lastSyncLabel = lastSync && !Number.isNaN(lastSync.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(lastSync)
    : "Never synced";
  const automationTime = (value) => value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
    : "—";
  const projectSourceStatusCounts = workfrontSourceStatusCounts(state.workfrontProjects, "sourceStatus");
  const changeRoundSourceStatusCounts = workfrontSourceStatusCounts(state.workfrontChangeRounds, "sourceStatus");
  const taskSourceStatusCounts = workfrontSourceStatusCounts(state.workfrontTasks, "taskStatus");
  $("#workfront-summary").innerHTML = [
    ["Workfront projects", state.workfrontProjects.length, `${projectSourceStatusCounts.length} distinct source statuses · ${teams}`, "accent-blue"],
    ["Workfront change rounds", state.workfrontChangeRounds.length, `${changeRoundSourceStatusCounts.length} distinct source statuses`, "accent-green"],
    ["Workfront tasks", state.workfrontTasks.length, `${taskSourceStatusCounts.length} distinct task statuses`, "accent-purple"]
  ].map((metric, index) => metricCard(
    metric,
    "workfront",
    ["all-projects", "all-change-rounds", "all-tasks"][index]
  )).join("");
  $("#workfront-sync-details").textContent = sync
    ? `Last sync ${lastSyncLabel}: ${sync.openProjectsFile} (${sync.projectSheet}) and ${sync.changeRoundsFile} (${sync.changeRoundsSheet}). ${sync.projects.updated + sync.changeRounds.updated} imported records updated; ${sync.projects.alreadyInWorkspace + sync.changeRounds.alreadyInWorkspace} native records left untouched. ${sync.projects.excludedDeliveryCentre || 0} project rows and ${sync.changeRounds.excludedDeliveryCentre || 0} CR rows from other delivery centres excluded. ${sync.tasks?.total ?? state.workfrontTasks.length} task records are joined to project status by Project ID${sync.taskSyncedAt ? ` (last task refresh ${automationTime(sync.taskSyncedAt)})` : " (tasks are populated by automatic DOM sync)"}; project, CR, and task statuses are displayed as reported by Workfront. Task status and progress remain separate from project status. ${sync.changeRoundsWithoutProject || 0} CRs reference a project ID absent from the current project list; those CRs remain visible below.`
    : "No Workfront sync has been run yet.";
  if (sync?.projectMissingColumns?.length) {
    $("#workfront-sync-details").textContent += ` Not supplied by the project report: ${sync.projectMissingColumns.join(", ")}. Previously imported values are retained and were not refreshed; new records leave these fields unavailable.`;
  }
  const automation = state.workfrontAutomation;
  $("#workfront-dom-sync-status").textContent = automation
    ? `Automatic sync ${automation.enabled ? "enabled" : "disabled"} · ${automation.status || "idle"}${automation.status === "syncing" ? ` · ${automation.detailsTotal ? `Details checked ${automation.detailsCompleted}/${automation.detailsTotal} projects` : automation.phase || "Reading reports"}` : ""} · Last attempt ${automationTime(automation.lastAttemptAt)} · Last successful import ${automationTime(automation.lastSuccessAt)}${automation.enabled ? ` · Next attempt ${automation.status === "syncing" ? "after current sync finishes" : automationTime(automation.nextSyncAt)}` : ""}${automation.lastError ? ` · Error: ${automation.lastError}` : ""}`
    : "Automatic sync status is unavailable.";
  const login = state.workfrontLogin;
  const loginRetryAvailable = login?.status === "scrapeError";
  const loginReady = ["awaitingLogin", "windowClosed", "scrapeError"].includes(login?.status);
  const loginCanCancel = ["awaitingLogin", "windowClosed"].includes(login?.status);
  const loginBusy = login?.status === "opening";
  const loginOpen = login?.status === "awaitingLogin" || loginBusy;
  $("#workfront-login-status").textContent = login?.status === "awaitingLogin"
    ? "The Workfront sign-in browser is open on the Creative Lab host. Complete SSO/MFA in that window, then return here and scrape."
    : loginBusy
      ? "Opening the Workfront sign-in browser on the Creative Lab host…"
    : login?.status === "windowClosed"
      ? "The Workfront sign-in window was closed. If sign-in is complete, click “I'm signed in — scrape now” to continue."
      : login?.status === "signedIn"
        ? "The Workfront browser session is saved on the host. You can scrape now or enable the 15-minute schedule."
          : login?.status === "closed"
            ? "The sign-in window is closed. Workfront reports can now be scraped from the saved host profile."
          : login?.status === "cancelled"
            ? "Workfront sign-in was cancelled. Open a new sign-in window to try again."
            : login?.status === "scrapeError"
            ? `Workfront sign-in completed, but the scrape failed: ${login.lastError} Retry the scrape or open Workfront sign-in again.`
            : login?.status === "error"
              ? `Could not open the Workfront sign-in browser: ${login.lastError}`
            : "Open Workfront sign-in to authenticate with SSO/MFA in the host browser.";
  $("#workfront-login-start").classList.toggle("hidden", loginOpen || loginReady && !loginRetryAvailable);
  $("#workfront-login-start").disabled = loginBusy || automation?.status === "syncing";
  $("#workfront-login-complete").classList.toggle("hidden", !loginReady);
  $("#workfront-login-complete").textContent = loginRetryAvailable ? "Retry Workfront scrape" : "I'm signed in — scrape now";
  $("#workfront-login-complete").disabled = automation?.status === "syncing";
  $("#workfront-login-cancel").classList.toggle("hidden", !loginCanCancel);
  $("#workfront-login-cancel").disabled = automation?.status === "syncing";
  $("#workfront-dom-toggle").textContent = automation?.enabled ? "Pause automatic sync" : "Enable 15-minute sync";
  $("#workfront-dom-sync-now").disabled = automation?.status === "syncing" || loginOpen;
  $("#workfront-dom-toggle").disabled = automation?.status === "syncing";

  const projectsView = state.workfrontDataset === "projects";
  const changeRoundsView = state.workfrontDataset === "changeRounds";
  const tasksView = state.workfrontDataset === "tasks";
  const records = projectsView ? state.workfrontProjects : changeRoundsView ? state.workfrontChangeRounds : state.workfrontTasks;
  renderDrillNotice("#workfront-drill-notice", "workfront");
  $("#workfront-project-status-filter").classList.toggle("hidden", !tasksView);
  $("#workfront-search").placeholder = tasksView
    ? "Search Project ID, project, task, assignee"
    : changeRoundsView ? "Search Project ID, CR ID, name, owner" : "Search Project ID, name, owner";
  $("#workfront-status-filter").setAttribute("aria-label", tasksView ? "Filter task status" : "Filter Workfront status");
  $("#workfront-list-title").textContent = projectsView ? "All Open Projects" : changeRoundsView ? "All Change Rounds" : "Workfront Tasks";
  $("#workfront-list-hint").textContent = projectsView
    ? "Projects keyed by Workfront Reference Number."
    : changeRoundsView
      ? "CRs link to their parent using Project Ref #; CR ID comes from Name."
      : "The source report includes open tasks only; task status and progress are separate from the parent project's status and joined by Project ID. Only tasks whose parent project appears in the project report are followed here.";
  $$("[data-workfront-dataset]").forEach((button) => button.classList.toggle("active", button.dataset.workfrontDataset === state.workfrontDataset));
  const teamSelect = $("#workfront-team-filter");
  const previousTeam = teamSelect.value;
  const filterTeams = [...new Set([...state.departments.map((department) => department.name), ...records.map(workfrontRecordTeam), previousTeam].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  teamSelect.innerHTML = `<option value="">All teams</option>${filterTeams.map((team) => `<option value="${escapeHTML(team)}">${escapeHTML(team)}</option>`).join("")}`;
  teamSelect.value = previousTeam;
  const teamFilter = teamSelect.value;
  const search = $("#workfront-search").value.trim().toLowerCase();
  const statusFilter = $("#workfront-status-filter");
  const projectStatusFilter = $("#workfront-project-status-filter");
  const previousStatus = statusFilter.value;
  const previousProjectStatus = projectStatusFilter.value;
  const drill = state.drill?.view === "workfront" ? state.drill : null;
  const priorityFilter = $("#workfront-priority-filter");
  const previousPriority = priorityFilter.value;
  const priorities = [...new Set([...records.map((record) => workfrontProjectPriority(record) || "Not provided"), previousPriority].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  priorityFilter.innerHTML = `<option value="">All project priorities</option>${priorities.map((priority) => `<option value="${escapeHTML(priority)}">${escapeHTML(priority)}</option>`).join("")}`;
  priorityFilter.value = priorities.includes(previousPriority) ? previousPriority : "";
  const taskStatus = (record) => tasksView ? record.taskStatus : record.sourceStatus;
  const taskActivityByProject = workfrontTaskActivityByProject();
  const statuses = [...new Set(records.map(taskStatus).filter(Boolean))]
    .filter((status) => !projectsView || isProductionWorkfrontStatus(status))
    .sort((a, b) => a.localeCompare(b));
  statusFilter.innerHTML = `<option value="">All ${tasksView ? "task" : "source"} statuses</option>${statuses.map((status) => `<option value="${escapeHTML(status)}">${escapeHTML(status)}</option>`).join("")}`;
  if (statuses.includes(previousStatus)) statusFilter.value = previousStatus;
  const projectStatuses = [...new Set(state.workfrontTasks.map((task) => task.projectStatus).filter(Boolean))]
    .filter(isProductionWorkfrontStatus)
    .sort((a, b) => a.localeCompare(b));
  projectStatusFilter.innerHTML = `<option value="">All project statuses</option>${projectStatuses.map((status) => `<option value="${escapeHTML(status)}">${escapeHTML(status)}</option>`).join("")}`;
  if (projectStatuses.includes(previousProjectStatus)) projectStatusFilter.value = previousProjectStatus;
  const statusKey = (value) => value === null || value === undefined || value === "" ? "Unspecified" : String(value);
  const filtered = records.filter((record) => {
    if (drill?.key === "open" && (!projectsView || !OVERVIEW_PROJECT_STATUSES.test(record.sourceStatus))) return false;
    if (drill?.key === "due-week" && (!projectsView || !OVERVIEW_PROJECT_STATUSES.test(record.sourceStatus)
      || !record.dueDate || record.dueDate < localDate() || record.dueDate > localDate(new Date(Date.now() + 7 * 86400000)))) return false;
    if (drill?.key === "production-project") {
      if (!projectsView || normalizeWorkfrontStatus(record.sourceStatus) !== normalizeWorkfrontStatus(drill.value)) return false;
      if (drill.assignment === "pending" && state.workfrontTasks.some((task) =>
        normalizeWorkfrontStatus(task.projectRef) === normalizeWorkfrontStatus(record.ref)
          && normalizeWorkfrontStatus(task.projectStatus) === "awaiting execution"
          && normalizeWorkfrontStatus(task.taskStatus) === "new"
          && normalizeWorkfrontStatus(task.taskName) === "build"
          && workfrontTaskIsAssigned(task))) return false;
      if (drill.assignment === "assigned" && !state.workfrontTasks.some((task) =>
        normalizeWorkfrontStatus(task.projectRef) === normalizeWorkfrontStatus(record.ref)
          && normalizeWorkfrontStatus(task.projectStatus) === "awaiting execution"
          && normalizeWorkfrontStatus(task.taskStatus) === "new"
          && String(task.assignees || "").trim()
          && normalizeWorkfrontStatus(task.assignees) !== "unassigned")) return false;
    }
    if (drill?.key === "production-task" && (!tasksView
      || normalizeWorkfrontStatus(record.projectStatus) !== normalizeWorkfrontStatus(drill.projectStatus)
      || normalizeWorkfrontStatus(record.taskStatus) !== normalizeWorkfrontStatus(drill.taskStatus)
      || drill.taskName && normalizeWorkfrontStatus(record.taskName) !== normalizeWorkfrontStatus(drill.taskName)
      || drill.assignment === "assigned" && !workfrontTaskIsAssigned(record)
      || drill.assignment === "unassigned" && workfrontTaskIsAssigned(record))) return false;
    if (drill?.key === "project-statuses" && (!projectsView || statusKey(record.sourceStatus) !== statusKey(drill.value))) return false;
    if (drill?.key === "task-statuses" && (!tasksView || statusKey(record.taskStatus) !== statusKey(drill.value))) return false;
    if (drill?.key === "all-projects" && !projectsView) return false;
    if (drill?.key === "project-priority" && (!projectsView || !PRIORITY_PROJECT_STATUSES.test(record.sourceStatus)
      || normalizeWorkfrontStatus(workfrontProjectPriority(record) || "Not provided") !== normalizeWorkfrontStatus(drill.value))) return false;
    if (drill?.key === "all-change-rounds" && !changeRoundsView) return false;
    if (drill?.key === "all-tasks" && !tasksView) return false;
    if (drill?.key === "cr-statuses" && (!changeRoundsView || statusKey(record.sourceStatus) !== statusKey(drill.value))) return false;
    if (drill?.key === "team" && workfrontRecordTeam(record) !== drill.value) return false;
    if (drill?.key === "project-ref" && (!projectsView || String(record.ref).toLowerCase() !== drill.value.toLowerCase())) return false;
    if (teamFilter && workfrontRecordTeam(record) !== teamFilter) return false;
    if (statusFilter.value && taskStatus(record) !== statusFilter.value) return false;
    if (tasksView && projectStatusFilter.value && record.projectStatus !== projectStatusFilter.value) return false;
    if (priorityFilter.value && (workfrontProjectPriority(record) || "Not provided") !== priorityFilter.value) return false;
    const projectActivity = projectsView ? taskActivityByProject.get(normalizeWorkfrontStatus(record.ref)) : null;
    const activity = projectsView ? workfrontTaskActivityLabel(projectActivity) : "";
    return !search || [...Object.values(record), activity].some((value) => String(value ?? "").toLowerCase().includes(search));
  });
  const pageSize = 50;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  state.workfrontPage = Math.min(state.workfrontPage, pageCount);
  const pageRecords = filtered.slice((state.workfrontPage - 1) * pageSize, state.workfrontPage * pageSize);
  const teamBadge = (record) => `<span class="workfront-team-badge ${workfrontRecordTeam(record) === "Unmapped" ? "unmapped" : ""}">${escapeHTML(workfrontRecordTeam(record))}</span>`;
  const knownProjectRefs = new Set([...state.projects, ...state.workfrontProjects].map((project) => project.ref.toLowerCase()));
  const table = projectsView
    ? `<table><thead><tr><th>Project ID</th><th>Project / source updates</th><th>Channel</th><th>Delivery centre</th><th>Team</th><th>Workfront status</th><th>Workfront task statuses</th><th>Pending since status change</th><th>Country</th><th>Due</th><th>Owner</th><th>LEM</th><th></th></tr></thead><tbody>${pageRecords.map((project) => {
      const updated = project.lastStatusChanged ? new Date(project.lastStatusChanged) : null;
      const age = updated && !Number.isNaN(updated.getTime()) ? formatPendingAge(updated) : "Unknown";
      const canPreAudit = project.productionStage === "Awaiting Audit";
      const action = canPreAudit && state.roleCapabilities.manageAudits && !isClientBlockedWorkfrontProject(project) ? `<button type="button" class="mini-button" data-action="quick-preaudit" data-ref="${escapeHTML(project.ref)}">Audit now</button>` : "";
      const taskActivity = taskActivityByProject.get(normalizeWorkfrontStatus(project.ref));
      const activity = workfrontTaskActivityLabel(taskActivity);
      return `<tr><td><strong>${escapeHTML(project.ref)}</strong></td><td>${workfrontProjectLink(project)}${workfrontSourceDetails(project)}</td><td>${escapeHTML(project.channel || project.assetType || "—")}</td><td>${escapeHTML(project.deliveryCentre || "—")}</td><td>${teamBadge(project)}</td><td>${badge(project.sourceStatus || "Unknown")}</td><td>${escapeHTML(activity)}</td><td>${updated && !Number.isNaN(updated.getTime()) ? `<time datetime="${escapeHTML(updated.toISOString())}" title="${escapeHTML(updated.toLocaleString())}">${escapeHTML(age)}</time>` : "Unknown"}</td><td>${escapeHTML(project.country || "—")}</td><td>${project.dueDate ? dateWithHoliday(project.dueDate) : "—"}</td><td>${escapeHTML(project.owner || "—")}</td><td>${escapeHTML(project.lem || "—")}</td><td>${action}</td></tr>`;
    }).join("")}</tbody></table>`
    : tasksView
      ? `<table><thead><tr><th>Project ID</th><th>Project</th><th>Project status</th><th>Task / source updates</th><th>Task status</th><th>Assignments and delegations</th><th>Progress</th><th>Planned start</th><th>Due (planned completion)</th><th>Delivery centre</th><th>Team</th></tr></thead><tbody>${pageRecords.map((task) => `<tr><td><strong>${escapeHTML(task.projectRef)}</strong></td><td>${workfrontProjectLink(task, task.projectName || "—")}</td><td>${badge(task.projectStatus || "Not in project report")}</td><td>${escapeHTML(task.taskName)}${workfrontSourceDetails(task)}</td><td>${badge(task.taskStatus || "Unknown")}</td><td>${escapeHTML(task.assignees || "Unassigned")}<div class="muted">Delegated: ${escapeHTML(task.delegations || "None reported")}</div></td><td>${task.percentComplete === null || task.percentComplete === undefined ? "—" : `${escapeHTML(task.percentComplete)}%`}</td><td>${task.plannedStartDate ? dateLabel(task.plannedStartDate) : "—"}</td><td>${task.plannedCompletionDate ? dateLabel(task.plannedCompletionDate) : "—"}</td><td>${escapeHTML(task.deliveryCentre || "—")}</td><td>${teamBadge(task)}</td></tr>`).join("")}</tbody></table>`
      : `<table><thead><tr><th>CR ID</th><th>Workfront CR ref</th><th>Project ID</th><th>Parent link</th><th>Project</th><th>Channel</th><th>Delivery centre</th><th>Team</th><th>Workfront status</th><th>Complexity</th><th>Assigned to</th><th>Expected delivery</th></tr></thead><tbody>${pageRecords.map((round) => {
        const parent = state.workfrontProjects.find((project) => project.ref.toLowerCase() === round.projectRef.toLowerCase()) || round;
        return `<tr><td><strong>${escapeHTML(round.crId)}</strong></td><td>${escapeHTML(round.workfrontId)}</td><td>${escapeHTML(round.projectRef)}</td><td>${knownProjectRefs.has(round.projectRef.toLowerCase()) ? '<span class="workfront-team-badge">Linked</span>' : '<span class="workfront-parent-missing">Not in project list</span>'}</td><td>${workfrontProjectLink(parent, round.title || "—")}${workfrontPriorityLabel(round)}</td><td>${escapeHTML(round.channel || round.assetType || "—")}</td><td>${escapeHTML(round.deliveryCentre || "—")}</td><td>${teamBadge(round)}</td><td>${badge(round.sourceStatus || "Unknown")}</td><td>${escapeHTML(round.complexity || "—")}</td><td>${escapeHTML(round.assignee || "—")}</td><td>${round.expectedDeliveryDate ? dateLabel(round.expectedDeliveryDate.slice(0, 10)) : "—"}</td></tr>`;
      }).join("")}</tbody></table>`;
  $("#workfront-records").innerHTML = pageRecords.length ? table : emptyState(sync ? "No matching Workfront records" : "No Workfront reports synced", sync ? "Try a different search or filter." : "Upload the current Workfront exports or run the automatic DOM sync to populate this tab.");
  const first = filtered.length ? (state.workfrontPage - 1) * pageSize + 1 : 0;
  const last = Math.min(state.workfrontPage * pageSize, filtered.length);
  $("#workfront-pagination").innerHTML = `<span>Showing ${first}–${last} of ${filtered.length.toLocaleString()} records</span><div><button type="button" class="button secondary" data-workfront-page="${state.workfrontPage - 1}" ${state.workfrontPage <= 1 ? "disabled" : ""}>Previous</button><span>Page ${state.workfrontPage} of ${pageCount}</span><button type="button" class="button secondary" data-workfront-page="${state.workfrontPage + 1}" ${state.workfrontPage >= pageCount ? "disabled" : ""}>Next</button></div>`;
  renderWorkfrontProductionQueues();
}

function formatPendingAge(updatedAt) {
  const elapsedHours = Math.max(0, Math.floor((Date.now() - updatedAt.getTime()) / 3600000));
  const days = Math.floor(elapsedHours / 24);
  const hours = elapsedHours % 24;
  return `${days}d ${hours}h`;
}

function normalizeWorkfrontStatus(status) {
  return String(status || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function workfrontTaskActivityByProject(tasks = state.workfrontTasks) {
  const activityByProject = new Map();
  for (const task of tasks) {
    const projectRef = normalizeWorkfrontStatus(task.projectRef);
    if (!projectRef) continue;
    const activity = activityByProject.get(projectRef) || { taskCount: 0, statusCounts: new Map() };
    activity.taskCount += 1;
    const value = task.taskStatus;
    const status = value === null || value === undefined || value === "" ? "Unspecified" : String(value);
    activity.statusCounts.set(status, (activity.statusCounts.get(status) || 0) + 1);
    activityByProject.set(projectRef, activity);
  }
  return activityByProject;
}

function workfrontSourceStatusCounts(records, field) {
  const counts = new Map();
  for (const record of records) {
    const value = record[field];
    const status = value === null || value === undefined || value === "" ? "Unspecified" : String(value);
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function workfrontTaskActivityLabel(activity) {
  if (!activity) return "No Workfront tasks";
  return [...activity.statusCounts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status} (${count})`)
    .join(" · ");
}

function isProductionWorkfrontStatus(status) {
  return !["in review", "on hold", "pending review", "pre-audit complete", "vo in progress", "cr in review", "cr pending review"]
    .includes(normalizeWorkfrontStatus(status));
}

function isClientBlockedWorkfrontProject(project) {
  return !isProductionWorkfrontStatus(project.sourceStatus);
}

function workfrontDisplayStage(project) {
  const status = normalizeWorkfrontStatus(project.sourceStatus);
  if (status === "cr in execution") return "CR in Execution";
  if (isClientBlockedWorkfrontProject(project)) return "Client-side hold";
  return project.productionStage || "Awaiting triage";
}

function renderWorkfrontProductionQueues() {
  const container = $("#workfront-production-queues");
  if (!container) return;
  const taskActivityByProject = workfrontTaskActivityByProject();
  const queues = [
    ["Awaiting Audit", "Current / Pre-Audit · pending audit", project => state.roleCapabilities.manageAudits ? `<button type="button" class="mini-button" data-action="quick-preaudit" data-ref="${escapeHTML(project.ref)}">Audit now</button>` : `<span class="muted">Awaiting audit</span>`],
    ["Awaiting Execution", "Awaiting allocation", project => state.roleCapabilities.allocateTasks ? `<button type="button" class="mini-button" data-action="workfront-allocate" data-workfront-id="${escapeHTML(project.workfrontId)}">Allocate</button>` : `<span class="muted">Awaiting assignment</span>`],
    ["Execution in progress", "In execution", project => `<span class="muted">${escapeHTML(project.assignee || state.projects.find(item => item.workfrontId === project.workfrontId)?.assignee || "Assigned")}</span>`],
    ["Audit", "Asset audit in progress", project => state.roleCapabilities.manageAudits ? `<button type="button" class="mini-button" data-action="quick-audit" data-workfront-id="${escapeHTML(project.workfrontId)}">Start audit</button>` : `<span class="muted">Audit in progress</span>`],
    ["In QC", "In QC", project => state.roleCapabilities.allocateTasks ? `<button type="button" class="mini-button" data-action="workfront-rework" data-workfront-id="${escapeHTML(project.workfrontId)}">Open rework</button><button type="button" class="mini-button" data-action="workfront-qc-complete" data-workfront-id="${escapeHTML(project.workfrontId)}">Mark complete</button>` : `<span class="muted">QC stage</span>`],
    ["Complete", "Complete", () => `<span class="status-pill">✓ Complete</span>`],
    ["Pending Clarification", "Pending clarification", () => `<span class="muted">Awaiting clarification</span>`],
    ["Planning", "Planning", () => `<span class="muted">Not ready for allocation</span>`],
    ["CR in Execution", "CR in execution", () => `<span class="muted">Tracked in the All Change Rounds report</span>`],
    ["Client-side hold", "Client-side project hold", () => `<span class="muted">No new project actions until the Workfront status changes; task activity is reported separately</span>`],
    ["Awaiting triage", "Needs status mapping", () => `<span class="muted">Review source Workfront status</span>`]
  ];
  container.innerHTML = queues.map(([stage, title, action]) => {
    const projects = state.workfrontProjects.filter((item) => workfrontDisplayStage(item) === stage
      && (stage === "Client-side hold" || !isClientBlockedWorkfrontProject(item)));
    return `<section class="workfront-stage-queue"><h3>${escapeHTML(title)} <span>${projects.length}</span></h3>${projects.length
      ? `<div class="workfront-stage-list">${projects.slice(0, 12).map((project) => {
        const activity = taskActivityByProject.get(normalizeWorkfrontStatus(project.ref));
        return `<article><div>${workfrontProjectLink(project, `${project.ref} · ${project.title}`)}<small>${escapeHTML(project.channel || project.assetType || "Unmapped")} · ${escapeHTML(project.workfrontTeam || "Unmapped")} · source ${escapeHTML(project.sourceStatus || "Unknown")}${activity ? ` · tasks ${escapeHTML(workfrontTaskActivityLabel(activity))}` : ""}</small>${workfrontPriorityLabel(project)}</div>${action(project)}</article>`;
      }).join("")}</div>`
      : `<p class="muted">No projects in this stage.</p>`}</section>`;
  }).join("");
}

function isScheduledWorkday(date, assignee) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6 || state.holidays.some((holiday) => holiday.date === date)) return false;
  // Half-day leave still leaves the member scheduled for the day; capacity reports use memberAvailability instead.
  return !state.leaves.some((leave) => leave.status === "Approved" && !leave.halfDay && leave.assignee === assignee && leaveCoversDate(leave, date));
}

// Returns the fraction of a working day the member is available: 0 (off / full leave), 0.5 (half-day leave) or 1.
function memberAvailability(date, assignee) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6 || state.holidays.some((holiday) => holiday.date === date)) return 0;
  const leaves = state.leaves.filter((leave) => leave.status === "Approved" && leave.assignee === assignee && leaveCoversDate(leave, date));
  if (leaves.some((leave) => !leave.halfDay)) return 0;
  return Math.max(0, 1 - 0.5 * new Set(leaves.map((leave) => leave.halfDay)).size);
}

function leaveDurationLabel(leave) {
  return leave?.halfDay ? `Half day · ${leave.halfDay}` : "";
}

function businessDaysInRange(start, end, assignee) {
  if (!start || !end || end < start) return 0;
  let count = 0;
  const date = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (date <= last) {
    if (isScheduledWorkday(date.toISOString().slice(0, 10), assignee)) count += 1;
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return count;
}

function workfrontTeamForWork(task) {
  const routingFields = `${task.channel || ""} ${task.taskType || ""}`.toLowerCase().replace(/[_-]+/g, " ");
  if (/\bcampaign\b/.test(routingFields)) return "Email Team";
  const asset = `${routingFields} ${task.title || ""}`;
  if (/\b(video|gif|banner animated|animated banner|banner gif)\b/.test(asset)) return "Video Team";
  if (/\b(website|banner html|html banner|banner web|aem webpage)\b/.test(asset)) return "Web Team";
  if (/\b(email|landing page|landing pages|edetailer|e detailer)\b/.test(asset)) return "Email Team";
  if (/\b(ipdf|print|ppt|gslide|illustration|poster|social media post|whatsapp|banner)\b/.test(asset)) return "Design Team";
  return "Unmapped";
}

function localTaskForWorkfrontRound(round) {
  const project = state.projects.find((item) => item.ref.toLowerCase() === String(round.projectRef || "").toLowerCase());
  if (!project) return { project: null, task: null };
  const task = state.tasks.find((item) => item.projectId === project.id
    && item.category === "CR"
    && String(item.crId || "").toLowerCase() === String(round.crId || "").toLowerCase());
  return { project, task };
}

function suggestedExecutioner(departmentId, excludeName = "") {
  const today = localDate();
  const eligible = departmentAssignees(departmentId).filter((member) => member.name.toLowerCase() !== excludeName.toLowerCase());
  return eligible.map((member) => {
    const activeTasks = state.tasks.filter((task) => task.assignee === member.name && !["Completed", "Archived"].includes(task.status));
    const onLeave = state.leaves.some((leave) => leave.status === "Approved" && leave.assignee === member.name && leaveCoversDate(leave, today));
    return { member, onLeave, remainingHours: activeTasks.reduce((sum, task) => sum + Math.max(0, Number(task.plannedHours || 0) - Number(task.loggedHours || 0)), 0) };
  }).sort((a, b) => Number(a.onLeave) - Number(b.onLeave) || a.remainingHours - b.remainingHours || a.member.name.localeCompare(b.member.name))[0]?.member || null;
}

const LEAVE_ACTION_STATUS_ORDER = ["rework identified", "in progress", "execution in progress", "assigned to execution", "new"];

function leaveActionTasks(date) {
  const user = state.user || {};
  const teams = (state.departments || []).filter((department) => department.id !== "qa"
    && (["manager", "leadership"].includes(user.role) || (user.teamIds || []).includes(department.id) || (user.teamIds || []).includes("qa")));
  let reportDate = date;
  const rows = [];
  const members = new Set();
  for (const team of teams) {
    const report = capacityBriefing({ teamId: team.id, date });
    reportDate = report.reportDate;
    for (const member of report.onLeaveList) {
      members.add(member.name);
      for (const task of member.tasks) rows.push({ ...task, member: member.name, leaveType: member.leaveType, leave: member.leave, team: team.name });
    }
  }
  const groups = new Map();
  for (const row of rows) {
    const status = row.status || "Not set";
    if (!groups.has(status)) groups.set(status, []);
    groups.get(status).push(row);
  }
  const rank = (status) => {
    const index = LEAVE_ACTION_STATUS_ORDER.indexOf(normalizeWorkfrontStatus(status));
    return index < 0 ? LEAVE_ACTION_STATUS_ORDER.length : index;
  };
  const byMaterialDate = (a, b) => (a.due || "9999").localeCompare(b.due || "9999") || String(a.ref).localeCompare(String(b.ref));
  return {
    reportDate,
    members: members.size,
    count: rows.length,
    hours: rows.reduce((sum, row) => sum + (row.remaining || 0), 0),
    groups: [...groups.entries()].map(([status, tasks]) => ({ status, tasks: tasks.sort(byMaterialDate), hours: tasks.reduce((sum, row) => sum + (row.remaining || 0), 0) }))
      .sort((a, b) => rank(a.status) - rank(b.status) || a.status.localeCompare(b.status))
  };
}

function renderLeaveActions(summary) {
  const target = $("#manager-leave-actions");
  if (!target) return;
  const today = localDate();
  $("#manager-leave-actions-date").textContent = briefingDateLabel(summary.reportDate, true);
  target.innerHTML = summary.count ? summary.groups.map((group) => `<section class="leave-action-group"><h3>${escapeHTML(group.status)} <span class="muted">${group.tasks.length} task${group.tasks.length === 1 ? "" : "s"} · ${escapeHTML(formatBriefingHours(group.hours))} hrs</span></h3>
    <div class="table-wrap"><table><thead><tr><th>Material expected</th><th>Team member</th><th>Type · task</th><th>Project</th><th>Priority</th><th>Required effort</th></tr></thead><tbody>${group.tasks.map((task) => {
      const project = (state.workfrontProjects || []).find((item) => normalizeWorkfrontStatus(item.ref) === normalizeWorkfrontStatus(task.ref));
      const due = task.due ? `<span class="${task.due < today ? "overdue" : ""}">${dateLabel(task.due)}${task.dueSource === "planned" ? "*" : ""}</span>${task.movedFrom ? holidayFlag(task.movedFrom) : ""}` : "—";
      return `<tr><td>${due}</td><td><strong>${escapeHTML(task.member)}</strong><small>${escapeHTML(task.team)} · ${escapeHTML(task.leaveType)}${task.leave ? ` ${escapeHTML(task.leave)}` : ""}</small></td><td>${escapeHTML(task.type)} · ${escapeHTML(task.ref)}</td><td>${project ? workfrontProjectLink(project, task.project) : escapeHTML(task.project)}</td><td>${escapeHTML(task.priority || "—")}</td><td>${task.remaining === null ? "Not set" : `${escapeHTML(formatBriefingHours(task.remaining))} hrs`}</td></tr>`;
    }).join("")}</tbody></table></div></section>`).join("")
    + (summary.groups.some((group) => group.tasks.some((task) => task.dueSource === "planned")) ? '<p class="form-hint">* No Material Expected Delivery Date in Workfront; planned completion date used.</p>' : "")
    : emptyState(summary.members ? "No open tasks to reassign" : "Everyone is available", summary.members ? `${summary.members} team member${summary.members === 1 ? " is" : "s are"} away, with no open Build or CR tasks.` : "No team member is on approved leave or away on this date.");
}

function renderManagerReports() {
  if (!state.roleCapabilities.viewManagerReports) return;
  const today = localDate();
  const dateInput = $("#manager-report-date");
  if (!dateInput.value) dateInput.value = localDate();
  const reportDate = dateInput.value;
  let urgentCount = 0;
  for (const project of state.workfrontProjects) {
    if (PRIORITY_PROJECT_STATUSES.test(project.sourceStatus) && normalizeWorkfrontStatus(workfrontProjectPriority(project)) === "urgent") urgentCount += 1;
  }
  const leaveActions = leaveActionTasks(reportDate);
  $("#manager-report-summary").innerHTML = metricCard(
    ["Urgent", urgentCount, "Workfront projects · filter by team in details", "accent-orange"],
    "workfront", "project-priority", "Urgent", state.roleCapabilities.viewWorkfront
  ) + `<button type="button" class="metric-card metric-card-action accent-red" data-scroll-target="manager-leave-actions-panel" aria-label="${escapeHTML(`On leave tasks: ${leaveActions.count}. Open the reassignment list`)}">
    <span class="metric-label">On leave · tasks to reassign</span><strong class="metric-value">${leaveActions.count}</strong><span class="metric-foot">${leaveActions.members} away on ${escapeHTML(briefingDateLabel(leaveActions.reportDate))} · ${escapeHTML(formatBriefingHours(leaveActions.hours))} hrs</span><span class="metric-drill-hint" aria-hidden="true">Take action →</span>
  </button>`;
  renderLeaveActions(leaveActions);
  const normalizeSourceStatus = (status) => String(status || "").trim().toLowerCase().replace(/\s+/g, " ");
  const matchingTasks = (projectStatus, taskStatus) => state.workfrontTasks.filter((task) =>
    normalizeSourceStatus(task.projectStatus) === normalizeSourceStatus(projectStatus)
      && normalizeSourceStatus(task.taskStatus) === normalizeSourceStatus(taskStatus));
  const isAssigned = workfrontTaskIsAssigned;
  const hasAssignedNewBuildTask = (projectRef) => state.workfrontTasks.some((task) =>
    normalizeSourceStatus(task.projectRef) === normalizeSourceStatus(projectRef)
      && normalizeSourceStatus(task.projectStatus) === "awaiting execution"
      && normalizeSourceStatus(task.taskStatus) === "new"
      && normalizeSourceStatus(task.taskName) === "build"
      && isAssigned(task));
  const taskRow = (label, projectStatus, taskStatus, assignment = "", taskName = "Build") => {
    const tasks = matchingTasks(projectStatus, taskStatus)
      .filter((task) => normalizeSourceStatus(task.taskName) === normalizeSourceStatus(taskName))
      .filter((task) => assignment === "assigned" ? isAssigned(task) : assignment === "unassigned" ? !isAssigned(task) : true);
    return `<button type="button" class="production-status-row" data-drill-view="workfront" data-drill-key="production-task" data-drill-task-name="${escapeHTML(taskName)}" data-drill-project-status="${escapeHTML(projectStatus)}" data-drill-task-status="${escapeHTML(taskStatus)}" data-drill-assignment="${assignment}" data-drill-label="${escapeHTML(`${taskName} · ${label} · ${projectStatus}`)}"><span>${escapeHTML(label)} <small>Project: ${escapeHTML(projectStatus)}</small></span><strong>${tasks.length.toLocaleString()}</strong></button>`;
  };
  const projectRow = (label, status, assignment = "") => {
    const projects = state.workfrontProjects.filter((project) =>
      normalizeSourceStatus(project.sourceStatus) === normalizeSourceStatus(status)
        && (assignment === "pending" ? !hasAssignedNewBuildTask(project.ref)
          : assignment === "assigned" ? hasAssignedNewBuildTask(project.ref) : true));
    return `<button type="button" class="production-status-row" data-drill-view="workfront" data-drill-key="production-project" data-drill-value="${escapeHTML(status)}" data-drill-assignment="${assignment}" data-drill-label="${escapeHTML(`${label} · ${status}`)}"><span>${escapeHTML(label)} <small>Project: ${escapeHTML(status)}</small></span><strong>${projects.length.toLocaleString()}</strong></button>`;
  };
  const completedAuditsToday = new Set(state.workfrontTasks.filter((task) =>
    /^asset audit$/i.test(task.taskName) && /^(complete|completed)$/i.test(task.taskStatus)
    && String(task.actualCompletionDate || "").slice(0, 10) === reportDate).map((task) => task.projectRef)).size;
  const undatedCompletedAudits = state.workfrontTasks.filter((task) => /^asset audit$/i.test(task.taskName)
    && /^(complete|completed)$/i.test(task.taskStatus) && !task.actualCompletionDate).length;
  const category = (title, rows) => `<section class="production-status-category"><h3>${escapeHTML(title)}</h3><div>${rows.join("")}</div></section>`;
  $("#manager-floor-status").innerHTML = `<div class="production-status-categories">
    ${category("Asset Audit", [
      projectRow("Pre-Audit", "Pre-Audit"),
      projectRow("New", "Current"),
      projectRow("In Progress", "Audit Ongoing"),
      projectRow("Complete", "Awaiting Execution"),
      `<div class="production-status-row production-status-static"><span>Asset audits completed · ${escapeHTML(reportDate)}${undatedCompletedAudits ? `<small>${undatedCompletedAudits} complete tasks have no completion date; sync task details to verify dates.</small>` : ""}</span><strong>${completedAuditsToday.toLocaleString()}</strong></div>`
    ])}
    ${category("Build", [
      projectRow("Pending assignment", "Awaiting Execution", "pending"),
      taskRow("New · assigned / not started", "Awaiting Execution", "New", "assigned"),
      taskRow("In Progress", "Execution In Progress", "In Progress"),
      taskRow("Complete", "In QC", "Complete")
    ])}
    ${category("QA Audit", [
      taskRow("New", "In QC", "New", "", "QA Audit"),
      taskRow("Assigned to QA", "In QC", "Assigned to QA", "", "QA Audit"),
      taskRow("QA In Progress", "In QC", "QA In Progress", "", "QA Audit")
    ])}
    ${category("Bug fixing", [
      taskRow("New", "In QC", "New", "", "Bug Fixing"),
      taskRow("Rework Identified", "In QC", "Rework Identified", "", "Bug Fixing"),
      taskRow("In Progress", "In QC", "In Progress", "", "Bug Fixing"),
      taskRow("QA In Progress", "In QC", "QA In Progress", "", "Bug Fixing"),
      taskRow("Complete", "In QC", "Complete", "", "Bug Fixing")
    ])}
    ${category("Pending Clarification", [
      projectRow("Pending Clarification", "Pending Clarification")
    ])}
  </div>`;
  const makeCountTable = (rows, label) => rows?.length
    ? `<table><thead><tr><th>${escapeHTML(label)}</th><th>Records</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHTML(row.label)}</td><td>${Number(row.count).toLocaleString()}</td></tr>`).join("")}</tbody></table>`
    : emptyState("No report data", "Sync the Workfront exports to populate this report.");
  const taskTeamCounts = new Map();
  for (const task of state.workfrontTasks) {
    const team = String(task.workfrontTeam || "").trim() || "Unmapped";
    taskTeamCounts.set(team, (taskTeamCounts.get(team) || 0) + 1);
  }
  const teamRows = [...taskTeamCounts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  $("#manager-floor-teams").innerHTML = makeCountTable(teamRows, "Production team · Workfront task records");
  const crStatusRows = workfrontSourceStatusCounts(state.workfrontChangeRounds, "sourceStatus");
  $("#manager-cr-status").innerHTML = makeCountTable(crStatusRows, "Workfront change-round status · as reported");
  const actionableRounds = state.workfrontChangeRounds.filter((round) => {
    const status = normalizeSourceStatus(round.sourceStatus);
    if (status === "assigned to execution" && round.executionAssignment !== "Assigned to executioner") return true;
    if (status !== "rework identified" || !round.assignee) return false;
    const eta = round.expectedDeliveryDate?.slice(0, 10) || today;
    return state.leaves.some((leave) => leave.status === "Approved" && leave.assignee.toLowerCase() === round.assignee.toLowerCase()
      && leave.startDate <= eta && leave.endDate >= today);
  });
  $("#manager-cr-assignment").innerHTML = actionableRounds.length
    ? `<table><thead><tr><th>CR / Project</th><th>Status</th><th>Assigned to</th><th>Attention</th><th>Action</th></tr></thead><tbody>${actionableRounds.map((round) => {
      const status = normalizeSourceStatus(round.sourceStatus);
      const { project, task } = localTaskForWorkfrontRound(round);
      const onLeave = status === "rework identified" && state.leaves.some((leave) => leave.status === "Approved"
        && leave.assignee.toLowerCase() === String(round.assignee || "").toLowerCase()
        && leave.startDate <= (round.expectedDeliveryDate?.slice(0, 10) || today) && leave.endDate >= today);
      const suggested = suggestedExecutioner(round.productionTeamId || project?.productionTeamId, onLeave ? round.assignee : "");
      const action = state.roleCapabilities.manageProjects && task && onLeave && suggested
        ? `<button class="mini-button" data-action="reassign-workfront-cr" data-task-id="${escapeHTML(task.id)}" data-assignee="${escapeHTML(suggested.name)}">Reassign to ${escapeHTML(suggested.name)}</button>`
        : state.roleCapabilities.manageProjects && status === "assigned to execution" && project && !task
          ? `<button class="mini-button" data-action="assign-workfront-cr" data-workfront-cr-id="${escapeHTML(round.workfrontId)}" data-project-id="${escapeHTML(project.id)}" data-assignee="${escapeHTML(suggested?.name || "")}">Create CR task</button>`
          : !project ? `<span class="muted">Allocate parent project first</span>`
            : onLeave && !task ? `<span class="muted">No linked CR task to reassign</span>`
              : `<span class="muted">${task ? "Open CR task" : "Awaiting executioner"}</span>`;
      const attention = onLeave ? "Assigned executioner is on approved leave"
        : status === "assigned to execution" ? round.executionAssignment
          : "Rework return needs coverage";
      const parent = state.workfrontProjects.find((project) => project.ref.toLowerCase() === round.projectRef.toLowerCase()) || round;
      return `<tr class="${onLeave || status === "assigned to execution" ? "cr-needs-attention" : ""}"><td><strong>${escapeHTML(round.crId)}</strong><small>${workfrontProjectLink(parent, `${round.projectRef} · ${round.title || "Untitled project"}`)}</small>${workfrontPriorityLabel(round)}</td><td>${escapeHTML(round.sourceStatus)}</td><td>${escapeHTML(round.assignee || "Unassigned")}</td><td>${escapeHTML(attention)}</td><td>${action}</td></tr>`;
    }).join("")}</tbody></table>`
    : emptyState("No CR assignment risks", "Assigned-to-Execution CRs and rework on approved leave will appear here.");

  const availableFor = (member) => isScheduledWorkday(reportDate, member.name) ? state.capacityHoursPerDay : 0;
  const todayLogs = [...state.workLogs, ...(state.sourceWorkLogs || [])].filter((entry) => entry.date === reportDate);
  const completionDates = new Map();
  for (const log of state.workLogs.filter((entry) => entry.progress >= 100 || entry.status === "Completed")) {
    const completedOn = completionDates.get(log.taskId);
    if (!completedOn || log.date < completedOn) completionDates.set(log.taskId, log.date);
  }
  const dailyTasks = state.tasks.filter((task) => task.assignee && task.status !== "Archived"
    && task.startDate && task.etaDate && reportDate >= task.startDate && reportDate <= task.etaDate
    && isScheduledWorkday(reportDate, task.assignee)
    && !(completionDates.get(task.id) && reportDate > completionDates.get(task.id))
    && !(task.status === "Completed" && !completionDates.has(task.id) && task.updatedAt?.slice(0, 10) < reportDate));
  const scheduledByDesigner = new Map();
  for (const task of dailyTasks) {
    const taskDays = Math.max(1, businessDaysInRange(task.startDate, task.etaDate, task.assignee));
    scheduledByDesigner.set(task.assignee, (scheduledByDesigner.get(task.assignee) || 0) + Number(task.plannedHours || 0) / taskDays);
  }
  const loggedByDesigner = new Map();
  for (const entry of todayLogs) loggedByDesigner.set(entry.userName, (loggedByDesigner.get(entry.userName) || 0) + Number(entry.hours || 0));
  const productionRoster = state.team.filter((member) => !state.users.some((user) => user.name.toLowerCase() === member.name.toLowerCase() && ["manager", "auditor"].includes(user.role)));
  const designerCapacity = productionRoster.map((member) => {
    const available = availableFor(member);
    const scheduled = scheduledByDesigner.get(member.name) || 0;
    return { name: member.name, available, scheduled, logged: loggedByDesigner.get(member.name) || 0, utilization: available ? scheduled / available * 100 : 0, away: available === 0 };
  });
  const totalCapacity = designerCapacity.reduce((sum, item) => sum + item.available, 0);
  $("#manager-daily-capacity").innerHTML = designerCapacity.length
    ? `<table><thead><tr><th>Designer</th><th>Available</th><th>Scheduled</th><th>Free capacity</th><th>Logged today</th><th>Utilization</th></tr></thead><tbody>${designerCapacity.map((member) => `<tr><td>${escapeHTML(member.name)}${member.away ? ' <span class="leave-today">Unavailable</span>' : ""}</td><td>${member.available.toFixed(1)}h</td><td>${member.scheduled.toFixed(1)}h</td><td>${Math.max(0, member.available - member.scheduled).toFixed(1)}h</td><td>${member.logged.toFixed(1)}h</td><td><div class="progress-caption"><span>${member.utilization.toFixed(0)}%</span><span>${member.scheduled > member.available ? "Over capacity" : ""}</span></div><div class="progress-track"><div class="progress-fill ${member.utilization > 100 ? "over-capacity-fill" : ""}" style="width:${Math.min(100, member.utilization)}%"></div></div></td></tr>`).join("")}<tr class="manager-report-total"><td>Team total</td><td>${totalCapacity.toFixed(1)}h</td><td>${designerCapacity.reduce((sum, item) => sum + item.scheduled, 0).toFixed(1)}h</td><td>${Math.max(0, totalCapacity - designerCapacity.reduce((sum, item) => sum + item.scheduled, 0)).toFixed(1)}h</td><td>${todayLogs.reduce((sum, entry) => sum + Number(entry.hours || 0), 0).toFixed(1)}h</td><td>${totalCapacity ? (designerCapacity.reduce((sum, item) => sum + item.scheduled, 0) / totalCapacity * 100).toFixed(0) : "0"}%</td></tr></tbody></table>`
    : emptyState("No rostered designers", "Add the production team to plan daily capacity.");

  const logGroups = new Map();
  const taskById = new Map(state.tasks.map((task) => [task.id, task]));
  const detailGroups = new Map();
  for (const entry of todayLogs) {
    const user = entry.userName || "Unspecified";
    const taskKey = entry.taskId || `${entry.projectRef}:${entry.taskCategory}:${entry.crId || ""}`;
    const group = logGroups.get(user) || { user, hours: 0, entries: 0, tasks: new Set(), projects: new Set(), completed: new Set() };
    group.hours += Number(entry.hours || 0);
    group.entries += 1;
    group.tasks.add(taskKey);
    group.projects.add(entry.projectRef);
    if (entry.progress >= 100 || entry.status === "Completed") group.completed.add(taskKey);
    logGroups.set(user, group);
    const task = taskById.get(entry.taskId);
    const detailKey = `${user}\u0000${taskKey}`;
    const detail = detailGroups.get(detailKey) || { user, taskName: task?.title || `${entry.taskCategory || "Build"} ${entry.crId || ""}`.trim(), projectRef: entry.projectRef, projectTitle: entry.projectTitle, category: entry.taskCategory || task?.category || "Build", crId: entry.crId, hours: 0, entries: 0, progress: 0 };
    detail.hours += Number(entry.hours || 0);
    detail.entries += 1;
    detail.progress = Math.max(detail.progress, Number(entry.progress || 0));
    detailGroups.set(detailKey, detail);
  }
  const productionRows = [...logGroups.values()].sort((a, b) => b.hours - a.hours || a.user.localeCompare(b.user));
  $("#manager-daily-production").innerHTML = productionRows.length
    ? `<table><thead><tr><th>Team member</th><th>Logged hours</th><th>Log entries</th><th>Tasks worked</th><th>Projects worked</th><th>Tasks completed</th></tr></thead><tbody>${productionRows.map((row) => `<tr><td>${escapeHTML(row.user)}</td><td>${row.hours.toFixed(1)}h</td><td>${row.entries}</td><td>${row.tasks.size}</td><td>${row.projects.size}</td><td>${row.completed.size}</td></tr>`).join("")}</tbody></table>`
    : emptyState("No production time logged", `No team work-log entries were recorded on ${dateLabel(reportDate)}.`);
  const detailRows = [...detailGroups.values()].sort((a, b) => b.hours - a.hours || a.user.localeCompare(b.user));
  $("#manager-daily-production-details").innerHTML = detailRows.length
    ? `<table><thead><tr><th>Team member</th><th>Task</th><th>Project ID</th><th>Project</th><th>Logged</th><th>Progress</th></tr></thead><tbody>${detailRows.map((row) => `<tr><td>${escapeHTML(row.user)}</td><td>${escapeHTML(row.category)}${row.crId ? ` · ${escapeHTML(row.crId)}` : ""}</td><td>${escapeHTML(row.projectRef)}</td><td>${escapeHTML(row.projectTitle || "—")}</td><td>${row.hours.toFixed(1)}h</td><td>${row.progress}%</td></tr>`).join("")}</tbody></table>`
    : "";

  const teamLoad = new Map();
  const taskMap = new Map(state.tasks.map((task) => [task.id, task]));
  for (const task of dailyTasks) {
    const team = workfrontTeamForWork(task);
    const group = teamLoad.get(team) || { label: team, tasks: new Set(), projects: new Set(), scheduled: 0, logged: 0 };
    group.tasks.add(task.id);
    group.projects.add(task.projectId);
    const days = Math.max(1, businessDaysInRange(task.startDate, task.etaDate, task.assignee));
    group.scheduled += Number(task.plannedHours || 0) / days;
    teamLoad.set(team, group);
  }
  for (const entry of todayLogs) {
    const task = taskMap.get(entry.taskId);
    const team = task ? workfrontTeamForWork(task) : "Unmapped";
    const group = teamLoad.get(team) || { label: team, tasks: new Set(), projects: new Set(), scheduled: 0, logged: 0 };
    group.logged += Number(entry.hours || 0);
    if (entry.taskId) group.tasks.add(entry.taskId);
    if (entry.projectId) group.projects.add(entry.projectId);
    teamLoad.set(team, group);
  }
  const teamLoadRows = [...teamLoad.values()].sort((a, b) => b.scheduled - a.scheduled || a.label.localeCompare(b.label));
  $("#manager-team-utilization").innerHTML = teamLoadRows.length
    ? `<table><thead><tr><th>Production team (channel)</th><th>Scheduled tasks</th><th>Projects</th><th>Planned today</th><th>Logged today</th><th>Share of studio capacity</th></tr></thead><tbody>${teamLoadRows.map((row) => `<tr><td>${escapeHTML(row.label)}</td><td>${row.tasks.size}</td><td>${row.projects.size}</td><td>${row.scheduled.toFixed(1)}h</td><td>${row.logged.toFixed(1)}h</td><td>${totalCapacity ? (row.scheduled / totalCapacity * 100).toFixed(1) : "0.0"}%</td></tr>`).join("")}</tbody></table>`
    : emptyState("No tasks scheduled", `No assigned tasks fall on ${dateLabel(reportDate)}.`);
}

function renderTeamUtilization() {
  if (!state.roleCapabilities.viewManagerReports) return;
  const today = localDate();
  const period = $("#utilization-period").value || "day";
  const anchorInput = $("#utilization-anchor-date");
  if (!anchorInput.value) anchorInput.value = today;
  const anchor = anchorInput.value;
  let startDate = anchor;
  let endDate = anchor;
  if (period === "week") {
    const date = new Date(`${anchor}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    startDate = date.toISOString().slice(0, 10);
    date.setUTCDate(date.getUTCDate() + 6);
    endDate = date.toISOString().slice(0, 10);
  } else if (period === "month") {
    const date = new Date(`${anchor}T00:00:00Z`);
    date.setUTCDate(1);
    startDate = date.toISOString().slice(0, 10);
    date.setUTCMonth(date.getUTCMonth() + 1);
    date.setUTCDate(0);
    endDate = date.toISOString().slice(0, 10);
  } else if (period === "duration") {
    startDate = $("#utilization-start-date").value;
    endDate = $("#utilization-end-date").value;
  }
  const isDuration = period === "duration";
  $("#utilization-anchor-label").classList.toggle("hidden", isDuration);
  $("#utilization-start-label").classList.toggle("hidden", !isDuration);
  $("#utilization-end-label").classList.toggle("hidden", !isDuration);
  $("#utilization-range-label").textContent = startDate && endDate
    ? `${dateLabel(startDate)} – ${dateLabel(endDate)}`
    : "Choose a date range";
  if (!startDate || !endDate || endDate < startDate) {
    $("#utilization-summary").innerHTML = "";
    $("#team-utilization-resources").innerHTML = emptyState("Invalid date range", "Choose a start date on or before the end date.");
    $("#team-utilization-channels").innerHTML = "";
    return;
  }
  const dates = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const lastDate = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= lastDate) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const productionRoster = state.team.filter((member) => member.role !== "leadership");
  const resources = new Map(productionRoster.map((member) => [member.name, {
    name: member.name, available: dates.filter((date) => isScheduledWorkday(date, member.name)).length * state.capacityHoursPerDay,
    scheduled: 0, logged: 0, nonProductive: 0, training: 0, meeting: 0, other: 0, tasks: new Set(), loggedTasks: new Set(), completed: new Set()
  }]));
  const channels = new Map();
  const taskById = new Map(state.tasks.map((task) => [task.id, task]));
  const projectById = new Map(state.projects.map((project) => [project.id, project]));
  for (const task of state.tasks) {
    if (!task.assignee || !task.startDate || !task.etaDate || task.status === "Archived") continue;
    const taskDays = businessDaysInRange(task.startDate, task.etaDate, task.assignee);
    if (!taskDays) continue;
    const scheduledDates = dates.filter((date) => date >= task.startDate && date <= task.etaDate && isScheduledWorkday(date, task.assignee));
    if (!scheduledDates.length) continue;
    const scheduledHours = Number(task.plannedHours || 0) * scheduledDates.length / taskDays;
    const resource = resources.get(task.assignee);
    if (resource) {
      resource.scheduled += scheduledHours;
      resource.tasks.add(task.id);
    }
    const channel = projectById.get(task.projectId)?.channel || task.taskType || "Unmapped";
    const group = channels.get(channel) || { channel, scheduled: 0, logged: 0, tasks: new Set(), projects: new Set(), completed: new Set() };
    group.scheduled += scheduledHours;
    group.tasks.add(task.id);
    group.projects.add(task.projectId);
    channels.set(channel, group);
  }
  const periodLogs = (state.operationsWorkspace?.productiveLogs || [...state.workLogs, ...state.sourceWorkLogs]).filter((entry) => entry.date >= startDate && entry.date <= endDate);
  const activityLogs = (state.operationsWorkspace?.activityLogs || []).filter((entry) => entry.date >= startDate && entry.date <= endDate);
  for (const entry of activityLogs) {
    const resource = resources.get(entry.userName);
    if (!resource) continue;
    resource.nonProductive += Number(entry.hours);
    resource[entry.category === "Training" ? "training" : entry.category === "Meeting" ? "meeting" : "other"] += Number(entry.hours);
  }
  let totalLogged = 0;
  const totalLoggedTasks = new Set();
  const totalProjects = new Set();
  const totalCompleted = new Set();
  for (const entry of periodLogs) {
    totalLogged += Number(entry.hours || 0);
    const task = taskById.get(entry.taskId);
    const resource = resources.get(entry.userName);
    if (resource) {
      resource.logged += Number(entry.hours || 0);
      if (entry.taskId) resource.loggedTasks.add(entry.taskId);
      if (entry.progress >= 100 || entry.status === "Completed") resource.completed.add(entry.taskId);
    }
    if (entry.taskId) totalLoggedTasks.add(entry.taskId);
    if (entry.projectId) totalProjects.add(entry.projectId);
    if (entry.taskId && (entry.progress >= 100 || entry.status === "Completed")) totalCompleted.add(entry.taskId);
    const channel = projectById.get(entry.projectId)?.channel || task?.taskType || "Unmapped";
    const group = channels.get(channel) || { channel, scheduled: 0, logged: 0, tasks: new Set(), projects: new Set(), completed: new Set() };
    group.logged += Number(entry.hours || 0);
    if (entry.taskId) group.tasks.add(entry.taskId);
    if (entry.projectId) group.projects.add(entry.projectId);
    if (entry.taskId && (entry.progress >= 100 || entry.status === "Completed")) group.completed.add(entry.taskId);
    channels.set(channel, group);
  }
  const totalAvailable = [...resources.values()].reduce((sum, row) => sum + row.available, 0);
  const totalScheduled = [...resources.values()].reduce((sum, row) => sum + row.scheduled, 0);
  const totalNonProductive = [...resources.values()].reduce((sum, row) => sum + row.nonProductive, 0);
  const recordedRate = (hours, capacity) => capacity ? `${(hours / capacity * 100).toFixed(1)}%` : "N/A";
  renderDrillNotice("#team-utilization-drill-notice", "team-utilization");
  $("#utilization-summary").innerHTML = [
    ["Available capacity", `${totalAvailable.toFixed(1)}h`, `${productionRoster.length} production resources`, "accent-blue"],
    ["Scheduled effort", `${totalScheduled.toFixed(1)}h`, `${Math.max(0, totalAvailable - totalScheduled).toFixed(1)}h free`, totalScheduled > totalAvailable ? "accent-red" : "accent-green"],
    ["Logged productive effort", `${totalLogged.toFixed(1)}h`, `${totalLoggedTasks.size} distinct tasks · ${totalProjects.size} projects`, "accent-purple"],
    ["Scheduled utilization", `${totalAvailable ? (totalScheduled / totalAvailable * 100).toFixed(0) : "0"}%`, "Scheduled hours ÷ available capacity", "accent-orange"],
    ["Tasks completed", totalCompleted.size, "Distinct tasks with completion logs in this interval", "accent-green"]
  ].map((metric, index) => metricCard(metric, "team-utilization", ["available", "scheduled", "logged", "utilized", "completed"][index])).join("")
    + metricCard(["Non-productive hours", `${totalNonProductive.toFixed(1)}h`, "Training + Meeting + Other; separate from project effort", "accent-blue"], "team-utilization", "non-productive")
    + metricCard(["Recorded utilization", recordedRate(totalLogged + totalNonProductive, totalAvailable), "Productive + non-productive logged hours / capacity; N/A when capacity is zero", "accent-green"], "team-utilization", "recorded");
  const utilizationDrill = state.drill?.view === "team-utilization" ? state.drill.key : "";
  const resourceRows = [...resources.values()].filter((row) => {
    if (utilizationDrill === "available") return row.available > 0;
    if (utilizationDrill === "scheduled" || utilizationDrill === "utilized") return row.scheduled > 0;
    if (utilizationDrill === "logged" || utilizationDrill === "today-logged" || utilizationDrill === "all-time-logged") return row.logged > 0;
    if (utilizationDrill === "completed") return row.completed.size > 0;
    if (utilizationDrill === "non-productive") return row.nonProductive > 0;
    if (utilizationDrill === "recorded") return row.logged + row.nonProductive > 0;
    return true;
  }).sort((a, b) => b.scheduled - a.scheduled || a.name.localeCompare(b.name));
  $("#team-utilization-resources").innerHTML = resourceRows.length
    ? `<table><thead><tr><th>Resource</th><th>Available</th><th>Scheduled</th><th>Productive logged</th><th>Training</th><th>Meeting</th><th>Other</th><th>Total non-productive</th><th>Total recorded</th><th>Recorded utilization</th><th>Scheduled utilization</th><th>Completed tasks</th></tr></thead>
      <tbody>${resourceRows.map((row) => `<tr><td>${escapeHTML(row.name)}</td><td>${row.available.toFixed(1)}h</td><td>${row.scheduled.toFixed(1)}h</td><td>${row.logged.toFixed(1)}h</td><td>${row.training.toFixed(1)}h</td><td>${row.meeting.toFixed(1)}h</td><td>${row.other.toFixed(1)}h</td><td>${row.nonProductive.toFixed(1)}h</td><td>${(row.logged + row.nonProductive).toFixed(1)}h</td><td>${recordedRate(row.logged + row.nonProductive, row.available)}</td><td>${row.available ? (row.scheduled / row.available * 100).toFixed(0) : "0"}%</td><td>${row.completed.size}</td></tr>`).join("")}
      <tr class="manager-report-total"><td>Team total</td><td>${totalAvailable.toFixed(1)}h</td><td>${totalScheduled.toFixed(1)}h</td><td>${totalLogged.toFixed(1)}h</td><td colspan="3"></td><td>${totalNonProductive.toFixed(1)}h</td><td>${(totalLogged + totalNonProductive).toFixed(1)}h</td><td>${recordedRate(totalLogged + totalNonProductive, totalAvailable)}</td><td>${totalAvailable ? (totalScheduled / totalAvailable * 100).toFixed(0) : "0"}%</td><td>${totalCompleted.size}</td></tr></tbody></table>`
    : emptyState("No matching production resources", "Clear the drill-through or choose another reporting period.");
  const channelRows = [...channels.values()].sort((a, b) => b.logged - a.logged || b.scheduled - a.scheduled || a.channel.localeCompare(b.channel));
  $("#team-utilization-channels").innerHTML = channelRows.length
    ? `<table><thead><tr><th>Channel</th><th>Scheduled</th><th>Logged</th><th>Projects</th><th>Tasks</th><th>Completed</th></tr></thead><tbody>${channelRows.map((row) => `<tr><td>${escapeHTML(row.channel)}</td><td>${row.scheduled.toFixed(1)}h</td><td>${row.logged.toFixed(1)}h</td><td>${row.projects.size}</td><td>${row.tasks.size}</td><td>${row.completed.size}</td></tr>`).join("")}</tbody></table>`
    : emptyState("No channel work in range", "No scheduled tasks or logged hours fall within this date range.");
  if (typeof renderActivityDetails === "function") renderActivityDetails(startDate, endDate);
}

function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve({ name: file.name, contentBase64: String(reader.result).split(",")[1] });
    reader.readAsDataURL(file);
  });
}

function renderCapacity() {
  if (!state.roleCapabilities.viewAht || !state.productionInsights) return;
  const tasks = state.tasks;
  const total = state.productionInsights.totals;
  const unassigned = tasks.filter((task) => !task.assignee && !["Completed", "Archived"].includes(task.status)).length;
  const overdue = tasks.filter((task) => isOpen(task) && task.etaDate < localDate()).length;
  const qaHours = tasks.reduce((sum, task) => sum + Number(task.qaBufferHours || 0), 0);
  $("#capacity-summary").innerHTML = [
    ["Open production tasks", total.open, `${total.count} total task records`, "accent-blue"],
    ["Scheduled hours", `${total.plannedHours.toFixed(1)}h`, `${qaHours.toFixed(1)}h protected QA buffer`, "accent-green"],
    ["Unassigned / overdue", `${unassigned} / ${overdue}`, `${total.loggedHours.toFixed(1)}h logged across team`, overdue ? "accent-red" : "accent-orange"]
  ].map((metric, index) => metricCard(metric, "capacity", ["open", "scheduled", "risk"][index])).join("");
  renderDrillNotice("#capacity-drill-notice", "capacity");
  const capacityDrill = state.drill?.view === "capacity" ? state.drill.key : "";
  const capacityTasks = tasks.filter((task) => {
    if (capacityDrill === "open") return isOpen(task);
    if (capacityDrill === "scheduled") return isOpen(task) && Boolean(task.startDate && task.etaDate);
    if (capacityDrill === "risk") return isOpen(task) && (!task.assignee || task.etaDate && task.etaDate < localDate());
    return false;
  });
  $("#capacity-drill-records").innerHTML = capacityDrill
    ? capacityTasks.length
      ? `<section class="panel"><div class="panel-heading"><div><h2>Matching task records</h2><p class="muted">${capacityTasks.length} task${capacityTasks.length === 1 ? "" : "s"} in this drill-through.</p></div></div><div class="table-wrap"><table><thead><tr><th>Project / task</th><th>Assigned</th><th>Status</th><th>Planned</th><th>Logged</th><th>Start</th><th>ETA</th></tr></thead><tbody>${capacityTasks.map((task) => {
        const project = state.projects.find((item) => item.id === task.projectId);
        return `<tr><td><strong>${escapeHTML(project?.ref || task.projectRef || "—")} · ${escapeHTML(task.title)}</strong><small>${escapeHTML(task.category)}${task.crId ? ` · ${escapeHTML(task.crId)}` : ""}</small></td><td>${escapeHTML(task.assignee || "Unassigned")}</td><td>${badge(task.status)}</td><td>${Number(task.plannedHours || 0).toFixed(1)}h</td><td>${Number(task.loggedHours || 0).toFixed(1)}h</td><td>${task.startDate ? `${dateLabel(task.startDate)} ${escapeHTML(task.startTime || "")}` : "—"}</td><td>${task.etaDate ? `${dateLabel(task.etaDate)} ${escapeHTML(task.etaTime || "")}` : "—"}</td></tr>`;
      }).join("")}</tbody></table></div></section>`
      : emptyState("No matching tasks", "Clear the drill-through or check the current task data.")
    : "";
  const approvedLeavesFor = (name) => state.leaves
    .filter((leave) => leave.assignee?.trim().toLowerCase() === name.trim().toLowerCase() && leave.status === "Approved")
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const members = state.team.map((member) => {
    const assigned = tasks.filter((task) => task.assignee === member.name && isOpen(task));
    const planned = assigned.reduce((sum, task) => sum + Number(task.plannedHours || 0), 0);
    const logged = assigned.reduce((sum, task) => sum + Number(task.loggedHours || 0), 0);
    const today = localDate();
    const approvedLeaves = approvedLeavesFor(member.name);
    const leaveToday = approvedLeaves.some((leave) => leaveCoversDate(leave, today));
    const nextLeave = approvedLeaves.find((leave) => leave.endDate >= today);
    return { name: member.name, role: member.role, count: assigned.length, planned, logged, remaining: Math.max(0, planned - logged), leaveToday, nextLeave, available: Math.max(0, (leaveToday ? 0 : state.capacityHoursPerDay) - assigned.filter((task) => task.startDate <= today && task.etaDate >= today).reduce((sum, task) => sum + Math.max(0, task.plannedHours / Math.max(1, Math.ceil(task.plannedHours / state.capacityHoursPerDay))), 0)) };
  });
  const leaveLabel = (member, today) => {
    const approvedLeaves = approvedLeavesFor(member.name);
    const details = (leave) => [leave.type, leave.halfDay].filter(Boolean).map(escapeHTML).join(" · ");
    const currentLeave = approvedLeaves.find((leave) => leaveCoversDate(leave, today));
    if (currentLeave) return `<strong class="leave-today">On leave today${details(currentLeave) ? ` · ${details(currentLeave)}` : ""}</strong>`;
    const nextLeave = approvedLeaves.find((leave) => leave.endDate >= today);
    if (nextLeave) return `Next: ${escapeHTML(dateLabel(nextLeave.startDate))}${details(nextLeave) ? ` · ${details(nextLeave)}` : ""}`;
    const pendingLeave = state.leaves.find((leave) => leave.assignee?.trim().toLowerCase() === member.name.trim().toLowerCase()
      && leave.status === "Pending" && leave.endDate >= today);
    return pendingLeave ? `Pending: ${escapeHTML(dateLabel(pendingLeave.startDate))}${details(pendingLeave) ? ` · ${details(pendingLeave)}` : ""}` : "—";
  };
  $("#capacity-team-table").innerHTML = `<table><thead><tr><th>Team member</th><th>Role</th><th>Open tasks</th><th>Planned hours</th><th>Logged hours</th><th>Remaining</th><th>Free today</th><th>Leave</th></tr></thead><tbody>${members.map((member) => `<tr><td>${escapeHTML(member.name)}</td><td>${escapeHTML(ROLE_LABELS[member.role] || member.role || "Executioner / Designer")}</td><td>${member.count}</td><td>${member.planned.toFixed(1)}h</td><td>${member.logged.toFixed(1)}h</td><td>${member.remaining.toFixed(1)}h</td><td>${member.available.toFixed(1)}h</td><td>${leaveLabel(member, localDate())}</td></tr>`).join("")}</tbody></table>`;
  const dimension = $("#insight-dimension").value || "byCategory";
  const groups = state.productionInsights[dimension] || [];
  const auditsDimension = dimension.startsWith("audits");
  $("#insight-matrix").innerHTML = groups.length
    ? `<table><thead><tr><th>${dimension === "byCategory" ? "Task category" : dimension === "byCategoryStatus" ? "Category · status" : dimension === "byStatus" || dimension === "auditsByStatus" ? "Status" : dimension.endsWith("ByCountry") || dimension === "byCountry" ? "Country / market" : dimension.endsWith("ByDpm") || dimension === "byDpm" ? "DPM" : dimension === "byDesigner" ? "Designer" : dimension.endsWith("ByAuditor") ? "Auditor" : dimension.endsWith("ByChannel") || dimension === "byChannel" ? "Channel" : "Complexity"}</th><th>${auditsDimension ? "Audits" : "Tasks"}</th>${auditsDimension ? "" : `<th>Open</th><th>Completed</th><th>Planned hours</th><th>Logged hours</th>`}</tr></thead><tbody>${groups.map((group) => `<tr><td>${escapeHTML(group.label)}</td><td>${group.count}</td>${auditsDimension ? "" : `<td>${group.open}</td><td>${group.completed}</td><td>${group.plannedHours.toFixed(1)}h</td><td>${group.loggedHours.toFixed(1)}h</td>`}</tr>`).join("")}</tbody></table>`
    : emptyState("No matrix data yet", "Production tasks and audit outcomes will be grouped here.");
  if (state.complexityMultipliers) {
    const form = $("#complexity-form");
    for (const level of ["Low", "Medium", "High"]) form.elements[level].value = state.complexityMultipliers[level];
  }
  if (state.operations && state.workfrontTasks.length) {
    const ops = state.operations;
    $("#capacity-summary").innerHTML = [
      ["Active assigned production", ops.assignedTasks, "Local + Workfront roster assignments", "accent-blue"],
      ["Known remaining workload", `${ops.resources.reduce((sum, member) => sum + member.remainingHours, 0).toFixed(1)}h`, "Conservative per-resource reservations; shared work may repeat", "accent-green"],
      ["Production risks", ops.risks.length, `${ops.unassignedTasks} unassigned / role-only tasks`, "accent-orange"]
    ].map(([label, value, foot, color]) => `<button type="button" class="metric-card ${color}" data-go="gantt"><span>${escapeHTML(label)}</span><strong class="metric-value">${escapeHTML(value)}</strong><small>${escapeHTML(foot)}</small></button>`).join("");
    const resources = new Map(ops.resources.map((member) => [member.name.toLowerCase(), member]));
    const today = localDate();
    $("#capacity-team-table").innerHTML = `<p class="muted">FIFO availability estimate, not a booking. Multi-person source work reserves full effort per person. Missing hours prevent confirming availability; audit-role capacity is not estimated from production assignments.</p><table><thead><tr><th>Team member</th><th>Role</th><th>Local open tasks</th><th>Planned hours</th><th>Logged hours</th><th>Remaining production workload</th><th>Capacity today</th><th>Estimated available after backlog</th><th>Leave</th></tr></thead><tbody>${state.team.map((member) => {
      const resource = resources.get(member.name.toLowerCase());
      const assigned = tasks.filter((task) => task.assignee === member.name && isOpen(task));
      const planned = assigned.reduce((sum, task) => sum + Number(task.plannedHours || 0), 0);
      const logged = assigned.reduce((sum, task) => sum + Number(task.loggedHours || 0), 0);
      return `<tr><td>${escapeHTML(member.name)}</td><td>${escapeHTML(ROLE_LABELS[member.role] || member.role || "Executioner / Designer")}</td><td>${assigned.length}</td><td>${planned.toFixed(1)}h</td><td>${logged.toFixed(1)}h</td><td>${resource ? `${resource.remainingHours.toFixed(1)}h${resource.unknownTasks ? ` + ${resource.unknownTasks} unknown` : ""}` : "Not tracked for this role"}</td><td>${resource ? `${resource.dailyCapacity}h` : "—"}</td><td>${resource ? resource.unknownTasks ? "Unavailable: missing hours" : `${dateLabel(resource.availableDate)} ${escapeHTML(resource.availableTime || "")}` : "Not tracked for this role"}</td><td>${leaveLabel({ name: member.name }, today)}</td></tr>`;
    }).join("")}</tbody></table>`;
  }
}

const BRIEFING_TASK_PATTERN = /^(build|cr(?:\s*\d+)?|change rounds?)$/i;
const BRIEFING_PRODUCTIVE_HOURS = 7;

function briefingTaskType(name) {
  const value = String(name || "").trim();
  if (/^build$/i.test(value)) return "Build";
  if (/^bug fixing$/i.test(value)) return "Bug fix";
  return "CR";
}

// Workfront planned hours are template defaults, so the AHT matrix estimate is preferred when available.
function briefingRemaining(task) {
  // Workfront planned hours are template values (e.g. 64h per Build), so only the AHT estimate is used.
  const effort = task.ahtHours;
  if (effort === null || effort === undefined || effort === "") return null;
  const planned = Number(effort);
  const progress = task.executionProgress ?? task.percentComplete;
  const hours = Math.max(0, planned - Math.max(Number(task.actualHours || 0), Number(task.executionLoggedHours || 0)));
  return progress === null || progress === undefined ? hours : Math.min(hours, planned * (1 - Number(progress) / 100));
}

// The next working day after today, skipping weekends and holidays.
function tomorrowBriefingDate(today = localDate()) {
  const cursor = new Date(`${today}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  return nextBriefingDays(cursor.toISOString().slice(0, 10), 1)[0];
}

function nextBriefingDays(date, count) {
  const days = [];
  const cursor = new Date(`${date}T00:00:00Z`);
  while (days.length < count) {
    const value = cursor.toISOString().slice(0, 10);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !state.holidays.some((holiday) => holiday.date === value)) days.push(value);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

const BRIEFING_BLOCKED_PROJECT = /^(on hold|pending clarification|pre-audit|audit ongoing)$/i;
const BRIEFING_PAST_BUILD_PROJECT = /^(in qc|pending review|cr pending review|cr in execution)$/i;

// Workfront Builds only count once the project has cleared audit and is in production.
const BRIEFING_BUILD_PRODUCTION_PROJECT = /^(awaiting execution|execution in progress)$/i;

function briefingInQueue(type, projectStatus, source = "local") {
  const status = String(projectStatus || "").trim();
  if (BRIEFING_BLOCKED_PROJECT.test(status)) return false;
  if (source === "workfront" && type === "Build") return BRIEFING_BUILD_PRODUCTION_PROJECT.test(status);
  return type !== "Build" || !BRIEFING_PAST_BUILD_PROJECT.test(status);
}

// Workfront Builds are due on the Material Expected Delivery Date only (planned completion is stale);
// CRs are due on their own Change Request delivery date, never the project's original material date.
function briefingDue(record, ref, plannedDate, mode = "local") {
  const project = (state.workfrontProjects || []).find((item) => normalizeWorkfrontStatus(item.ref) === normalizeWorkfrontStatus(ref));
  const candidates = mode === "cr" ? [[plannedDate, "cr"]]
    : mode === "workfront" ? [[record.materialExpectedDate, "material"], [project?.materialExpectedDate, "material"]]
      : [[record.materialExpectedDate, "material"], [project?.materialExpectedDate, "material"], [plannedDate, "planned"], [project?.dueDate, "planned"]];
  const pick = candidates.find(([date]) => date);
  if (!pick) return { due: "", dueSource: "", movedFrom: "", movedHoliday: "" };
  // A date on a holiday or weekend is not a delivery day; it counts on the next working day.
  const original = String(pick[0]).slice(0, 10);
  const due = nextBriefingDays(original, 1)[0];
  return { due, dueSource: pick[1], movedFrom: due === original ? "" : original, movedHoliday: due === original ? "" : holidayOn(original)?.name || (holidayOn(original) ? "Holiday" : "") };
}

function briefingExecutedNexoRefs() {
  const tasks = [...(state.workfrontTasks || []), ...(state.workfrontGanttTasks || [])];
  const nexoRefs = new Set([
    ...(state.workfrontProjects || []).filter((project) => /\bnexo\b/i.test(project.title || project.projectName || "")).map((project) => normalizeWorkfrontStatus(project.ref)),
    ...tasks.filter((task) => /\bnexo\b/i.test(task.projectName || "")).map((task) => normalizeWorkfrontStatus(task.projectRef))
  ].filter(Boolean));
  return new Set(tasks.filter((task) => nexoRefs.has(normalizeWorkfrontStatus(task.projectRef))
    && normalizeWorkfrontStatus(task.taskName) === "engagement lead review"
    && normalizeWorkfrontStatus(task.taskStatus) === "in progress").map((task) => normalizeWorkfrontStatus(task.projectRef)));
}

function capacityBriefingTasks(teamId, excludedRefs = briefingExecutedNexoRefs()) {
  const closed = /^(completed?|archived|cancell?ed)$/i;
  const byKey = new Map();
  const add = (row) => {
    if (excludedRefs.has(normalizeWorkfrontStatus(row.ref))) return;
    const key = `${normalizeWorkfrontStatus(row.ref)}:${row.type}:${normalizeWorkfrontStatus(row.crId)}`;
    const existing = byKey.get(key);
    if (!existing || (row.remaining ?? -1) > (existing.remaining ?? -1)) byKey.set(key, row);
  };
  for (const task of state.workfrontTasks || []) {
    if (!BRIEFING_TASK_PATTERN.test(String(task.taskName || "").trim())) continue;
    if (closed.test(String(task.executionStatus || task.taskStatus || "").trim())) continue;
    if ((task.productionTeamId || "") !== teamId) continue;
    if (!briefingInQueue(briefingTaskType(task.taskName), task.projectStatus, "workfront")) continue;
    add({ id: task.workfrontId || task.id, source: "Workfront task", ref: task.projectRef, project: task.projectName || "", type: briefingTaskType(task.taskName),
      names: productionTaskNames(task), assetType: task.assetType || "", status: task.executionStatus || task.taskStatus || "", projectStatus: task.projectStatus || "",
      progress: task.executionProgress ?? task.percentComplete ?? null, remaining: briefingRemaining(task),
      ...briefingDue(task, task.projectRef, task.plannedCompletionDate, briefingTaskType(task.taskName) === "CR" ? "cr" : "workfront"), priority: workfrontProjectPriority(task) });
  }
  for (const round of state.workfrontChangeRounds || []) {
    if (!/^(new|assigned to execution|in progress|rework identified|execution in progress)$/i.test(String(round.sourceStatus || "").trim())) continue;
    if ((round.productionTeamId || "") !== teamId) continue;
    add({ id: round.workfrontId || round.id, source: "Workfront change round", ref: round.projectRef, crId: round.crId || "", project: round.title || "", type: "CR",
      names: round.assignee ? [round.assignee] : [], assetType: round.assetType || "", status: round.sourceStatus || "", projectStatus: round.projectStatus || "", progress: null, remaining: briefingRemaining(round),
      ...briefingDue(round, round.projectRef, round.expectedDeliveryDate, "cr"), priority: workfrontProjectPriority(round) });
  }
  for (const task of state.tasks || []) {
    if (!BRIEFING_TASK_PATTERN.test(String(task.category || "").trim()) || closed.test(String(task.status || "").trim())) continue;
    const project = state.projects.find((item) => item.id === task.projectId);
    if ((project?.productionTeamId || "") !== teamId) continue;
    if (!briefingInQueue(briefingTaskType(task.category), project?.status)) continue;
    add({ id: task.id, source: "Local app task", ref: project?.ref || task.projectRef || "", crId: briefingTaskType(task.category) === "CR" ? task.crId || "" : "", project: project?.title || task.title || "", type: briefingTaskType(task.category),
      names: task.assignee ? [task.assignee] : [], assetType: project?.assetType || "", status: task.status || "", projectStatus: project?.status || "",
      progress: task.progress ?? null, remaining: Math.max(0, Number(task.plannedHours || 0) - Number(task.loggedHours || 0)),
      ...briefingDue({ materialExpectedDate: project?.materialExpectedDate }, project?.ref || task.projectRef || "", task.etaDate), priority: workfrontProjectPriority(task) || project?.priority || "" });
  }
  return [...byKey.values()];
}

// Asset audit is counted per Workfront project in the audit stage: Pre-Audit, or Audit (Current / Audit Ongoing).
// Effort is the AHT matrix Channel lead estimate (auditAhtHours) less progress on the project's Asset Audit task.
const BRIEFING_PRE_AUDIT = /^pre-audit$/i;
const BRIEFING_IN_AUDIT = /^(current|audit ongoing)$/i;

function briefingAssetAudits(teamId, excludedRefs = briefingExecutedNexoRefs()) {
  const projects = (state.workfrontProjects || []).filter((project) => (project.productionTeamId || "") === teamId
    && !excludedRefs.has(normalizeWorkfrontStatus(project.ref))
    && (BRIEFING_PRE_AUDIT.test(String(project.sourceStatus || "").trim()) || BRIEFING_IN_AUDIT.test(String(project.sourceStatus || "").trim())));
  const rows = projects.map((project) => {
    const task = (state.workfrontTasks || []).find((item) => /^asset audit$/i.test(String(item.taskName || "").trim())
      && normalizeWorkfrontStatus(item.projectRef) === normalizeWorkfrontStatus(project.ref));
    const effort = project.auditAhtHours ?? task?.auditAhtHours;
    const progress = Math.min(100, Math.max(0, Number(task?.executionProgress ?? task?.percentComplete ?? 0)));
    return { pre: BRIEFING_PRE_AUDIT.test(String(project.sourceStatus || "").trim()), hours: effort === null || effort === undefined ? null : Number(effort) * (1 - progress / 100) };
  });
  const stage = (isPre) => {
    const list = rows.filter((row) => row.pre === isPre);
    return { count: list.length, hours: list.reduce((sum, row) => sum + (row.hours || 0), 0) };
  };
  return { count: rows.length, hours: rows.reduce((sum, row) => sum + (row.hours || 0), 0), unknown: rows.filter((row) => row.hours === null).length,
    audit: stage(false), preAudit: stage(true) };
}

function briefingPendingClarification(teamId, excludedRefs = briefingExecutedNexoRefs()) {
  const pending = /^pending clarification$/i;
  const projects = (state.workfrontProjects || []).filter((project) => (project.productionTeamId || "") === teamId
    && !excludedRefs.has(normalizeWorkfrontStatus(project.ref))
    && pending.test(String(project.sourceStatus || project.status || "").trim()));
  const changeRounds = (state.workfrontChangeRounds || []).filter((round) => (round.productionTeamId || "") === teamId
    && !excludedRefs.has(normalizeWorkfrontStatus(round.projectRef))
    && pending.test(String(round.sourceStatus || "").trim()));
  return {
    projects: projects.map((project) => ({ source: "Workfront project", type: "Project", ref: project.ref || "", crId: "", project: project.title || project.projectName || "",
      status: project.sourceStatus || project.status || "", projectStatus: project.sourceStatus || project.status || "", priority: project.priority || "",
      names: [], due: project.materialExpectedDate || project.dueDate || "" })),
    changeRounds: changeRounds.map((round) => ({ source: "Workfront change round", type: "CR", ref: round.projectRef || "", crId: round.crId || "",
      project: round.title || "", status: round.sourceStatus || "", projectStatus: round.projectStatus || "", priority: workfrontProjectPriority(round),
      names: round.assignee ? [round.assignee] : [], due: round.expectedDeliveryDate || "" }))
  };
}

function capacityBriefing({ teamId, date, productiveHours = BRIEFING_PRODUCTIVE_HOURS }) {
  const [today, ...rest] = nextBriefingDays(date, 6);
  const reportDate = today;
  const nextDate = rest[0];
  const fiveDays = [today, ...rest.slice(0, 4)];
  const isPriorityUrgent = (task) => normalizeWorkfrontStatus(task.priority) === "urgent";
  const isNameUrgent = (task) => /\b(?:NEXO|RICH)\b/i.test(String(task.project || ""));
  const isUrgent = (task) => isPriorityUrgent(task) || isNameUrgent(task);
  const designers = state.team.filter((member) => (member.teamIds || []).includes(teamId) && (!member.role || member.role === "executioner"));
  const availabilityOn = (day) => designers.reduce((sum, member) => sum + memberAvailability(day, member.name), 0);
  const workdayToday = nextBriefingDays(reportDate, 1)[0] === reportDate;
  const availableToday = workdayToday ? designers.filter((member) => memberAvailability(reportDate, member.name) > 0) : [];
  const halfDayToday = workdayToday ? designers.filter((member) => memberAvailability(reportDate, member.name) === 0.5) : [];
  const excludedRefs = briefingExecutedNexoRefs();
  const allTasks = capacityBriefingTasks(teamId, excludedRefs);
  const isEdetailer = (task) => /^e-?detailer$/i.test(String(task.assetType || "").trim());
  const tasks = allTasks;
  const edetailers = teamId === "email" ? allTasks.filter(isEdetailer) : [];
  const hours = (list) => list.reduce((sum, task) => sum + (task.remaining || 0), 0);
  const summary = (list) => {
    const byType = {};
    for (const task of list) {
      byType[task.type] ||= { hours: 0, count: 0 };
      byType[task.type].hours += task.remaining || 0;
      byType[task.type].count += 1;
    }
    const crs = list.filter((task) => task.type === "CR").length;
    const projects = new Set(list.filter((task) => task.type !== "CR").map((task) => task.ref)).size;
    return { hours: hours(list), count: projects + crs, projects, crs, byType, unknown: list.filter((task) => task.remaining === null).length, undated: list.filter((task) => !task.due).length };
  };
  // Due today includes carried-over (overdue) work so Urgent is always a subset of the total due.
  const dueToday = tasks.filter((task) => task.due && task.due <= reportDate);
  const dueNext = tasks.filter((task) => task.due === nextDate);
  const projectsOnly = (list) => list.filter((task) => task.type !== "CR");
  const urgentToday = dueToday.filter((task) => task.type !== "CR" && isUrgent(task));
  const urgentNext = dueNext.filter((task) => task.type !== "CR" && isUrgent(task));
  const upcoming = tasks.filter((task) => task.due && task.due >= reportDate && task.due <= fiveDays.at(-1));
  const leaveDays = fiveDays.reduce((sum, day) => sum + designers.length - availabilityOn(day), 0);
  const capacityToday = workdayToday ? availabilityOn(reportDate) * productiveHours : 0;
  const atRisk = new Set(dueToday);
  const reportProjects = (state.workfrontProjects || []).filter((project) => (project.productionTeamId || "") === teamId
    && !excludedRefs.has(normalizeWorkfrontStatus(project.ref))
    && !/^(completed?|archived|cancell?ed|pending clarification)$/i.test(String(project.sourceStatus || project.status || "").trim())
    && (isPriorityUrgent({ priority: project.priority }) && normalizeWorkfrontStatus(project.sourceStatus || project.status) === "current"
      || /\b(?:NEXO|RICH)\b/i.test(String(project.title || project.projectName || ""))));
  const projectRows = reportProjects.filter((project) => !allTasks.some((task) => task.type === "Build"
    && normalizeWorkfrontStatus(task.ref) === normalizeWorkfrontStatus(project.ref))).map((project) => {
    const name = project.title || project.projectName || "";
    return { id: `urgent-project:${project.ref}`, ref: project.ref, project: name, type: "Project", names: [], assetType: project.assetType || "",
      status: project.sourceStatus || project.status || "", projectStatus: project.sourceStatus || project.status || "", progress: null, remaining: null,
      ...briefingDue(project, project.ref, "", "workfront"), priority: project.priority || "" };
  });
  const knownProjectRefs = new Set((state.workfrontProjects || []).map((project) => normalizeWorkfrontStatus(project.ref)));
  const listedBuildRefs = new Set(allTasks.filter((task) => task.type === "Build").map((task) => normalizeWorkfrontStatus(task.ref)));
  const taskOnlyProjects = new Map();
  for (const task of state.workfrontTasks || []) {
    const ref = normalizeWorkfrontStatus(task.projectRef);
    if (!ref || knownProjectRefs.has(ref) || listedBuildRefs.has(ref) || excludedRefs.has(ref) || taskOnlyProjects.has(ref)) continue;
    if ((task.productionTeamId || "") !== teamId || !/^build$/i.test(String(task.taskName || "").trim())) continue;
    if (!/\b(?:NEXO|RICH)\b/i.test(task.projectName || "")) continue;
    if (/^(completed?|archived|cancell?ed)$/i.test(String(task.executionStatus || task.taskStatus || "").trim())
      || /^(completed?|archived|cancell?ed|pending clarification)$/i.test(String(task.projectStatus || "").trim())) continue;
    taskOnlyProjects.set(ref, { id: `urgent-project:${task.projectRef}`, source: "Workfront task", ref: task.projectRef,
      project: task.projectName, type: "Project", names: productionTaskNames(task), assetType: task.assetType || "",
      status: task.executionStatus || task.taskStatus || "", projectStatus: task.projectStatus || "", progress: null, remaining: null,
      ...briefingDue(task, task.projectRef, "", "workfront"), priority: workfrontProjectPriority(task) });
  }
  projectRows.push(...taskOnlyProjects.values());
  const urgentTasks = allTasks.filter(isUrgent);
  const urgentList = [...urgentTasks, ...projectRows].sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || String(a.ref).localeCompare(String(b.ref)));
  const namedUrgentList = urgentList.filter(isNameUrgent);
  const priorityUrgentList = urgentList.filter((task) => isPriorityUrgent(task) && !isNameUrgent(task));
  const pendingClarification = briefingPendingClarification(teamId, excludedRefs);
  const onLeaveList = workdayToday ? designers.filter((member) => memberAvailability(reportDate, member.name) < 1).map((member) => {
    const leave = state.leaves.find((item) => item.status === "Approved" && item.assignee === member.name && leaveCoversDate(item, reportDate));
    const key = member.name.toLowerCase();
    const memberTasks = allTasks.filter((task) => task.names.some((name) => String(name).toLowerCase() === key))
      .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || String(a.ref).localeCompare(String(b.ref)));
    return { name: member.name, teamId, leaveType: [leave?.type || "Away", leaveDurationLabel(leave)].filter(Boolean).join(" · "), leave: leave ? `${briefingDateLabel(leave.startDate)}${leave.endDate && leave.endDate !== leave.startDate ? ` – ${briefingDateLabel(leave.endDate)}` : ""}` : "", tasks: memberTasks, hours: hours(memberTasks) };
  }) : [];
  return {
    teamId, reportDate, nextDate, fiveDays, productiveHours,
    preparedOn: localDate(), requestedDate: date, requestedHoliday: reportDate === date ? null : holidayOn(date),
    team: teamId === "email" ? "Email + eDetailer Team" : state.departments.find((department) => department.id === teamId)?.name || teamId,
    designers: designers.length, available: availableToday.length, onLeaveToday: designers.length - availableToday.length, halfDayToday: halfDayToday.length,
    capacityToday,
    backlog: summary(tasks),
    backlogProjects: summary(projectsOnly(tasks)),
    dueToday: { ...summary(dueToday), overdue: dueToday.filter((task) => task.due < reportDate).length }, dueNext: summary(dueNext),
    dueTodayProjects: { ...summary(projectsOnly(dueToday)), overdue: projectsOnly(dueToday).filter((task) => task.due < reportDate).length },
    dueNextProjects: summary(projectsOnly(dueNext)),
    urgentToday: { ...summary(urgentToday), overdue: urgentToday.filter((task) => task.due < reportDate).length },
    urgentNext: summary(urgentNext),
    eDetailer: teamId === "email" ? {
      backlog: summary(edetailers),
      dueToday: summary(edetailers.filter((task) => task.due && task.due <= reportDate)),
      fiveDay: summary(edetailers.filter((task) => task.due && task.due >= reportDate && task.due <= fiveDays.at(-1))),
      nextDue: edetailers.map((task) => task.due).filter(Boolean).sort()[0] || ""
    } : null,
    fiveDayCapacity: fiveDays.reduce((sum, day) => sum + availabilityOn(day) * productiveHours, 0),
    assetAudit: teamId === "email" ? briefingAssetAudits(teamId, excludedRefs) : null,
    leaveDays,
    fiveDayTasks: summary(upcoming),
    fiveDayProjectTasks: summary(projectsOnly(upcoming)),
    todayRisk: capacityToday - hours([...atRisk]),
    urgentList,
    priorityUrgentList,
    namedUrgentList,
    pendingClarification,
    sourceTasks: allTasks,
    sourceUrgentProjects: projectRows,
    onLeaveList
  };
}

function formatBriefingLeaveDays(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(1);
}

function briefingDateLabel(value, withYear = false) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) }).format(new Date(`${value}T00:00:00`));
}

function formatBriefingHours(value) {
  const rounded = Math.round(Number(value || 0) * 100) / 100;
  return Math.round(rounded * 10) === rounded * 10 ? rounded.toFixed(1) : rounded.toFixed(2);
}

// Deliverables are projects (Build) and CRs, never individual Workfront tasks.
function briefingDeliverables(summary) {
  return `${summary.projects} project${summary.projects === 1 ? "" : "s"} · ${summary.crs} CR${summary.crs === 1 ? "" : "s"}`;
}

function briefingTypeLine(summary) {
  const parts = Object.entries(summary.byType).map(([type, value]) => `${type === "Build" ? "Projects" : type === "CR" ? "CRs" : type}: ${formatBriefingHours(value.hours)}h`);
  return `${briefingDeliverables(summary)}${parts.length > 1 ? ` (${parts.join(" · ")})` : ""}`;
}

function briefingProjectLine(summary) {
  return `${summary.projects} project${summary.projects === 1 ? "" : "s"}`;
}

function capacityBriefingSourceRows(report) {
  const columns = ["Record category", "Data source", "Team", "Report date", "Type", "Project reference", "CR ID", "Project name",
    "Status", "Project status", "Priority", "Assignee", "Due date", "Due date source", "Remaining effort hours", "Dashboard treatment"];
  const rows = [
    ...report.sourceTasks.map((item) => ["Capacity work item", item.source || "Workfront", report.team, report.reportDate, item.type, item.ref, item.crId || "",
      item.project, item.status, item.projectStatus, item.priority, item.names.join("; "), item.due, item.dueSource, item.remaining,
      report.teamId === "email" && /^e-?detailer$/i.test(String(item.assetType || "")) ? "Included in Email + eDetailer totals; eDetailer breakdown is informational, not additional capacity" : "Included in capacity work figures"]),
    ...report.sourceUrgentProjects.map((item) => ["Urgent project without production task", item.source || "Workfront project", report.team, report.reportDate, item.type, item.ref, "",
      item.project, item.status, item.projectStatus, item.priority, "", item.due, item.dueSource, "", "Urgent list only; excluded from capacity work figures"]),
    ...report.pendingClarification.projects.map((item) => ["Pending clarification", item.source, report.team, report.reportDate, item.type, item.ref, item.crId,
      item.project, item.status, item.projectStatus, item.priority, item.names.join("; "), item.due, "Workfront source date", "",
      "Separate pending clarification project card; excluded from capacity work figures"]),
    ...report.pendingClarification.changeRounds.map((item) => ["Pending clarification", item.source, report.team, report.reportDate, item.type, item.ref, item.crId,
      item.project, item.status, item.projectStatus, item.priority, item.names.join("; "), item.due, "Workfront source date", "",
      "Separate pending clarification CR card; excluded from capacity work figures"])
  ];
  return [columns, ...rows];
}

function capacityBriefingSourceCsv(report) {
  const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return capacityBriefingSourceRows(report).map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function capacityBriefingXlsx(report) {
  const sourceRows = capacityBriefingSourceRows(report);
  const columns = sourceRows[0];
  const rows = sourceRows.slice(1);
  const xml = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const columnName = (index) => {
    let name = "";
    for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
    return name;
  };
  const sheetRows = [columns, ...rows].map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => {
    const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
    return typeof value === "number" ? `<c r="${reference}"><v>${value}</v></c>` : `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  }).join("")}</row>`).join("");
  const files = {
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Briefing Source Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`
  };
  return window.fflate.zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, new TextEncoder().encode(value)])));
}

function capacityBriefingHtml(report, notes = {}) {
  const font = "font-family:Segoe UI,Arial,Helvetica,sans-serif;";
  const memberLabel = ["email", "web", "edetailer"].includes(report.teamId) ? "developer" : "designer";
  const cell = (label, value, foot, color, unit = "hrs") => `<td width="300" valign="top" style="${font}width:300px;border:1px solid #cfd6e0;padding:10px 12px;"><div style="font-size:11px;font-weight:700;letter-spacing:.3px;color:${color};text-transform:uppercase;">${escapeHTML(label)}</div><div style="font-size:22px;font-weight:700;color:${color};margin:6px 0 4px;">${escapeHTML(unit === "hrs" ? formatBriefingHours(value) : String(value))} <span style="font-size:12px;font-weight:600;color:#4b5563;">${escapeHTML(unit)}</span></div><div style="font-size:12px;color:#4b5563;">${escapeHTML(foot)}</div></td>`;
  const row = (left, right) => `<tr>${left}${right}</tr>`;
  const list = (text) => {
    const items = String(text || "").split(/\n+/).map((item) => item.trim()).filter(Boolean);
    return items.length ? `<ol style="${font}font-size:13px;color:#111827;margin:6px 0 16px 22px;padding:0;">${items.map((item) => `<li style="margin:2px 0;">${escapeHTML(item)}</li>`).join("")}</ol>` : `<p style="${font}font-size:13px;color:#6b7280;margin:6px 0 16px;">None noted.</p>`;
  };
  const proposed = notes.proposed || {};
  const risk = report.todayRisk;
  const riskColor = risk < 0 ? "#b91c1c" : "#047857";
  const riskBg = risk < 0 ? "#fde8e8" : "#e7f6ee";
  const th = (label, align = "left") => `<th style="${font}font-size:10px;text-align:${align};padding:5px 5px;white-space:normal;letter-spacing:0;text-transform:none;background:#e8edf5;border:1px solid #cfd6e0;color:#1f2937;">${label}</th>`;
  const td = (value, align = "left") => `<td style="${font}font-size:11px;text-align:${align};padding:5px 5px;word-wrap:break-word;overflow-wrap:anywhere;border:1px solid #cfd6e0;color:#111827;">${value}</td>`;
  const dueCell = (task) => {
    if (!task.due) return "—";
    const label = `${escapeHTML(briefingDateLabel(task.due))}${task.dueSource === "planned" ? "*" : ""}`;
    return task.movedFrom ? `${label}<div style="margin-top:3px;padding:2px 5px;background:#fef3c7;border:1px solid #f59e0b;color:#92400e;font-size:11px;">${escapeHTML(briefingDateLabel(task.movedFrom))} is ${escapeHTML(task.movedHoliday || "a non-working day")} → next working day</div>` : label;
  };
  const urgentRows = (tasks) => tasks.map((task) => `<tr>${td(`${escapeHTML(task.type)} · ${escapeHTML(task.ref)}`)}${td(escapeHTML(task.project))}${td(escapeHTML(task.names.join(", ") || "Unassigned"))}${td(`${escapeHTML(task.status || "—")}${task.progress !== null && task.progress !== undefined ? ` (${escapeHTML(Math.round(task.progress))}%)` : ""}`)}${td(task.remaining === null ? "Not set" : `${escapeHTML(formatBriefingHours(task.remaining))} hrs`, "right")}${td(dueCell(task))}${td(escapeHTML(proposed[task.id] ? briefingDateLabel(proposed[task.id]) : ""))}</tr>`).join("");
  const urgentTable = (tasks) => `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;table-layout:fixed;"><colgroup><col width="70"><col width="149"><col width="80"><col width="80"><col width="55"><col width="85"><col width="80"></colgroup><thead><tr>${th("Type · task")}${th("Project")}${th("Assignee")}${th("Status")}${th("Effort", "right")}${th("Project due")}${th("Proposed date")}</tr></thead><tbody>${urgentRows(tasks)}</tbody></table>`;
  // Fixed 600px email width; the outer table keeps Outlook from stretching the layout.
  return `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:600px;max-width:600px;table-layout:fixed;"><tr><td style="${font}width:600px;padding:0;border:0;color:#111827;word-wrap:break-word;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:14px;"><tr><td valign="top" style="${font}"><div style="font-size:11px;font-weight:700;letter-spacing:.6px;color:#6b7fd7;">WPP PRODUCTION · ${escapeHTML(report.team.toUpperCase())}</div><div style="font-size:22px;font-weight:700;color:#111827;margin:4px 0;">${escapeHTML(report.team.replace(/\s*Team$/i, ""))} Capacity &amp; Delivery Briefing</div><div style="font-size:12px;color:#6b7280;">Reporting date: ${escapeHTML(briefingDateLabel(report.reportDate, true))}${report.preparedOn && report.reportDate > report.preparedOn ? ` <span style="background:#e0f2fe;color:#075985;padding:1px 5px;">Advance report · prepared ${escapeHTML(briefingDateLabel(report.preparedOn))}</span>` : ""}${report.requestedDate !== report.reportDate ? ` <span style="background:#fef3c7;color:#92400e;padding:1px 5px;">(${escapeHTML(briefingDateLabel(report.requestedDate))} is ${escapeHTML(report.requestedHoliday?.name || "a non-working day")} — next working day used)</span>` : ""} · Production scope: ${escapeHTML(report.team)} project cards${report.eDetailer ? " (eDetailer shown separately)" : ""}</div></td><td width="140" align="right" valign="top"><table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><td style="${font}background:${riskBg};border:1px solid ${riskColor};padding:8px 14px;text-align:center;"><div style="font-size:11px;font-weight:700;color:${riskColor};">${risk < 0 ? "▲ TODAY RISK" : "TODAY HEADROOM"}</div><div style="font-size:18px;font-weight:700;color:${riskColor};">${risk < 0 ? "−" : "+"}${escapeHTML(formatBriefingHours(Math.abs(risk)))} HRS</div></td></tr></table></td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:18px;">
${row(cell(`Total team capacity available (${briefingDateLabel(report.reportDate)})`, report.capacityToday, `${report.available} available ${memberLabel}${report.available === 1 ? "" : "s"} × ${report.productiveHours} hrs${report.halfDayToday ? ` (${report.halfDayToday} half day)` : ""}${report.onLeaveToday ? ` · ${report.onLeaveToday} on leave / away` : ""}${report.teamId === "email" ? " · Shared Email + eDetailer capacity (counted once)" : ""}`, "#111827"),
  cell(`Total ${report.team.replace(/\s*Team$/i, "").toLowerCase()} backlog (in queue)`, report.backlogProjects.hours, `${briefingProjectLine(report.backlogProjects)}${report.backlogProjects.unknown ? ` · ${report.backlogProjects.unknown} without AHT estimate` : ""}${report.backlogProjects.undated ? ` · ${report.backlogProjects.undated} without delivery date` : ""}`, "#047857"))}
${row(cell(`Total project due today (${briefingDateLabel(report.reportDate)})`, report.dueTodayProjects.hours, `${briefingProjectLine(report.dueTodayProjects)}${report.dueTodayProjects.overdue ? ` · incl. ${report.dueTodayProjects.overdue} overdue` : ""}`, "#4f46e5"),
  cell(`Total project due (${briefingDateLabel(report.nextDate)})`, report.dueNextProjects.hours, briefingProjectLine(report.dueNextProjects), "#4f46e5"))}
${row(cell(`Of which urgent projects — due today (${briefingDateLabel(report.reportDate)})`, report.urgentToday.hours, `${briefingProjectLine(report.urgentToday)}${report.urgentToday.overdue ? ` · ${report.urgentToday.overdue} overdue` : ""}`, "#c2410c"),
  cell(`Of which urgent projects — due (${briefingDateLabel(report.nextDate)})`, report.urgentNext.hours, briefingProjectLine(report.urgentNext), "#c2410c"))}
${row(cell("Next 5 days capacity", report.fiveDayCapacity, `${formatBriefingLeaveDays(report.leaveDays)} planned leave day${report.leaveDays === 1 ? "" : "s"} · ${briefingDateLabel(report.fiveDays[0])} – ${briefingDateLabel(report.fiveDays.at(-1))}`, "#0e7490"),
  cell("Next 5 days projects due", report.fiveDayProjectTasks.hours, `${briefingProjectLine(report.fiveDayProjectTasks)} due`, "#0e7490"))}
${row(cell("Pending clarification · projects", report.pendingClarification.projects.length, "", "#b45309", report.pendingClarification.projects.length === 1 ? "project" : "projects"),
  cell("Pending clarification · CRs", report.pendingClarification.changeRounds.length, "", "#b45309", report.pendingClarification.changeRounds.length === 1 ? "CR" : "CRs"))}
${report.eDetailer ? row(cell("eDetailer backlog (included in totals)", report.eDetailer.backlog.hours, `${briefingProjectLine(report.eDetailer.backlog)}${report.eDetailer.nextDue ? ` · next due ${briefingDateLabel(report.eDetailer.nextDue)}` : ""}${report.eDetailer.backlog.unknown ? ` · ${report.eDetailer.backlog.unknown} without AHT estimate` : ""}`, "#be185d"),
  cell("eDetailer due today / next 5 days", report.eDetailer.fiveDay.hours, `Today: ${formatBriefingHours(report.eDetailer.dueToday.hours)} hrs (${briefingProjectLine(report.eDetailer.dueToday)}) · 5 days: ${briefingProjectLine(report.eDetailer.fiveDay)}`, "#be185d")) : ""}
${report.assetAudit ? row(cell("Asset audit — total projects", report.assetAudit.count, `Audit: ${report.assetAudit.audit.count} · Pre-Audit: ${report.assetAudit.preAudit.count}`, "#7c3aed", report.assetAudit.count === 1 ? "project" : "projects"),
  cell("Asset audit — total effort", report.assetAudit.hours, `Audit: ${formatBriefingHours(report.assetAudit.audit.hours)}h · Pre-Audit: ${formatBriefingHours(report.assetAudit.preAudit.hours)}h${report.assetAudit.unknown ? ` · ${report.assetAudit.unknown} without estimate` : ""}`, "#7c3aed")) : ""}
</table>
<div style="${font}font-size:14px;font-weight:700;color:#111827;">ACTION PLANNED TO MANAGE RISK</div>${list(notes.actions)}
<div style="${font}font-size:14px;font-weight:700;color:#111827;">SUPPORT REQUIRED</div>${list(notes.support)}
<div style="${font}font-size:14px;font-weight:700;color:#111827;margin-bottom:6px;">URGENT TASK LIST · PRIORITY</div>
${report.priorityUrgentList.length ? urgentTable(report.priorityUrgentList) : `<p style="${font}font-size:13px;color:#6b7280;">No open Urgent-priority projects or CRs.</p>`}
<div style="${font}font-size:14px;font-weight:700;color:#111827;margin:12px 0 6px;">ALSO URGENT · NEXO / RICH PROJECTS</div>
${report.namedUrgentList.length ? urgentTable(report.namedUrgentList) : `<p style="${font}font-size:13px;color:#6b7280;">No open NEXO or RICH projects.</p>`}
${report.urgentList.some((task) => task.dueSource === "planned") ? `<p style="${font}font-size:11px;color:#6b7280;">* No Material Expected Delivery Date in Workfront; planned completion date used.</p>` : ""}
</td></tr></table>`;
}

function briefingNotesKey(teamId, date) {
  return `capacityBriefing:${teamId}:${date}`;
}

function readBriefingNotes(teamId, date) {
  try {
    return JSON.parse(localStorage.getItem(briefingNotesKey(teamId, date)) || "{}");
  } catch {
    return {};
  }
}

function briefingTeamDefault() {
  const own = ["manager", "leadership"].includes(state.user?.role) ? "" : (state.user?.teamIds || []).find((id) => id !== "qa");
  return state.capacityReportTeam || own || "design";
}

function currentBriefing() {
  const form = $("#briefing-form");
  const teamId = form?.elements.teamId.value || briefingTeamDefault();
  const date = form?.elements.date.value || localDate();
  const notes = readBriefingNotes(teamId, date);
  notes.actions = form?.elements.actions.value ?? notes.actions;
  notes.support = form?.elements.support.value ?? notes.support;
  const productiveHours = Number(form?.elements.productiveHours.value) || BRIEFING_PRODUCTIVE_HOURS;
  return { report: capacityBriefing({ teamId, date, productiveHours }), notes };
}

function renderCapacityBriefing({ syncInputs = false } = {}) {
  const form = $("#briefing-form");
  if (!form || !state.roleCapabilities.viewAht) return;
  const teams = (state.departments || []).filter((department) => department.id !== "qa"
    && (["manager", "leadership"].includes(state.user.role) || (state.user.teamIds || []).includes(department.id) || (state.user.teamIds || []).includes("qa")));
  const select = form.elements.teamId;
  const selected = select.value || briefingTeamDefault();
  select.innerHTML = teams.map((department) => `<option value="${escapeHTML(department.id)}">${escapeHTML(department.id === "email" ? "Email + eDetailer Team" : department.name)}</option>`).join("");
  select.value = teams.some((department) => department.id === selected) ? selected : teams[0]?.id || "";
  if (!form.elements.date.value) form.elements.date.value = nextBriefingDays(localDate(), 1)[0];
  if (syncInputs) {
    const saved = readBriefingNotes(select.value, form.elements.date.value);
    form.elements.actions.value = saved.actions || "";
    form.elements.support.value = saved.support || "";
  }
  const { report, notes } = currentBriefing();
  const proposed = notes.proposed || {};
  const urgentDateTable = (title, tasks) => tasks.length
    ? `<h3>${title}</h3><table><thead><tr><th>Task</th><th>Material expected</th><th>Proposed delivery date</th></tr></thead><tbody>${tasks.map((task) => `<tr><td><strong>${escapeHTML(task.type)} · ${escapeHTML(task.ref)}</strong><small>${escapeHTML(task.project)}</small></td><td>${task.due ? dateLabel(task.due) : "—"}${task.movedFrom ? `<small class="holiday-flag">${escapeHTML(dateLabel(task.movedFrom))} is ${escapeHTML(task.movedHoliday || "a non-working day")}</small>` : ""}</td><td><input type="date" aria-label="Proposed delivery date for ${escapeHTML(task.ref)}" data-briefing-proposed="${escapeHTML(task.id)}" value="${escapeHTML(proposed[task.id] || "")}"></td></tr>`).join("")}</tbody></table>`
    : "";
  $("#briefing-urgent-dates").innerHTML = report.urgentList.length
    ? `${urgentDateTable("Urgent by priority", report.priorityUrgentList)}${urgentDateTable("Also urgent · NEXO / RICH projects", report.namedUrgentList)}`
    : '<p class="muted">No open urgent projects for this team.</p>';
  $("#briefing-preview").innerHTML = capacityBriefingHtml(report, notes);
}

function saveBriefingNotes() {
  const form = $("#briefing-form");
  const teamId = form.elements.teamId.value;
  const date = form.elements.date.value;
  const notes = readBriefingNotes(teamId, date);
  notes.actions = form.elements.actions.value;
  notes.support = form.elements.support.value;
  notes.proposed = Object.fromEntries($$("[data-briefing-proposed]").filter((input) => input.value).map((input) => [input.dataset.briefingProposed, input.value]));
  try {
    localStorage.setItem(briefingNotesKey(teamId, date), JSON.stringify(notes));
  } catch {
    // Storage may be unavailable in private browsing; the preview still updates.
  }
}

function briefingSubject(report) {
  return `${report.team.replace(/\s*Team$/i, "")} Capacity & Delivery Briefing – ${briefingDateLabel(report.reportDate, true)}`;
}

function briefingBase64Lines(value) {
  return btoa(unescape(encodeURIComponent(value))).match(/.{1,76}/g)?.join("\r\n") || "";
}

function capacityBriefingEmailMessage(report, notes, to) {
  const subject = briefingSubject(report).replace(/[\r\n]+/g, " ");
  const encodedSubject = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
  const body = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${capacityBriefingHtml(report, notes)}</body></html>`;
  const boundary = `capacity-briefing-${Date.now()}`;
  const sourceCsv = capacityBriefingSourceCsv(report);
  const attachmentName = `${report.team.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}-capacity-briefing-source-${report.reportDate}.csv`;
  return [`To: ${to}`, `Subject: ${encodedSubject}`, "X-Unsent: 1", "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", briefingBase64Lines(body),
    `--${boundary}`, `Content-Type: text/csv; charset=UTF-8; name="${attachmentName}"`, `Content-Disposition: attachment; filename="${attachmentName}"`,
    "Content-Transfer-Encoding: base64", "", briefingBase64Lines(sourceCsv), `--${boundary}--`, ""].join("\r\n");
}

async function copyCapacityBriefing() {
  const { report, notes } = currentBriefing();
  const html = capacityBriefingHtml(report, notes);
  const plain = $("#briefing-preview").innerText;
  try {
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([plain], { type: "text/plain" })
    })]);
  } catch {
    const range = document.createRange();
    range.selectNodeContents($("#briefing-preview"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("copy");
    selection.removeAllRanges();
  }
  showToast("Briefing copied. Paste it into a new Outlook email.");
}

function downloadCapacityBriefingEmail() {
  const { report, notes } = currentBriefing();
  const to = $("#briefing-form").elements.recipients.value.replace(/[\r\n]+/g, " ").trim();
  try {
    localStorage.setItem("capacityBriefing:recipients", to);
  } catch {
    // Recipient memory is optional.
  }
  const eml = capacityBriefingEmailMessage(report, notes, to);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([eml], { type: "message/rfc822" }));
  link.download = `${report.team.replace(/\s+/g, "-")}-capacity-briefing-${report.reportDate}.eml`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("Email draft downloaded with the briefing source-data CSV attached. Open it in Outlook, review, and send.");
}

function downloadCapacityBriefingSource() {
  const { report } = currentBriefing();
  const workbook = capacityBriefingXlsx(report);
  const team = report.team.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([workbook], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  link.download = `${team}-capacity-briefing-source-${report.reportDate}.xlsx`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("Briefing source-data Excel report downloaded.");
}

function setCapacityTab(tab, { render = true } = {}) {
  state.capacityTab = tab;
  $$("[data-capacity-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.capacityTab === tab);
    button.setAttribute("aria-selected", String(button.dataset.capacityTab === tab));
  });
  $$("[data-capacity-pane]").forEach((pane) => { pane.hidden = pane.dataset.capacityPane !== tab; });
  if (tab === "report" && render) renderCapacityBriefing({ syncInputs: true });
}

function productionTaskNames(task) {
  const names = task.assignmentNames ?? String(task.assignees || "").split(";");
  const unique = new Map();
  for (const name of names) {
    if (typeof name !== "string") continue;
    const trimmed = name.trim().replace(/,\s*Role \/ team$/i, "").trim();
    const key = normalizeWorkfrontStatus(trimmed);
    if (key && key !== "unassigned" && !trimmed.includes("|") && !/,\s*(Job Role|Team)$/i.test(trimmed) && !unique.has(key)) unique.set(key, trimmed);
  }
  return [...unique.values()];
}

const GANTT_TASK_PATTERN = /^(Build|CR(?:\s*\d+)?|Change Rounds?|Bug Fixing|QA(?:\s.*)?|Quality Assurance.*)$/i;
const GANTT_OTHER_GROUP = "Other / Unassigned";

function ganttCrWindow(task) {
  if (task.localTask || task.category && !task.taskName) return null;
  if (!task.changeRound && !/^(CR(?:\s*\d+)?|Change Rounds?)$/i.test(task.taskName || task.category || "")) return null;
  const rounds = state.workfrontChangeRounds.filter((round) => normalizeWorkfrontStatus(round.projectRef) === normalizeWorkfrontStatus(task.projectRef));
  const crId = normalizeWorkfrontStatus(task.crId || (/^CR\s*\d+$/i.test(task.taskName || "") ? task.taskName : "")).replace(/\s/g, "");
  const round = task.changeRound ? task : crId
    ? rounds.find((item) => normalizeWorkfrontStatus(item.crId).replace(/\s/g, "") === crId)
    : rounds.length === 1 ? rounds[0] : null;
  return { acceptanceDate: task.acceptanceDate || round?.acceptanceDate || "", expectedDeliveryDate: task.expectedDeliveryDate || round?.expectedDeliveryDate || "" };
}

function ganttDate(value) {
  const date = value ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value) : null;
  return date && Number.isFinite(date.getTime()) ? localDate(date) : "";
}

function ganttDateTimeLabel(value) {
  const date = ganttDate(value);
  if (!date) return "Unavailable";
  if (!String(value).includes("T")) return dateLabel(date);
  return `${dateLabel(date)} ${new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

function ganttEffort(task) {
  const hours = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const qaOnly = /^(QA(?:\s.*)?|Quality Assurance.*)$/i.test(task.taskName || task.category || "");
  const production = qaOnly ? 0 : hours(task.productionHours ?? task.ahtHours);
  const qa = task.qaEstimateUnavailable ? null : hours(task.qaBufferHours ?? task.qaAhtHours);
  return { production, qa, label: `Build / production AHT: ${production === null ? "Unavailable" : `${production.toFixed(1)}h`} · QA AHT: ${qa === null ? "Unavailable" : `${qa.toFixed(1)}h`}` };
}

function ganttEffortFill(task, left, width, shownLeft, shownWidth) {
  const { production, qa } = ganttEffort(task);
  if (production === null || qa === null || production + qa <= 0) return "";
  const split = left + width * production / (production + qa);
  const segment = (className, start, end) => {
    const visibleStart = Math.max(start, shownLeft);
    const visibleEnd = Math.min(end, shownLeft + shownWidth);
    return visibleEnd > visibleStart ? `<span class="${className}" style="left:${(visibleStart - shownLeft) / shownWidth * 100}%;width:${(visibleEnd - visibleStart) / shownWidth * 100}%"></span>` : "";
  };
  return segment("gantt-build-effort", left, split) + segment("gantt-qa-buffer", split, left + width);
}

function ganttRosterMember(name) {
  return state.team.find((member) => normalizeWorkfrontStatus(member.name) === normalizeWorkfrontStatus(name));
}

function ganttMemberInTeam(name, teamId) {
  if (!teamId) return true;
  const member = ganttRosterMember(name);
  const teams = member?.teamIds || [];
  return teamId === "unassigned" ? !teams.length : teams.includes(teamId);
}

function completedByDate(isCompleted, completionDate, startDate) {
  return isCompleted && (!completionDate || ganttDate(completionDate) <= startDate);
}

function timelineMarkers(task, columnIndex, columns, scale, startDate) {
  return [["material", task.materialExpectedDate], ["completion", task.crSla ? task.expectedDeliveryDate : task.plannedCompletionDate || task.etaDate], ["actual", task.actualCompletionDate]].map(([kind, date]) => {
    const dateOnly = ganttDate(date);
    if (!dateOnly || scale === "hour" && dateOnly !== startDate) return "";
    const timestamp = String(date).includes("T") ? new Date(date) : null;
    const minutes = timestamp ? timestamp.getHours() * 60 + timestamp.getMinutes() : null;
    const index = scale === "hour" ? minutes === null ? columns.length - 0.15 : (minutes - 690) / 30
      : columnIndex(dateOnly) + (scale === "day" && minutes !== null ? minutes / 1440 : 0.5);
    return index >= 0 && index < columns.length ? `<span class="timeline-marker ${kind}" style="--marker-left:${index}" title="${kind}: ${escapeHTML(ganttDateTimeLabel(date))}"></span>` : "";
  }).join("");
}

function renderWorkfrontGantt(columns, columnIndex, scale, groupBy, startDate, unitWidth) {
  const all = $("#gantt-source").value === "all";
  const parents = new Map([...state.workfrontProjects, ...(all ? state.projects : [])].map((project) => [normalizeWorkfrontStatus(project.ref), project]));
  const teamId = $("#gantt-team-filter").value;
  const imported = [...state.workfrontTasks, ...(state.workfrontGanttTasks || [])];
  const changeRounds = state.workfrontChangeRounds.map((round) => ({
    ...round,
    changeRound: true,
    taskName: /^CR(?:\s*\d+)?$/i.test(round.crId || "") ? round.crId : "CR",
    taskStatus: round.executionStatus || round.sourceStatus || "Unspecified",
    projectName: parents.get(normalizeWorkfrontStatus(round.projectRef))?.title || round.title,
    productionTeamId: round.productionTeamId || parents.get(normalizeWorkfrontStatus(round.projectRef))?.productionTeamId,
    assignmentNames: round.assignee ? [round.assignee] : [],
    plannedStartDate: ganttDate(round.acceptanceDate),
    plannedCompletionDate: ganttDate(round.expectedDeliveryDate),
    actualCompletionDate: String(round.actualCompletionDate || round.completionDate || "").slice(0, 10)
  }));
  const local = all ? state.tasks.filter((task) => {
    const project = state.projects.find((item) => item.id === task.projectId);
    return !imported.some((source) => productionTaskNames(source).length && normalizeWorkfrontStatus(source.projectRef) === normalizeWorkfrontStatus(project?.ref || task.projectRef)
      && normalizeWorkfrontStatus(source.taskName) === normalizeWorkfrontStatus(task.category));
  }).map((task) => {
    const project = state.projects.find((item) => item.id === task.projectId);
    return { ...task, localTask: true, taskName: task.category, taskStatus: task.status, assignmentNames: [task.assignee],
      projectRef: project?.ref || task.projectRef, projectName: project?.title || task.projectTitle,
      plannedStartDate: task.startDate, plannedCompletionDate: task.etaDate, percentComplete: task.progress,
      materialExpectedDate: state.workfrontProjects.find((item) => item.ref === project?.ref)?.materialExpectedDate,
      qaAhtHours: task.qaBufferHours };
  }) : [];
  const completed = (task) => ["complete", "completed", "qa completed"].includes(normalizeWorkfrontStatus(task.executionStatus || task.taskStatus));
  const teamNames = (task) => productionTaskNames(task).filter((name) => ganttRosterMember(name) && ganttMemberInTeam(name, teamId));
  const inSelectedTeam = (task) => {
    if (!teamId) return true;
    const names = productionTaskNames(task);
    const members = names.filter(ganttRosterMember);
    if (teamId === "unassigned") return !names.length || names.some((name) => ganttMemberInTeam(name, teamId));
    if (members.length) return teamNames(task).length > 0;
    return (task.productionTeamId || parents.get(normalizeWorkfrontStatus(task.projectRef))?.productionTeamId) === teamId;
  };
  let hiddenCompleted = 0;
  const tasks = [...imported, ...changeRounds, ...local].map((task) => {
    const crWindow = ganttCrWindow(task);
    return crWindow ? { ...task, ...crWindow, crSla: true, plannedStartDate: ganttDate(crWindow.acceptanceDate),
      plannedCompletionDate: ganttDate(crWindow.expectedDeliveryDate), materialExpectedDate: crWindow.expectedDeliveryDate } : task;
  }).filter((task) => {
    const parent = parents.get(normalizeWorkfrontStatus(task.projectRef));
    const visible = GANTT_TASK_PATTERN.test(task.taskName)
      && inSelectedTeam(task)
      && (!$("#gantt-status-filter").value || (task.taskStatus || "Unspecified") === $("#gantt-status-filter").value)
      && (!$("#gantt-project-status-filter").value || (parent?.sourceStatus || parent?.status || "Unspecified") === $("#gantt-project-status-filter").value);
    if (visible && completedByDate(completed(task), task.actualCompletionDate || task.plannedCompletionDate, startDate)) {
      hiddenCompleted += 1;
      return false;
    }
    return visible;
  });
  const scheduled = (task) => Boolean(task.plannedStartDate && task.plannedCompletionDate && task.plannedStartDate <= task.plannedCompletionDate
    && (!task.crSla || new Date(task.acceptanceDate) <= new Date(task.expectedDeliveryDate)));
  const assignment = (task) => productionTaskNames(task).join("; ") || "Unassigned / role-only";
  const open = tasks.filter((task) => !completed(task));
  $("#gantt-summary").innerHTML = [
    ["Workfront tasks", tasks.length, `${open.length} open · ${tasks.filter(completed).length} completed`, "accent-blue"],
    ["Assignments", new Set(tasks.flatMap(teamNames).map(normalizeWorkfrontStatus)).size, `${tasks.filter((task) => !teamNames(task).length).length} Other / Unassigned tasks listed at the bottom`, "accent-purple"],
    ["Planned dates", tasks.filter(scheduled).length, `${tasks.filter((task) => !scheduled(task)).length} without usable dates`, "accent-orange"]
  ].map(([label, value, foot, color]) => `<div class="metric-card ${color}"><span class="metric-label">${escapeHTML(label)}</span><strong class="metric-value">${escapeHTML(value)}</strong><span class="metric-foot">${escapeHTML(foot)}</span></div>`).join("");
  $("#gantt-drill-notice").innerHTML = "";
  $("#gantt-source-notice").textContent = `Build, CR, Bug Fixing and QA from Workfront, including change rounds and role-only or unassigned Bug Fixing rows. Team members appear first; other and unassigned work is listed at the bottom${teamId ? " within the selected team scope" : ""}. ${hiddenCompleted} task${hiddenCompleted === 1 ? "" : "s"} completed on or before ${dateLabel(startDate)} hidden. Click a row or press Enter for source activity and full details. CR SLA runs from Change Request Acceptance Date to Change Request Expected Delivery Date (material expected date/time), shown in local time; missing CR dates are not replaced by planned dates. Blue and yellow fills show supplied production/QA AHT proportions, not booked time; missing AHT remains unfilled. The green strip shows progress.${scale === "hour" ? " Non-CR imported bars cover the displayed day, not an hourly booking." : ""} Undated and out-of-window tasks remain listed.`;
  const groups = new Map();
  for (const task of tasks) {
    const keys = !teamNames(task).length ? [GANTT_OTHER_GROUP]
      : groupBy === "project" ? [normalizeWorkfrontStatus(task.projectRef)] : groupBy === "task" ? [task.taskName] : teamNames(task);
    for (const key of keys) {
      const group = groups.get(key) || [];
      group.push(task);
      groups.set(key, group);
    }
  }
  const cells = columns.map((column) => `<span class="gantt-grid-day ${column.weekend ? "weekend" : ""}"></span>`).join("");
  const lanes = [...groups.entries()].sort(([a], [b]) => Number(a === GANTT_OTHER_GROUP) - Number(b === GANTT_OTHER_GROUP)).map(([key, groupedTasks]) => {
    groupedTasks.sort((a, b) => (a.plannedStartDate || "").localeCompare(b.plannedStartDate || "") || a.taskName.localeCompare(b.taskName));
    const first = groupedTasks[0];
    const parent = parents.get(normalizeWorkfrontStatus(first.projectRef)) || { ref: first.projectRef, title: first.projectName };
    const heading = key === GANTT_OTHER_GROUP ? GANTT_OTHER_GROUP : groupBy === "project"
      ? `${escapeHTML(parent.ref)} · ${workfrontProjectLink(parent)} · Project status: ${escapeHTML(parent.sourceStatus || "Unknown")}`
      : `${groupBy === "task" ? "Task: " : ""}${escapeHTML(key)}`;
    const rows = groupedTasks.map((task) => {
      const project = parents.get(normalizeWorkfrontStatus(task.projectRef)) || { ref: task.projectRef, title: task.projectName };
      const reportedProgress = task.executionProgress ?? task.percentComplete;
      const progress = reportedProgress === null || reportedProgress === undefined ? null : Math.max(0, Math.min(100, Number(reportedProgress)));
      const dates = task.crSla ? `CR SLA: Acceptance ${ganttDateTimeLabel(task.acceptanceDate)} → Material expected ${ganttDateTimeLabel(task.expectedDeliveryDate)}`
        : scheduled(task) ? `${dateLabel(task.plannedStartDate)} – ${dateLabel(task.plannedCompletionDate)}` : "Planned dates unavailable or invalid";
      const effort = ganttEffort(task);
      const effortLabel = `${effort.production === null ? "?" : effort.production.toFixed(1)}h production + ${effort.qa === null ? "?" : effort.qa.toFixed(1)}h QA`;
      const title = `${task.projectRef} · ${task.projectName} · Project priority: ${workfrontProjectPriority(task) || "Not provided"} · Project status: ${project.sourceStatus || "Unknown"} · ${task.taskName} · Task status: ${task.taskStatus} · Assigned: ${assignment(task)} · ${dates} · ${effort.label} · Progress: ${progress === null ? "Unavailable" : `${progress}%`}`;
      let bar = "";
      if (scheduled(task) && (scale !== "hour" || task.plannedStartDate <= startDate && task.plannedCompletionDate >= startDate)) {
        const position = (value) => {
          const date = new Date(value);
          const minutes = date.getHours() * 60 + date.getMinutes();
          if (scale === "hour") return (Math.round((new Date(`${ganttDate(value)}T00:00:00`) - new Date(`${startDate}T00:00:00`)) / 86400000) * 1440 + minutes - 690) / 30;
          return columnIndex(ganttDate(value)) + (scale === "day" ? minutes / 1440 : 0);
        };
        const preciseCr = task.crSla && String(task.acceptanceDate).includes("T") && String(task.expectedDeliveryDate).includes("T") && ["hour", "day"].includes(scale);
        const left = preciseCr ? position(task.acceptanceDate) : scale === "hour" ? 0 : columnIndex(task.plannedStartDate);
        const width = preciseCr ? position(task.expectedDeliveryDate) - left
          : scale === "hour" ? columns.length : Math.max(1, columnIndex(task.plannedCompletionDate) - left + 1);
        const shownLeft = Math.max(0, left);
        const shownWidth = Math.min(columns.length - shownLeft, width - Math.max(0, -left));
        if (shownWidth > 0) {
          bar = `<span class="gantt-bar workfront-gantt-bar category-${task.taskName.toLowerCase().replace(/[^a-z]+/g, "-")} ${completed(task) ? "completed" : ""}" style="--bar-left:${shownLeft};--bar-width:${shownWidth};--hour-left:${shownLeft};--hour-width:${shownWidth}" title="${escapeHTML(title)}">${ganttEffortFill(task, left, width, shownLeft, shownWidth)}${progress === null ? "" : `<span class="gantt-progress" style="width:${progress}%"></span>`}<span class="gantt-label">${escapeHTML(task.taskName)} · ${effortLabel} · ${escapeHTML(task.executionStatus || task.taskStatus)}</span></span>`;
        }
      }
      const log = task.changeRound ? "" : task.localTask ? (isOpen(task) && (state.roleCapabilities.manageProjects || task.assignee === state.user?.name) ? `<button class="mini-button" data-action="log-task" data-id="${escapeHTML(task.id)}">Log hrs</button>` : "")
        : state.user?.role === "executioner" && PRODUCTION_TASK_PATTERN.test(String(task.taskName || "").trim()) && productionTaskNames(task).includes(state.user.name) ? `<button class="mini-button" data-action="log-source-task" data-id="${escapeHTML(task.workfrontId)}">Log hrs</button>` : "";
      const hoverSource = task.localTask ? "local" : task.changeRound ? "cr" : "source";
      const hoverId = task.changeRound ? task.workfrontId : task.id || task.workfrontId;
      return `<div class="gantt-lane" tabindex="0" data-hover-task="${escapeHTML(`${hoverSource}:${hoverId}`)}"><div class="gantt-person workfront-gantt-person"><strong>${escapeHTML(task.projectRef)} · ${escapeHTML(task.taskName)}</strong><small>${escapeHTML(assignment(task))}</small><small>${escapeHTML(task.executionStatus || task.taskStatus || task.sourceStatus)}${bar ? "" : " · No bar in this window"}</small>${task.crSla ? `<small>${escapeHTML(dates)}</small>` : ""}${workfrontPriorityLabel(task)}<small>${escapeHTML(effort.label)}</small>${log}</div><div class="gantt-material">${task.crSla ? escapeHTML(ganttDateTimeLabel(task.expectedDeliveryDate)) : dateWithHoliday(task.materialExpectedDate)}</div><div class="gantt-track">${cells}${bar}${timelineMarkers(task, columnIndex, columns, scale, startDate)}</div></div>`;
    }).join("");
    return `<details class="gantt-project-group" data-timeline-group="${escapeHTML(`${groupBy}:${key}`)}" open><summary>${heading} <span>${groupedTasks.length} task${groupedTasks.length === 1 ? "" : "s"}</span></summary>${rows}</details>`;
  }).join("");
  const header = columns.map((column) => `<div class="gantt-day ${column.weekend ? "weekend" : ""}">${column.label}</div>`).join("");
  $("#gantt-chart").innerHTML = `<div class="gantt-grid workfront-gantt production-timeline" style="--gantt-day-count:${columns.length};--gantt-scale:${scale};--cell-width:${unitWidth}px"><div class="gantt-header"><div class="gantt-person gantt-header-label">Project · task / executioner</div><div class="gantt-material">Material expected</div><div class="gantt-days">${header}</div></div>${lanes || emptyState("No matching production tasks", "Check the team and status filters and Workfront sync progress.")}</div>`;
}

function populateGanttStatusFilter(selector, values, label) {
  const select = $(selector);
  const selected = select.value;
  const statuses = [...new Set(values.map((value) => value || "Unspecified"))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = `<option value="">${label}</option>${statuses.map((status) => `<option value="${escapeHTML(status)}">${escapeHTML(status)}</option>`).join("")}`;
  select.value = statuses.includes(selected) ? selected : "";
}

function renderGantt() {
  renderGanttContent();
  const row = timelineDetailKey && [...(document.querySelectorAll?.("[data-hover-task]") || [])].find((item) => item.dataset.hoverTask === timelineDetailKey);
  if (row) showTimelineHover(row);
  else if (timelineDetailKey) hideTimelineDetail();
}

function renderGanttContent() {
  const scale = $("#gantt-scale").value || "day";
  const groupBy = $("#gantt-group-by").value || "resource";
  const startDate = $("#gantt-anchor").value || localDate();
  const teamFilter = $("#gantt-team-filter");
  const selectedTeam = teamFilter.value;
  teamFilter.innerHTML = `<option value="">All teams</option>${state.departments.map((department) => `<option value="${escapeHTML(department.id)}">${escapeHTML(department.name)}</option>`).join("")}<option value="unassigned">Unassigned team</option>`;
  teamFilter.value = selectedTeam;
  const teamId = teamFilter.value;
  const isWorkfront = state.roleCapabilities.viewWorkfront && $("#gantt-source").value !== "local";
  const automation = state.workfrontAutomation;
  const syncTime = (value) => value ? new Date(value).toLocaleString() : "Not available";
  $("#gantt-sync-status").classList.toggle("hidden", !isWorkfront);
  $("#gantt-sync-status").textContent = `Workfront sync: ${automation?.status || "not synced"}. ${automation?.enabled ? "Automatic import every 15 minutes." : "Automatic import is paused; enable it in Workfront reports."} Last complete import: ${syncTime(automation?.lastSuccessAt)}.${automation?.status === "syncing" ? ` Details checked: ${automation.detailsCompleted || 0}/${automation.detailsTotal || 0}.` : ""}${automation?.nextSyncAt ? ` Next import: ${syncTime(automation.nextSyncAt)}.` : ""}${automation?.lastError ? ` Error: ${automation.lastError}` : ""} The timeline refreshes imported data every 10 seconds while this page is visible.`;
  const parents = new Map(state.workfrontProjects.map((project) => [normalizeWorkfrontStatus(project.ref), project]));
  const statusTasks = isWorkfront ? [...state.workfrontTasks, ...(state.workfrontGanttTasks || []), ...state.workfrontChangeRounds.map((round) => ({ ...round, taskStatus: round.executionStatus || round.sourceStatus })), ...($("#gantt-source").value === "all" ? state.tasks.map((task) => ({ ...task, taskStatus: task.status })) : [])] : state.tasks;
  populateGanttStatusFilter("#gantt-status-filter", statusTasks.map((task) => isWorkfront ? task.taskStatus : task.status), "All task statuses");
  populateGanttStatusFilter("#gantt-project-status-filter", state.workfrontProjects.map((project) => project.sourceStatus), "All project statuses");
  $("#gantt-project-status-wrap").classList.toggle("hidden", !isWorkfront);
  const localTasks = state.tasks.filter((task) => {
    const member = ganttRosterMember(task.assignee);
    const project = state.projects.find((item) => item.id === task.projectId);
    const inTeam = !teamId || (member ? ganttMemberInTeam(task.assignee, teamId)
      : teamId === "unassigned" || (task.productionTeamId || project?.productionTeamId) === teamId);
    return ["Build", "CR", "Bug Fixing", "QA"].includes(task.category) && inTeam
      && !completedByDate(task.status === "Completed", task.actualCompletionDate || task.etaDate, startDate)
      && (!$("#gantt-status-filter").value || (task.status || "Unspecified") === $("#gantt-status-filter").value);
  });
  const shiftEnds = isWorkfront ? [] : localTasks.map((task) => state.team.find((member) => member.name === task.assignee)?.shiftEnd || "21:30");
  const hourEnd = shiftEnds.includes("21:30") ? "21:30" : "20:30";
  const hourSlots = hourEnd === "21:30" ? 20 : 18;
  const anchor = new Date(`${startDate}T00:00:00`);
  const columns = [];
  const formatDate = (date) => localDate(date);
  if (scale === "hour") {
    for (let slot = 0; slot < hourSlots; slot += 1) {
      const minute = 11 * 60 + 30 + slot * 30;
      const hour = Math.floor(minute / 60);
      const minutePart = minute % 60;
      const time = `${String(hour).padStart(2, "0")}:${String(minutePart).padStart(2, "0")}`;
      columns.push({ label: slot === hourSlots - 1 ? `${time}<br>–${hourEnd}` : time, date: startDate, time });
    }
  } else if (scale === "day") {
    for (let index = 0; index < 35; index += 1) {
      const date = new Date(anchor);
      date.setDate(date.getDate() + index);
      const key = formatDate(date);
      columns.push({ label: `${date.toLocaleDateString(undefined, { weekday: "short" })}<br>${key.slice(5)}`, date: key, weekend: [0, 6].includes(date.getDay()) });
    }
  } else if (scale === "week") {
    anchor.setDate(anchor.getDate() - ((anchor.getDay() + 6) % 7));
    for (let index = 0; index < 16; index += 1) {
      const date = new Date(anchor);
      date.setDate(date.getDate() + index * 7);
      columns.push({ label: `Week of<br>${formatDate(date).slice(5)}`, date: formatDate(date) });
    }
  } else {
    anchor.setDate(1);
    for (let index = 0; index < 12; index += 1) {
      const date = new Date(anchor.getFullYear(), anchor.getMonth() + index, 1);
      columns.push({ label: date.toLocaleDateString(undefined, { month: "short", year: "2-digit" }), date: formatDate(date) });
    }
  }
  const unitWidth = scale === "hour" ? 72 : scale === "day" ? 86 : 112;
  const columnIndex = (date) => {
    if (scale === "hour") return 0;
    const target = new Date(`${date}T00:00:00`);
    if (scale === "day") return Math.round((target - new Date(`${columns[0].date}T00:00:00`)) / 86400000);
    if (scale === "week") return Math.floor((target - new Date(`${columns[0].date}T00:00:00`)) / (7 * 86400000));
    return (target.getFullYear() - anchor.getFullYear()) * 12 + target.getMonth() - anchor.getMonth();
  };
  if (isWorkfront) {
    renderWorkfrontGantt(columns, columnIndex, scale, groupBy, startDate, unitWidth);
    return;
  }
  $("#gantt-source-notice").textContent = `Local production schedule. Team members appear first; Other / Unassigned work is listed at the bottom. Blue and yellow fills show supplied production/QA AHT proportions; the green strip shows progress. Missing AHT remains unfilled. Tasks completed on or before ${dateLabel(startDate)} are hidden. Click a row or press Enter for details. Workfront CR SLA dates are available in the Workfront tasks source.`;
  const logs = state.ganttLogs.reduce((groups, log) => {
    groups.set(log.taskId, (groups.get(log.taskId) || 0) + Number(log.hours || 0));
    return groups;
  }, new Map());
  const scheduledTasks = localTasks;
  const ganttDrill = state.drill?.view === "gantt" ? state.drill.key : "";
  const tasks = scheduledTasks.filter((task) => {
    if (ganttDrill === "open" || ganttDrill === "scheduled") return isOpen(task);
    if (ganttDrill === "risk") return task.status === "Completed" || isOpen(task) && task.etaDate < localDate();
    return true;
  });
  const visibleMembers = state.team.filter((member) => ganttMemberInTeam(member.name, teamId));
  const isOther = (task) => !ganttRosterMember(task.assignee);
  const memberTasks = tasks.filter((task) => !isOther(task));
  const resources = groupBy === "project"
    ? [...new Set(memberTasks.map((task) => task.projectId))]
    : groupBy === "task" ? [...new Set(memberTasks.map((task) => task.category))]
      : visibleMembers.map((member) => member.name);
  if (tasks.some(isOther)) resources.push(GANTT_OTHER_GROUP);
  const openTasks = tasks.filter((task) => isOpen(task));
  const plannedHours = openTasks.reduce((sum, task) => sum + Number(task.plannedHours || 0), 0);
  const qaHours = openTasks.reduce((sum, task) => sum + Number(task.qaBufferHours || 0), 0);
  $("#gantt-summary").innerHTML = [
    ["Open production tasks", openTasks.length, `${openTasks.filter((task) => !task.assignee).length} unassigned`, "accent-blue"],
    ["Scheduled effort", `${plannedHours.toFixed(1)}h`, `${qaHours.toFixed(1)}h QA from supplied AHT`, "accent-orange"],
    ["Behind / completed", `${openTasks.filter((task) => task.etaDate < localDate()).length} / ${tasks.filter((task) => task.status === "Completed").length}`, "Capacity ETA reflects current priority order", "accent-green"]
  ].map((metric, index) => metricCard(metric, "gantt", ["open", "scheduled", "risk"][index])).join("");
  renderDrillNotice("#gantt-drill-notice", "gantt");
  const header = columns.map((column, index) => `<div class="gantt-day ${column.weekend ? "weekend" : ""}" data-timeline-index="${index}">${column.label}</div>`).join("");
  const lanes = resources.map((resource, resourceIndex) => {
    const assigned = tasks.filter((task) => resource === GANTT_OTHER_GROUP ? isOther(task) : !isOther(task) && (groupBy === "project"
      ? task.projectId === resource
      : groupBy === "task" ? task.category === resource : normalizeWorkfrontStatus(task.assignee) === normalizeWorkfrontStatus(resource)))
      .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || "") || (a.startTime || "").localeCompare(b.startTime || "") || a.priorityOrder - b.priorityOrder);
    const renderTask = (task) => {
      const project = state.projects.find((item) => item.id === task.projectId);
      const materialExpectedDate = state.workfrontProjects.find((item) => item.ref === project?.ref)?.materialExpectedDate || project?.materialExpectedDate;
      const unscheduledRow = () => `<div class="gantt-lane" tabindex="0" data-hover-task="local:${escapeHTML(task.id)}"><div class="gantt-person"><strong>${escapeHTML(project?.ref || task.projectRef)} · ${escapeHTML(task.category)}</strong><small>${escapeHTML(task.assignee)} · No bar in this window</small></div><div class="gantt-material">${dateLabel(materialExpectedDate)}</div><div class="gantt-track">${timelineMarkers({ ...task, materialExpectedDate }, columnIndex, columns, scale, startDate)}</div></div>`;
      if (!task.startDate || !task.etaDate || task.startDate > task.etaDate) return unscheduledRow();
      let left;
      let width;
      if (scale === "hour") {
        if (task.startDate !== startDate) return unscheduledRow();
        const startMinutes = Number(task.startTime.slice(0, 2)) * 60 + Number(task.startTime.slice(3));
        left = Math.max(0, (startMinutes - (11 * 60 + 30)) / 30);
        width = Math.min(Number(task.plannedHours) * 2, Math.max(0.5, columns.length - left));
      } else {
        left = columnIndex(task.startDate);
        const end = columnIndex(task.etaDate);
        width = Math.max(1, end - left + 1);
      }
      if (left >= columns.length || left + width <= 0) return unscheduledRow();
      const shownLeft = Math.max(0, left);
      const shownWidth = Math.min(columns.length - shownLeft, width - Math.max(0, -left));
      const logged = logs.get(task.id) || Number(task.loggedHours || 0);
      const progress = Math.max(0, Math.min(100, Number(task.progress || 0)));
      const behind = isOpen(task) && (task.etaDate < localDate() || logged > task.productionHours && progress < 100);
      const expedited = task.etaOverride && task.etaDate < (task.capacityEtaDate || task.etaDate);
      const category = task.category === "Bug Fixing" ? `Bug ${task.bugScope}` : task.category;
      const label = `${category}${task.crId ? ` ${task.crId}` : ""} · ${task.projectRef} · ${task.productionHours.toFixed(1)}h build + ${task.qaBufferHours.toFixed(1)}h QA`;
      const laneName = groupBy !== "resource" || resource === GANTT_OTHER_GROUP ? task.assignee || "Unassigned" : resource;
      const title = `${task.title}${task.observations ? ` · Observation: ${task.observations}` : ""} · ${dateLabel(task.startDate)} ${task.startTime}–${dateLabel(task.etaDate)} ${task.etaTime} · ${logged.toFixed(1)}h logged / ${task.plannedHours.toFixed(1)}h scheduled · QA ${task.qaBufferHours.toFixed(1)}h${expedited ? ` · CAPACITY ETA ${dateLabel(task.capacityEtaDate)} ${task.capacityEtaTime}` : ""}${behind ? " · BEHIND SCHEDULE" : ""}`;
      const action = state.roleCapabilities.manageProjects ? "edit-task" : "log-task";
      return `<div class="gantt-lane" tabindex="0" data-hover-task="local:${escapeHTML(task.id)}"><div class="gantt-person"><strong>${escapeHTML(laneName)}</strong><small>${escapeHTML(category)}${task.crId ? ` · ${escapeHTML(task.crId)}` : ""} · ${logged.toFixed(1)}/${task.plannedHours.toFixed(1)}h${behind ? ' · <em class="behind-label">Behind</em>' : expedited ? ' · <em class="expedited-label">Expedited risk</em>' : ""}</small>${task.qaEstimateUnavailable ? "<small>QA AHT unavailable</small>" : ""}${isOpen(task) && (state.roleCapabilities.manageProjects || task.assignee === state.user?.name) ? `<button type="button" class="mini-button" data-action="log-task" data-id="${escapeHTML(task.id)}">Log hrs</button>` : ""}</div><div class="gantt-material">${dateLabel(materialExpectedDate)}</div><div class="gantt-track" data-assignee="${escapeHTML(task.assignee || "Unassigned")}">${columns.map((column, index) => `<span class="gantt-grid-day ${column.weekend ? "weekend" : ""}" data-date="${escapeHTML(column.date)}" data-time="${column.time || ""}" data-timeline-index="${index}"></span>`).join("")}<button type="button" draggable="${state.roleCapabilities.manageProjects}" class="gantt-bar category-${task.category.toLowerCase().replace(/[^a-z]+/g, "-")} ${task.status === "Completed" ? "completed" : ""} ${behind ? "behind" : ""} ${expedited ? "expedited" : ""}" style="--bar-left:${shownLeft};--bar-width:${shownWidth};--hour-left:${shownLeft};--hour-width:${shownWidth}" data-action="${action}" data-id="${escapeHTML(task.id)}" title="${escapeHTML(title)}">${ganttEffortFill(task, left, width, shownLeft, shownWidth)}<span class="gantt-progress" style="width:${progress}%"></span><span class="gantt-label">${task.status === "Completed" ? "✓ " : ""}${escapeHTML(label)} · ${task.plannedHours.toFixed(1)}h total${task.etaOverride ? ` · FAST ETA${expedited ? ` vs ${dateLabel(task.capacityEtaDate)}` : ""}` : ""}</span></button>${timelineMarkers({ ...task, materialExpectedDate }, columnIndex, columns, scale, startDate)}</div></div>`;
    };
    const projectGroups = new Map();
    for (const task of assigned) {
      const group = projectGroups.get(task.projectId) || [];
      group.push(task);
      projectGroups.set(task.projectId, group);
    }
    const taskRows = resource === GANTT_OTHER_GROUP
      ? `<details class="gantt-project-group" open><summary>${GANTT_OTHER_GROUP} <span>${assigned.length} tasks</span></summary>${assigned.map(renderTask).join("")}</details>`
      : groupBy === "project"
      ? assigned.length
        ? `<details class="gantt-project-group" ${resourceIndex === 0 ? "open" : ""}><summary><strong>${escapeHTML(assigned[0].projectRef)}</strong> · ${escapeHTML(assigned[0].projectTitle)} <span>${assigned.length} task${assigned.length === 1 ? "" : "s"}</span></summary>${assigned.map(renderTask).join("")}</details>`
        : ""
      : [...projectGroups.values()].map((projectTasks) => {
        const firstTask = projectTasks[0];
        return `<details class="gantt-project-group" open><summary><strong>${escapeHTML(firstTask.projectRef)}</strong> · ${escapeHTML(firstTask.projectTitle)} <span>${projectTasks.length} task${projectTasks.length === 1 ? "" : "s"}</span></summary>${projectTasks.map(renderTask).join("")}</details>`;
      }).join("");
    const leaveRows = state.leaves.filter((leave) => groupBy === "resource" && leave.assignee === resource).map((leave) => {
      let left;
      let width;
      if (scale === "hour") {
        if (!leaveCoversDate(leave, startDate)) return "";
        left = 0;
        width = columns.length;
      } else {
        const first = columns[0].date;
        const lastColumn = columns.at(-1);
        const last = scale === "week"
          ? formatDate(new Date(new Date(`${lastColumn.date}T00:00:00`).getTime() + 6 * 86400000))
          : scale === "month"
            ? formatDate(new Date(new Date(`${lastColumn.date}T00:00:00`).getFullYear(), new Date(`${lastColumn.date}T00:00:00`).getMonth() + 1, 0))
            : lastColumn.date;
        if (leave.endDate < first || leave.startDate > last) return "";
        left = columnIndex(leave.startDate < first ? first : leave.startDate);
        const endIndex = columnIndex(leave.endDate > last ? last : leave.endDate);
        width = Math.max(1, endIndex - left + 1);
      }
      const leaveLabel = `${leave.type} · ${dateLabel(leave.startDate)}${leave.startDate !== leave.endDate ? ` – ${dateLabel(leave.endDate)}` : ""}`;
      return `<div class="gantt-lane leave-lane"><div class="gantt-person"><strong>${escapeHTML(resource)}</strong><small>Leave · ${escapeHTML(leave.type)}</small></div><div class="gantt-material">—</div><div class="gantt-track" data-assignee="${escapeHTML(resource)}">${columns.map((column, index) => `<span class="gantt-grid-day ${column.weekend ? "weekend" : ""}" data-date="${escapeHTML(column.date)}" data-time="${column.time || ""}" data-timeline-index="${index}"></span>`).join("")}<span class="gantt-leave-bar" style="--bar-left:${Math.max(0, left)};--bar-width:${Math.min(columns.length - Math.max(0, left), width)}" title="${escapeHTML(leaveLabel)}">${escapeHTML(leave.type)} · ${escapeHTML(dateLabel(leave.startDate))}${leave.startDate !== leave.endDate ? ` – ${escapeHTML(dateLabel(leave.endDate))}` : ""}</span></div></div>`;
    }).join("");
    return `${groupBy === "task" ? `<div class="gantt-person"><strong>${escapeHTML(resource)} tasks</strong></div>` : ""}${taskRows}${leaveRows}`;
  }).join("");
  const groupLabel = groupBy === "project" ? "Project · assigned resource" : groupBy === "task" ? "Task category · project / resource" : "Designer · task";
  const timelineLabel = scale === "hour" ? `${groupLabel} · ${dateLabel(startDate)} · 11:30–${hourEnd}` : `${groupLabel} · effort`;
  $("#gantt-chart").innerHTML = `<div class="gantt-grid production-timeline" style="--gantt-day-count:${columns.length};--gantt-scale:${scale};--cell-width:${unitWidth}px"><div class="gantt-header"><div class="gantt-person gantt-header-label">${escapeHTML(timelineLabel)}</div><div class="gantt-material">Material expected</div><div class="gantt-days">${header}</div></div>${lanes || emptyState("No production tasks scheduled", "Create a project Build or add a CR/Bug task. Assign it to see the capacity slot.")}</div>`;
}

function departmentAssignees(departmentId) {
  if (!departmentId || departmentId === "unassigned") return [];
  return state.team
    .filter((member) => (member.role || "executioner") === "executioner"
      && (member.teamIds || []).some((id) => id === "qa" || id === departmentId))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function setAssigneeOptions(select, departmentId, allowUnassigned = false) {
  const selected = select.value;
  const members = departmentAssignees(departmentId);
  select.innerHTML = `${allowUnassigned ? '<option value="">Unassigned</option>' : ""}${members.map((member) => `<option value="${escapeHTML(member.name)}">${escapeHTML(member.name)}</option>`).join("")}`;
  if (members.some((member) => member.name === selected)) select.value = selected;
  else select.value = allowUnassigned ? "" : members[0]?.name || "";
}

function worklogTaskOptions() {
  const isMine = (task) => state.roleCapabilities.manageProjects || task.assignee === state.user.name;
  return [...state.tasks.filter((task) => isOpen(task) && isMine(task)),
    ...state.workfrontTasks.filter((task) => state.user.role === "executioner" && PRODUCTION_TASK_PATTERN.test(String(task.taskName || "").trim())
      && productionTaskNames(task).includes(state.user.name)).map((task) => ({
      id: `wf:${task.workfrontId}`, projectId: "", category: task.taskName, projectRef: task.projectRef, projectTitle: task.projectName,
      progress: task.executionProgress ?? task.percentComplete ?? 0, status: task.executionStatus || "In Progress", sourceTask: true
    }))];
}

function openWorklogDialog(taskId) {
  populateSelects();
  const form = $("#worklog-form");
  const task = worklogTaskOptions().find((item) => item.id === taskId);
  if (!task) return showToast("This task is not available for your hour log. Refresh the timeline and check the assignment.", true);
  form.reset();
  populateSelects();
  form.elements.taskId.value = task.id;
  form.elements.projectId.value = task.projectId || "";
  form.elements.date.value = localDate();
  form.elements.progress.value = task.progress ?? 0;
  form.elements.status.value = task.status === "Completed" ? "Completed" : ["Not Started", "In Progress", "In Review", "On Hold"].includes(task.status) ? task.status : "In Progress";
  const phase = /^bug fixing$/i.test(task.category) ? "Bug Fixing" : /^cr\s*1$/i.test(task.category) ? "CR1" : /^cr\s*2$/i.test(task.category) ? "CR2" : "Build";
  form.elements.phase.value = phase;
  $("#worklog-dialog").showModal();
  form.elements.hours.focus();
}

function populateSelects() {
  const members = [...state.team].sort((a, b) => a.name.localeCompare(b.name));
  const options = members.map((member) => `<option value="${escapeHTML(member.name)}">${escapeHTML(member.name)}</option>`).join("");
  const assigneeFilter = $("#assignee-filter");
  const selectedAssignee = assigneeFilter.value;
  assigneeFilter.innerHTML = `<option value="">All team members</option>${options}`;
  assigneeFilter.value = selectedAssignee;
  const projectAssignee = $('#project-form [name="assignee"]');
  const currentAssignee = projectAssignee.value;
  projectAssignee.innerHTML = `${state.roleCapabilities.manageProjects ? '<option value="">Unassigned</option>' : ""}${options}` || '<option value="">Add a team member first</option>';
  if (members.some((member) => member.name === currentAssignee)) projectAssignee.value = currentAssignee;
  const projectTeam = $('#project-form [name="productionTeamId"]');
  const currentProjectTeam = projectTeam.value;
  const permittedDepartments = state.roleCapabilities.manageWorkspace
    ? state.departments
    : state.departments.filter((department) => (state.user.teamIds || []).includes("qa") || (state.user.teamIds || []).includes(department.id));
  projectTeam.innerHTML = `${state.roleCapabilities.manageWorkspace ? '<option value="unassigned">Unassigned · Manager triage</option>' : ""}${permittedDepartments.map((department) => `<option value="${escapeHTML(department.id)}">${escapeHTML(department.name)}</option>`).join("")}`;
  if ([...projectTeam.options].some((option) => option.value === currentProjectTeam)) projectTeam.value = currentProjectTeam;
  else if (permittedDepartments.length) projectTeam.value = permittedDepartments[0].id;
  populateProjectAssignees();
  const worklogSelect = $('#worklog-form [name="taskId"]');
  const currentTask = worklogSelect.value;
  const loggableTasks = worklogTaskOptions();
  worklogSelect.innerHTML = loggableTasks.map((task) => `<option value="${escapeHTML(task.id)}">${escapeHTML(task.category)}${task.crId ? ` ${escapeHTML(task.crId)}` : ""} · ${escapeHTML(task.projectRef)} · ${escapeHTML(task.projectTitle)}</option>`).join("");
  if (loggableTasks.some((task) => task.id === currentTask)) worklogSelect.value = currentTask;
  const selectedLogTask = loggableTasks.find((task) => task.id === worklogSelect.value);
  $('#worklog-form [name="projectId"]').value = selectedLogTask?.projectId || "";
  $('#worklog-form button[type="submit"]').disabled = !worklogSelect.options.length;
  const taskProject = $('#task-form [name="projectId"]');
  const selectedTaskProject = taskProject.value;
  taskProject.innerHTML = state.projects.map((project) => `<option value="${escapeHTML(project.id)}">${escapeHTML(project.ref)} · ${escapeHTML(project.title)}</option>`).join("");
  if (state.projects.some((project) => project.id === selectedTaskProject)) taskProject.value = selectedTaskProject;
  const marketSelect = $("#audit-market");
  const selectedMarket = marketSelect.value;
  marketSelect.innerHTML = `<option value="">Choose market</option>${state.marketMatrix.map((row) => `<option value="${escapeHTML(row.market)}">${escapeHTML(row.market)}</option>`).join("")}`;
  marketSelect.value = selectedMarket;
  const currentRefs = [...new Set(state.workfrontSync?.currentProjectRefs || [])];
  $("#audit-project-suggestions").innerHTML = currentRefs.map((ref) => {
    const project = state.workfrontProjects.find((item) => item.ref.toLowerCase() === ref.toLowerCase())
      || state.projects.find((item) => item.ref.toLowerCase() === ref.toLowerCase());
    return `<option value="${escapeHTML(ref)}" label="${escapeHTML(`${project?.title || "Current WPP Production project"} · Current`)}"></option>`;
  }).join("");
  const roundSelect = $('#change-round-form [name="projectRef"]');
  const selectedRef = roundSelect.value;
  roundSelect.innerHTML = `<option value="">Choose project</option>${[...state.projects].sort((a, b) => a.ref.localeCompare(b.ref)).map((project) => `<option value="${escapeHTML(project.ref)}">${escapeHTML(project.ref)} · ${escapeHTML(project.title)}</option>`).join("")}`;
  roundSelect.value = selectedRef;
  $("#allocation-form [name=assignee]").innerHTML = options || '<option value="">Add a team member first</option>';
  const leaveAssignee = $('#leave-form [name="assignee"]');
  const selectedLeaveAssignee = leaveAssignee.value;
  leaveAssignee.innerHTML = state.roleCapabilities.manageTeamLeave
    ? options || '<option value="">Add a team member first</option>'
    : `<option value="${escapeHTML(state.user.name)}">${escapeHTML(state.user.name)} · You</option>`;
  if (members.some((member) => member.name === selectedLeaveAssignee)) leaveAssignee.value = selectedLeaveAssignee;
  $("#allocation-form button[type=submit]").disabled = !members.length;
  $("#task-form [name=assignee]").innerHTML = `<option value="">Unassigned</option>${options}`;
  $("#change-round-form [name=assignee]").innerHTML = `<option value="">Unassigned</option>${options}`;
  $("#workfront-allocation-form [name=assignee]").innerHTML = options;
  $("#workfront-rework-form [name=assignee]").innerHTML = options;
}

function populateProjectAssignees() {
  const projectAssignee = $('#project-form [name="assignee"]');
  const projectTeam = $('#project-form [name="productionTeamId"]');
  const departmentId = projectTeam.value;
  setAssigneeOptions(projectAssignee, departmentId, state.roleCapabilities.manageProjects);
}

function workfrontProjectForRef(ref) {
  return state.workfrontProjects.find((project) => project.ref.toLowerCase() === ref.toLowerCase())
    || state.projects.find((project) => project.ref.toLowerCase() === ref.toLowerCase());
}

function auditPrefillFromWorkfront(project) {
  const rawType = `${project.assetType || ""} ${project.channel || ""} ${project.taskType || ""} ${project.title || ""}`.toLowerCase();
  const channel = WORKFRONT_CHANNELS.includes(project.channel) ? project.channel : /\bemail\b/.test(rawType) ? "Email"
    : /landing page/.test(rawType) ? "Landing Pages"
      : /edetailer|e detailer/.test(rawType) ? "eDetailer"
        : /\bipdf\b/.test(rawType) ? "iPDF"
          : /\bprint\b/.test(rawType) ? "Print"
            : /\bppt\b/.test(rawType) ? "PPT"
              : /\bgslide/.test(rawType) ? "Gslide"
                : /banner.*html|html.*banner/.test(rawType) ? "Banner-HTML"
                  : /banner.*gif|gif.*banner/.test(rawType) ? "Banner-GIF"
                    : /banner.*anim|anim.*banner/.test(rawType) ? "Banner-Animated"
                      : /\bvideo\b/.test(rawType) ? "Video"
                        : /banner/.test(rawType) ? "Banner-Static" : "";
  const marketName = project.country || project.market || "";
  const market = state.marketMatrix.find((row) => row.market.toLowerCase() === marketName.toLowerCase())?.market || marketName;
  const request = `${project.requestType || ""} ${project.taskType || ""}`.toLowerCase();
  const requestType = /localiz/.test(request) ? "Localization" : /update|repurpose|adapt/.test(request) ? "Update/Repurpose" : "New Build";
  const complexityText = String(project.complexity || "").trim();
  const complexityNumber = Number(complexityText);
  const complexity = /^(low|simple)$/i.test(complexityText) || Number.isFinite(complexityNumber) && complexityNumber > 0 && complexityNumber <= 0.7 ? "Simple"
    : /^(high|complex)$/i.test(complexityText) || Number.isFinite(complexityNumber) && complexityNumber >= 1.5 ? "Complex" : "Medium";
  return {
    auditType: "Pre-Audit",
    workfrontId: project.workfrontId || "",
    projectRef: project.ref,
    projectName: project.title,
    market,
    primaryDpm: project.projectOwner || project.owner || "",
    channel,
    requestType,
    complexity,
    pageCount: project.pages || 1
  };
}

function startWorkfrontPreAudit(ref) {
  const currentRefs = state.workfrontSync?.currentProjectRefs || [];
  if (!currentRefs.some((currentRef) => currentRef.toLowerCase() === ref.toLowerCase())) {
    showToast("Only PRD WPP Production projects in the Awaiting Audit queue can be selected.", true);
    return;
  }
  const project = workfrontProjectForRef(ref) || { ref, title: "", pages: 1 };
  setView("audits");
  openAuditForm(auditPrefillFromWorkfront(project));
}

function startWorkfrontCurrentAudit(ref) {
  const project = workfrontProjectForRef(ref);
  if (!project || project.productionStage !== "Awaiting Audit" || normalizeWorkfrontStatus(project.sourceStatus) !== "current") {
    showToast("Only PRD WPP Production projects with Current status can be selected for an asset audit.", true);
    return;
  }
  const prefill = auditPrefillFromWorkfront(project);
  prefill.auditType = "Audit";
  setView("audits");
  openAuditForm(prefill);
}

function startWorkfrontAudit(workfrontId) {
  const project = state.workfrontProjects.find((item) => item.workfrontId === workfrontId);
  if (!project || !["Audit", "In QC"].includes(project.productionStage)) {
    showToast("Only PRD WPP Production assets in the Audit / QC queue can be selected.", true);
    return;
  }
  const prefill = auditPrefillFromWorkfront(project);
  prefill.auditType = "Audit";
  setView("audits");
  openAuditForm(prefill);
}

function openAuditForm(prefill = {}) {
  const form = $("#audit-form");
  form.reset();
  populateSelects();
  form.elements.startDate.value = localDate();
  const currentTime = new Date().toTimeString().slice(0, 5);
  form.elements.startTime.value = currentTime < "11:30" ? "12:30" : currentTime > "21:30" ? "12:30" : currentTime;
  form.elements.signOffName.value = state.user.name;
  form.elements.auditStatus.value = "Pending";
  form.elements.sourceFile.value = "Available";
  form.elements.priority.value = "Normal";
  renderAuditDocuments();
  updateAuditFormMode();
  updateAuditGreeting();
  $("#audit-template-preview").classList.add("hidden");
  $("#copy-audit-template").classList.add("hidden");
  form.elements.auditType.value = prefill.auditType || "Audit";
  form.elements.workfrontId.value = prefill.workfrontId || "";
  form.elements.crId.value = prefill.crId || "";
  if (prefill.projectRef) {
    form.elements.projectRef.value = prefill.projectRef;
    form.elements.projectName.value = prefill.projectName || "";
    setAuditMarket(prefill.market || "");
    form.elements.primaryDpm.value = prefill.primaryDpm || "";
    populateAuditBackups();
    form.elements.channel.value = prefill.channel || form.elements.channel.value;
    form.elements.requestType.value = prefill.requestType || "New Build";
    form.elements.complexity.value = prefill.complexity || "Medium";
    form.elements.pageCount.value = prefill.pageCount || 1;
  } else {
    const params = new URLSearchParams(location.search);
    const ref = params.get("project");
    if (ref) {
      const project = state.projects.find((item) => item.ref === ref);
      form.elements.projectRef.value = ref;
      if (project) {
        form.elements.projectName.value = project.title;
        form.elements.market.value = project.market || "";
      }

      history.replaceState(null, "", location.pathname);
    }
  }
  updateAuditFormMode();
  updateAuditGreeting();
  $("#audit-dialog").showModal();
  if (typeof renderAuditClocks === "function") renderAuditClocks();
  if (prefill.projectRef && typeof auditClockAction === "function") {
    const current = state.auditSessions?.find((session) => session.userId === state.user.id && session.state !== "stopped");
    if (!current || current.projectRef === prefill.projectRef && current.crId === (prefill.crId || "") && current.state === "held") {
      auditClockAction("start", prefill.projectRef, prefill.crId || "");
    }
  }
}

async function openWorkfrontAllocation(workfrontId) {
  const source = state.workfrontProjects.find((project) => project.workfrontId === workfrontId);
  if (!source) return showToast("The Workfront project is no longer in the imported PRD report.", true);
  try {
    const estimate = await api(`/api/workfront/${encodeURIComponent(workfrontId)}/suggestions`, { method: "POST", body: "{}" });
    const form = $("#workfront-allocation-form");
    form.reset();
    populateSelects();
      setAssigneeOptions(form.elements.assignee, source.productionTeamId);
    form.elements.workfrontId.value = workfrontId;
    $("#workfront-allocation-label").textContent = `${source.ref} · ${source.title} · ${source.channel || source.assetType} · ${source.complexity || "Medium"} complexity · Workfront project priority: ${workfrontProjectPriority(source) || "Not provided"} (read-only)`;
    $("#workfront-allocation-effort").textContent = `${estimate.productionHours.toFixed(1)}h production + ${estimate.qaBufferHours.toFixed(1)}h QA buffer = ${estimate.plannedHours.toFixed(1)}h planned`;
    $("#workfront-resource-suggestions").innerHTML = estimate.resources.map((resource) => `<button type="button" class="resource-card ${resource.recommended ? "recommended" : ""}" data-workfront-resource="${escapeHTML(resource.name)}" data-start="${escapeHTML(resource.plannedStartDate)}" data-start-time="${escapeHTML(resource.plannedStartTime)}"><span><span class="resource-card-assignment"><small>Assigned</small><strong>${escapeHTML(resource.name)}</strong></span>${resource.recommended ? "<em>Recommended</em>" : ""}</span><small>${resource.remainingHours.toFixed(1)}h remaining · ${resource.availableTodayHours.toFixed(1)}h free today${resource.onLeaveToday ? " · on leave" : ""}</small><small>${dateLabel(resource.plannedStartDate)} ${resource.plannedStartTime} – ${dateLabel(resource.plannedEndDate)} ${resource.plannedEndTime}</small></button>`).join("") || emptyState("No resources available", "Add a team member to the roster before assigning work.");
    const recommended = estimate.resources[0];
    if (recommended) {
      form.elements.assignee.value = recommended.name;
      form.elements.plannedStartDate.value = recommended.plannedStartDate;
      form.elements.startTime.value = recommended.plannedStartTime;
    } else {
      form.elements.plannedStartDate.value = localDate();
      form.elements.startTime.value = "11:30";
    }
    updateShiftTimeFields(form);
    $("#workfront-allocation-dialog").showModal();
  } catch (error) {
    showToast(error.message, true);
  }
}

function openWorkfrontRework(workfrontId) {
  const source = state.workfrontProjects.find((project) => project.workfrontId === workfrontId);
  if (!source) return showToast("The Workfront project is no longer in the imported PRD report.", true);
  const form = $("#workfront-rework-form");
  form.reset();
  populateSelects();
  setAssigneeOptions(form.elements.assignee, source.productionTeamId);
  form.elements.workfrontId.value = workfrontId;
  form.elements.startDate.value = localDate();
  form.elements.startTime.value = "11:30";
  const native = state.projects.find((project) => project.workfrontId === workfrontId);
  if (native?.assignee) form.elements.assignee.value = native.assignee;
  updateShiftTimeFields(form, true);
  $("#workfront-rework-cr-wrap").classList.add("hidden");
  $("#workfront-rework-scope-wrap").classList.remove("hidden");
  $("#workfront-rework-dialog").showModal();
}

function updateAuditFormMode() {
  const form = $("#audit-form");
  const preAudit = form.elements.auditType.value === "Pre-Audit";
  $("#audit-status-label").textContent = preAudit ? "Pre-Audit status" : "Audit status";
  $("#audit-only-fields").classList.toggle("hidden", preAudit);
  $("#minor-update-label").classList.toggle("hidden", form.elements.requestType.value !== "Update/Repurpose" || preAudit);
}

function updateAuditGreeting() {
  const form = $("#audit-form");
  const primary = form.elements.primaryDpm.value.trim();
  const backup = form.elements.backupDpm.value.trim();
  $("#audit-greeting-preview").value = !primary ? "" : form.elements.primaryOnLeave.checked && backup
    ? `Hello ${backup} & ${primary},`
    : `Hello ${primary},`;
}

function setAuditMarket(market) {
  const select = $("#audit-market");
  if (market && ![...select.options].some((option) => option.value === market)) select.add(new Option(market, market));
  select.value = market;
}

function populateAuditBackups() {
  const form = $("#audit-form");
  const mapping = state.marketMatrix.find((row) => row.market === form.elements.market.value);
  form.elements.backupDpm.value = mapping?.backupDpm || "";
  form.elements.secondaryBackupDpm.value = mapping?.secondaryBackupDpm || "";
  updateAuditGreeting();
}

async function calculateAuditTat() {
  const form = $("#audit-form");
  const estimate = await api("/api/tat-estimate", {
    method: "POST",
    body: JSON.stringify({
      channel: form.elements.channel.value,
      requestType: form.elements.requestType.value,
      complexity: form.elements.complexity.value,
      pageCount: Number(form.elements.pageCount.value),
      startDate: form.elements.startDate.value,
      startTime: form.elements.startTime.value
    })
  });
  form.elements.calculatedTat.value = estimate.calculatedTat;
  form.elements.etaDate.value = estimate.etaDate;
  form.elements.etaTime.value = estimate.etaTime;
  return estimate;
}

function formatEta(date, time) {
  if (!date || !time) return "Not calculated";
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const label = new Intl.DateTimeFormat("en", { month: "short" }).format(new Date(year, month - 1, day));
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  const meridiem = hour >= 12 ? "PM" : "AM";
  return `${day}${suffix} ${label}, ${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${meridiem}`;
}

function auditCapacityLabel(estimate) {
  const best = estimate.candidates.find((candidate) => candidate.tentativeDate);
  return `<strong>Tentative delivery: ${best ? `${escapeHTML(formatEta(best.tentativeDate, best.tentativeTime))} · ${escapeHTML(best.name)}` : "Unavailable"}</strong><p>${escapeHTML(estimate.assumption)}</p>${estimate.warnings.map((warning) => `<p class="muted">${escapeHTML(warning)}</p>`).join("")}`;
}

function formatTemplateList(value, noneLabel = "") {
  const values = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return values.length ? `<ul>${values.map((line) => `<li>${escapeHTML(line)}</li>`).join("")}</ul>` : escapeHTML(noneLabel);
}

function safeTemplateLink(label, link) {
  if (!link) return escapeHTML(label || "Not provided");
  try {
    const parsed = new URL(link);
    if (["http:", "https:"].includes(parsed.protocol)) return `<a class="audit-link" href="${escapeHTML(parsed.href)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label || parsed.href)}</a>`;
  } catch {
    return escapeHTML(label || link);
  }
  return escapeHTML(label || link);
}

function generateAuditTemplate() {
  const form = $("#audit-form");
  const values = Object.fromEntries(new FormData(form));
  const greeting = $("#audit-greeting-preview").value || "Hello,";
  const divider = "<hr>";
  const observations = formatTemplateList(values.observations, "None");
  const lines = values.auditType === "Pre-Audit" ? [
    `${greeting}<br><br>Pre-Audit has been completed for the project – <b>${escapeHTML(values.projectName || "—")}</b> (Project ID: <b>${escapeHTML(values.projectRef)}</b>)`,
    divider,
    `PRD expected number of days: <b>${escapeHTML(values.calculatedTat || "Not calculated")}</b> (Based on TAT Grid)`,
    `Pre-Audit Status: <b>${escapeHTML(values.auditStatus)}</b>`,
    `Request Type: <b>${escapeHTML(values.requestType)}</b>`,
    `Complexity: <b>${escapeHTML(values.complexity)}</b>`,
    `High Priority: <b>${escapeHTML(values.priority)}</b>`,
    divider,
    "<b>Pre-requisites as follows:</b>",
    `Source Files: <b>${values.sourceFile === "Available" ? "Yes" : "No"}</b>`,
    `Functional Document: ${safeTemplateLink(values.functionalDoc, values.functionalDoc)}`,
    `Style Guide Document: ${safeTemplateLink(values.styleGuideDoc, values.styleGuideDoc)}`,
    `<b>Input documents:</b><br>${auditDocumentEntries().length ? auditDocumentEntries().map((document) => safeTemplateLink(document.name, document.link)).join("<br>") : "None"}`,
    divider,
    "<b>Dependencies:</b>",
    formatTemplateList(values.dependencies, "None"),
    divider,
    "<b>Observations:</b>",
    observations,
    divider,
    `Thanks,<br>${escapeHTML(values.signOffName || state.user.name)}`
  ] : [
    `${greeting}<br><br>Asset Audit has been completed for the project – <b>${escapeHTML(values.projectName || "—")}</b> (Project ID: <b>${escapeHTML(values.projectRef)}</b>)`,
    `The request is estimated to be delivered by <b>${formatEta(values.etaDate, values.etaTime)}</b>`,
    divider,
    `Audit Status: <b>${escapeHTML(values.auditStatus)}</b>`,
    `Complexity: <b>${escapeHTML(values.complexity)}</b>`,
    `Source file: <b>${escapeHTML(values.sourceFile)}</b>`,
    `Request Type: <b>${escapeHTML(values.requestType)}</b>`,
    ...(values.requestType === "Update/Repurpose" ? [`Minor Update: <b>${escapeHTML(values.minorUpdate)}</b>`] : []),
    `Priority: <b>${escapeHTML(values.priority)}</b>`,
    ...(values.observations.trim() ? [divider, "<b>Observations:</b>", observations] : []),
    divider,
    "<b>Requirements:</b>",
    values.outputFormat === "Print" ? "<b>This is a PRINT Request therefore the color space would be CMYK along with standard bleed and crop marks.</b>" : "",
    values.outputFormat === "iPDF" ? "<b>This is an iPDF Request therefore the color space would be RGB.</b>" : "",
    values.outputFormat === "Banner" ? "<b>This is a banner Request therefore the output would be JPG/PNG.</b>" : "",
    values.outputFormat === "PPT" ? "<b>The output of this request will be Microsoft Powerpoint only.</b>" : "",
    values.outputFormat === "GSlide" ? "<b>The output of the file would be Google Slides. Therefore convert this PPT into Google Slides.</b>" : "",
    formatTemplateList(values.requirements),
    divider,
    "<b>Input documents:</b>",
    auditDocumentEntries().length ? auditDocumentEntries().map((document) => `- ${safeTemplateLink(document.name, document.link)}`).join("<br>") : "None",
    values.functionalDoc ? `Functional Document: ${safeTemplateLink(values.functionalDoc, values.functionalDoc)}` : "",
    values.styleGuideDoc ? `Style Guide Document: ${safeTemplateLink(values.styleGuideDoc, values.styleGuideDoc)}` : "",
    divider,
    `Thanks,<br>${escapeHTML(values.signOffName || state.user.name)}`
  ].filter(Boolean);
  $("#audit-template-preview").innerHTML = lines.map((line) => `<div>${line}</div>`).join("");
  $("#audit-template-preview").classList.remove("hidden");
  $("#copy-audit-template").classList.remove("hidden");
}

function setTeamTab(tab) {
  if (tab === "accounts" && !state.roleCapabilities.manageWorkspace) tab = "members";
  state.teamTab = tab;
  $$("[data-team-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.teamTab === tab);
    button.setAttribute("aria-selected", String(button.dataset.teamTab === tab));
  });
  $$("[data-team-pane]").forEach((pane) => { pane.hidden = pane.dataset.teamPane !== tab; });
}

function setView(view) {
  if (view === "activity" || state.user?.role === "executioner" && view === "aht") view = "worklog";
  if (state.user?.role === "executioner" && ![...EXECUTIONER_VIEWS, "leaves"].includes(view)) view = "my-work";
  if (view === "hygiene" && !state.roleCapabilities.viewHygiene) return;
  if (view === "quality" && !state.roleCapabilities.viewQuality) return;
  if (view === "workfront" && !state.roleCapabilities.viewWorkfront) return;
  if (["manager-reports", "team-utilization"] .includes(view) && !state.roleCapabilities.viewManagerReports) return;
  if (view === "leaves" || view === "team") {
    setTeamTab(view === "leaves" || state.user?.role === "executioner" ? "leave" : "members");
    view = "team";
  }
  $(".main-content").style.minHeight = "";
  state.view = view;
  $$(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach((section) => section.classList.toggle("hidden", section.id !== `view-${view}`));
  $("#page-title").textContent = { overview: "Overview", "manager-reports": "Manager reports", "team-utilization": "Team utilization", projects: "Projects", audits: "Asset audits", team: "Team & leave", gantt: "Gantt timeline", capacity: "Capacity", workfront: "Workfront reports", aht: state.roleCapabilities.viewAht ? "AHT & capacity" : "My performance" }[view] || "Overview";
  if (["my-work", "quality", "hygiene", "kpi", "feedback", "worklog"].includes(view)) $("#page-title").textContent = { "my-work": "My work", quality: "Quality / FTR", hygiene: "Hygiene", kpi: "KPI / team performance", feedback: "Learning, challenges & feedback", worklog: "Work log" }[view];
  if (["my-work", "quality", "hygiene", "kpi", "feedback", "worklog"].includes(view) && typeof renderWorkflowViews === "function") renderWorkflowViews();
  if (view === "worklog") renderWorkLogView();
  if (view === "projects") renderProjects();
  if (view === "audits") renderAudits();
  if (view === "gantt") renderGantt();
  if (view === "capacity") { renderCapacity(); setCapacityTab(state.capacityTab || "report"); }
  if (view === "leaves") renderLeaves();
  if (view === "workfront") renderWorkfront();
  if (view === "manager-reports") {
    renderManagerReports();
    if (typeof loadLeadershipReports === "function") loadLeadershipReports();
  }
  if (view === "team-utilization") renderTeamUtilization();
  if (view === "aht") renderAht();
  if (view === "team") { renderTeam(); renderLeaves(); }
  if (view === "overview") renderDashboard();
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
}

function drillInto(button) {
  const { drillView: view, drillKey: key, drillValue: value = "", drillLabel: label } = button.dataset;
  if (!view || !key) return;
  if (view === "workfront" && !state.roleCapabilities.viewWorkfront) return;
  if (view === "team-utilization" && !state.roleCapabilities.viewManagerReports) return;
  if (view === "audits" && !state.roleCapabilities.viewAudits) return;
  if (view === "capacity" && !state.roleCapabilities.viewAht) return;
  if (view === "gantt") $("#gantt-source").value = "local";
  state.drill = {
    view,
    key,
    value,
    projectStatus: button.dataset.drillProjectStatus || "",
    taskStatus: button.dataset.drillTaskStatus || "",
    taskName: button.dataset.drillTaskName || "",
    assignment: button.dataset.drillAssignment || "",
    label: label || `${key} details`
  };

  if (view === "projects") {
    $("#project-search").value = "";
    $("#status-filter").value = "";
    $("#assignee-filter").value = "";
  }
  if (view === "audits") {
    $("#audit-search").value = "";
    $("#audit-type-filter").value = "";
    $("#audit-status-filter").value = "";
  }
  if (view === "workfront") {
    state.workfrontDataset = key === "production-task" || ["all-tasks", "task-statuses"].includes(key)
      ? "tasks"
      : key === "production-project" ? "projects"
        : ["all-change-rounds", "cr-statuses"].includes(key) ? "changeRounds" : "projects";
    state.workfrontPage = 1;
    $("#workfront-search").value = "";
    $("#workfront-team-filter").value = key === "team" ? value : "";
    $("#workfront-status-filter").value = "";
    $("#workfront-project-status-filter").value = "";
    const prioritySelect = $("#workfront-priority-filter");
    if (key === "project-priority") {
      prioritySelect.innerHTML = `<option value="">All project priorities</option><option value="${escapeHTML(value)}">${escapeHTML(value)}</option>`;
    }
    prioritySelect.value = key === "project-priority" ? value : "";
  }
  if (view === "team-utilization" && ["today-logged", "all-time-logged"].includes(key)) {
    if (key === "today-logged") {
      $("#utilization-period").value = "day";
      $("#utilization-anchor-date").value = localDate();
    } else {
      const logDates = state.workLogs.map((entry) => entry.date).filter(Boolean).sort();
      $("#utilization-period").value = "duration";
      $("#utilization-start-date").value = logDates[0] || localDate();
      $("#utilization-end-date").value = localDate();
    }
  }
  if (["aht", "worklog"].includes(view) && key === "personal-logs") $("#personal-log-period").value = "year";
  setView(view);
}

function clearDrill() {
  const view = state.drill?.view;
  state.drill = null;
  if (view === "projects") {
    $("#project-search").value = "";
    $("#status-filter").value = "";
    $("#assignee-filter").value = "";
  }
  if (view === "audits") {
    $("#audit-search").value = "";
    $("#audit-type-filter").value = "";
    $("#audit-status-filter").value = "";
  }
  if (view === "workfront") {
    state.workfrontDataset = "projects";
    $("#workfront-search").value = "";
    $("#workfront-team-filter").value = "";
    $("#workfront-status-filter").value = "";
    $("#workfront-priority-filter").value = "";
    $("#workfront-project-status-filter").value = "";
    state.workfrontPage = 1;
  }
  if (view === "projects") renderProjects();
  if (view === "audits") renderAudits();
  if (view === "leaves") renderLeaves();
  if (view === "workfront") renderWorkfront();
  if (view === "team-utilization") renderTeamUtilization();
  if (view === "aht") renderAht();
  if (view === "capacity") { renderCapacity(); setCapacityTab(state.capacityTab || "report"); }
  if (view === "gantt") renderGantt();
  if (view === "team") renderTeam();
}

function openProject(project) {
  const form = $("#project-form");
  form.reset();
  populateSelects();
  form.elements.id.value = project?.id || "";
  $("#project-dialog-title").textContent = project ? "Edit project" : "New project";
  $("#project-source-priority").textContent = `Workfront project priority: ${workfrontProjectPriority(project) || "Not provided"} (read-only; edit in Workfront and sync).`;
  form.elements.ref.value = project?.ref || "";
  form.elements.title.value = project?.title || "";
  form.elements.assignee.value = project ? (project.assignee || "") : (state.team[0]?.name || "");
  form.elements.market.value = project?.market || "";
  form.elements.channel.value = project?.channel || "";
  form.elements.taskType.value = project?.taskType || "New Build";
  form.elements.requestType.value = project?.requestType || "Standard";
  form.elements.pages.value = project?.pages || 1;
  form.elements.complexity.value = project?.complexity || 1;
  form.elements.progress.value = project?.progress ?? 0;
  form.elements.status.value = project?.status || "Not Started";
  form.elements.tatDate.value = project?.tatDate || "";
  form.elements.dueDate.value = project?.dueDate || localDate();
  form.elements.notes.value = project?.notes || "";
  form.elements.ref.readOnly = Boolean(project);
  populateProjectAssignees();
  $("#project-dialog").showModal();
}

function downloadCSV(filename, rows) {
  const csv = rows.map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function exportProjects() {
  const columns = ["Reference", "Title", "Designer", "Market", "Channel", "Task type", "Request type", "Pages", "Complexity", "Progress", "Status", "TAT date", "Due date", "Notes"];
  const rows = state.projects.map((item) => [item.ref, item.title, item.assignee, item.market, item.channel, item.taskType, item.requestType, item.pages, item.complexity, item.progress, item.status, item.tatDate, item.dueDate, item.notes]);
  downloadCSV("team-projects.csv", [columns, ...rows]);
}

function exportAudits() {
  const columns = ["Type", "Project ID", "CR ID", "Project name", "Market", "Channel", "Request type", "Minor update", "Complexity", "Page/frame count", "TAT", "DPM on leave", "Auditor", "Primary DPM", "Backup DPM", "Secondary backup DPM", "Start date", "Start time", "ETA date", "ETA time", "Result", "Source file", "Priority", "Observations", "Dependencies", "Requirements", "Format", "Functional document", "Style guide", "Email sign-off", "Input documents"];
  const rows = state.audits.map((item) => [item.auditType, item.projectRef, item.crId || "", item.projectName, item.market, item.channel, item.requestType, item.minorUpdate, item.complexity, item.pageCount, item.calculatedTat, item.primaryOnLeave, item.auditor, item.primaryDpm, item.backupDpm, item.secondaryBackupDpm, item.startDate, item.startTime, item.etaDate, item.etaTime, item.auditStatus, item.sourceFile, item.priority, item.observations, item.dependencies, item.requirements, item.outputFormat, item.functionalDoc, item.styleGuideDoc, item.signOffName, (item.documents || []).map((document) => `${document.name}: ${document.link}`).join(" | ")]);
  downloadCSV("asset-audits.csv", [columns, ...rows]);
}

function addBusinessDays(date, days) {
  const holidays = new Set(state.holidays.map((holiday) => holiday.date));
  const result = new Date(`${date}T00:00:00Z`);
  let added = 0;
  while (added < days) {
    result.setUTCDate(result.getUTCDate() + 1);
    const weekday = result.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.has(result.toISOString().slice(0, 10))) added += 1;
  }
  return result.toISOString().slice(0, 10);
}

function updateChangeRoundEta() {
  const form = $("#change-round-form");
  const landedDate = form.elements.landedDate.value;
  const landedTime = form.elements.landedTime.value;
  if (!landedDate || !landedTime) {
    $("#change-round-eta").value = "";
    return;
  }
  const days = form.elements.complexity.value === "High" ? 3 : 1;
  $("#change-round-eta").value = `${dateLabel(addBusinessDays(landedDate, days))} at ${landedTime}`;
  const project = state.projects.find((item) => item.id === form.elements.projectRef.value || item.ref === form.elements.projectRef.value);
  if (!project || form.elements.etaOverride.checked) return;
  api("/api/planner/task-suggestions", {
    method: "POST",
    body: JSON.stringify({ projectId: project.id, category: "CR", complexity: form.elements.complexity.value, units: 1 })
  }).then((estimate) => {
    const resource = estimate.resources.find((item) => item.name === form.elements.assignee.value) || estimate.resources[0];
    if (!resource || form.elements.etaOverride.checked) return;
    if (!form.elements.assignee.value && state.roleCapabilities.manageProjects) form.elements.assignee.value = resource.name;
    form.elements.etaDate.value = resource.plannedEndDate;
    form.elements.etaTime.value = resource.plannedEndTime;
  }).catch((error) => showToast(`Could not calculate the capacity ETA: ${error.message}`, true));
}

function renderMarketMatrixDraft() {
  $("#matrix-row-count").textContent = `${marketMatrixDraft.length} markets`;
  $("#market-matrix-rows").innerHTML = marketMatrixDraft.map((row, index) => `
    <div class="matrix-row" data-index="${index}">
      <label>Market<input data-field="market" value="${escapeHTML(row.market)}" maxlength="120" required></label>
      <label>Primary DPM<input data-field="primaryDpm" value="${escapeHTML(row.primaryDpm)}" maxlength="100" required></label>
      <label>Backup DPM<input data-field="backupDpm" value="${escapeHTML(row.backupDpm)}" maxlength="100"></label>
      <label>Secondary backup<input data-field="secondaryBackupDpm" value="${escapeHTML(row.secondaryBackupDpm)}" maxlength="100"></label>
      <button class="matrix-remove" type="button" data-remove-market="${index}" aria-label="Remove ${escapeHTML(row.market)}">×</button>
    </div>`).join("") || emptyState("No markets in the matrix", "Add a market to configure its DPM and backup contacts.");
  $("#holiday-list").innerHTML = holidaysDraft.length ? holidaysDraft.map((holiday, index) => `
    <span class="holiday-chip">${escapeHTML(dateLabel(holiday.date))}${holiday.name ? ` · ${escapeHTML(holiday.name)}` : ""}<button type="button" data-remove-holiday="${index}" aria-label="Remove holiday ${escapeHTML(holiday.date)}">×</button></span>
  `).join("") : '<span class="form-hint">No extra holidays configured.</span>';
}

function openMarketMatrix() {
  marketMatrixDraft = state.marketMatrix.map((row) => ({ ...row }));
  holidaysDraft = state.holidays.map((holiday) => ({ ...holiday }));
  renderMarketMatrixDraft();
  $("#market-matrix-dialog").showModal();
}

async function openAllocation(project, audit = null, selfAssign = false) {
  const form = $("#allocation-form");
  populateSelects();
  form.reset();
  form.elements.projectId.value = project.id;
  form.elements.auditId.value = audit?.id || "";
  setAssigneeOptions(form.elements.assignee, project.productionTeamId);
  if (selfAssign) {
    const select = form.elements.assignee;
    select.innerHTML = `<option value="${escapeHTML(state.user.name)}">${escapeHTML(state.user.name)}</option>`;
    select.value = state.user.name;
  } else {
    form.elements.assignee.value = project.assignee || form.elements.assignee.options[0]?.value || "";
  }
  form.elements.dueDate.value = project.dueDate || localDate();
  form.elements.plannedStartDate.value = project.plannedStartDate || localDate();
  form.elements.startTime.value = project.plannedStartTime || state.team.find((member) => member.name === form.elements.assignee.value)?.shiftStart || "11:30";
  updateShiftTimeFields(form);
  $("#allocation-project-label").textContent = `${project.ref} · ${project.title} · Workfront project priority: ${workfrontProjectPriority(project) || "Not provided"} (read-only)`;
  $("#allocation-tat-label").textContent = `Current turnaround (TAT) date: ${dateLabel(project.tatDate)}. Confirming a due date here will not change TAT.`;
  $("#resource-suggestions").innerHTML = "";
  $("#allocation-effort").textContent = selfAssign ? "Claim this unassigned task to add it to your personal timeline." : "Calculating AHT-based effort and current resource bandwidth…";
  $("#allocation-effort").classList.toggle("hidden", selfAssign);
  $("#resource-suggestions").classList.toggle("hidden", selfAssign);
  form.elements.assignee.disabled = selfAssign;
  $("#allocation-dialog").showModal();
  if (!selfAssign) {
    try {
      const estimate = await api("/api/planner/suggestions", { method: "POST", body: JSON.stringify({ projectId: project.id }) });
      $("#allocation-effort").textContent = `${estimate.productionHours.toFixed(1)}h production + ${estimate.qaBufferHours.toFixed(1)}h QA buffer = ${estimate.plannedHours.toFixed(1)}h scheduled.`;
      $("#resource-suggestions").innerHTML = estimate.resources.map((resource) => `<button type="button" class="resource-card ${resource.recommended ? "recommended" : ""}" data-resource="${escapeHTML(resource.name)}" data-start="${escapeHTML(resource.plannedStartDate)}" data-start-time="${escapeHTML(resource.plannedStartTime)}"><span><span class="resource-card-assignment"><small>Assigned</small><strong>${escapeHTML(resource.name)}</strong></span>${resource.recommended ? '<em>Recommended</em>' : ""}</span><small>${resource.onLeaveToday ? "On leave today" : `${resource.availableTodayHours.toFixed(1)}h free today`} · ${resource.openTasks ?? resource.openProjects} open · ${resource.remainingHours.toFixed(1)}h remaining</small><small>${resource.nextLeave ? `Next leave ${dateLabel(resource.nextLeave.startDate)}${resource.nextLeave.endDate !== resource.nextLeave.startDate ? `–${dateLabel(resource.nextLeave.endDate)}` : ""} · ` : ""}Available ${dateLabel(resource.plannedStartDate)} ${resource.plannedStartTime} · target ${dateLabel(resource.plannedEndDate)} ${resource.plannedEndTime}</small></button>`).join("") || emptyState("No resources available", "Add a team member to the roster before assigning work.");
      if (estimate.resources.length) {
        form.elements.assignee.value = estimate.resources[0].name;
        form.elements.plannedStartDate.value = estimate.resources[0].plannedStartDate;
        form.elements.startTime.value = estimate.resources[0].plannedStartTime || "11:30";
        updateShiftTimeFields(form);
      }
    } catch (error) {
      $("#allocation-dialog").close();
      showToast(`Could not load resource suggestions: ${error.message}`, true);
    }
  }
}

function auditDocumentEntries(includeBlank = false) {
  const documents = $$("#audit-documents [data-document-row]").map((row) => ({
    name: row.querySelector("[data-document-name]").value.trim(),
    link: row.querySelector("[data-document-link]").value.trim()
  }));
  return includeBlank ? documents : documents.filter((document) => document.name || document.link);
}

function renderAuditDocuments(documents = []) {
  const rows = documents.length ? documents : [{ name: "", link: "" }];
  $("#audit-documents").innerHTML = rows.map((document, index) => `<div class="document-row" data-document-row><label>Document name<input data-document-name maxlength="240" value="${escapeHTML(document.name || "")}" placeholder="e.g. Source brief"></label><label>Document URL<input data-document-link type="url" maxlength="1000" value="${escapeHTML(document.link || "")}" placeholder="https://…"></label><button type="button" class="matrix-remove" data-remove-document="${index}" aria-label="Remove input document">×</button></div>`).join("");
}

function updateTaskCategoryFields() {
  const form = $("#task-form");
  const category = form.elements.category.value;
  const bugScope = form.elements.bugScope.value;
  const needsCrId = category === "CR" || category === "Bug Fixing" && bugScope === "CR";
  form.elements.category.querySelector('[value="Build"]').hidden = !form.elements.id.value;
  $("#task-cr-id-wrap").classList.toggle("hidden", !needsCrId);
  $("#task-bug-scope-wrap").classList.toggle("hidden", category !== "Bug Fixing");
  form.elements.crId.required = needsCrId;
  if (needsCrId && (!form.elements.id.value || !form.elements.crId.value)) {
    const projectId = form.elements.projectId.value;
    const crTasks = state.tasks.filter((task) => task.projectId === projectId && task.category === "CR");
    form.elements.crId.value = `CR${crTasks.length + 1}`;
  }
  if (!needsCrId) form.elements.crId.value = "";
}

async function updateTaskEstimate() {
  const form = $("#task-form");
  $("#task-source-priority").textContent = `Workfront project priority: ${workfrontProjectPriority({ projectId: form.elements.projectId.value }) || "Not provided"} (read-only; separate from local task priority).`;
  if (!form.elements.projectId.value || !form.elements.units.value) return;
  const estimate = await api("/api/planner/task-suggestions", {
    method: "POST",
    body: JSON.stringify({
      projectId: form.elements.projectId.value,
      category: form.elements.category.value,
      complexity: form.elements.complexity.value,
      units: Number(form.elements.units.value),
      bugScope: form.elements.bugScope.value
    })
  });
  $("#task-estimate-preview").textContent = `${estimate.productionHours.toFixed(1)}h production + ${estimate.qaBufferHours.toFixed(1)}h AHT QA = ${estimate.plannedHours.toFixed(1)}h scheduled.${estimate.qaEstimateUnavailable ? " QA AHT unavailable; estimate excludes QA." : ""}`;
  const assignee = form.elements.assignee.value;
  const resource = estimate.resources.find((item) => item.name === assignee) || estimate.resources[0];
  if (resource) {
    const leaveHint = resource.nextLeave ? ` Next leave: ${dateLabel(resource.nextLeave.startDate)}.` : "";
    $("#task-estimate-preview").textContent += ` Suggested capacity: ${resource.name}, ${dateLabel(resource.plannedStartDate)}–${dateLabel(resource.plannedEndDate)}.${leaveHint}`;
  }
  if (resource && !form.elements.id.value) {
    if (!state.roleCapabilities.manageProjects) form.elements.assignee.value = state.user.name;
    else if (!assignee) form.elements.assignee.value = resource.name;
    if (!form.elements.startDate.value) form.elements.startDate.value = resource.plannedStartDate;
    if (!form.elements.startTime.value) form.elements.startTime.value = resource.plannedStartTime;
    if (!form.elements.etaOverride.checked) {
      form.elements.etaDate.value = resource.plannedEndDate;
      form.elements.etaTime.value = resource.plannedEndTime;
    }
  }
  updateShiftTimeFields(form);
}

function updateShiftTimeFields(form, resetStart = false) {
  const member = state.team.find((item) => item.name === form.elements.assignee.value);
  const start = member?.shiftStart || "11:30";
  const end = member?.shiftEnd || (member ? "21:30" : "20:30");
  form.elements.startTime.min = start;
  form.elements.startTime.max = end;
  if (resetStart) form.elements.startTime.value = start;
  if (form.elements.etaTime) {
    form.elements.etaTime.min = start;
    form.elements.etaTime.max = end;
  }
}

function openTaskDialog(task = null, prefill = null) {
  const values = task || prefill || {};
  const form = $("#task-form");
  form.reset();
  populateSelects();
  form.elements.id.value = values.id || "";
  form.elements.category.value = values.category || "CR";
  form.elements.projectId.value = values.projectId || state.projects.find((project) => project.assignee === state.user.name)?.id || state.projects[0]?.id || "";
  $("#task-source-priority").textContent = `Workfront project priority: ${workfrontProjectPriority({ projectId: form.elements.projectId.value }) || "Not provided"} (read-only; separate from local task priority).`;
  setAssigneeOptions(form.elements.assignee, state.projects.find((project) => project.id === form.elements.projectId.value)?.productionTeamId, true);
  form.elements.bugScope.value = values.bugScope || "Build";
  form.elements.crId.value = values.crId || "";
  form.elements.complexity.value = values.complexity || "Medium";
  form.elements.units.value = values.units || 1;
  form.elements.assignee.value = values.assignee || (state.roleCapabilities.manageProjects ? "" : state.user.name);
  form.elements.priority.value = values.priority || "Normal";
  form.elements.priorityOrder.value = values.priorityOrder || "3";
  form.elements.status.value = values.status || "Not Started";
  form.elements.startDate.value = values.startDate || "";
  form.elements.startTime.value = values.startTime || "";
  form.elements.etaDate.value = values.etaDate || "";
  form.elements.etaTime.value = values.etaTime || "";
  form.elements.etaOverride.checked = values.etaOverride || false;
  form.elements.title.value = values.category === "Build" ? "" : values.title || "";
  form.elements.observations.value = values.observations || "";
  form.elements.assignee.disabled = !state.roleCapabilities.manageProjects;
  form.elements.priority.disabled = !state.roleCapabilities.manageProjects;
  form.elements.priorityOrder.disabled = !state.roleCapabilities.manageProjects;
  form.elements.status.disabled = !state.roleCapabilities.manageProjects;
  form.elements.etaOverride.disabled = !state.roleCapabilities.manageProjects;
  form.elements.etaDate.readOnly = !form.elements.etaOverride.checked;
  form.elements.etaTime.readOnly = !form.elements.etaOverride.checked;
  updateShiftTimeFields(form);
  $("#task-dialog-title").textContent = task ? "Edit production task" : "Add CR / Bug Fixing task";
  updateTaskCategoryFields();
  $("#task-dialog").showModal();
  if (task) $("#task-estimate-preview").textContent = `${task.productionHours.toFixed(1)}h production + ${task.qaBufferHours.toFixed(1)}h QA buffer = ${task.plannedHours.toFixed(1)}h scheduled; capacity ETA ${dateLabel(task.etaDate)} ${task.etaTime}.`;
  else updateTaskEstimate().catch((error) => showToast(`Could not estimate this task: ${error.message}`, true));
}

async function downloadBackup() {
  const backup = await api("/api/export");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
  link.download = `team-project-hub-backup-${localDate()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function boot() {
  if (typeof initializeWorkflowUI === "function") initializeWorkflowUI();
  if (typeof initializeLeadershipReportsUI === "function") initializeLeadershipReportsUI();
  try {
    const status = await api("/api/auth/status");
    if (status.user) {
      state.user = status.user;
      await refreshData();
    } else {
      showAuth(status.setupRequired);
    }
  } catch (error) {
    showAuth(false);
    showToast(error.message, true);
  }

  $("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    const setup = form.dataset.mode === "setup";
    try {
      const response = await api(setup ? "/api/auth/setup" : "/api/auth/login", { method: "POST", body: JSON.stringify(body) });
      state.user = response.user;
      await refreshData();
      showToast(setup ? "Workspace created. You are the Manager." : "Signed in successfully.");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  $("#logout-button").addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
      state.user = null;
      showAuth(false);
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#main-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (button) setView(button.dataset.view);
  });
  $("#main-nav").addEventListener("pointerdown", (event) => {
    if (event.target.closest("[data-view]")) event.preventDefault();
  });
  const hoverCard = document.createElement("section");
  hoverCard.id = "timeline-hover";
  hoverCard.className = "timeline-hover";
  hoverCard.hidden = true;
  hoverCard.setAttribute("role", "region");
  hoverCard.setAttribute("aria-label", "Task details");
  timelineDetailCard.element = hoverCard;
  const toggleTimelineDetail = (row) => {
    if (timelineDetailKey === row.dataset.hoverTask && !hoverCard.hidden) hideTimelineDetail();
    else showTimelineHover(row);
  };
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-timeline-detail]")) {
      const row = document.querySelector(`[data-hover-task="${CSS.escape(timelineDetailKey)}"]`);
      hideTimelineDetail();
      row?.focus();
      return;
    }
    const row = event.target.closest("[data-hover-task]");
    if (row && !event.target.closest("button, a, input, select, [data-action]")) toggleTimelineDetail(row);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !hoverCard.hidden) hideTimelineDetail();
    if ((event.key === "Enter" || event.key === " ") && event.target.matches?.("[data-hover-task]")) {
      event.preventDefault();
      toggleTimelineDetail(event.target);
    }
  });
  $("#today-risk-button").addEventListener("click", () => {
    setView("capacity");
    setCapacityTab("report");
  });
  $("#assignment-alert-button").addEventListener("click", () => $("#assignment-alert-dialog").showModal());
  $$("[data-capacity-tab]").forEach((button) => button.addEventListener("click", () => setCapacityTab(button.dataset.capacityTab)));
  $("#briefing-form").addEventListener("input", (event) => {
    if ((event.target.name === "date" || event.target.dataset.briefingProposed) && event.target.value) {
      const working = nextBriefingDays(event.target.value, 1)[0];
      if (working !== event.target.value) {
        const holiday = holidayOn(event.target.value);
        event.target.value = working;
        showToast(`${holiday ? `${holiday.name || "Holiday"} is a holiday` : "That is a weekend"} — moved to the next working day, ${briefingDateLabel(working)}.`);
      }
    }
    if (event.target.name === "teamId" || event.target.name === "date") {
      state.capacityReportTeam = $("#briefing-form").elements.teamId.value;
      renderCapacityBriefing({ syncInputs: true });
      renderOperations();
      return;
    }
    if (event.target.name !== "recipients") saveBriefingNotes();
    renderCapacityBriefing();
  });
  $("#briefing-form").addEventListener("submit", (event) => event.preventDefault());
  $$("[data-briefing-day]").forEach((button) => button.addEventListener("click", () => {
    const form = $("#briefing-form");
    const today = localDate();
    const date = button.dataset.briefingDay === "tomorrow" ? tomorrowBriefingDate(today) : nextBriefingDays(today, 1)[0];
    form.elements.date.value = date;
    form.elements.date.dispatchEvent(new Event("input", { bubbles: true }));
    if (button.dataset.briefingDay === "tomorrow") showToast(`Tomorrow's report generated for ${briefingDateLabel(date)} — ready to share today.`);
  }));
  $("#holiday-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const date = form.elements.date.value;
    const name = form.elements.name.value.trim();
    if (state.holidays.some((holiday) => holiday.date === date)) return showToast("That date is already a holiday.", true);
    const holidays = [...state.holidays, { date, name }].sort((a, b) => a.date.localeCompare(b.date));
    if (await saveHolidays(holidays, `${name} added to the holiday calendar.`)) form.reset();
  });
  $("#holiday-calendar").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-delete-holiday]");
    if (!button) return;
    const holiday = state.holidays.find((item) => item.date === button.dataset.deleteHoliday);
    if (!holiday || !confirm(`Remove ${holiday.name || "holiday"} (${holiday.date}) from the calendar?`)) return;
    await saveHolidays(state.holidays.filter((item) => item.date !== holiday.date), `${holiday.name || "Holiday"} removed.`);
  });
  $("#briefing-copy").addEventListener("click", copyCapacityBriefing);
  $("#briefing-download").addEventListener("click", downloadCapacityBriefingEmail);
  $("#briefing-source-download").addEventListener("click", downloadCapacityBriefingSource);
  try {
    $("#briefing-form").elements.recipients.value = localStorage.getItem("capacityBriefing:recipients") || "";
  } catch {
    // Recipient memory is optional.
  }
  $(".brand").addEventListener("click", (event) => {
    event.preventDefault();
    setView("overview");
  });
  $("#view-workfront").addEventListener("click", (event) => {
    const auditButton = event.target.closest("[data-action=quick-preaudit]");
    if (auditButton) {
      startWorkfrontPreAudit(auditButton.dataset.ref);
      return;
    }
    const datasetButton = event.target.closest("[data-workfront-dataset]");
    if (datasetButton) {
      state.workfrontDataset = datasetButton.dataset.workfrontDataset;
      state.drill = null;
      state.workfrontPage = 1;
      $("#workfront-search").value = "";
      $("#workfront-status-filter").value = "";
      $("#workfront-project-status-filter").value = "";
      renderWorkfront();
      return;
    }
    const pageButton = event.target.closest("[data-workfront-page]");
    if (pageButton && !pageButton.disabled) {
      state.workfrontPage = Number(pageButton.dataset.workfrontPage);
      renderWorkfront();
    }
  });
  $("#workfront-search").addEventListener("input", () => { state.workfrontPage = 1; renderWorkfront(); });
  $("#workfront-team-filter").addEventListener("change", () => { state.workfrontPage = 1; renderWorkfront(); });
  $("#workfront-status-filter").addEventListener("change", () => { state.workfrontPage = 1; renderWorkfront(); });
  $("#workfront-project-status-filter").addEventListener("change", () => { state.workfrontPage = 1; renderWorkfront(); });
  $("#workfront-priority-filter").addEventListener("change", () => { state.workfrontPage = 1; renderWorkfront(); });
  $("#workfront-upload-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    const openFile = form.elements.openProjects.files[0];
    const changeRoundsFile = form.elements.changeRounds.files[0];
    button.disabled = true;
    button.textContent = "Syncing…";
    try {
      const [openProjects, changeRounds] = await Promise.all([fileAsBase64(openFile), fileAsBase64(changeRoundsFile)]);
      const summary = await api("/api/workfront/sync", { method: "POST", body: JSON.stringify({ openProjects, changeRounds }) });
      await refreshData();
      state.workfrontDataset = "projects";
      state.workfrontPage = 1;
      setView("workfront");
      showToast(`Workfront sync complete: ${summary.projects.added} projects and ${summary.changeRounds.added} CRs added; ${summary.projects.alreadyInWorkspace + summary.changeRounds.alreadyInWorkspace} existing records skipped.`);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = "Sync reports";
    }
  });
  $("#workfront-login-start").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Opening Workfront…";
    try {
      await api("/api/workfront/login", { method: "POST", body: JSON.stringify({}) });
      await refreshData();
      showToast("Workfront sign-in opened on the Creative Lab host. Complete SSO/MFA there, then return and scrape.");
    } catch (error) {
      await refreshData();
      showToast(error.message, true);
    } finally {
      button.textContent = "Open Workfront sign-in";
      renderWorkfront();
    }
  });
  $("#workfront-login-complete").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Closing sign-in & scraping…";
    try {
      const { summary } = await api("/api/workfront/login/complete", { method: "POST", body: JSON.stringify({}) });
      await refreshData();
      showToast(`Workfront scrape complete: ${summary.projects.added} projects, ${summary.changeRounds.added} CRs and ${summary.tasks.added} tasks added; ${summary.projects.updated + summary.changeRounds.updated + summary.tasks.updated} existing report records updated.`);
    } catch (error) {
      await refreshData();
      showToast(error.message, true);
    } finally {
      button.textContent = "I'm signed in — scrape now";
      renderWorkfront();
    }
  });
  $("#workfront-login-cancel").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api("/api/workfront/login/cancel", { method: "POST", body: JSON.stringify({}) });
      await refreshData();
      showToast("Workfront sign-in cancelled.");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      renderWorkfront();
    }
  });
  $("#workfront-dom-sync-now").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Scraping Workfront…";
    try {
      const summary = await api("/api/workfront/dom-sync", { method: "POST", body: JSON.stringify({}) });
      await refreshData();
      showToast(`Workfront scrape complete: ${summary.projects.added} projects, ${summary.changeRounds.added} CRs and ${summary.tasks.added} tasks added; ${summary.projects.updated + summary.changeRounds.updated + summary.tasks.updated} existing report records updated.`);
    } catch (error) {
      showToast(error.message, true);
    } finally {
      button.textContent = "Scrape Workfront now";
      renderWorkfront();
    }
  });
  $("#workfront-dom-toggle").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const enabled = !state.workfrontAutomation?.enabled;
    button.disabled = true;
    try {
      await api("/api/workfront/automation", { method: "POST", body: JSON.stringify({ enabled }) });
      await refreshData();
      showToast(enabled ? "Automatic Workfront sync enabled; the first scrape has started." : "Automatic Workfront sync paused.");
    } catch (error) {
      showToast(error.message, true);
    } finally {
      renderWorkfront();
    }
  });
  $("#gantt-chart").addEventListener("dragstart", (event) => {
    const bar = event.target.closest("[data-action=edit-task]");
    if (!bar || !state.roleCapabilities.manageProjects) return;
    event.dataTransfer.setData("text/plain", bar.dataset.id);
    event.dataTransfer.effectAllowed = "move";
  });
  $("#gantt-chart").addEventListener("dragover", (event) => {
    if (event.target.closest(".gantt-grid-day[data-date]")) event.preventDefault();
  });
  $("#gantt-chart").addEventListener("drop", async (event) => {
    const cell = event.target.closest(".gantt-grid-day[data-date]");
    const track = cell?.closest(".gantt-track");
    const taskId = event.dataTransfer.getData("text/plain");
    const task = state.tasks.find((item) => item.id === taskId);
    if (!cell || !track || !task || !state.roleCapabilities.manageProjects) return;
    event.preventDefault();
    const startTime = cell.dataset.time || task.startTime;
    try {
      await api(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: "PUT",
        body: JSON.stringify({ assignee: track.dataset.assignee === "Unassigned" ? "" : track.dataset.assignee, startDate: cell.dataset.date, startTime })
      });
      await refreshData();
      showToast(`Moved ${task.category}${task.crId ? ` ${task.crId}` : ""} to ${track.dataset.assignee} for ${dateLabel(cell.dataset.date)} ${startTime}.`);
    } catch (error) {
      showToast(error.message, true);
    }
  });
  document.addEventListener("click", (event) => {
    const readAlert = event.target.closest("[data-read-notification]");
    if (readAlert) {
      api(`/api/notifications/${readAlert.dataset.readNotification}/read`, { method: "POST" }).then(() => refreshData()).catch((error) => showToast(error.message, true));
      return;
    }
    const goButton = event.target.closest("[data-go]");
    if (goButton) return setView(goButton.dataset.go);
    const teamTab = event.target.closest("[data-team-tab]");
    if (teamTab) return setTeamTab(teamTab.dataset.teamTab);
    const clearDrillButton = event.target.closest("[data-clear-drill]");
    if (clearDrillButton) return clearDrill();
    const drillButton = event.target.closest("[data-drill-view]");
    if (drillButton) return drillInto(drillButton);
    const closeButton = event.target.closest("[data-close]");
    if (closeButton) return $(`#${closeButton.dataset.close}`).close();
    if (event.target.closest("[data-save-aht-matrix]")) {
      saveAhtMatrix();
      return;
    }
    const leaveDecisionButton = event.target.closest("[data-leave-decision]");
    if (leaveDecisionButton) {
      const { leaveId, leaveDecision } = leaveDecisionButton.dataset;
      api(`/api/leaves/${encodeURIComponent(leaveId)}`, {
        method: "PUT",
        body: JSON.stringify({ action: leaveDecision })
      }).then(async (result) => {
        await refreshData();
        if (leaveDecision === "approve") {
          const changed = (result.impacts || []).filter((impact) => impact.beforeStartDate !== impact.afterStartDate || impact.beforeEtaDate !== impact.afterEtaDate).length;
          showToast(`Leave approved. ${changed} task${changed === 1 ? "" : "s"} rescheduled around the absence.`);
        } else showToast("Leave request declined.");
      }).catch((error) => showToast(error.message, true));
      return;
    }
    const deleteLeaveButton = event.target.closest("[data-leave-delete]");
    if (deleteLeaveButton) {
      api(`/api/leaves/${encodeURIComponent(deleteLeaveButton.dataset.leaveDelete)}`, { method: "DELETE" })
        .then(async () => {
          await refreshData();
          showToast("Leave removed and affected schedules recalculated.");
        })
        .catch((error) => showToast(error.message, true));
      return;
    }
    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    if (["log-task", "log-source-task"].includes(actionButton.dataset.action)) {
      openWorklogDialog(actionButton.dataset.action === "log-source-task" ? `wf:${actionButton.dataset.id}` : actionButton.dataset.id);
      return;
    }
    if (actionButton.dataset.action === "leave-reassign-task") {
      const task = state.tasks.find((item) => item.id === actionButton.dataset.id);
      if (!task) {
        showToast("The task is no longer available. Refresh the report and try again.", true);
        return;
      }
      openTaskDialog({ ...task, assignee: actionButton.dataset.assignee || task.assignee });
      return;
    }
    if (actionButton.dataset.action === "assign-workfront-cr") {
      const round = state.workfrontChangeRounds.find((item) => item.workfrontId === actionButton.dataset.workfrontCrId);
      const project = state.projects.find((item) => item.id === actionButton.dataset.projectId);
      if (!round || !project) {
        showToast("The Workfront CR or its local project is no longer available. Refresh the reports and try again.", true);
        return;
      }
      const complexityText = String(round.complexity || "").toLowerCase();
      const complexity = /high|complex/.test(complexityText) ? "High" : /low|simple/.test(complexityText) ? "Low" : "Medium";
      openTaskDialog(null, {
        category: "CR",
        projectId: project.id,
        crId: round.crId,
        complexity,
        assignee: actionButton.dataset.assignee || ""
      });
      return;
    }
    if (actionButton.dataset.action === "reassign-workfront-cr") {
      const task = state.tasks.find((item) => item.id === actionButton.dataset.taskId);
      if (!task) {
        showToast("The linked CR task is no longer available. Refresh the reports and try again.", true);
        return;
      }
      openTaskDialog({ ...task, assignee: actionButton.dataset.assignee || task.assignee });
      return;
    }
    if (actionButton.dataset.action === "quick-preaudit") {
      startWorkfrontPreAudit(actionButton.dataset.ref);
      return;
    }
    if (actionButton.dataset.action === "quick-current-audit") {
      startWorkfrontCurrentAudit(actionButton.dataset.ref);
      return;
    }
    if (actionButton.dataset.action === "quick-audit") {
      startWorkfrontAudit(actionButton.dataset.workfrontId);
      return;
    }
    if (actionButton.dataset.action === "workfront-allocate") {
      openWorkfrontAllocation(actionButton.dataset.workfrontId);
      return;
    }
    if (actionButton.dataset.action === "workfront-rework") {
      openWorkfrontRework(actionButton.dataset.workfrontId);
      return;
    }
    if (actionButton.dataset.action === "workfront-qc-complete") {
      const workfrontId = actionButton.dataset.workfrontId;
      api(`/api/workfront/${encodeURIComponent(workfrontId)}/qc-complete`, { method: "POST", body: "{}" })
        .then(async () => {
          await refreshData();
          showToast("QC complete; the Workfront project is marked complete.");
        })
        .catch((error) => showToast(error.message, true));
      return;
    }
    if (actionButton.dataset.action === "allocate-task") {
      const audit = state.audits.find((item) => item.id === actionButton.dataset.id);
      const project = audit && state.projects.find((item) => item.ref.toLowerCase() === audit.projectRef.toLowerCase());
      if (audit && project) openAllocation(project, audit);
      return;
    }
    const task = state.tasks.find((item) => item.id === actionButton.dataset.id);
    if (actionButton.dataset.action === "edit-task" && task) {
      openTaskDialog(task);
      return;
    }
    const project = state.projects.find((item) => item.id === actionButton.dataset.id);
    if (actionButton.dataset.action === "open-allocation" && project) {
      openAllocation(project);
      return;
    }
    if (actionButton.dataset.action === "claim-task" && project) {
      openAllocation(project, null, true);
      return;
    }
    if (actionButton.dataset.action === "edit-project" && project) openProject(project);
    if (actionButton.dataset.action === "log-work" && project) {
      populateSelects();
      const form = $("#worklog-form");
      form.reset();
      populateSelects();
      form.elements.taskId.value = state.tasks.find((task) => task.projectId === project.id && task.category === "Build")?.id || "";
      form.elements.projectId.value = project.id;
      form.elements.date.value = localDate();
      form.elements.progress.value = project.progress;
      form.elements.status.value = project.status === "Completed" ? "Completed" : project.status;
      $("#worklog-dialog").showModal();
    }
  });
  $("#projects-new-button").addEventListener("click", () => openProject());
  $("#project-search").addEventListener("input", renderProjects);
  $("#status-filter").addEventListener("change", renderProjects);
  $("#assignee-filter").addEventListener("change", renderProjects);
  $("#audit-search").addEventListener("input", renderAudits);
  $("#audit-type-filter").addEventListener("change", renderAudits);
  $("#audit-status-filter").addEventListener("change", renderAudits);
  $("#projects-export").addEventListener("click", exportProjects);
  $("#audits-export").addEventListener("click", exportAudits);
  $("#market-matrix-button").addEventListener("click", openMarketMatrix);
  $("#new-change-round-button").addEventListener("click", () => {
    const form = $("#change-round-form");
    form.reset();
    populateSelects();
    const now = new Date();
    form.elements.landedDate.value = localDate(now);
    form.elements.landedTime.value = now.toTimeString().slice(0, 5);
    form.elements.priority.value = "Normal";
    form.elements.etaDate.readOnly = true;
    form.elements.etaTime.readOnly = true;
    const project = state.projects[0];
    if (project) {
      form.elements.projectRef.value = project.ref;
      setAssigneeOptions(form.elements.assignee, project.productionTeamId, true);
      const crCount = state.tasks.filter((task) => task.projectId === project.id && task.category === "CR").length;
      form.elements.crId.value = `CR${crCount + 1}`;
    }
    updateChangeRoundEta();
    $("#change-round-dialog").showModal();
  });
  $("#new-task-button").addEventListener("click", () => {
    $("#gantt-source").value = "local";
    renderGantt();
    openTaskDialog();
  });
  for (const id of ["task-form", "allocation-form", "workfront-allocation-form", "workfront-rework-form"]) {
    const form = $(`#${id}`);
    form.elements.assignee.addEventListener("change", () => updateShiftTimeFields(form, true));
  }
  $('#task-form [name="projectId"]').addEventListener("change", (event) => {
    const project = state.projects.find((item) => item.id === event.currentTarget.value);
    setAssigneeOptions($("#task-form [name=assignee]"), project?.productionTeamId, true);
  });
  $('#change-round-form [name="projectRef"]').addEventListener("change", (event) => {
    const project = state.projects.find((item) => item.ref === event.currentTarget.value);
    setAssigneeOptions($("#change-round-form [name=assignee]"), project?.productionTeamId, true);
  });
  const syncHalfDayLeave = () => {
    const form = $("#leave-form");
    const half = Boolean(form.elements.halfDay.value);
    if (half) form.elements.endDate.value = form.elements.startDate.value;
    form.elements.endDate.readOnly = half;
  };
  $("#leave-form").elements.halfDay.addEventListener("change", syncHalfDayLeave);
  $("#leave-form").elements.startDate.addEventListener("change", syncHalfDayLeave);
  $("#leave-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    try {
      const result = await api("/api/leaves", { method: "POST", body: JSON.stringify(body) });
      form.reset();
      form.elements.startDate.value = localDate();
      form.elements.endDate.value = localDate();
      form.elements.endDate.readOnly = false;
      await refreshData();
      if (result.leave.status === "Pending") showToast("Leave request submitted. It will affect capacity only after Manager approval.");
      else {
        const changed = (result.impacts || []).filter((impact) => impact.beforeStartDate !== impact.afterStartDate || impact.beforeEtaDate !== impact.afterEtaDate).length;
        showToast(`Leave approved. ${changed} existing task${changed === 1 ? "" : "s"} rescheduled around the absence.`);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#gantt-scale").addEventListener("change", (event) => {
    state.ganttScale = event.currentTarget.value;
    renderGantt();
  });
  $("#gantt-group-by").addEventListener("change", renderGantt);
  $("#gantt-team-filter").addEventListener("change", () => {
    if (state.drill?.view === "gantt") state.drill = null;
    renderGantt();
  });
  for (const selector of ["#gantt-status-filter", "#gantt-project-status-filter"]) {
    $(selector).addEventListener("change", () => {
      if (state.drill?.view === "gantt") state.drill = null;
      renderGantt();
    });
  }
  $("#gantt-source").addEventListener("change", () => {
    if (state.drill?.view === "gantt") state.drill = null;
    $("#gantt-status-filter").value = "";
    $("#gantt-project-status-filter").value = "";
    renderGantt();
  });
  $("#gantt-anchor").value = localDate();
  $("#gantt-anchor").addEventListener("change", renderGantt);
  $("#insight-dimension").addEventListener("change", renderCapacity);
  $("#manager-report-date").value = localDate();
  $("#manager-report-date").addEventListener("change", renderManagerReports);
  $("#manager-report-summary").addEventListener("click", (event) => {
    const button = event.target.closest("[data-scroll-target]");
    if (!button) return;
    const panel = document.getElementById(button.dataset.scrollTarget);
    panel.open = true;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("#utilization-anchor-date").value = localDate();
  $("#utilization-start-date").value = localDate();
  $("#utilization-end-date").value = localDate();
  $("#utilization-period").addEventListener("change", renderTeamUtilization);
  ["utilization-anchor-date", "utilization-start-date", "utilization-end-date"].forEach((id) => {
    $(`#${id}`).addEventListener("change", renderTeamUtilization);
  });
  $("#personal-log-period").addEventListener("change", renderPersonalTaskLogs);
  $("#new-audit-button").addEventListener("click", () => openAuditForm());
  $("#audit-form").elements.projectRef.addEventListener("change", (event) => {
    const ref = event.currentTarget.value.trim();
    const project = workfrontProjectForRef(ref);
    if (project) {
      const prefill = auditPrefillFromWorkfront(project);
      const form = $("#audit-form");
      form.elements.workfrontId.value = project.workfrontId || "";
      form.elements.projectName.value = prefill.projectName || "";
      setAuditMarket(prefill.market || "");
      form.elements.primaryDpm.value = prefill.primaryDpm || "";
      populateAuditBackups();
      if (prefill.channel) form.elements.channel.value = prefill.channel;
      form.elements.requestType.value = prefill.requestType;
      form.elements.complexity.value = prefill.complexity;
      form.elements.pageCount.value = prefill.pageCount;
    }
  });
  $("#add-audit-document").addEventListener("click", () => {
    const documents = auditDocumentEntries(true);
    documents.push({ name: "", link: "" });
    renderAuditDocuments(documents);
  });
  $("#audit-documents").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-document]");
    if (!button) return;
    const documents = auditDocumentEntries(true);
    documents.splice(Number(button.dataset.removeDocument), 1);
    renderAuditDocuments(documents);
  });
  $("#audit-market").addEventListener("change", (event) => {
    const project = workfrontProjectForRef($("#audit-form").elements.projectRef.value.trim());
    $("#audit-primary-dpm").value = project?.projectOwner || project?.owner || "";
    populateAuditBackups();
  });
  $("#audit-form").elements.auditType.addEventListener("change", updateAuditFormMode);
  $("#audit-form").elements.requestType.addEventListener("change", updateAuditFormMode);
  $("#audit-form").elements.primaryDpm.addEventListener("input", updateAuditGreeting);
  $("#audit-form").elements.backupDpm.addEventListener("input", updateAuditGreeting);
  $("#audit-form").elements.primaryOnLeave.addEventListener("change", updateAuditGreeting);
  $("#audit-form").elements.etaTime.addEventListener("change", (event) => {
    const minutes = Number(event.currentTarget.value.slice(0, 2)) * 60 + Number(event.currentTarget.value.slice(3));
    if (event.currentTarget.value && minutes < 12 * 60 + 30) {
      event.currentTarget.value = "12:30";
      showToast("ETA time adjusted to the 12:30 shift start.");
    } else if (event.currentTarget.value && minutes > 21 * 60 + 30) {
      event.currentTarget.value = "21:30";
      showToast("ETA time adjusted to the 21:30 shift end.");
    }
  });
  ["projectRef", "channel", "requestType", "complexity", "pageCount", "startDate", "startTime"].forEach((name) => {
    $("#audit-form").elements[name].addEventListener("input", () => {
      $("#audit-form").elements.calculatedTat.value = "";
      $("#audit-form").elements.capacityRequested.value = "false";
      $("#audit-capacity-result").innerHTML = "";
    });
    $("#audit-form").elements[name].addEventListener("change", () => {
      $("#audit-form").elements.calculatedTat.value = "";
      $("#audit-form").elements.capacityRequested.value = "false";
      $("#audit-capacity-result").innerHTML = "";
    });
    $("#audit-form").addEventListener("reset", () => { $("#audit-capacity-result").innerHTML = ""; });
    $("#calculate-audit-capacity").addEventListener("click", async () => {
      const form = $("#audit-form");
      try {
        const estimate = await api("/api/audit-capacity-estimate", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
        form.elements.capacityRequested.value = "true";
        $("#audit-capacity-result").innerHTML = `${auditCapacityLabel(estimate)}<table><thead><tr><th>Resource</th><th>Existing workload</th><th>Tentative delivery</th></tr></thead><tbody>${estimate.candidates.map((candidate) => `<tr><td>${escapeHTML(candidate.name)}</td><td>${candidate.backlogHours}h</td><td>${escapeHTML(formatEta(candidate.tentativeDate, candidate.tentativeTime))}</td></tr>`).join("")}</tbody></table>`;
      } catch (error) {
        form.elements.capacityRequested.value = "false";
        $("#audit-capacity-result").textContent = error.message;
        showToast(error.message, true);
      }
    });
  });
  $("#calculate-audit-tat").addEventListener("click", async () => {
    try {
      const estimate = await calculateAuditTat();
      showToast(`TAT: ${estimate.calculatedTat}. ETA ${dateLabel(estimate.etaDate)} at ${estimate.etaTime}.`);
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#generate-audit-template").addEventListener("click", async () => {
    const form = $("#audit-form");
    if (!form.elements.projectRef.value.trim()) {
      form.elements.projectRef.reportValidity();
      return;
    }
    try {
      if (!form.elements.calculatedTat.value) await calculateAuditTat();
      generateAuditTemplate();
      showToast("Email template generated from the audit details.");
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#copy-audit-template").addEventListener("click", async () => {
    const preview = $("#audit-template-preview");
    try {
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([preview.innerHTML], { type: "text/html" }),
          "text/plain": new Blob([preview.innerText], { type: "text/plain" })
        })]);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(preview.innerText);
      } else {
        throw new Error("Rich clipboard access is unavailable in this browser context.");
      }
      showToast("Formatted audit email template copied.");
    } catch (error) {
      let fallbackError = error;
      try {
        const fallback = document.createElement("textarea");
        fallback.value = preview.innerText;
        fallback.setAttribute("readonly", "");
        fallback.style.position = "fixed";
        fallback.style.opacity = "0";
        document.body.append(fallback);
        fallback.select();
        const copied = document.execCommand("copy");
        fallback.remove();
        if (!copied) throw new Error("The browser refused the clipboard request.");
        showToast("Audit email template copied as plain text.");
      } catch (fallbackFailure) {
        fallbackError = fallbackFailure;
        showToast(`Could not copy template: ${fallbackError.message}`, true);
      }
    }
  });
  $("#project-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    const id = body.id;
    delete body.id;
    body.pages = Number(body.pages);
    body.progress = Number(body.progress);
    body.complexity = Number(body.complexity);
    try {
      await api(id ? `/api/projects/${encodeURIComponent(id)}` : "/api/projects", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
      $("#project-dialog").close();
      await refreshData();
      showToast(id ? "Project updated." : "Project added.");
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#worklog-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    body.hours = Number(body.hours);
    body.progress = Number(body.progress);
    try {
      const sourceLog = body.taskId.startsWith("wf:");
      if (sourceLog) body.taskId = body.taskId.slice(3);
      await api(sourceLog ? "/api/workfront-worklogs" : "/api/worklogs", { method: "POST", body: JSON.stringify(body) });
      $("#worklog-dialog").close();
      await refreshData();
      showToast("Progress and work log saved.");
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#audit-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.elements.calculatedTat.value) {
      try {
        await calculateAuditTat();
      } catch (error) {
        showToast(error.message, true);
        return;
      }
    }
    const body = Object.fromEntries(new FormData(event.currentTarget));
    body.pageCount = Number(body.pageCount);
    body.documents = auditDocumentEntries();
    try {
      const audit = await api("/api/audits", { method: "POST", body: JSON.stringify(body) });
      $("#audit-dialog").close();
      await refreshData();
      if (audit.auditType === "Pre-Audit" && audit.auditStatus === "Pass" && audit.workfrontId) {
        const source = state.workfrontProjects.find((project) => project.workfrontId === audit.workfrontId);
        if (source?.productionStage === "Awaiting Execution") {
          showToast("Current project audit passed. Choose an available designer to allocate the project.");
          await openWorkfrontAllocation(audit.workfrontId);
        } else {
          showToast("Pre-Audit passed. The project is held as Pre-Audit Complete until Workfront confirms clarifications and dependencies are clear.");
        }
      } else if (!audit.crId && audit.auditType === "Audit" && audit.auditStatus === "Pass") {
        if (audit.workfrontId) {
          showToast("Final audit passed. The Workfront project is marked complete.");
        } else {
          const project = state.projects.find((item) => item.ref.toLowerCase() === audit.projectRef.toLowerCase());
          if (project) openAllocation(project, audit);
          showToast("Audit passed. Assign the project task.");
        }
      } else {
        showToast("Audit saved to the shared workspace.");
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#resource-suggestions").addEventListener("click", (event) => {
    const suggestion = event.target.closest("[data-resource]");
    if (!suggestion) return;
    const form = $("#allocation-form");
    form.elements.assignee.value = suggestion.dataset.resource;
    form.elements.plannedStartDate.value = suggestion.dataset.start;
    form.elements.startTime.value = suggestion.dataset.startTime || "11:30";
    updateShiftTimeFields(form);
  });
  $("#workfront-resource-suggestions").addEventListener("click", (event) => {
    const suggestion = event.target.closest("[data-workfront-resource]");
    if (!suggestion) return;
    const form = $("#workfront-allocation-form");
    form.elements.assignee.value = suggestion.dataset.workfrontResource;
    form.elements.plannedStartDate.value = suggestion.dataset.start;
    form.elements.startTime.value = suggestion.dataset.startTime || "11:30";
    updateShiftTimeFields(form);
  });
  $("#workfront-allocation-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    try {
      const result = await api(`/api/workfront/${encodeURIComponent(body.workfrontId)}/allocate`, { method: "POST", body: JSON.stringify(body) });
      $("#workfront-allocation-dialog").close();
      await refreshData();
      $("#gantt-scale").value = "day";
      $("#gantt-source").value = "local";
      setView("gantt");
      showToast(`Allocated ${result.project.ref} to ${result.task.assignee}; it is on the Gantt timeline.`);
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#workfront-rework-form").elements.category.addEventListener("change", (event) => {
    const isCr = event.target.value === "CR";
    $("#workfront-rework-cr-wrap").classList.toggle("hidden", !isCr);
    $("#workfront-rework-scope-wrap").classList.toggle("hidden", isCr);
  });
  $("#workfront-rework-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    try {
      const result = await api(`/api/workfront/${encodeURIComponent(body.workfrontId)}/rework`, { method: "POST", body: JSON.stringify(body) });
      $("#workfront-rework-dialog").close();
      await refreshData();
      $("#gantt-source").value = "local";
      setView("gantt");
      showToast(`Opened ${result.task.title} for ${result.task.assignee}.`);
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#allocation-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const projectId = form.elements.projectId.value;
    const body = { auditId: form.elements.auditId.value, assignee: form.elements.assignee.value, dueDate: form.elements.dueDate.value, plannedStartDate: form.elements.plannedStartDate.value, startTime: form.elements.startTime.value };
    try {
      form.elements.assignee.disabled = false;
      await api(`/api/projects/${encodeURIComponent(projectId)}/allocation`, { method: "POST", body: JSON.stringify(body) });
      $("#allocation-dialog").close();
      await refreshData();
      showToast("Task allocated. The project TAT date was left unchanged.");
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#change-round-form").elements.complexity.addEventListener("change", updateChangeRoundEta);
  $("#change-round-form").elements.landedDate.addEventListener("input", updateChangeRoundEta);
  $("#change-round-form").elements.landedTime.addEventListener("input", updateChangeRoundEta);
  $("#change-round-form").elements.projectRef.addEventListener("change", (event) => {
    const project = state.projects.find((item) => item.ref === event.currentTarget.value);
    const crCount = state.tasks.filter((task) => task.projectId === project?.id && task.category === "CR").length;
    $("#change-round-form").elements.crId.value = `CR${crCount + 1}`;
    updateChangeRoundEta();
  });
  $("#change-round-form").elements.assignee.addEventListener("change", updateChangeRoundEta);
  $("#change-round-form").elements.etaOverride.addEventListener("change", (event) => {
    const form = $("#change-round-form");
    form.elements.etaDate.readOnly = !event.currentTarget.checked;
    form.elements.etaTime.readOnly = !event.currentTarget.checked;
    if (!event.currentTarget.checked) updateChangeRoundEta();
  });
  $("#change-round-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api("/api/change-rounds", { method: "POST", body: JSON.stringify(body) });
      $("#change-round-dialog").close();
      await refreshData();
      showToast("CR task saved with its contractual and capacity ETAs.");
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#task-form").elements.category.addEventListener("change", () => {
    updateTaskCategoryFields();
    updateTaskEstimate().catch((error) => showToast(error.message, true));
  });
  $("#task-form").elements.bugScope.addEventListener("change", updateTaskCategoryFields);
  ["projectId", "complexity", "units", "assignee"].forEach((name) => {
    $("#task-form").elements[name].addEventListener("change", () => {
      updateTaskCategoryFields();
      updateTaskEstimate().catch((error) => showToast(error.message, true));
    });
  });
  $("#task-form").elements.etaOverride.addEventListener("change", (event) => {
    const form = $("#task-form");
    form.elements.etaDate.readOnly = !event.currentTarget.checked;
    form.elements.etaTime.readOnly = !event.currentTarget.checked;
    if (!event.currentTarget.checked) updateTaskEstimate().catch((error) => showToast(error.message, true));
  });
  $("#task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    const id = body.id;
    delete body.id;
    body.units = Number(body.units);
    body.priorityOrder = Number(body.priorityOrder);
    try {
      const response = await api(id ? `/api/tasks/${encodeURIComponent(id)}` : "/api/tasks", {
        method: id ? "PUT" : "POST", body: JSON.stringify(body)
      });
      $("#task-dialog").close();
      await refreshData();
      showToast(id ? "Production task updated." : `${response.task.category}${response.task.crId ? ` ${response.task.crId}` : ""} task added to the timeline.`);
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#complexity-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const complexityMultipliers = Object.fromEntries(["Low", "Medium", "High"].map((level) => [level, Number(form.elements[level].value)]));
    try {
      const response = await api("/api/capacity-settings", { method: "PUT", body: JSON.stringify({ complexityMultipliers }) });
      state.complexityMultipliers = response.complexityMultipliers;
      renderCapacity();
      showToast("Complexity multipliers saved for future effort estimates.");
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#worklog-form").elements.taskId.addEventListener("change", (event) => {
    const task = state.tasks.find((item) => item.id === event.currentTarget.value);
    $("#worklog-form").elements.projectId.value = task?.projectId || "";
  });
  $("#add-market-row-button").addEventListener("click", () => {
    marketMatrixDraft.push({ market: "", primaryDpm: "", backupDpm: "", secondaryBackupDpm: "" });
    renderMarketMatrixDraft();
    $("#market-matrix-rows .matrix-row:last-child [data-field=market]").focus();
  });
  $("#market-matrix-rows").addEventListener("input", (event) => {
    const input = event.target.closest("[data-field]");
    const row = input?.closest(".matrix-row");
    if (input && row) marketMatrixDraft[Number(row.dataset.index)][input.dataset.field] = input.value;
  });
  $("#market-matrix-rows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-market]");
    if (!button) return;
    marketMatrixDraft.splice(Number(button.dataset.removeMarket), 1);
    renderMarketMatrixDraft();
  });
  $("#add-holiday-button").addEventListener("click", () => {
    const date = $("#holiday-date").value;
    const name = $("#holiday-name").value.trim();
    if (!date) return showToast("Choose a holiday date.", true);
    if (holidaysDraft.some((holiday) => holiday.date === date)) return showToast("That holiday date is already in the calendar.", true);
    holidaysDraft.push({ date, name });
    holidaysDraft.sort((a, b) => a.date.localeCompare(b.date));
    $("#holiday-date").value = "";
    $("#holiday-name").value = "";
    renderMarketMatrixDraft();
  });
  $("#holiday-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-holiday]");
    if (!button) return;
    holidaysDraft.splice(Number(button.dataset.removeHoliday), 1);
    renderMarketMatrixDraft();
  });
  $("#market-matrix-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $$("#market-matrix-rows .matrix-row").forEach((row, index) => {
      row.querySelectorAll("[data-field]").forEach((input) => {
        marketMatrixDraft[index][input.dataset.field] = input.value.trim();
      });
    });
    try {
      const settings = await api("/api/planner-settings", {
        method: "PUT",
        body: JSON.stringify({ rows: marketMatrixDraft, holidays: holidaysDraft })
      });
      state.marketMatrix = settings.marketMatrix;
      state.holidays = settings.holidays;
      $("#market-matrix-dialog").close();
      renderAll();
      showToast("Market matrix and holiday calendar saved.");
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#team-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api("/api/team", { method: "POST", body: JSON.stringify({ name: form.elements.name.value }) });
      form.reset();
      await refreshData();
      showToast("Team member added.");
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#team-list").addEventListener("change", async (event) => {
    const executorBox = event.target.closest("[data-team-report-executor]");
    if (executorBox) {
      try {
        await api(`/api/team/${encodeURIComponent(executorBox.dataset.teamReportExecutor)}/report-executor`, {
          method: "PUT", body: JSON.stringify({ reportExecutor: executorBox.checked })
        });
        await refreshData();
        showToast(executorBox.checked ? "Counted as an executor in Quality, FTR and KPI reports." : "No longer counted as an executor in reports.");
      } catch (error) {
        showToast(error.message, true);
        renderTeam();
      }
      return;
    }
    const emailInput = event.target.closest("[data-team-email]");
    if (emailInput) {
      try {
        await api(`/api/team/${encodeURIComponent(emailInput.dataset.teamEmail)}/wpp-email`, {
          method: "PUT", body: JSON.stringify({ wppProductionEmail: emailInput.value })
        });
        await refreshData();
        showToast("WPP Production email updated.");
      } catch (error) {
        showToast(error.message, true);
        renderTeam();
      }
      return;
    }
    const departments = event.target.closest("[data-team-departments]");
    if (departments) {
      try {
        await api(`/api/team/${encodeURIComponent(departments.dataset.teamDepartments)}/departments`, {
          method: "PUT",
          body: JSON.stringify({ teamIds: [...departments.selectedOptions].map((option) => option.value) })
        });
        await refreshData();
        showToast("Team / department access updated.");
      } catch (error) {
        showToast(error.message, true);
        renderTeam();
      }
      return;
    }
    const workfrontInput = event.target.closest("[data-team-workfront]");
    if (workfrontInput) {
      try {
        await api(`/api/team/${encodeURIComponent(workfrontInput.dataset.teamWorkfront)}/workfront`, {
          method: "PUT",
          body: JSON.stringify({ workfrontIds: workfrontInput.value })
        });
        await refreshData();
        showToast("Workfront mapping updated; assigned Workfront tasks now follow this team member.");
      } catch (error) {
        showToast(error.message, true);
        renderTeam();
      }
      return;
    }
    const select = event.target.closest("[data-team-shift]");
    if (!select) return;
    try {
      const [shiftStart, shiftEnd] = select.value.split("|");
      await api(`/api/team/${encodeURIComponent(select.dataset.teamShift)}/shift`, { method: "PUT", body: JSON.stringify({ shiftStart, shiftEnd }) });
      await refreshData();
      showToast("Shift updated; unstarted tasks were moved to the selected shift.");
    } catch (error) {
      showToast(error.message, true);
      renderTeam();
    }
  });
  $('#project-form [name="productionTeamId"]').addEventListener("change", populateProjectAssignees);
  $("#account-role").addEventListener("change", (event) => {
    const isGlobalRole = ["manager", "leadership"].includes(event.currentTarget.value);
    $("#account-departments-field").classList.toggle("hidden", isGlobalRole);
    $("#account-form [name=teamIds]").required = !isGlobalRole;
  });
  $("#account-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const body = Object.fromEntries(new FormData(form));
      body.teamIds = [...form.elements.teamIds.selectedOptions].map((option) => option.value);
      await api("/api/users", { method: "POST", body: JSON.stringify(body) });
      form.reset();
      $("#account-role").dispatchEvent(new Event("change"));
      await refreshData();
      showToast("Teammate account created.");
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#accounts-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-save-account-role]");
    if (!button) return;
    const select = $(`[data-account-role="${CSS.escape(button.dataset.saveAccountRole)}"]`);
    try {
      await api(`/api/users/${encodeURIComponent(button.dataset.saveAccountRole)}/access`, {
        method: "PUT",
        body: JSON.stringify({ role: select.value })
      });
      await refreshData();
      showToast("Account role updated. Department access is taken from the team roster.");
    } catch (error) {
      showToast(error.message, true);
    }
  });
  $("#backup-button").addEventListener("click", async () => {
    try {
      await downloadBackup();
      showToast("Workspace backup downloaded.");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  setInterval(() => {
    if (state.user && !document.hidden) refreshData(true);
  }, 10000);
  document.addEventListener("visibilitychange", () => {
    if (state.user && !document.hidden) refreshData(true);
  });
}

boot();
