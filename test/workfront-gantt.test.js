"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function ganttFixture(options = {}) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { value: "", innerHTML: "", textContent: "", style: {}, classList: { toggle() {} } });
    return elements.get(selector);
  };
  element("#gantt-source").value = options.source || "workfront";
  element("#gantt-scale").value = options.scale || "day";
  element("#gantt-group-by").value = options.groupBy || "project";
  element("#gantt-team-filter").value = options.teamId || "";
  element("#gantt-status-filter").value = options.status || "";
  element("#gantt-project-status-filter").value = options.projectStatus || "";
  element("#gantt-anchor").value = "2026-10-12";
  const context = vm.createContext({
    document: { querySelector: element },
    window: { innerWidth: 1400, innerHeight: 900 },
    URL,
    console
  });
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  assert.match(source, /\nboot\(\);\s*$/);
  vm.runInContext(source.replace(/\nboot\(\);\s*$/, ""), context);
  const project = { ref: "WF-1", title: "Email project", sourceStatus: "Execution in Progress" };
  const task = {
    id: "imported-1", projectRef: "WF-1", projectName: "Email project",
    taskName: "Build", taskStatus: "New", assignees: "Designer One Designer Two",
    assignmentNames: ["Designer One Designer Two"],
    plannedStartDate: "2026-10-12", plannedCompletionDate: "2026-10-14", percentComplete: 40
  };
  context.snapshot = {
    roleCapabilities: { viewWorkfront: options.allowed !== false },
    workfrontProjects: [project],
    workfrontTasks: options.tasks || [task],
    workfrontGanttTasks: options.ganttOnlyTasks || [],
    workfrontChangeRounds: options.rounds || [],
    tasks: options.localTasks || []
  };
  context.snapshot.departments = [{ id: "email", name: "Email Team" }, { id: "design", name: "Design Team" }];
  context.snapshot.projects = options.projects || [];
  context.snapshot.team = options.members || [...new Set(["Designer One Designer Two", ...(options.localTasks || []).map((task) => task.assignee)])].map((name) => ({ name, role: "executioner" }));
  vm.runInContext("applySnapshot(snapshot); renderGantt();", context);
  return { elements, element, context, task };
}

test("Workfront Gantt joins projects and shows exact task status, assignments, dates, and progress", () => {
  const { element } = ganttFixture();
  const html = element("#gantt-chart").innerHTML;
  assert.match(html, /WF-1/);
  assert.match(html, /Project status: Execution in Progress/);
  assert.match(html, /<small>New<\/small>/);
  assert.match(html, /Designer One Designer Two/);
  assert.match(html, /width:40%/);
  assert.match(html, /--bar-width:3/);
  assert.doesNotMatch(html, /data-action=|draggable=|gantt-qa-buffer|data-assignee=/);
});

test("Workfront Gantt includes change rounds with acceptance and expected delivery dates", () => {
  const round = {
    workfrontId: "CR-1", projectRef: "WF-1", title: "Email project", crId: "CR1", assignee: "Designer One",
    productionTeamId: "email", sourceStatus: "Assigned to Execution",
    acceptanceDate: "2026-10-12T12:00:00.000Z", expectedDeliveryDate: "2026-10-14T12:00:00.000Z"
  };
  const { context, element } = ganttFixture({ rounds: [round], tasks: [] });
  const html = element("#gantt-chart").innerHTML;
  assert.match(html, /WF-1 · CR1/);
  assert.match(html, /CR SLA: Acceptance Oct 12, 2026 .*Material expected Oct 14, 2026/);
  assert.match(html, /category-cr/);
  const placed = [];
  context.row = { dataset: { hoverTask: "cr:CR-1" }, after: (card) => placed.push(card), setAttribute() {} };
  vm.runInContext("showTimelineHover(row);", context);
  assert.equal(placed[0], element("#timeline-hover"));
  assert.match(element("#timeline-hover").innerHTML, /CR1/);
  assert.match(element("#timeline-hover").innerHTML, /Oct 12, 2026 – Oct 14, 2026/);
});

