"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  closeWorkfrontLogin,
  collectVirtualGrid,
  enrichWorkfrontReports,
  findReportContentFrame,
  getWorkfrontLoginStatus,
  pageForReport,
  recordWorkfrontLoginScrapeResult,
  scrapeWorkfrontReports,
  selectTaskDeliveryCentre,
  readDetailFields,
  readUserUpdates,
  taskReportPromptMode,
  workfrontLoginIsOpen
} = require("../workfront-dom");
const { chromium } = require("playwright");

test("waits for delayed delivery-centre suggestions and verifies a selected token, not search text", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<section role="tabpanel" aria-label="Prompts">
      <input role="combobox" onkeydown="if(event.key.length === 1) window.suggestionsOpen = true" oninput="clearTimeout(window.suggestTimer); if(this.value) window.suggestTimer = setTimeout(() => {
        if(window.suggestionsOpen) document.querySelector('#suggestions').innerHTML = '<div role=option onclick=selectCentre()>PRD WPP Production</div>';
      }, 900)">
      <div id="selected"></div>
      </section><div id="suggestions"></div>
      <script>function selectCentre() {
        document.querySelector('#suggestions').innerHTML = '';
        setTimeout(() => { document.querySelector('#selected').innerHTML = '<div role=gridcell aria-label="Remove selected delivery centre">PRD WPP Production</div>'; }, 200);
      }</script>`);
    const panel = page.getByRole("tabpanel", { name: "Prompts" });
    await selectTaskDeliveryCentre(page, panel, panel.getByRole("combobox"));
    assert.equal(await panel.getByRole("combobox").inputValue(), "");
    assert.deepEqual(await panel.getByRole("gridcell").allInnerTexts(), ["PRD WPP Production"]);
    await page.locator("#selected").evaluate((element) => { element.innerHTML += '<div role="gridcell">Other Centre</div>'; });
    await assert.rejects(selectTaskDeliveryCentre(page, panel, panel.getByRole("combobox")), /not restricted to PRD WPP Production/);
  } finally { await browser.close(); }
});

test("reports each scrape phase and rejects failed detail reads instead of declaring a complete import", async (t) => {
  const browser = await chromium.launch({ headless: true });
  let includeProject = false;
  const reportPages = new Map();
  t.mock.method(chromium, "launchPersistentContext", async () => {
    const context = await browser.newContext();
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      const report = url.pathname.match(/\/report\/([^/]+)/)?.[1];
      if (url.hostname === "experience.adobe.com") {
        reportPages.set(report, route.request().frame().page());
        return route.fulfill({ contentType: "text/html", body: `<iframe src="https://fixture.my.workfront.adobe.com/report/${report}/detail"></iframe>` });
      }
      const hasProject = report === "projects" && includeProject;
      const grid = `<div role="grid"><div role="columnheader">Reference Number</div><div role="columnheader">Project Name</div>
        <div class="ReactVirtualized__Grid table-list-body" style="height:100px">
        ${hasProject ? '<div role="row"><div role="gridcell">P1</div><div role="gridcell">Project without a detail link</div></div>' : ""}
        </div></div><p>Showing ${hasProject ? 1 : 0} items</p>`;
      return route.fulfill({ contentType: "text/html", body: report === "tasks"
        ? `<main><h1>What should we include in your Report?</h1><p>Project Delivery Centre</p>
          <button onclick="this.hidden=true;document.querySelector('#operator').hidden=false">-- Any --</button>
          <div id="operator" hidden><div role="option" onclick="document.querySelector('#search').hidden=false">Equal</div></div>
          <div id="search" hidden><input role="combobox" oninput="if(this.value)document.querySelector('#option').hidden=false">
          <div id="option" role="option" hidden onclick="this.hidden=true;document.querySelector('#selection').hidden=false">PRD WPP Production</div>
          <div id="selection" role="gridcell" hidden>PRD WPP Production</div></div>
          <button onclick="document.querySelector('main').hidden=true;document.querySelector('#results').hidden=false">Run Report</button></main>
          <div id="results" hidden><button role="tab">Details</button><div role="tabpanel" aria-label="Details">
          <button>Collapse All</button>${grid}</div></div>`
        : `<button role="tab">Details</button>${grid}` });
    });
    return context;
  });
  const urls = Object.fromEntries([["openProjects", "projects"], ["changeRounds", "rounds"], ["tasks", "tasks"]]
    .map(([key, id]) => [key, `https://experience.adobe.com/report/${id}/detail`]));
  try {
    const phases = [];
    const reports = await scrapeWorkfrontReports(urls, null, async (phase) => phases.push(phase));
    assert.notEqual(reportPages.get("tasks"), reportPages.get("projects"));
    assert.notEqual(reportPages.get("tasks"), reportPages.get("rounds"));
    assert.deepEqual(phases, ["Reading open projects", "Reading change rounds", "Reading tasks", "Reading project and task details"]);
    assert.deepEqual(reports.detailErrors, []);
    includeProject = true;
    await assert.rejects(scrapeWorkfrontReports(urls), /detail scraping was incomplete \(1 failed records\).*no readable detail link/);
  } finally { await browser.close(); }
});

