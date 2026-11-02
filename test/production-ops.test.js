"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { effectiveWorkfrontPriority, gdBannerDeadline, gdBannerOverdueProjects, isGdBannerDesignProject, productionOperations, recordAssignmentNotifications, sourceRemaining } = require("../production-ops");

const team = [{ name: "Designer One", role: "executioner" }, { name: "Manager", role: "manager" }];
const task = { id: "source", workfrontId: "wf-task", projectRef: "P1", taskName: "Build", taskStatus: "In Progress",
  assignmentNames: ["Designer One", "ROC | Developer"], plannedHours: 32, actualHours: 8, percentComplete: 50,
  detailSyncedAt: "2026-10-13T00:00:00Z", plannedStartDate: "2026-10-12", plannedCompletionDate: "2026-10-14", materialExpectedDate: "2026-10-15" };
const gdBannerProject = { ref: "GD1", title: "Customer GD Banner creative", sourceStatus: "Execution in Progress",
  channel: "Banner", productionTeamId: "design", actualStartDate: "2026-10-12T09:30:00Z", materialExpectedDate: "2026-10-30" };

test("GD Banner design urgency uses a two-business-day deadline from Actual Start Date", () => {
  assert.equal(isGdBannerDesignProject(gdBannerProject), true);
  assert.equal(effectiveWorkfrontPriority({ ...gdBannerProject, priority: "Low" }), "Urgent");
  assert.equal(effectiveWorkfrontPriority({ ...gdBannerProject, title: "Customer Banner", priority: "Low" }), "Low");
  assert.equal(isGdBannerDesignProject({ ...gdBannerProject, title: "Customer GD2 Banner creative" }), false);
  assert.equal(isGdBannerDesignProject({ ...gdBannerProject, productionTeamId: "web" }), false);
  assert.equal(gdBannerDeadline(gdBannerProject, [{ date: "2026-10-13" }]).toISOString(), "2026-10-15T09:30:00.000Z");
  assert.equal(gdBannerDeadline({ ...gdBannerProject, actualStartDate: "2026-10-09T09:30:00Z" }).toISOString(), "2026-10-13T09:30:00.000Z");
});

test("GD Banner projects become overdue after two business days regardless of material date", () => {
  const holidays = [{ date: "2026-10-13", name: "Configured holiday" }];
  const deadline = new Date("2026-10-15T09:30:00.000Z");
  assert.deepEqual(gdBannerOverdueProjects([gdBannerProject], holidays, deadline), []);
  const overdue = gdBannerOverdueProjects([gdBannerProject], holidays, new Date(deadline.getTime() + 1));
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].overdueSince, deadline.toISOString());
  assert.deepEqual(gdBannerOverdueProjects([
    { ...gdBannerProject, sourceStatus: "Completed" },
    { ...gdBannerProject, ref: "GD2", title: "Customer Banner" }
  ], holidays, new Date("2026-10-20T09:30:00Z")), []);
  const operations = productionOperations({ workfrontProjects: [gdBannerProject], holidays }, "2026-10-15", new Date(deadline.getTime() + 1));
  assert.equal(operations.gdBannerOverdues[0].ref, "GD1");
});

test("operations combine local and Workfront project data and deduplicate matching resource effort", () => {
  const ops = productionOperations({ team, projects: [{ id: "local", ref: "P1", title: "Local project", status: "In Progress" }],
    workfrontProjects: [{ ref: "P1", materialExpectedDate: "2026-10-15" }, { ref: "P2", title: "Source-only", sourceStatus: "Current" }],
    tasks: [{ id: "local-task", projectId: "local", projectRef: "P1", category: "Build", assignee: "Designer One", status: "In Progress", plannedHours: 12, loggedHours: 2 }],
    workfrontTasks: [task], capacityHoursPerDay: 8 }, "2026-10-13");
  assert.equal(ops.projects.length, 2);
  assert.equal(ops.projects.find((project) => project.ref === "P1").materialExpectedDate, "2026-10-15");
  assert.equal(ops.resources.length, 1);
  assert.equal(ops.resources[0].remainingHours, 16);
  assert.equal(ops.resources[0].backlogDays, 2);
  assert.equal(ops.resources[0].dailyCapacity, 8);
  assert.ok(ops.risks.some((risk) => risk.labels.includes("Material arrives after completion date")));
});

test("unknown hours never imply free availability; role-only work stays in risks and not a roster lane", () => {
  const ops = productionOperations({ team, workfrontTasks: [{ ...task, plannedHours: null }, { ...task, id: "role-only", assignmentNames: [] },
    { ...task, id: "qa", taskName: "QA Audit" }], tasks: [], projects: [], leaves: [
      { status: "Approved", assignee: "Designer One", startDate: "2026-10-13", endDate: "2026-10-14" }
    ] }, "2026-10-13");
  assert.equal(ops.resources[0].unknownTasks, 1);
  assert.equal(ops.resources[0].backlogDays, null);
  assert.equal(ops.resources[0].dailyCapacity, 0);
  assert.equal(ops.unassignedTasks, 1);
  assert.equal(ops.assignedTasks, 1);
  assert.ok(ops.risks.find((risk) => risk.id === "workfront:role-only").labels.includes("No roster executioner assigned"));
});

test("source remainder uses app execution progress and avoids counting mirrored actual logs twice", () => {
  assert.equal(sourceRemaining({ ...task, percentComplete: null, actualHours: 8, executionLoggedHours: 8 }), 24);
  assert.equal(sourceRemaining({ ...task, executionProgress: 100 }), 0);
  assert.equal(sourceRemaining({ ...task, detailSyncedAt: "" }), null);
});

test("role-only bug fixing is excluded from production risks and capacity", () => {
  const ops = productionOperations({ team, workfrontTasks: [
    { ...task, taskName: "Bug Fixing", id: "default-bug", assignmentNames: ["ROC | Developer"] },
    { ...task, taskName: "Bug Fixing", id: "named-bug", assignmentNames: ["Designer One"] }
  ], projects: [], tasks: [] }, "2026-10-13");
  assert.equal(ops.unassignedTasks, 0);
  assert.equal(ops.assignedTasks, 1);
  assert.ok(ops.risks.every((risk) => risk.id !== "workfront:default-bug"));
});

test("assignment alerts persist once, repeat after reassignment, and never notify role-only or manager accounts", () => {
  const data = { users: [{ id: "u1", name: "Designer One", role: "executioner" }, { id: "u2", name: "Manager", role: "manager" }],
    team, projects: [], tasks: [], workfrontTasks: [task] };
  recordAssignmentNotifications(data);
  assert.equal(data.notifications.length, 1);
  assert.equal(data.notifications[0].userId, "u1");
  data.notifications[0].readAt = "2026-10-13";
  recordAssignmentNotifications(data);
  assert.equal(data.notifications.length, 1);
  data.workfrontTasks = [{ ...task, assignmentNames: ["ROC | Developer", "Manager"] }];
  recordAssignmentNotifications(data);
  assert.equal(data.notifications.length, 1);
  data.workfrontTasks = [task];
  recordAssignmentNotifications(data);
  assert.equal(data.notifications.length, 2);
  assert.equal(data.notifications[1].readAt, "2026-10-13");
});

test("completed execution logs remove source work from active capacity without modifying source status", () => {
  const source = { ...task, executionStatus: "Completed", executionProgress: 100 };
  const ops = productionOperations({ team, workfrontTasks: [source], tasks: [], projects: [] }, "2026-10-13");
  assert.equal(ops.assignedTasks, 0);
  assert.equal(ops.resources[0].remainingHours, 0);
  assert.equal(source.taskStatus, "In Progress");
});