test("Gantt shows role-only Bug Fixing records and scopes unassigned rows by team", () => {
  const bug = {
    id: "bug-role", workfrontId: "BUG-ROLE", projectRef: "WF-1", projectName: "Email project",
    taskName: "Bug Fixing", taskStatus: "New", assignees: "ROC | Developer, Role / team",
    assignmentNames: [], productionTeamId: "email", plannedStartDate: "2026-10-12", plannedCompletionDate: "2026-10-14"
  };
  const { element } = ganttFixture({ groupBy: "resource", teamId: "email", tasks: [], ganttOnlyTasks: [bug] });
  assert.match(element("#gantt-chart").innerHTML, /WF-1 · Bug Fixing/);
  assert.match(element("#gantt-chart").innerHTML, /Unassigned \/ role-only/);
  assert.match(element("#gantt-chart").innerHTML, /category-bug-fixing/);
  const otherTeam = ganttFixture({ groupBy: "resource", teamId: "design", tasks: [], ganttOnlyTasks: [bug] });
  assert.doesNotMatch(otherTeam.element("#gantt-chart").innerHTML, /BUG-ROLE/);
  assert.match(element("#gantt-source-notice").textContent, /role-only or unassigned Bug Fixing rows/);
});

test("resource grouping retains the reported multi-assignment label without splitting names", () => {
  const { element } = ganttFixture({ groupBy: "resource" });
  assert.match(element("#gantt-chart").innerHTML, /<summary>Designer One Designer Two/);
  assert.match(element("#gantt-summary").innerHTML, /Assignments/);
});

test("Workfront Gantt retains outside-roster and unassigned work in one bottom group", () => {
  const { task } = ganttFixture();
  for (const groupBy of ["resource", "project", "task"]) {
    const { element } = ganttFixture({ groupBy, members: [], tasks: [
      { ...task, id: "one", assignmentNames: ["External One", "External Two"], assignees: "External One; External Two" },
      { ...task, id: "two", assignmentNames: ["External Three"], assignees: "External Three" },
      { ...task, id: "role", assignmentNames: [], assignees: "ROC | Developer, Role / team" },
      { ...task, id: "unassigned", assignmentNames: [], assignees: "Unassigned" }
    ] });
    const html = element("#gantt-chart").innerHTML;
    for (const name of ["External One", "External Two", "External Three"]) assert.ok(html.includes(name));
    assert.equal((html.match(/class="gantt-lane"/g) || []).length, 4);
    assert.match(html, /<summary>Other \/ Unassigned/);
    assert.match(html, /source:role/);
    assert.match(html, /source:unassigned/);
    assert.match(element("#gantt-summary").innerHTML, /Assignments<\/span><strong class="metric-value">0/);
    assert.match(element("#gantt-summary").innerHTML, /4 open/);
  }
});

test("legacy assignment labels stay intact, exclude roles, and deduplicate names", () => {
  const { task } = ganttFixture();
  const { context } = ganttFixture();
  context.taskInput = { ...task, assignmentNames: undefined, assignees: "Person One Person Two; Designer; designer; ROC | Developer, Job Role" };
  assert.equal(vm.runInContext("productionTaskNames(taskInput).join('; ')", context), "Person One Person Two; Designer");
});

test("All production retains Workfront assignments and dates over a matching local mirror", () => {
  const { task } = ganttFixture();
  const { element } = ganttFixture({
    source: "all", members: [],
    tasks: [{ ...task, assignmentNames: ["Workfront Person"] }],
    projects: [{ id: "local-project", ref: "WF-1", title: "Local mirror" }],
    localTasks: [{
      id: "local-mirror", projectId: "local-project", projectRef: "WF-1", category: "Build",
      assignee: "Old Local Person", startDate: "2026-10-15", etaDate: "2026-10-17"
    }]
  });
  const html = element("#gantt-chart").innerHTML;
  assert.match(html, /Workfront Person/);
  assert.match(html, /--bar-width:3/);
  assert.doesNotMatch(html, /Old Local Person|local:local-mirror/);
});

