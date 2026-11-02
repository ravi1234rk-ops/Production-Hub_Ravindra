"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { mapWorkfrontProjectRow, mapWorkfrontTaskRows, workfrontDomReports, mergedWorkloadHours, workfrontRemainingHours, parseWorkfrontAssignments, workfrontNameKeys } = require("../server");
const { setReportFields } = require("../workfront-dom");

const headers = [
  "", "Project: Reference Number", "Project: Name", "Task Name", "Status", "Assignments",
  "Project: Primary Material", "Planned Start Date", "Planned Completion Date",
  "Project: Delivery Centre", "% Complete", "Workfront Project URL"
];

function taskReport(options = {}) {
  return {
    headers,
    rowIds: options.rowIds || ["WF-TASK-1"],
    rows: options.rows || [[
      "Select Item - Build", "WF-PROJECT-1", "Workfront project", "Build", "In Progress",
      "Designer One, Designer Two", "Email", "9/7/26", "9/16/26",
      "PRD WPP Production", "80% 80%",
      "https://experience.adobe.com/#/@fhoffmann-larocheag/so:laroche-Production/workfront/project/6a9023040007a68cc5ab27f13ebb136f/tasks"
    ]]
  };
}

test("maps Workfront task IDs, task status, assignment, progress, and project fields separately", () => {
  const [task] = mapWorkfrontTaskRows(taskReport());
  assert.equal(task.workfrontId, "WF-TASK-1");
  assert.equal(task.projectRef, "WF-PROJECT-1");
  assert.equal(task.projectName, "Workfront project");
  assert.equal(task.workfrontUrl, "https://experience.adobe.com/#/@fhoffmann-larocheag/so:laroche-Production/workfront/project/6a9023040007a68cc5ab27f13ebb136f/tasks");
  assert.equal(task.taskName, "Build");
  assert.equal(task.taskStatus, "In Progress");
  assert.equal(task.assignees, "Designer One, Designer Two");
  assert.equal(task.percentComplete, 80);
  assert.equal(task.deliveryCentre, "PRD WPP Production");
  assert.equal(task.plannedStartDate, "2026-09-07");
  assert.equal(task.plannedCompletionDate, "2026-09-16");
});

test("accepts empty progressive task batches while still validating their headers and IDs", () => {
  assert.deepEqual(mapWorkfrontTaskRows(taskReport({ rows: [], rowIds: [] })), []);
  assert.throws(() => mapWorkfrontTaskRows({ headers: [], rows: [], rowIds: [] }), /missing required columns/);
  assert.throws(() => mapWorkfrontTaskRows(taskReport({ rows: [], rowIds: ["unexpected"] })), /missing stable task IDs/);
});

test("routes Campaign task assets to Email Team", () => {
  const report = taskReport();
  report.rows[0][6] = "Campaign";
  const [task] = mapWorkfrontTaskRows(report);
  assert.equal(task.workfrontTeam, "Email Team");
  assert.equal(task.productionTeamId, "email");
});

test("maps historical completion, entry date and explicit CR identity without guessing them", () => {
  const report = taskReport();
  report.headers = [...report.headers, "Actual Completion Date", "Entry Date", "CR ID"];
  report.rows[0].push("10/03/26", "10/01/26", "CR2");
  const [task] = mapWorkfrontTaskRows(report);
  assert.equal(task.actualCompletionDate, "2026-10-03");
  assert.equal(new Date(task.entryDate).toLocaleDateString("en-CA"), "2026-10-01");
  assert.equal(task.crId, "CR2");
});

test("rejects missing or duplicate Workfront task IDs", () => {
  assert.throws(() => mapWorkfrontTaskRows(taskReport({ rowIds: [] })), /missing stable task IDs/);
  assert.throws(() => mapWorkfrontTaskRows(taskReport({
    rows: [
      taskReport().rows[0],
      [...taskReport().rows[0]]
    ],
    rowIds: ["WF-TASK-1", "WF-TASK-1"]
  })), /is repeated in the task report/);
});

test("rejects ambiguous task progress rather than storing a misleading value", () => {
  const report = taskReport();
  report.rows[0][10] = "40% 80%";
  assert.throws(() => mapWorkfrontTaskRows(report), /ambiguous progress value/);
});