test("reads project details sequentially and imports read-only priority into progressive batches", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  let maximumPages = 0;
  context.on("page", () => { maximumPages = Math.max(maximumPages, context.pages().length); });
  try {
    await context.route("**/*", (route) => route.fulfill({
      contentType: "text/html",
      body: new URL(route.request().url()).hostname === "experience.adobe.com"
        ? `<iframe style="width:1000px;height:900px"></iframe><script>
          function loadProject() {
            document.querySelector("iframe").src = "https://laroche.my.workfront.adobe.com" + location.hash.slice(location.hash.indexOf("/project/"));
          }
          addEventListener("hashchange", loadProject);
          loadProject();
          </script>`
        : `<div id="header-widget-status">Execution In Progress</div>
          <button data-rsp-slot="text">Tasks</button>
          <div data-testid="table-container"><div class="ReactVirtualized__Grid table-list-body" style="height:100px;width:500px"></div></div>
          <button data-rsp-slot="text">Project Details</button>
          <button>Content Studio Project</button>
          <div data-testid="view-mode-container">
            <div data-testid="field-plannedCompletionDate"><h4>Planned Completion Date</h4>Oct 20, 2026</div>
            <div data-testid="field-priority"><h4>Priority</h4>Urgent</div>
            <div data-testid="field-actualStartDate"><h4>Actual Start Date</h4>Oct 12, 2026</div>
            <div data-testid="field-executor"><h4>Executor name</h4>Designer One</div>
            <div data-testid="field-errors"><h4>Total Number of Errors</h4>0</div>
          </div>
          <button data-rsp-slot="text">Updates</button><button role="tab">System activity</button>
          <div data-testid="activity-layout">Manager changed the status to Execution In Progress <button data-omega-element="date">Oct 10</button></div>
          <div role="tooltip" class="_is-open">October 10, 2026 at 7:27 PM</div>`
    }));
    const reports = {
      openProjects: {
        headers: ["Reference Number", "Project Name", "Status", "Workfront Project URL"],
        rows: [
          ["PRIORITY-1", "Priority project", "Execution In Progress", "https://laroche.my.workfront.adobe.com/project/priority-project/tasks"],
          ["PRIORITY-2", "Second project", "Execution In Progress", "https://laroche.my.workfront.adobe.com/project/priority-project-2/tasks"]
        ]
      },
      tasks: { headers: ["Project: Reference Number"], rows: [], rowIds: [] }
    };
    const batches = [];
    await enrichWorkfrontReports(context, reports, async (batch) => batches.push(batch));
    assert.equal(maximumPages, 1);
    assert.equal(batches.length, 2);
    assert.deepEqual(reports.detailErrors, []);
    assert.equal(reports.openProjects.rows[0][reports.openProjects.headers.indexOf("Priority")], "Urgent");
    assert.equal(reports.openProjects.rows[0][reports.openProjects.headers.indexOf("Actual Start Date")], "Oct 12, 2026");
    assert.equal(reports.openProjects.rows[0][reports.openProjects.headers.indexOf("Executor name")], "Designer One");
    assert.equal(reports.openProjects.rows[0][reports.openProjects.headers.indexOf("Total Number of Errors")], "0");
    assert.equal(batches[0].openProjects.rows[0][batches[0].openProjects.headers.indexOf("Priority")], "Urgent");
  } finally { await browser.close(); }
});