test("Gantt exposes paused, running and failed Workfront sync states without claiming fresh data", () => {
  const { context, element } = ganttFixture();
  vm.runInContext("state.workfrontAutomation = { enabled: false, status: 'idle' }; renderGantt();", context);
  assert.match(element("#gantt-sync-status").textContent, /paused/);
  assert.match(element("#gantt-sync-status").textContent, /Last complete import: Not available/);
  vm.runInContext("state.workfrontAutomation = { enabled: true, status: 'syncing', detailsCompleted: 4, detailsTotal: 10 }; renderGantt();", context);
  assert.match(element("#gantt-sync-status").textContent, /Details checked: 4\/10/);
  vm.runInContext("state.workfrontAutomation = { enabled: true, status: 'error', lastError: 'Sign-in expired' }; renderGantt();", context);
  assert.match(element("#gantt-sync-status").textContent, /Error: Sign-in expired/);
});

test("project priority comes from the parent, stays distinct from task priority and is escaped", () => {
  const { context, element } = ganttFixture();
  vm.runInContext(`state.workfrontProjects[0].priority = "Urgent <review>";
    state.workfrontTasks[0].priority = "Low";
    renderGantt();
    showTimelineHover({ dataset: { hoverTask: "source:imported-1" }, getBoundingClientRect: () => ({ left: 0, top: 100 }) });`, context);
  for (const selector of ["#gantt-chart", "#timeline-hover"]) {
    assert.match(element(selector).innerHTML, /Project priority: Urgent &lt;review&gt;/);
    assert.doesNotMatch(element(selector).innerHTML, /Project priority: Low|<review>/);
  }
  vm.runInContext('state.workfrontProjects[0].priority = ""; renderGantt();', context);
  assert.match(element("#gantt-chart").innerHTML, /Project priority: Not provided/);
});

test("Gantt keeps material in a column and moves delegation and activity details to hover", () => {
  const { task } = ganttFixture();
  const { element, context } = ganttFixture({ tasks: [{
    ...task, materialExpectedDate: "2026-10-20", materialDateSource: "Parent project",
    delegations: "Delegate One for Designer Two",
    latestSystemActivity: "Designer Two changed the status to In Progress",
    lastStatusChanged: "2026-10-12T10:00:00Z", detailSyncedAt: "2026-10-12T11:00:00Z"
  }] });
  assert.match(element("#gantt-chart").innerHTML, /gantt-material.*Oct 20, 2026/);
  assert.doesNotMatch(element("#gantt-chart").innerHTML, /Delegate One|changed the status/);
  vm.runInContext('showTimelineHover({ dataset: { hoverTask: "source:imported-1" }, getBoundingClientRect: () => ({ left: 0, top: 100 }) });', context);
  assert.match(element("#timeline-hover").innerHTML, /Delegate One for Designer Two/);
  assert.match(element("#timeline-hover").innerHTML, /changed the status to In Progress/);
  assert.match(element("#timeline-hover").innerHTML, /Pending since status change:/);
});