test("accepts only HTTPS Workfront project links from task report rows", () => {
  const report = taskReport();
  report.rows[0][11] = "https://attacker.example/project/6a9023040007a68cc5ab27f13ebb136f";
  const [task] = mapWorkfrontTaskRows(report);
  assert.equal(task.workfrontUrl, "");
});

test("maps source detail dates, exact assignment names, delegations, hours and status history", () => {
  const report = taskReport();
  report.headers = [...report.headers];
  setReportFields(report, 0, {
    "Planned Completion Date": "Oct 13, 2026 12:05 AM",
    "Material Expected Delivery Date": "Oct 12, 2026 6:00 PM",
    "Assignments": "ROC | Developer, Job Role; Aakarsh Patel; Designer Two",
    "Delegations": "Delegate Person for Aakarsh Patel",
    "Planned Hours": "64 Hours", "Actual Hours": "8 Hours",
    "Last Status Changed": "October 9, 2026 7:27 PM",
    "Latest System Activity": "Updated planned completion",
    "Latest System Activity Date": "October 12, 2026 10:00 AM",
    "Detail Synced At": "2026-10-12T10:01:00Z"
  });
  const [task] = mapWorkfrontTaskRows(report);
  assert.equal(task.plannedCompletionDate, "2026-10-13");
  assert.equal(task.materialExpectedDate, "2026-10-12");
  assert.deepEqual(task.assignmentNames, ["Aakarsh Patel", "Designer Two"]);
  assert.equal(task.delegations, "Delegate Person for Aakarsh Patel");
  assert.equal(task.plannedHours, 64);
  assert.equal(task.actualHours, 8);
  assert.equal(task.lastStatusChanged, new Date("October 9, 2026 7:27 PM").toISOString());
  assert.notEqual(task.lastStatusChanged, task.latestSystemActivityDate);
});

test("capacity combines independent workload and avoids counting overlapping source work twice", () => {
  assert.equal(mergedWorkloadHours(new Map([["project:build", 16], ["local:bug fixing", 4]]), new Map([["project:build", 24], ["source:build", 8]])), 36);
  assert.equal(mergedWorkloadHours(new Map(), new Map()), 0);
});

test("remaining Workfront workload respects progress and hours without inventing unknown progress", () => {
  assert.equal(workfrontRemainingHours({ plannedHours: 64, actualHours: 0, percentComplete: 75 }), 16);
  assert.equal(workfrontRemainingHours({ plannedHours: 64, actualHours: 60, percentComplete: 75 }), 4);
  assert.equal(workfrontRemainingHours({ plannedHours: 64, actualHours: 0, percentComplete: null }), 64);
});
function productionReports() {
  return {
    openProjects: {
      headers: ["Reference Number", "Project Name", "Status", "Primary Material", "Country", "Delivery Centre", "ROC | Request Type"],
      rows: [["12345", "Project", "Execution in Progress", "Email", "India", "PRD WPP Production", "Localization"]]
    },
    changeRounds: {
      headers: ["Project Ref #", "Project Name", "Reference Number", "Name", "Assigned To: Name", "Project: Primary Material", "Project: Complexity", "Status", "Project: Delivery Centre"],
      rows: [["12345", "Project", "54321", "CR1", "Designer", "Email", "Medium", "New", "PRD WPP Production"]]
    }
  };
}

test("imports the production-manager report without inventing omitted planning fields", () => {
  const { projects } = workfrontDomReports(productionReports());
  const project = mapWorkfrontProjectRow(projects.rows[0], projects.headers);
  assert.equal(project.ref, "12345");
  assert.equal(project.sourceStatus, "Execution in Progress");
  assert.equal(project.requestType, "Localization");
  for (const field of ["pages", "complexity", "dueDate", "lastUpdateDate", "lem", "owner", "priority"]) {
    assert.equal(Object.hasOwn(project, field), false, field);
  }
  const previous = { pages: 12, complexity: "High", dueDate: "2026-10-20", lastUpdateDate: "2026-10-10T00:00:00.000Z", lem: "Previous LEM", priority: "Urgent" };
  const merged = { ...previous, ...project };
  for (const [field, value] of Object.entries(previous)) assert.equal(merged[field], value);
});

