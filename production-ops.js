"use strict";

const nameKey = (value) => String(value || "").trim().toLowerCase();
const productionType = (value) => /^(build|cr(?:\s*\d+)?|change rounds?|bug fixing)$/i.test(String(value || "").trim());
const closed = (value) => /^(completed?|archived|cancelled|canceled)$/i.test(String(value || "").trim());

function isGdBannerDesignProject(project) {
  const designTeam = project?.productionTeamId === "design" || /^design team$/i.test(String(project?.workfrontTeam || ""));
  return designTeam
    && /^banner$/i.test(String(project?.channel || project?.assetType || "").trim())
    && /\bGD\b/i.test(String(project?.title || project?.projectName || ""));
}

function effectiveWorkfrontPriority(project) {
  return isGdBannerDesignProject(project) ? "Urgent" : project?.priority || "";
}

function gdBannerDeadline(project, holidays = []) {
  const deadline = new Date(project?.actualStartDate || "");
  if (Number.isNaN(deadline.getTime())) return null;
  const holidayDates = new Set(holidays.map((holiday) => holiday.date));
  let businessDays = 0;
  while (businessDays < 2) {
    deadline.setUTCDate(deadline.getUTCDate() + 1);
    const weekday = deadline.getUTCDay();
    if (weekday === 0 || weekday === 6 || holidayDates.has(deadline.toISOString().slice(0, 10))) continue;
    businessDays += 1;
  }
  return deadline;
}

function gdBannerOverdueProjects(projects = [], holidays = [], now = new Date()) {
  return projects.flatMap((project) => {
    if (!isGdBannerDesignProject(project) || closed(project.sourceStatus || project.status)) return [];
    const deadline = gdBannerDeadline(project, holidays);
    return deadline && now.getTime() > deadline.getTime()
      ? [{ ...project, overdueSince: deadline.toISOString() }]
      : [];
  });
}

function rosterNames(task, team) {
  return (task.assignmentNames || []).filter((name) => team.some((member) =>
    nameKey(member.name) === nameKey(name) && (!member.role || member.role === "executioner")));
}

function sourceRemaining(task) {
  if (task.plannedHours === null || task.plannedHours === undefined || !task.detailSyncedAt) return null;
  const progress = task.executionProgress ?? task.percentComplete;
  const hours = Math.max(0, task.plannedHours - Math.max(task.actualHours || 0, task.executionLoggedHours || 0));
  return progress === null || progress === undefined ? hours : Math.min(hours, task.plannedHours * (1 - progress / 100));
}