test("Build and Bug Fixing totals and drill-through use task identity, not just matching statuses", () => {
  const { task } = ganttFixture();
  const { context, element } = ganttFixture({ tasks: [
    { ...task, taskStatus: "In Progress", projectStatus: "Execution In Progress" },
    { ...task, taskName: "Bug Fixing", taskStatus: "In Progress", projectStatus: "Execution In Progress" },
    { ...task, taskName: "QA Audit", taskStatus: "In Progress", projectStatus: "Execution In Progress" },
    { ...task, taskName: "Bug Fixing", taskStatus: "In Progress", projectStatus: "In QC" },
    { ...task, taskName: "Build", taskStatus: "In Progress", projectStatus: "In QC" }
  ] });
  vm.runInContext("state.roleCapabilities.viewManagerReports = true; renderManagerReports()", context);
  const html = element("#manager-floor-status").innerHTML;
  assert.match(html, /data-drill-task-name="Build" data-drill-project-status="Execution In Progress" data-drill-task-status="In Progress"[^]*?<strong>1<\/strong>/);
  assert.match(html, /data-drill-task-name="Bug Fixing" data-drill-project-status="In QC" data-drill-task-status="In Progress"[^]*?<strong>1<\/strong>/);
});
test("missing dates and tasks outside the window stay listed without invented bars", () => {
  const { task } = ganttFixture();
  const { element } = ganttFixture({ tasks: [
    { ...task, taskName: "CR", plannedStartDate: "", plannedCompletionDate: "" },
    { ...task, taskName: "Build", plannedStartDate: "2026-09-01", plannedCompletionDate: "2026-09-03" },
    { ...task, taskName: "Bug Fixing", plannedStartDate: "2026-10-15", plannedCompletionDate: "2026-10-12" }
  ] });
  const html = element("#gantt-chart").innerHTML;
  for (const name of ["CR", "Build", "Bug Fixing"]) assert.ok(html.includes(name));
  assert.doesNotMatch(html, /workfront-gantt-bar/);
  assert.equal((html.match(/No bar in this window/g) || []).length, 3);
});

test("assigned unfollowed projects stay visible and pending-issue statuses are not treated as completed", () => {
  const { task } = ganttFixture();
  const { element } = ganttFixture({ tasks: [
    { ...task, taskName: "CR", taskStatus: "Complete - Pending Issues", percentComplete: 100 },
    { ...task, taskName: "Build", taskStatus: "Completed" },
    { ...task, taskName: "Bug Fixing", projectRef: "MISSING" }
  ] });
  const html = element("#gantt-chart").innerHTML;
  assert.match(html, /MISSING/);
  assert.match(element("#gantt-summary").innerHTML, /2 open · 1 completed/);
  assert.equal((html.match(/category-build completed/g) || []).length, 1);
});

test("hour view displays date coverage and explicitly avoids hourly-booking claims", () => {
  const { task } = ganttFixture();
  const { element } = ganttFixture({ scale: "hour", tasks: [
    { ...task, plannedStartDate: "2026-10-10", plannedCompletionDate: "2026-10-14" }
  ] });
  assert.match(element("#gantt-chart").innerHTML, /--bar-width:18/);
  assert.match(element("#gantt-chart").innerHTML, /20:00<br>–20:30/);
  assert.match(element("#gantt-source-notice").textContent, /not an hourly booking/);
});

test("week and month views use imported planned dates", () => {
  for (const scale of ["week", "month"]) {
    const { element } = ganttFixture({ scale });
    assert.match(element("#gantt-chart").innerHTML, /workfront-gantt-bar/);
    assert.match(element("#gantt-chart").innerHTML, /--bar-width:1/);
  }
});

test("Workfront Gantt escapes source labels and does not expose imported editing actions", () => {
  const { task } = ganttFixture();
  const { element } = ganttFixture({ tasks: [{ ...task, projectRef: '<img onerror="bad()">', assignees: "<script>bad()</script>" }] });
  const html = element("#gantt-chart").innerHTML;
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img/);
});

test("local schedule remains available and Workfront access is required for the imported view", () => {
  for (const options of [{ source: "local" }, { allowed: false }]) {
    const { element } = ganttFixture(options);
    assert.match(element("#gantt-chart").innerHTML, /No production tasks scheduled/);
    assert.doesNotMatch(element("#gantt-chart").innerHTML, /workfront-gantt-bar/);
  }
});

test("local scheduled tasks retain their edit/log actions and calculated QA buffer", () => {
  const { element } = ganttFixture({ source: "local", localTasks: [{
    id: "local-task", projectId: "local-project", projectRef: "LOCAL-1", projectTitle: "Local project",
    title: "Build", category: "Build", assignee: "Designer", status: "In Progress",
    startDate: "2026-10-12", startTime: "12:30", etaDate: "2026-10-14", etaTime: "15:00",
    plannedHours: 10, productionHours: 6, qaBufferHours: 4, loggedHours: 0, progress: 20
  }] });
  const html = element("#gantt-chart").innerHTML;
  assert.match(html, /data-action="log-task"/);
  assert.match(html, /gantt-qa-buffer/);
  assert.match(html, /LOCAL-1/);
  assert.doesNotMatch(html, /workfront-gantt-bar/);
});