test("Comments reader keeps human authors, dates and text separate from system activity and reports unavailable coverage", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<button role="tab">Comments</button>
      <div data-testid="activity-layout">System changed status to Complete</div>
      <div data-testid="comment-layout" data-comment-id="C1"><span data-testid="comment-author">Auditor One</span>
        <div data-testid="comment-text">Asset audit completed<br>Complexity: High<br>Request Type: Update</div>
        <button data-omega-element="date">Oct 12</button></div>
      <div role="tooltip" class="_is-open">October 12, 2026 at 2:30 PM</div>`);
    const result = await readUserUpdates(page, page);
    const updates = JSON.parse(result["User Updates"]);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, "C1");
    assert.equal(updates[0].author, "Auditor One");
    assert.match(updates[0].text, /Complexity: High/);
    assert.equal(new Date(updates[0].date).getFullYear(), 2026);
    assert.match(result["Updates Read Status"], /earlier\/paginated/);
    await page.setContent("<p>Adobe Sign in</p>");
    assert.match((await readUserUpdates(page, page))["Updates Read Status"], /unavailable/);
    await page.setContent('<button role="tab">Comments</button><p>No comments</p>');
    assert.equal((await readUserUpdates(page, page))["Updates Read Status"], "No comments in loaded Updates");
  } finally { await browser.close(); }
});

test("enriches outside-list Asset Audit tasks, authored Updates and all selected names, not just header avatars", async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  try {
    await context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: new URL(route.request().url()).hostname === "experience.adobe.com"
      ? '<iframe style="width:1000px;height:900px" src="https://laroche.my.workfront.adobe.com/task/task-1/overview"></iframe>'
      : `<div id="header-widget-status">In Progress</div>
        <div data-testid="view-mode-container">
          <div data-testid="field-status"><h4>Status</h4>In Progress</div>
          <div data-testid="field-plannedCompletionDate"><h4>Planned Completion Date</h4>Oct 13, 2026 6:00 PM</div>
          <div data-testid="field-workRequiredExpression"><h4>Planned Hours</h4>18 Hours</div>
          <div data-testid="field-actualWorkRequiredExpression"><h4>Actual Hours</h4>3 Hours</div>
        </div>
        <div id="header-widget-assignments"><div data-testid="avatar"><img alt="Designer One"></div></div>
        <button data-testid="data-test-assignments-wrapper" onclick="document.getElementById('dialog').hidden=false">Assignments and delegations</button>
        <div id="dialog" data-testid="assignment-dialog" hidden>
          <input id="assignment-search-input" aria-label="Assignments, 3 selected.">
          <div data-testid="assignment-pill"><span role="option" aria-label="Designer One"><img src="/internal/user/avatar"></span></div>
          <div data-testid="assignment-pill"><span role="option" aria-label="Designer Two"><img src="/internal/user/avatar"></span></div>
          <div data-testid="assignment-pill"><span role="option" aria-label="ROC | Developer"></span></div>
          <button role="tab">Assignments</button><button role="tab">Delegations</button>
          <div data-testid="delegations-content">People delegated to this task will display here</div>
          <button disabled>Save</button><button onclick="document.getElementById('dialog').hidden=true">Cancel</button>
        </div>
        <button data-rsp-slot="text">Updates</button>
        <button role="tab">Comments</button>
        <div data-testid="comment-layout" data-comment-id="AUDIT-NOTE"><span data-testid="comment-author">Auditor One</span>
          <div data-testid="comment-text">Asset audit completed<br>Complexity: High<br>Page count: 4</div>
          <button data-omega-element="date">Oct 9</button></div>
        <button role="tab" onclick="setTimeout(()=>document.getElementById('history').innerHTML=document.getElementById('activity').innerHTML,500)">System activity</button>
        <div id="history">No system activity</div>
        <template id="activity"><div data-testid="activity-layout">Update on Child task: Designer One changed the status to Complete <button data-omega-element="date">Oct 10, 8:00 PM</button></div><div data-testid="activity-layout">Designer Two changed status from New to In Progress <button data-omega-element="date">Oct 9, 7:27 PM</button></div><div role="tooltip" class="_is-open">October 9, 2026 at 7:27 PM</div></template>` }));
    const reports = {
      openProjects: { headers: [], rows: [] },
      tasks: {
        headers: ["Project: Reference Number", "Project: Name", "Task Name", "Status", "Assignments", "Project: Primary Material", "Planned Start Date", "Planned Completion Date", "Project: Delivery Centre", "% Complete"],
        rows: [["outside-project", "Outside project", "Asset Audit", "New", "Designer One", "Email", "", "", "PRD WPP Production", "80%"]],
        rowIds: ["task-1"]
      }
    };
    const batches = [];
    await enrichWorkfrontReports(context, reports, async (batch) => batches.push(batch));
    const get = (name) => reports.tasks.rows[0][reports.tasks.headers.indexOf(name)];
    assert.equal(get("Status"), "In Progress");
    assert.equal(get("Assignments"), "Designer One; Designer Two; ROC | Developer, Role / team");
    assert.equal(get("Planned Hours"), "18 Hours");
    assert.equal(get("Last Status Changed"), "October 9, 2026 7:27 PM");
    assert.match(get("Latest System Activity"), /^Designer Two changed status from New to In Progress/);
    assert.equal(get("Latest System Activity Date"), "October 9, 2026 7:27 PM");
    const updates = JSON.parse(get("User Updates"));
    assert.equal(updates[0].id, "AUDIT-NOTE");
    assert.equal(updates[0].author, "Auditor One");
    assert.match(updates[0].text, /Page count: 4/);
    assert.match(get("Updates Read Status"), /Loaded comments only/);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].openProjects.rows.length, 0);
    assert.deepEqual(batches[0].tasks.rowIds, ["task-1"]);
  } finally { await browser.close(); }
});

test("expands every custom form by stable identity and reads only visible source fields", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div data-testid="view-mode-container"><div data-testid="field-plannedCompletionDate"><h4>Planned Completion Date</h4>Oct 13, 2026 6:00 PM</div></div>
      <button data-testid="clickable-one" aria-expanded="false">Content Studio Request</button><div id="one" hidden data-testid="field-outer-cell"><label for="DE:Number of Pages-view">Number of Pages</label>2</div>
      <button data-testid="clickable-two" aria-expanded="false">Content Studio Project</button><div id="two" hidden data-testid="field-outer-cell"><label for="DE:Material Expected Delivery Date-view">Material Expected Delivery Date</label>Oct 12, 2026 6:00 PM</div>
      <div hidden data-testid="view-mode-container"><div data-testid="field-plannedCompletionDate"><h4>Planned Completion Date</h4>Jan 1, 1999</div></div>`);
    await page.evaluate(() => {
      for (const [button, id] of [[document.querySelector('[data-testid="clickable-one"]'), "one"], [document.querySelector('[data-testid="clickable-two"]'), "two"]]) {
        button.addEventListener("click", () => { button.setAttribute("aria-expanded", "true"); document.getElementById(id).hidden = false; });
      }
    });
    const fields = await readDetailFields(page.mainFrame(), true);
    assert.equal(fields["Planned Completion Date"], "Oct 13, 2026 6:00 PM");
    assert.equal(fields["Number of Pages"], "2");
    assert.equal(fields["Material Expected Delivery Date"], "Oct 12, 2026 6:00 PM");
  } finally { await browser.close(); }
});