function productionOperations(snapshot, today, now = new Date()) {
  const projects = new Map((snapshot.workfrontProjects || []).map((project) =>
    [nameKey(project.ref), { ...project, status: project.sourceStatus, source: "workfront" }]));
  for (const project of snapshot.projects || []) projects.set(nameKey(project.ref), { ...projects.get(nameKey(project.ref)), ...project, source: "local" });
  const team = snapshot.team || [];
  const rows = [
    ...(snapshot.tasks || []).filter((task) => productionType(task.category)).map((task) => ({
      ...task, source: "local", ref: task.projectRef || snapshot.projects.find((project) => project.id === task.projectId)?.ref,
      type: task.category, names: team.filter((member) => nameKey(member.name) === nameKey(task.assignee) && (!member.role || member.role === "executioner")).map((member) => member.name),
      remaining: Math.max(0, Number(task.plannedHours || 0) - Number(task.loggedHours || 0)),
      finish: task.etaDate, material: projects.get(nameKey(task.projectRef))?.materialExpectedDate
    })),
    ...(snapshot.workfrontTasks || []).filter((task) => productionType(task.taskName)).map((task) => ({
      ...task, source: "workfront", ref: task.projectRef, type: task.taskName,
      status: task.executionStatus || task.taskStatus, names: rosterNames(task, team), remaining: sourceRemaining(task),
      finish: task.plannedCompletionDate, material: task.materialExpectedDate
    }))
  ];
  const active = rows.filter((task) => !closed(task.status) && (!/^bug fixing$/i.test(task.type) || task.names.length));
  const resources = team.filter((member) => !member.role || member.role === "executioner").map((member) => {
    const local = new Map();
    const source = new Map();
    let unknown = 0;
    const assigned = active.filter((task) => task.names.some((name) => nameKey(name) === nameKey(member.name)));
    for (const task of assigned) {
      if (task.remaining === null) { unknown++; continue; }
      const key = `${nameKey(task.ref)}:${nameKey(task.type)}`;
      const totals = task.source === "local" ? local : source;
      totals.set(key, (totals.get(key) || 0) + task.remaining);
    }
    const hours = [...new Set([...local.keys(), ...source.keys()])].reduce((sum, key) => sum + Math.max(local.get(key) || 0, source.get(key) || 0), 0);
    const away = (snapshot.leaves || []).some((leave) => leave.status === "Approved" && nameKey(leave.assignee) === nameKey(member.name) && leave.startDate <= today && leave.endDate >= today);
    const holiday = (snapshot.holidays || []).some((day) => day.date === today);
    const weekend = [0, 6].includes(new Date(`${today}T12:00:00`).getDay());
    return { name: member.name, taskCount: assigned.length, remainingHours: Number(hours.toFixed(2)), unknownTasks: unknown,
      dailyCapacity: away || holiday || weekend ? 0 : Number(snapshot.capacityHoursPerDay || 8), away,
      backlogDays: unknown ? null : Number((hours / Number(snapshot.capacityHoursPerDay || 8)).toFixed(2)) };
  });
  const risks = [];
  for (const task of active) {
    const labels = [];
    if (!task.names.length) labels.push("No roster executioner assigned");
    if (!task.finish) labels.push("Completion date unavailable");
    else if (task.finish < today) labels.push("Overdue");
    if (task.remaining === null) labels.push("Workload hours not verified");
    if (task.material && task.material > (task.plannedStartDate || task.startDate || task.finish)) labels.push("Material arrives after planned start");
    if (task.material && task.finish && task.material > task.finish) labels.push("Material arrives after completion date");
    if (task.names.some((name) => (snapshot.leaves || []).some((leave) => leave.status === "Approved" && nameKey(name) === nameKey(leave.assignee) && leave.startDate <= task.finish && leave.endDate >= (task.startDate || task.plannedStartDate || today)))) labels.push("Approved leave overlaps task");
    if (labels.length) risks.push({ id: `${task.source}:${task.id}`, projectRef: task.ref, taskName: task.type, names: task.names, labels, dueDate: task.finish || "" });
  }
  return { projects: [...projects.values()], resources, risks,
    gdBannerOverdues: gdBannerOverdueProjects(snapshot.workfrontProjects || [], snapshot.holidays || [], now),
    assignedTasks: active.filter((task) => task.names.length).length,
    unassignedTasks: active.filter((task) => !task.names.length).length };
}

function recordAssignmentNotifications(data) {
  data.notifications ||= [];
  data.assignmentState ||= {};
  const current = {};
  const team = data.team || [];
  const tasks = [
    ...(data.tasks || []).filter((task) => productionType(task.category) && !closed(task.status)).map((task) => ({
      key: `local:${task.id}`, ref: data.projects.find((project) => project.id === task.projectId)?.ref || "",
      type: task.category, names: [task.assignee]
    })),
    ...(data.workfrontTasks || []).filter((task) => productionType(task.taskName) && !closed(task.taskStatus)).map((task) => ({
      key: `workfront:${task.workfrontId}`, ref: task.projectRef, type: task.taskName, names: rosterNames(task, team)
    }))
  ];
  for (const task of tasks) {
    current[task.key] = task.names.filter((name) => team.some((member) => nameKey(member.name) === nameKey(name))
      && data.users.some((user) => nameKey(user.name) === nameKey(name) && user.role === "executioner")).map(nameKey);
    for (const name of current[task.key]) {
      if ((data.assignmentState[task.key] || []).includes(name)) continue;
      const account = data.users.find((user) => nameKey(user.name) === name && user.role === "executioner");
      if (!account) continue;
      data.notifications.unshift({ id: require("node:crypto").randomUUID(), userId: account.id, taskKey: task.key,
        projectRef: task.ref, message: `${task.type} assigned to you · ${task.ref}`, createdAt: new Date().toISOString(), readAt: null });
    }
  }
  data.assignmentState = current;
}

module.exports = { effectiveWorkfrontPriority, gdBannerDeadline, gdBannerOverdueProjects, isGdBannerDesignProject, productionOperations, recordAssignmentNotifications, rosterNames, sourceRemaining, productionType };