test("unknown progress is not invented and bars clip to the selected window", () => {
  const { task } = ganttFixture();
  const { element } = ganttFixture({ tasks: [{
    ...task, percentComplete: null, plannedStartDate: "2026-10-10", plannedCompletionDate: "2026-10-14"
  }] });
  const html = element("#gantt-chart").innerHTML;
  assert.match(html, /Progress: Unavailable/);
  assert.doesNotMatch(html, /class="gantt-progress"/);
  assert.match(html, /--bar-left:0;--bar-width:3/);
});

test("team filtering applies team membership to every Workfront grouping and its summaries", () => {
  const { task } = ganttFixture();
  for (const groupBy of ["resource", "project", "task"]) {
    const { element } = ganttFixture({ teamId: "email", groupBy, members: [
      { name: "Email Person", teamIds: ["email"] }, { name: "Design Person", teamIds: ["design"] }
    ], tasks: [
      { ...task, taskName: "Build", productionTeamId: "design", assignmentNames: ["Email Person"] },
      { ...task, taskName: "Bug Fixing", productionTeamId: "email", assignmentNames: ["Design Person"] }
    ] });
    assert.match(element("#gantt-chart").innerHTML, /WF-1 · Build/);
    assert.doesNotMatch(element("#gantt-chart").innerHTML, /Bug Fixing/);
    assert.match(element("#gantt-summary").innerHTML, /1 open/);
  }
});

test("task-wise Workfront groups retain project and resource labels", () => {
  const { element } = ganttFixture({ groupBy: "task" });
  assert.match(element("#gantt-chart").innerHTML, /<summary>Task: Build/);
  assert.match(element("#gantt-chart").innerHTML, /Email project/);
  assert.match(element("#gantt-chart").innerHTML, /Designer One Designer Two/);
});

test("task and project statuses combine across every Workfront grouping", () => {
  const { task } = ganttFixture();
  for (const groupBy of ["resource", "project", "task"]) {
    const { element } = ganttFixture({
      groupBy, status: "In Progress", projectStatus: "Execution in Progress",
      tasks: [{ ...task, taskName: "Build", taskStatus: "In Progress" }, { ...task, taskName: "CR", taskStatus: "New" }]
    });
    assert.match(element("#gantt-chart").innerHTML, /WF-1 · Build/);
    assert.doesNotMatch(element("#gantt-chart").innerHTML, /WF-1 · CR/);
    assert.match(element("#gantt-summary").innerHTML, /1 open/);
  }
});

test("local task status filtering excludes nonmatching schedule rows", () => {
  const base = {
    projectId: "local-project", projectRef: "LOCAL-1", projectTitle: "Local project",
    title: "Build", category: "Build", assignee: "Designer",
    startDate: "2026-10-12", startTime: "11:30", etaDate: "2026-10-14", etaTime: "15:00",
    plannedHours: 10, productionHours: 6, qaBufferHours: 4, loggedHours: 0, progress: 20
  };
  const { element } = ganttFixture({
    source: "local", status: "In Progress",
    localTasks: [{ ...base, id: "started", status: "In Progress" }, { ...base, id: "waiting", status: "Not Started" }]
  });
  assert.match(element("#gantt-chart").innerHTML, /data-id="started"/);
  assert.doesNotMatch(element("#gantt-chart").innerHTML, /data-id="waiting"/);
});