test("Workfront sign-in is initially closed and exposes no credentials", () => {
  assert.deepEqual(getWorkfrontLoginStatus(), {
    status: "idle",
    openedAt: null,
    completedAt: null,
    lastError: ""
  });
  assert.equal(workfrontLoginIsOpen(), false);
});

test("selects the nested Workfront report frame instead of the Experience shell", () => {
  const reportId = "68889a9300074153056d1d87522009cf";
  const mainFrame = { url: () => `https://experience.adobe.com/#/@org/workfront/report/${reportId}/detail` };
  const reportFrame = { url: () => `https://laroche.my.workfront.adobe.com/report/${reportId}/detail` };
  assert.equal(findReportContentFrame([mainFrame, reportFrame], mainFrame, reportId), reportFrame);
  assert.equal(findReportContentFrame([mainFrame], mainFrame, reportId), null);
});

test("recognizes both tabbed and prompt-first Workfront task report layouts", () => {
  assert.equal(taskReportPromptMode({ hasPromptsTab: true, hasPromptFirstControls: false }), "tabbed");
  assert.equal(taskReportPromptMode({ hasPromptsTab: false, hasPromptFirstControls: true }), "prompt-first");
  assert.equal(taskReportPromptMode({ hasPromptsTab: false, hasPromptFirstControls: false }), null);
});