test("maps exact project priority, including cleared, custom and missing values", () => {
  for (const priority of ["Urgent", "High", "Normal", "Low", "None", "Custom priority", ""]) {
    const input = productionReports();
    input.openProjects.headers.push("Priority");
    input.openProjects.rows[0].push(priority);
    const { projects } = workfrontDomReports(input);
    assert.equal(mapWorkfrontProjectRow(projects.rows[0], projects.headers).priority, priority);
  }
  const { projects } = workfrontDomReports(productionReports());
  assert.equal(Object.hasOwn(mapWorkfrontProjectRow(projects.rows[0]), "priority"), false);
});

test("a failed detail read does not clear the previous priority when another row added its column", () => {
  const input = productionReports();
  input.openProjects.headers.push("Priority", "Detail Error");
  input.openProjects.rows[0].push("", "Project priority is unavailable");
  const { projects } = workfrontDomReports(input);
  const project = mapWorkfrontProjectRow(projects.rows[0], projects.headers);
  assert.equal(Object.hasOwn(project, "priority"), false);
  assert.equal({ priority: "High", ...project }.priority, "High");
});

test("refreshes planning fields when the DOM report supplies them, including cleared values", () => {
  const input = productionReports();
  input.openProjects.headers.push("Number of Pages", "Complexity", "Planned Completion Date");
  input.openProjects.rows[0].push("8", "", "10/20/26");
  const { projects } = workfrontDomReports(input);
  const project = mapWorkfrontProjectRow(projects.rows[0], projects.headers);
  assert.equal(project.pages, 8);
  assert.equal(project.complexity, "");
  assert.equal(project.dueDate, "2026-10-20");
});

test("still rejects production reports missing identity, status, or delivery-centre columns", () => {
  for (const column of ["Reference Number", "Project Name", "Status", "Delivery Centre"]) {
    const input = productionReports();
    const index = input.openProjects.headers.indexOf(column);
    input.openProjects.headers.splice(index, 1);
    input.openProjects.rows[0].splice(index, 1);
    assert.throws(() => workfrontDomReports(input), /missing required columns/);
  }
});

test("an explicitly missing or invalid Workfront page count is not guessed as one page", () => {
  for (const pages of ["", "unknown", "0", "-1", "1.5"]) {
    const input = productionReports();
    input.openProjects.headers.push("Number of Pages");
    input.openProjects.rows[0].push(pages);
    const { projects } = workfrontDomReports(input);
    assert.equal(mapWorkfrontProjectRow(projects.rows[0], projects.headers).pages, null);
  }
});

test("Banner projects route by project name: HTML to Web, GIF/animation to Video, everything else to Design", () => {
  const cases = [
    ["Austria_Banner_HTML5_resize_PRD", "web", "Web Team"],
    ["Obesity Week 2026_PRE Congress_Animation_Production_PRD", "video", "Video Team"],
    ["Vabysmo banner GIF set_PRD", "video", "Video Team"],
    ["Finland_Ophthalmology_Vabysmo banner_PRD", "design", "Design Team"]
  ];
  for (const [title, teamId, team] of cases) {
    const input = productionReports();
    input.openProjects.rows[0][1] = title;
    input.openProjects.rows[0][3] = "Banner";
    const { projects } = workfrontDomReports(input);
    const project = mapWorkfrontProjectRow(projects.rows[0], projects.headers);
    assert.equal(project.productionTeamId, teamId, title);
    assert.equal(project.workfrontTeam, team, title);
  }
  const input = productionReports();
  input.openProjects.rows[0][1] = "HTML animation guide";
  input.openProjects.rows[0][3] = "iPDF";
  const { projects } = workfrontDomReports(input);
  assert.equal(mapWorkfrontProjectRow(projects.rows[0], projects.headers).productionTeamId, "design");
});

test("Workfront assignments keep people scraped as 'Role / team' and drop job roles", () => {
  assert.deepEqual(parseWorkfrontAssignments("Shailendra Kumar, Role / team; ROC | Developer, Role / team; ROC | QA, Job Role; Design Team, Team; Sarthak Gupta; sarthak gupta; Unassigned"),
    ["Shailendra Kumar", "Sarthak Gupta"]);
  const key = (name) => workfrontNameKeys(name);
  assert.ok(key("OmSingh Rathore").some((item) => key("Om Singh Rathore").includes(item)));
  assert.ok(key("Mishra Ishita").some((item) => key("Ishita Mishra").includes(item)));
  assert.ok(key("Rahul Yadav.ry4").some((item) => key("Rahul Yadav").includes(item)));
  assert.equal(key("Anshul Jain").some((item) => key("Ansul Jain").includes(item)), false);
});