test("local grouping and summaries filter by team membership and respect configured hourly shift end", () => {
  const tasks = ["email", "design"].map((department) => ({
    id: department, projectId: department, projectRef: department.toUpperCase(), projectTitle: `${department} project`,
    title: "Build", category: "Build", assignee: department, status: "Not Started",
    startDate: "2026-10-12", startTime: "11:30", etaDate: "2026-10-12", etaTime: "19:30",
    plannedHours: 8, productionHours: 4.8, qaBufferHours: 3.2, loggedHours: 0, progress: 0
  }));
  for (const groupBy of ["resource", "project", "task"]) {
    const { element } = ganttFixture({
      source: "local", scale: "hour", teamId: "email", groupBy, localTasks: tasks,
      projects: [{ id: "email", productionTeamId: "email" }, { id: "design", productionTeamId: "design" }],
      members: [{ name: "email", shiftStart: "11:30", shiftEnd: "20:30", teamIds: ["email"] }]
    });
    const html = element("#gantt-chart").innerHTML;
    assert.match(html, /EMAIL/);
    assert.doesNotMatch(html, /DESIGN/);
    assert.match(html, /--gantt-day-count:18/);
  }
});

test("resource Gantt includes QA work, filters by team membership and hides work completed by the start date", () => {
  const { task } = ganttFixture();
  const members = [
    { name: "Email Person", teamIds: ["email"], role: "executioner" },
    { name: "Design Person", teamIds: ["design"], role: "executioner" }
  ];
  const tasks = [
    { ...task, id: "qa", taskName: "QA Audit", assignmentNames: ["Design Person"] },
    { ...task, id: "bug", taskName: "Bug Fixing", assignmentNames: ["Design Person", "External Person"] },
    { ...task, id: "email", taskName: "CR 1", assignmentNames: ["Email Person"] },
    { ...task, id: "done-before", taskStatus: "Complete", actualCompletionDate: "2026-10-11", assignmentNames: ["Design Person"] },
    { ...task, id: "done-on", taskStatus: "Completed", plannedCompletionDate: "2026-10-12", assignmentNames: ["Design Person"] },
    { ...task, id: "done-later", taskStatus: "Complete", plannedCompletionDate: "2026-10-14", assignmentNames: ["Design Person"] },
    { ...task, id: "other", taskName: "Kickoff", assignmentNames: ["Design Person"] }
  ];
  const all = ganttFixture({ groupBy: "resource", members, tasks }).element("#gantt-chart").innerHTML;
  assert.match(all, /source:qa/);
  assert.doesNotMatch(all, /<summary>External Person/);
  assert.doesNotMatch(all, /source:done-before|source:done-on|source:other/);
  assert.match(all, /source:done-later/);
  const { element } = ganttFixture({ groupBy: "resource", teamId: "design", members, tasks });
  const html = element("#gantt-chart").innerHTML;
  assert.deepEqual([...html.matchAll(/<summary>([^<]+?) <span>/g)].map((match) => match[1]), ["Design Person"]);
  assert.match(html, /source:qa/);
  assert.match(html, /source:bug/);
  assert.doesNotMatch(html, /source:email|source:done-before|source:done-on/);
  assert.match(element("#gantt-source-notice").textContent, /2 tasks completed on or before Oct 12, 2026 hidden/);
  const external = ganttFixture({ groupBy: "resource", teamId: "unassigned", members, tasks }).element("#gantt-chart").innerHTML;
  assert.deepEqual([...external.matchAll(/<summary>([^<]+?) <span>/g)].map((match) => match[1]), ["Other / Unassigned"]);
});