test("runs project prompts and switches from Chart to Details in the nested report frame", async () => {
  const reportId = "projects";
  let ran = false;
  let detailsSelected = false;
  const clicks = [];
  const locator = (count, click = async () => {}, children = {}) => ({
    count: async () => count(),
    isVisible: async () => count() > 0,
    isEnabled: async () => true,
    click,
    first() { return this; },
    locator: (selector) => children[selector]
  });
  const run = locator(() => ran ? 0 : 1, async () => { ran = true; clicks.push("run"); });
  const details = locator(() => ran ? 1 : 0, async () => { detailsSelected = true; clicks.push("details"); });
  const grid = locator(() => detailsSelected ? 1 : 0, undefined, {
    '[role="columnheader"]': locator(() => 18),
    ".ReactVirtualized__Grid.table-list-body": locator(() => 1)
  });
  const mainFrame = {
    url: () => `https://experience.adobe.com/#/workfront/report/${reportId}/detail`,
    getByRole: () => { throw new Error("The Experience shell must not be scraped."); }
  };
  const reportFrame = {
    url: () => `https://laroche.my.workfront.adobe.com/report/${reportId}/detail`,
    getByRole: (role, { name }) => role === "tab" ? details : name === "Expand All" ? locator(() => 0) : run,
    locator: () => grid
  };
  const page = {
    frames: () => [mainFrame, reportFrame],
    mainFrame: () => mainFrame,
    waitForTimeout: async () => {}
  };
  assert.equal(await pageForReport(page, "All Open Projects", reportId), reportFrame);
  assert.deepEqual(clicks, ["run", "details"]);
});

test("report readiness failures identify the Details grid rather than assuming sign-out", async () => {
  const mainFrame = { url: () => "https://experience.adobe.com/" };
  await assert.rejects(pageForReport({
    frames: () => [mainFrame],
    mainFrame: () => mainFrame,
    waitForTimeout: async () => {}
  }, "All Open Projects", "projects", 0), /Details grid did not load.*layout may have changed/);
});

test("allows retrying a failed Workfront scrape after the sign-in window closes", async () => {
  recordWorkfrontLoginScrapeResult(new Error("Task report did not load"));
  const status = await closeWorkfrontLogin();
  assert.equal(status.status, "closed");
  assert.equal(workfrontLoginIsOpen(), false);
});

function virtualGridFixture(options = {}) {
  let scrollTop = 0;
  const allRows = options.rows || ["A", "B", "C", "D", "E"];
  return {
    readSnapshot: async () => ({
      headers: ["Reference Number"],
      rows: allRows
        .map((value, index) => ({ position: index * 10, values: [value] }))
        .filter((row) => row.position >= scrollTop && row.position <= scrollTop + 20),
      scrollTop,
      scrollHeight: 50,
      clientHeight: 20,
      expectedCount: options.expectedCount ?? 5
    }),
    scrollTo: async (nextTop) => { scrollTop = nextTop; }
  };
}

test("collects every virtualized row once while preserving report order", async () => {
  const fixture = virtualGridFixture();
  const report = await collectVirtualGrid(fixture.readSnapshot, fixture.scrollTo, async () => {});
  assert.deepEqual(report, {
    headers: ["Reference Number"],
    rows: [["A"], ["B"], ["C"], ["D"], ["E"]]
  });
});

test("rejects a partial grid rather than importing an incomplete snapshot", async () => {
  const fixture = virtualGridFixture({ rows: ["A", "B", "C"], expectedCount: 5 });
  await assert.rejects(
    collectVirtualGrid(fixture.readSnapshot, fixture.scrollTo, async () => {}),
    /only 3 rows were collected/
  );
});

test("collects task rows by stable Workfront IDs and retains aligned IDs", async () => {
  let scrollTop = 0;
  const rows = [
    { identity: "task-a", position: 0, values: ["Project A", "Build"] },
    { identity: "task-b", position: 10, values: ["Project B", "QA"] },
    { identity: "task-c", position: 20, values: ["Project C", "CR"] }
  ];
  const readSnapshot = async () => ({
    headers: ["Project", "Task"],
    rows: rows.filter((row) => row.position >= scrollTop && row.position <= scrollTop + 20),
    scrollTop,
    scrollHeight: 40,
    clientHeight: 20,
    expectedCount: 3
  });
  const report = await collectVirtualGrid(readSnapshot, async (top) => { scrollTop = top; }, async () => {}, {
    useStableRowIds: true,
    scrollRatio: 0.5
  });
  assert.deepEqual(report, {
    headers: ["Project", "Task"],
    rows: [["Project A", "Build"], ["Project B", "QA"], ["Project C", "CR"]],
    rowIds: ["task-a", "task-b", "task-c"]
  });
});

test("rejects task rows without stable IDs", async () => {
  const fixture = virtualGridFixture();
  await assert.rejects(
    collectVirtualGrid(
      async () => ({ ...(await fixture.readSnapshot()), rows: [{ position: 0, values: ["A"] }] }),
      fixture.scrollTo,
      async () => {},
      { useStableRowIds: true }
    ),
    /missing its stable record ID/
  );
});
