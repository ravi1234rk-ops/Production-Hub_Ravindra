"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

test("tabs open at the top, refreshes preserve scroll, and navigation stays pinned", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.clock.install();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const memberId = "12345678-1234-1234-1234-123456789abc";
    const snapshot = {
      user: { name: "Test Manager", role: "manager", teamIds: [] },
      roleCapabilities: { viewWorkfront: true, viewManagerReports: true, viewAht: true, manageWorkspace: true, manageAudits: true },
      departments: [
        { id: "email", name: "Email Team", assetTypes: ["Email"] },
        { id: "design", name: "Design Team", assetTypes: ["Print"] }
      ],
      team: [
        { id: memberId, name: "Test Designer", teamIds: ["email"], shiftStart: "12:30", shiftEnd: "21:30" },
        { id: "design-member", name: "Design Member", teamIds: ["design"], shiftStart: "12:30", shiftEnd: "21:30" }
      ],
      workfrontProjects: [
        { ref: "EMAIL-1", title: "Email project", sourceStatus: "Execution in Progress", productionTeamId: "email", priority: "Urgent" },
        { ref: "DESIGN-1", title: "Design project", sourceStatus: "Execution in Progress", productionTeamId: "design", priority: "Low" },
        { ref: "DESIGN-URGENT", title: "Urgent design project", sourceStatus: "Current", productionTeamId: "design", priority: "Urgent" },
        { ref: "NO-PRIORITY", title: "Unprioritized project", sourceStatus: "Planning", productionTeamId: "design" },
        { ref: "CUSTOM-PRIORITY", title: "Custom priority project", sourceStatus: "Planning", productionTeamId: "design", priority: "Special <review>" },
        { ref: "AUDIT-1", title: "Audit project", sourceStatus: "Audit Ongoing", priority: "High" }
      ],
      workfrontChangeRounds: [{ projectRef: "EMAIL-1", crId: "CR1", workfrontId: "ROUND-1", title: "Email change", sourceStatus: "New" }],
      workfrontTasks: Array.from({ length: 40 }, (_, index) => ({
        id: `task-${index}`, projectRef: index % 2 ? "DESIGN-1" : "EMAIL-1",
        taskName: index % 3 ? "Build" : "CR", taskStatus: index % 4 ? "New" : "In Progress", projectStatus: "Execution in Progress",
        assignees: index % 2 ? "Design Member" : "Test Designer", assignmentNames: [index % 2 ? "Design Member" : "Test Designer"],
        productionTeamId: index % 2 ? "design" : "email", percentComplete: 0,
        plannedStartDate: "2026-10-12", plannedCompletionDate: "2026-10-14"
      }))
    };
    snapshot.workfrontAutomation = { enabled: true, status: "idle", lastSuccessAt: "2026-10-12T10:00:00Z" };
    let shiftRequest;
    await page.route("http://frontend.test/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/auth/status") {
        return route.fulfill({ json: { user: snapshot.user, setupRequired: false } });
      }
      if (pathname === "/api/data") return route.fulfill({ json: snapshot });
      if (pathname === "/api/audit-capacity-estimate") return route.fulfill({ json: {
        assumption: "Existing local and Workfront workload first", warnings: ["Role-only work cannot be allocated"],
        candidates: [{ name: "Test Designer", backlogHours: 16, tentativeDate: "2030-01-08", tentativeTime: "16:00" }]
      } });
      if (pathname === `/api/team/${memberId}/shift`) {
        shiftRequest = route.request().postDataJSON();
        Object.assign(snapshot.team[0], shiftRequest);
        return route.fulfill({ json: snapshot.team[0] });
      }
      const files = { "/": "index.html", "/app.js": "app.js", "/workflow-ui.js": "workflow-ui.js", "/operations-ui.js": "operations-ui.js", "/process-audit-ui.js": "process-audit-ui.js", "/styles.css": "styles.css" };
      if (!files[pathname]) return route.fulfill({ status: 404 });
      return route.fulfill({
        body: await fs.readFile(path.join(__dirname, "../public", files[pathname])),
        contentType: pathname.endsWith(".js") ? "application/javascript" : pathname === "/styles.css" ? "text/css" : "text/html"
      });
    });
    await page.goto("http://frontend.test/");
    await page.waitForFunction(() => !document.querySelector("#app-shell").classList.contains("hidden") || document.querySelector("#toast").textContent);
    assert.equal(await page.locator("#auth-screen").isVisible(), false, await page.locator("#toast").textContent());
    assert.deepEqual(await page.locator(".view:not(.hidden)").evaluateAll((views) => views.map((view) => view.id)), ["view-overview"]);
    await page.locator('#main-nav [data-view="manager-reports"]').click();
    assert.deepEqual(await page.locator('#manager-report-summary [data-drill-key="project-priority"] .metric-label').allTextContents(), ["Urgent"]);
    for (const priority of ["Urgent"]) {
      await page.locator('#main-nav [data-view="manager-reports"]').click();
      const card = page.locator('#manager-report-summary [data-drill-key="project-priority"]').filter({
        has: page.locator(".metric-label", { hasText: new RegExp(`^${priority}$`) })
      });
      const count = snapshot.workfrontProjects.filter((project) => (project.priority || "Not provided") === priority).length;
      assert.equal(Number(await card.locator(".metric-value").innerText()), count);
      await card.click();
      assert.equal(await page.locator("#workfront-priority-filter").inputValue(), priority);
      assert.equal(await page.locator("#workfront-records tbody tr").count(), count);
      if (priority === "Urgent") {
        for (const team of ["Email Team", "Design Team"]) {
          await page.locator("#workfront-team-filter").selectOption(team);
          assert.equal(await page.locator("#workfront-records tbody tr").count(), 1);
          assert.match(await page.locator("#workfront-records tbody tr").innerText(), new RegExp(team));
          await page.clock.fastForward(10000);
          await page.waitForFunction(() => document.querySelector("#last-updated").textContent.includes("Live team data"));
          assert.equal(await page.locator("#workfront-team-filter").inputValue(), team);
          assert.equal(await page.locator("#workfront-priority-filter").inputValue(), priority);
          assert.equal(await page.locator("#workfront-records tbody tr").count(), 1);
          assert.deepEqual(await page.locator(".view:not(.hidden)").evaluateAll((views) => views.map((view) => view.id)), ["view-workfront"]);
        }
      }
      await page.locator("[data-clear-drill]").click();
      assert.equal(await page.locator("#workfront-team-filter").inputValue(), "");
      assert.equal(await page.locator("#workfront-priority-filter").inputValue(), "");
    }
    for (const taskName of ["", "Build"]) {
      await page.locator('#main-nav [data-view="manager-reports"]').click();
      const card = taskName
        ? page.locator(`#manager-floor-status [data-drill-task-name="${taskName}"][data-drill-task-status="In Progress"]`)
        : page.locator('#manager-floor-status [data-drill-value="Audit Ongoing"]');
      const count = Number(await card.locator("strong").innerText());
      assert.ok(count > 0);
      await card.click();
      assert.equal(await page.locator("#workfront-records tbody tr").count(), count);
      for (let refresh = 0; refresh < 2; refresh++) {
        await page.evaluate(() => refreshData(true));
        assert.deepEqual(await page.locator(".view:not(.hidden)").evaluateAll((views) => views.map((view) => view.id)), ["view-workfront"]);
        assert.equal(await page.locator("#page-title").innerText(), "Workfront reports");
        assert.equal(await page.locator("#workfront-records tbody tr").count(), count);
        assert.match(await page.locator("#workfront-drill-notice").innerText(), /In Progress/);
      }
    }
    await page.locator("[data-clear-drill]").click();
    for (const dataset of ["projects", "tasks", "changeRounds"]) {
      await page.locator(`[data-workfront-dataset="${dataset}"]`).click();
      await page.locator("#workfront-priority-filter").selectOption("Urgent");
      const count = dataset === "tasks" ? 20 : dataset === "projects" ? 2 : 1;
      assert.equal(await page.locator("#workfront-records tbody tr").count(), count);
      assert.equal(await page.locator("#workfront-records .workfront-project-priority").count(), count);
      assert.ok((await page.locator("#workfront-records .workfront-project-priority").allTextContents()).every((text) => text === "Project priority: Urgent"));
      await page.evaluate(() => refreshData(true));
      assert.equal(await page.locator("#workfront-priority-filter").inputValue(), "Urgent");
      assert.equal(await page.locator("#workfront-records tbody tr").count(), count);
      assert.deepEqual(await page.locator(".view:not(.hidden)").evaluateAll((views) => views.map((view) => view.id)), ["view-workfront"]);
      await page.locator("#workfront-priority-filter").selectOption("");
    }
    await page.locator('#main-nav [data-view="gantt"]').click();
    await page.locator("#gantt-anchor").fill("2026-10-12");
    await page.locator("#gantt-anchor").dispatchEvent("change");
    await page.locator("#gantt-team-filter").selectOption("email");
    assert.ok((await page.locator("#gantt-chart .workfront-project-priority").allTextContents()).every((text) => text === "Project priority: Urgent"));
    for (const grouping of ["resource", "project", "task"]) {
      await page.locator("#gantt-group-by").selectOption(grouping);
      assert.equal(await page.locator(".workfront-gantt .gantt-lane").count(), 20);
      assert.equal(await page.locator("#gantt-chart").getByText("DESIGN-1", { exact: false }).count(), 0);
    }
    await page.locator("#gantt-group-by").selectOption("resource");
    assert.deepEqual(await page.locator(".workfront-gantt .gantt-project-group > summary").allTextContents(), ["Test Designer 20 tasks"]);
    await page.locator("#gantt-team-filter").selectOption("design");
    assert.deepEqual(await page.locator(".workfront-gantt .gantt-project-group > summary").allTextContents(), ["Design Member 20 tasks"]);
    await page.locator("#gantt-team-filter").selectOption("email");
    const originalTask = { ...snapshot.workfrontTasks[0] };
    Object.assign(snapshot.workfrontTasks[0], {
      assignmentNames: ["Test Designer", "External Workfront Designer"], assignees: "Test Designer; External Workfront Designer",
      taskStatus: "Complete", percentComplete: 100, plannedCompletionDate: "2026-10-20"
    });
    await page.clock.fastForward(10000);
    await page.waitForFunction(() => document.querySelector("#gantt-chart").textContent.includes("External Workfront Designer"));
    assert.equal(await page.locator(".gantt-project-group > summary", { hasText: "External Workfront Designer" }).count(), 0);
    const importedLane = page.locator('[data-hover-task="source:task-0"]');
    assert.equal(await importedLane.count(), 1);
    assert.match(await importedLane.innerText(), /External Workfront Designer/);
    await importedLane.locator("strong").click();
    const details = page.locator("#timeline-hover");
    assert.equal(await details.isVisible(), true);
    assert.equal(await importedLane.evaluate((lane) => lane.nextElementSibling?.id), "timeline-hover");
    const laneBox = await importedLane.boundingBox();
    assert.ok((await details.boundingBox()).y >= laneBox.y + laneBox.height - 1);
    await page.evaluate(() => refreshData(true));
    assert.equal(await details.isVisible(), true);
    assert.equal(await page.locator('[data-hover-task="source:task-0"]').evaluate((lane) => lane.nextElementSibling?.id), "timeline-hover");
    await page.keyboard.press("Escape");
    assert.equal(await details.isVisible(), false);
    await importedLane.focus();
    await page.keyboard.press("Enter");
    assert.equal(await details.isVisible(), true);
    await details.locator("[data-close-timeline-detail]").click();
    assert.equal(await details.isVisible(), false);
    assert.match(await importedLane.innerText(), /Complete/);
    assert.match(await importedLane.locator(".workfront-gantt-bar").getAttribute("title"), /Oct 20, 2026/);
    assert.match(await importedLane.locator(".gantt-progress").getAttribute("style"), /100%/);
    assert.match(await page.locator("#gantt-sync-status").innerText(), /Automatic import every 15 minutes/);
    assert.equal(await page.locator("#gantt-team-filter").inputValue(), "email");
    assert.equal(await page.locator("#gantt-group-by").inputValue(), "resource");
    assert.deepEqual(await page.locator(".view:not(.hidden)").evaluateAll((views) => views.map((view) => view.id)), ["view-gantt"]);
    snapshot.workfrontTasks[0].plannedCompletionDate = "2026-10-12";
    await page.clock.fastForward(10000);
    await page.waitForFunction(() => !document.querySelector('[data-hover-task="source:task-0"]'));
    assert.match(await page.locator("#gantt-source-notice").innerText(), /1 task completed on or before Oct 12, 2026 hidden/);
    Object.assign(snapshot.workfrontTasks[0], originalTask);
    await page.clock.fastForward(10000);
    await page.waitForFunction(() => !document.querySelector("#gantt-chart").textContent.includes("External Workfront Designer"));
    assert.equal(await page.getByText("External Workfront Designer", { exact: true }).count(), 0);
    await page.locator("#gantt-status-filter").selectOption("In Progress");
    assert.equal(await page.locator(".workfront-gantt .gantt-lane").count(), 10);
    await page.locator("#gantt-project-status-filter").selectOption("Execution in Progress");
    assert.equal(await page.locator(".workfront-gantt .gantt-lane").count(), 10);
    await page.evaluate(() => window.scrollTo({ top: 900, behavior: "instant" }));
    const before = await page.evaluate(() => window.scrollY);
    assert.ok(before > 500);
    await page.evaluate(() => refreshData(true));
    assert.equal(await page.evaluate(() => window.scrollY), before);
    assert.equal(await page.locator("#gantt-team-filter").inputValue(), "email");
    assert.equal(await page.locator("#gantt-status-filter").inputValue(), "In Progress");
    assert.equal(await page.locator("#gantt-project-status-filter").inputValue(), "Execution in Progress");
    await page.locator('#main-nav [data-view="team"]').click();
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    assert.equal(await page.locator(".main-content").evaluate((main) => main.style.minHeight), "");
    assert.equal((await page.locator(".sidebar").boundingBox()).y, 0);
    assert.deepEqual(await page.locator(".view:not(.hidden)").evaluateAll((views) => views.map((view) => view.id)), ["view-team"]);
    assert.equal(await page.locator('#main-nav [data-view="leaves"]').count(), 0);
    assert.equal(await page.locator("#page-title").innerText(), "Team & leave");
    const visiblePanes = () => page.locator("[data-team-pane]:not([hidden])").evaluateAll((panes) => panes.map((pane) => pane.dataset.teamPane));
    assert.deepEqual(await visiblePanes(), ["members"]);
    assert.equal(await page.locator(".department-overview").evaluate((details) => details.open), false);
    await page.locator('[data-team-tab="leave"]').click();
    assert.deepEqual(await visiblePanes(), ["leave"]);
    assert.equal(await page.locator(".leave-list-panel").isVisible(), true);
    assert.equal(await page.locator("#leave-risk-report").isVisible(), false);
    await page.evaluate(() => refreshData(true));
    assert.deepEqual(await visiblePanes(), ["leave"]);
    await page.locator('[data-team-tab="accounts"]').click();
    assert.deepEqual(await visiblePanes(), ["accounts"]);
    assert.equal(await page.locator("#accounts-panel").isVisible(), true);
    assert.equal(await page.locator("#account-form").isVisible(), false);
    await page.locator('#main-nav [data-view="overview"]').click();
    await page.locator('#view-overview [data-drill-view="leaves"]').first().click();
    assert.deepEqual(await page.locator(".view:not(.hidden)").evaluateAll((views) => views.map((view) => view.id)), ["view-team"]);
    assert.deepEqual(await visiblePanes(), ["leave"]);
    assert.match(await page.locator("#leaves-drill-notice").innerText(), /Showing/);
    await page.locator("[data-clear-drill]").click();
    await page.locator('#main-nav [data-view="team"]').click();
    assert.deepEqual(await visiblePanes(), ["members"]);
    await page.getByRole("combobox", { name: "Shift for Test Designer", exact: true }).selectOption("11:30|20:30");
    await page.waitForFunction(() => document.querySelector("#toast").textContent.includes("Shift updated"));
    assert.deepEqual(shiftRequest, { shiftStart: "11:30", shiftEnd: "20:30" });
    await page.locator('#main-nav [data-view="gantt"]').click();
    await page.locator("#gantt-scale").selectOption("hour");
    assert.equal(await page.locator(".gantt-day").count(), 18);
    assert.match(await page.locator(".gantt-day").last().innerText(), /20:30/);
    await page.evaluate(() => window.scrollTo({ top: 700, behavior: "instant" }));
    assert.ok(await page.evaluate(() => window.scrollY) > 500);
    assert.equal(await page.locator('#main-nav [data-view="projects"]').isVisible(), false);
    await page.locator('#main-nav [data-view="overview"]').click();
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    assert.equal(await page.locator(".main-content").evaluate((main) => main.style.minHeight), "");
    assert.deepEqual(await page.locator(".view:not(.hidden)").evaluateAll((views) => views.map((view) => view.id)), ["view-overview"]);
    for (const viewport of [{ width: 1440, height: 600 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.locator('#main-nav [data-view="gantt"]').click();
      await page.evaluate(() => window.scrollTo({ top: 700, behavior: "instant" }));
      const scrolled = await page.evaluate(() => window.scrollY);
      assert.ok(scrolled > 500);
      assert.equal((await page.locator(".sidebar").boundingBox()).y, 0);
      await page.evaluate(() => refreshData(true));
      assert.equal(await page.evaluate(() => window.scrollY), scrolled);
      assert.equal((await page.locator(".sidebar").boundingBox()).y, 0);
      const overviewTab = page.locator('#main-nav [data-view="overview"]');
      await overviewTab.focus();
      await overviewTab.press("Enter");
      assert.equal(await page.evaluate(() => window.scrollY), 0);
      assert.equal(await page.locator(".main-content").evaluate((main) => main.style.minHeight), "");
      assert.equal((await page.locator(".sidebar").boundingBox()).y, 0);
      assert.deepEqual(await page.locator(".nav-link.active").evaluateAll((tabs) => tabs.map((tab) => tab.dataset.view)), ["overview"]);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => openAuditForm({ projectRef: "EMAIL-1", channel: "Email" }));
    await page.locator('#audit-form [name="etaDate"]').fill("2030-01-09");
    await page.locator('#audit-form [name="etaTime"]').fill("12:30");
    await page.locator("#calculate-audit-capacity").click();
    await page.waitForFunction(() => document.querySelector("#audit-capacity-result").textContent.includes("Tentative delivery"));
    assert.match(await page.locator("#audit-capacity-result").innerText(), /Role-only work cannot be allocated/);
    assert.match(await page.locator("#audit-capacity-result").innerText(), /Test Designer/);
    assert.equal(await page.locator('#audit-form [name="etaDate"]').inputValue(), "2030-01-09");
    assert.equal(await page.locator('#audit-form [name="capacityRequested"]').inputValue(), "true");
    await page.locator('#audit-form [name="pageCount"]').fill("2");
    assert.equal(await page.locator('#audit-form [name="capacityRequested"]').inputValue(), "false");
    assert.equal(await page.locator("#audit-capacity-result").innerText(), "");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