test("team-member groups precede Other / Unassigned in every grouping", () => {
  const { task } = ganttFixture();
  for (const groupBy of ["resource", "project", "task"]) {
    const { element } = ganttFixture({ groupBy, members: [{ name: "Roster Person", teamIds: ["email"] }], tasks: [
      { ...task, id: "external", assignmentNames: ["Outside Person"] },
      { ...task, id: "unassigned-build", assignmentNames: [], assignees: "" },
      { ...task, id: "unassigned-qa", taskName: "QA Audit", assignmentNames: [], assignees: "" },
      { ...task, id: "member", assignmentNames: ["Roster Person"] }
    ] });
    const html = element("#gantt-chart").innerHTML;
    assert.ok(html.indexOf("source:member") < html.indexOf("<summary>Other / Unassigned"));
    assert.ok(html.indexOf("<summary>Other / Unassigned") < html.indexOf("source:external"));
    assert.match(html, /source:unassigned-build/);
    assert.match(html, /source:unassigned-qa/);
    assert.doesNotMatch(html, /<summary>Outside Person/);
    assert.match(element("#gantt-summary").innerHTML, /Assignments<\/span><strong class="metric-value">1/);
  }
});

test("outside-roster work follows project team scope without creating outside-person lanes", () => {
  const { task } = ganttFixture();
  const tasks = [
    { ...task, id: "email-other", productionTeamId: "email", assignmentNames: ["Outside Person"] },
    { ...task, id: "design-other", productionTeamId: "design", assignmentNames: [] }
  ];
  const { element } = ganttFixture({ groupBy: "resource", teamId: "email", members: [], tasks });
  assert.match(element("#gantt-chart").innerHTML, /source:email-other/);
  assert.doesNotMatch(element("#gantt-chart").innerHTML, /source:design-other|<summary>Outside Person/);
});

test("CR SLA uses acceptance and expected delivery timestamps, including hour positions and material marker", () => {
  const { task } = ganttFixture();
  const round = {
    workfrontId: "CR-TIMED", projectRef: "WF-1", crId: "CR2", assignee: "Designer",
    acceptanceDate: "2026-10-12T12:30:00", expectedDeliveryDate: "2026-10-12T15:30:00",
    materialExpectedDate: "2026-10-20", ahtHours: 2, qaAhtHours: 1
  };
  for (const scale of ["hour", "day", "week", "month"]) {
    const { context, element } = ganttFixture({ scale, tasks: [
      { ...task, taskName: "CR 2", crId: "CR2", plannedStartDate: "2026-10-20", plannedCompletionDate: "2026-10-25" }
    ], rounds: [round] });
    const html = element("#gantt-chart").innerHTML;
    assert.match(html, /CR SLA: Acceptance Oct 12, 2026 12:30 → Material expected Oct 12, 2026 15:30/);
    assert.match(html, /<div class="gantt-material">Oct 12, 2026 15:30<\/div>/);
    assert.match(html, /class="timeline-marker material"/);
    if (scale === "hour") {
      assert.match(html, /--bar-left:2;--bar-width:6/);
      assert.match(html, /class="timeline-marker material" style="--marker-left:8"/);
      assert.match(html, /class="timeline-marker completion" style="--marker-left:8"/);
    }
    if (scale === "day") assert.match(html, /--bar-width:0\.125/);
    context.row = { dataset: { hoverTask: "cr:CR-TIMED" }, after() {}, setAttribute() {} };
    vm.runInContext("showTimelineHover(row);", context);
    assert.match(element("#timeline-hover").innerHTML, /Acceptance Oct 12, 2026 12:30 → Material expected Oct 12, 2026 15:30/);
  }
});

test("CRs never invent acceptance dates or use stale planned/material dates", () => {
  const { task } = ganttFixture();
  for (const acceptanceDate of ["", "2026-10-12T16:30:00"]) {
    const { element } = ganttFixture({ tasks: [], rounds: [{
      workfrontId: "MISSING-CR", projectRef: "WF-1", crId: "CR1", entryDate: "2026-10-12",
      acceptanceDate, expectedDeliveryDate: "2026-10-12T15:30:00"
    }] });
    assert.match(element("#gantt-chart").innerHTML, /cr:MISSING-CR/);
    assert.doesNotMatch(element("#gantt-chart").innerHTML, /workfront-gantt-bar category-cr/);
  }
  const { element } = ganttFixture({ tasks: [{ ...task, taskName: "CR" }], rounds: [] });
  assert.match(element("#gantt-chart").innerHTML, /Acceptance Unavailable → Material expected Unavailable/);
  assert.doesNotMatch(element("#gantt-chart").innerHTML, /workfront-gantt-bar category-cr/);
});

test("AHT fills show supplied production and QA proportions separately from progress", () => {
  const { task } = ganttFixture();
  const { element } = ganttFixture({ tasks: [{ ...task, ahtHours: 6, qaAhtHours: 2, percentComplete: 40 }] });
  const html = element("#gantt-chart").innerHTML;
  assert.match(html, /class="gantt-build-effort" style="left:0%;width:75%"/);
  assert.match(html, /class="gantt-qa-buffer" style="left:75%;width:25%"/);
  assert.match(html, /class="gantt-progress" style="width:40%"/);
  assert.match(html, /Build \/ production AHT: 6\.0h · QA AHT: 2\.0h/);
  for (const qaAhtHours of [null, undefined, "invalid", -1]) {
    const missing = ganttFixture({ tasks: [{ ...task, ahtHours: 6, qaAhtHours }] }).element("#gantt-chart").innerHTML;
    assert.match(missing, /QA AHT: Unavailable/);
    assert.doesNotMatch(missing, /class="gantt-build-effort"|class="gantt-qa-buffer"/);
  }
  const qaOnly = ganttFixture({ tasks: [{ ...task, taskName: "QA Audit", ahtHours: 6, qaAhtHours: 2 }] }).element("#gantt-chart").innerHTML;
  assert.match(qaOnly, /class="gantt-qa-buffer" style="left:0%;width:100%"/);
  assert.doesNotMatch(qaOnly, /class="gantt-build-effort"/);
});

test("AHT proportions retain their original positions when the timeline clips a bar", () => {
  const { task } = ganttFixture();
  const html = ganttFixture({ tasks: [{
    ...task, plannedStartDate: "2026-10-10", plannedCompletionDate: "2026-10-13", ahtHours: 6, qaAhtHours: 2
  }] }).element("#gantt-chart").innerHTML;
  assert.match(html, /class="gantt-build-effort" style="left:0%;width:50%"/);
  assert.match(html, /class="gantt-qa-buffer" style="left:50%;width:50%"/);
});

test("local work also retains unassigned and non-roster tasks at the bottom with AHT fills", () => {
  const base = {
    projectId: "local", projectRef: "LOCAL", category: "Build", title: "Build", status: "In Progress",
    startDate: "2026-10-12", startTime: "11:30", etaDate: "2026-10-14", etaTime: "15:00",
    plannedHours: 8, productionHours: 6, qaBufferHours: 2, progress: 20
  };
  for (const groupBy of ["resource", "project", "task"]) {
    const { element } = ganttFixture({ source: "local", groupBy, members: [{ name: "Designer" }], localTasks: [
      { ...base, id: "external", assignee: "Outside" }, { ...base, id: "unassigned", assignee: "" },
      { ...base, id: "member", assignee: "Designer" }
    ] });
    const html = element("#gantt-chart").innerHTML;
    assert.ok(html.indexOf("local:member") < html.indexOf("<summary>Other / Unassigned"));
    assert.match(html, /local:unassigned/);
    assert.match(html, /local:external/);
    assert.match(html, /class="gantt-build-effort" style="left:0%;width:75%"/);
    assert.match(html, /class="gantt-qa-buffer" style="left:75%;width:25%"/);
  }
});

test("timeline details open inline below the row and stay open across refreshes", () => {
  const { context, element } = ganttFixture();
  const placed = [];
  context.row = { dataset: { hoverTask: "source:imported-1" }, after: (card) => placed.push(card), setAttribute() {} };
  vm.runInContext("showTimelineHover(row);", context);
  assert.equal(placed[0], element("#timeline-hover"));
  assert.equal(element("#timeline-hover").hidden, false);
  assert.match(element("#timeline-hover").innerHTML, /data-close-timeline-detail/);
  vm.runInContext("hideTimelineDetail();", context);
  assert.equal(element("#timeline-hover").hidden, true);
});
