"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = __dirname;
const DEFAULT_REPORT_URLS = {
  openProjects: "https://experience.adobe.com/#/@fhoffmann-larocheag/so:laroche-Production/workfront/report/6867d84700033d2530c4b4813cd52cf4/detail",
  changeRounds: "https://experience.adobe.com/#/@fhoffmann-larocheag/so:laroche-Production/workfront/report/6870eb8500030aa2f3bebb4acf74a50c/detail",
  tasks: "https://experience.adobe.com/#/@fhoffmann-larocheag/so:laroche-Production/workfront/report/68889a9300074153056d1d87522009cf/detail"
};
const WORKFRONT_LOGIN_HELP = "Use Workfront Reports > Automatic Workfront sync > Open Workfront sign-in, complete SSO/MFA in the host browser, then retry.";
// Concurrent detail tabs intermittently leave Workfront's forms unloaded in the saved session.
const DETAIL_CONCURRENCY = 1;
let interactiveLoginContext = null;
let interactiveLoginOpening = false;
let interactiveLoginState = { status: "idle", openedAt: null, completedAt: null, lastError: "" };

// Cloud-sync clients (OneDrive/iCloud) evict browser-profile files, which stalls Chromium and loses the session.
function profileDirectory() {
  const configured = process.env.WORKFRONT_PROFILE_DIR;
  if (configured) return path.resolve(configured);
  const synced = /[\\/](CloudStorage|OneDrive[^\\/]*|iCloud Drive|Mobile Documents)[\\/]/i.test(ROOT);
  return synced ? path.join(os.homedir(), ".team-project-hub", "workfront-profile") : path.join(ROOT, "data", "workfront-profile");
}

function ensureProfileDirectory() {
  const directory = profileDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function getWorkfrontLoginStatus() {
  return { ...interactiveLoginState };
}

function workfrontLoginIsOpen() {
  return interactiveLoginOpening || interactiveLoginContext !== null;
}

async function openWorkfrontLogin() {
  if (workfrontLoginIsOpen()) throw new Error("A Workfront sign-in browser is already open.");
  interactiveLoginOpening = true;
  const openedAt = new Date().toISOString();
  interactiveLoginState = { status: "opening", openedAt, completedAt: null, lastError: "" };
  let context;
  try {
    context = await chromium.launchPersistentContext(ensureProfileDirectory(), {
      headless: false,
      args: ["--disable-background-networking"]
    });
    interactiveLoginContext = context;
    context.on("close", () => {
      if (interactiveLoginContext === context) {
        interactiveLoginContext = null;
        interactiveLoginState = { ...interactiveLoginState, status: "windowClosed" };
      }
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(DEFAULT_REPORT_URLS.openProjects, { waitUntil: "commit", timeout: 30000 });
    interactiveLoginState = { status: "awaitingLogin", openedAt, completedAt: null, lastError: "" };
    return getWorkfrontLoginStatus();
  } catch (error) {
    if (context) {
      interactiveLoginContext = null;
      await context.close().catch(() => {});
    }
    interactiveLoginState = {
      status: "error",
      openedAt,
      completedAt: null,
      lastError: String(error.message || "Could not open the Workfront sign-in browser.").slice(0, 500)
    };
    throw error;
  } finally {
    interactiveLoginOpening = false;
  }
}

async function closeWorkfrontLogin({ cancel = false } = {}) {
  const context = interactiveLoginContext;
  if (!context && interactiveLoginState.status !== "windowClosed" && !(interactiveLoginState.status === "scrapeError" && !cancel)) {
    throw new Error("No Workfront sign-in browser is open.");
  }
  if (context) await context.close();
  interactiveLoginContext = null;
  interactiveLoginState = {
    status: cancel ? "cancelled" : "closed",
    openedAt: interactiveLoginState.openedAt,
    completedAt: new Date().toISOString(),
    lastError: ""
  };
  return getWorkfrontLoginStatus();
}

function recordWorkfrontLoginScrapeResult(error = null) {
  interactiveLoginState = {
    ...interactiveLoginState,
    status: error ? "scrapeError" : "signedIn",
    completedAt: new Date().toISOString(),
    lastError: error ? String(error.message || "Workfront scrape failed.").slice(0, 500) : ""
  };
}

async function collectVirtualGrid(readSnapshot, scrollTo, wait, options = {}) {
  const collected = new Map();
  let headers;
  let previousTop = -1;
  let snapshot;
  for (let pass = 0; pass < 20000; pass += 1) {
    snapshot = await readSnapshot();
    if (!snapshot || !Array.isArray(snapshot.headers) || !snapshot.headers.length) {
      throw new Error("The Workfront report grid has no readable column headers.");
    }
    if (snapshot.expectedCount > 10000) throw new Error("The Workfront report exceeds the 10,000-row safety limit.");
    if (!headers) headers = snapshot.headers;
    else if (headers.length !== snapshot.headers.length || headers.some((header, index) => header !== snapshot.headers[index])) {
      throw new Error("The Workfront report columns changed while the report was being read.");
    }
    for (const row of snapshot.rows || []) {
      if (!Array.isArray(row.values) || row.values.length !== headers.length) {
        throw new Error("A Workfront grid row does not match the report's column count; no partial data was imported.");
      }
      if (options.useStableRowIds && (typeof row.identity !== "string" || !row.identity)) {
        throw new Error("A Workfront task row is missing its stable record ID; no partial data was imported.");
      }
      const key = options.useStableRowIds ? row.identity : row.position;
      const existing = collected.get(key);
      if (existing && JSON.stringify(existing.values) !== JSON.stringify(row.values)) {
        throw new Error("A Workfront report row changed during scraping; no partial data was imported.");
      }
      collected.set(key, { position: row.position, identity: row.identity, values: row.values });
      if (collected.size > 10000) throw new Error("The Workfront report exceeds the 10,000-row safety limit.");
    }
    if (!Number.isFinite(snapshot.scrollTop) || !Number.isFinite(snapshot.scrollHeight) || !Number.isFinite(snapshot.clientHeight)) {
      throw new Error("The Workfront report grid does not expose a readable scroll position.");
    }
    const maxScroll = Math.max(0, snapshot.scrollHeight - snapshot.clientHeight);
    if (snapshot.scrollTop >= maxScroll || snapshot.expectedCount !== null && collected.size >= snapshot.expectedCount) break;
    if (snapshot.scrollTop <= previousTop) throw new Error("The Workfront report grid stopped scrolling before all rows were read.");
    previousTop = snapshot.scrollTop;
    const scrollRatio = Number.isFinite(options.scrollRatio) ? options.scrollRatio : 1;
    const nextTop = Math.min(maxScroll, snapshot.scrollTop + Math.max(1, Math.floor(snapshot.clientHeight * scrollRatio)));
    await scrollTo(nextTop);
    await wait();
  }
  const entries = [...collected.values()].sort((left, right) => left.position - right.position);
  const rows = entries.map((row) => row.values);
  if (snapshot?.expectedCount !== null && snapshot?.expectedCount !== undefined && rows.length !== snapshot.expectedCount) {
    throw new Error(`Workfront reports ${snapshot.expectedCount} items, but only ${rows.length} rows were collected. No partial data was imported.`);
  }
  if (rows.length > 10000) throw new Error("The Workfront report exceeds the 10,000-row safety limit.");
  return {
    headers,
    rows,
    ...(options.useStableRowIds ? { rowIds: entries.map((row) => row.identity) } : {})
  };
}

async function pageForReport(page, label, expectedReportId, timeout = 90000) {
  const deadline = Date.now() + timeout;
  let clickedRun = false;
  let clickedDetails = false;
  while (Date.now() < deadline) {
    const frame = findReportContentFrame(page.frames(), page.mainFrame(), expectedReportId);
    if (frame) {
      if (!clickedRun) {
        const runReport = frame.getByRole("button", { name: /^Run Report$/i });
        if (await runReport.count() && await runReport.first().isVisible() && await runReport.first().isEnabled()) {
          await runReport.first().click({ timeout: 5000 });
          clickedRun = true;
        }
      }
      const details = frame.getByRole("tab", { name: "Details", exact: true });
      if (!clickedDetails && await details.count() && await details.isVisible() && await details.isEnabled()) {
        await details.click({ timeout: 5000 });
        clickedDetails = true;
      }
      const grid = frame.locator('[role="grid"]').first();
      if (await grid.count() && await grid.isVisible()) {
        const headers = await grid.locator('[role="columnheader"]').count();
        const body = grid.locator(".ReactVirtualized__Grid.table-list-body");
        if (headers > 1 && await body.count() === 1) {
          const expandAll = frame.getByRole("button", { name: "Expand All", exact: true });
          if (await expandAll.count() && await expandAll.isVisible()) {
            await expandAll.click({ timeout: 5000 });
            await frame.getByRole("button", { name: "Collapse All", exact: true }).waitFor({ state: "visible", timeout: 10000 });
          }
          return frame;
        }
      }
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`The ${label} report Details grid did not load. The report layout may have changed, Workfront may be unavailable, or its session may have expired. ${WORKFRONT_LOGIN_HELP}`);
}

function findReportContentFrame(frames, mainFrame, expectedReportId) {
  return frames.find((frame) => frame !== mainFrame && frame.url().includes(`/report/${expectedReportId}/`)) || null;
}

function taskReportPromptMode({ hasPromptsTab, hasPromptFirstControls }) {
  if (hasPromptsTab) return "tabbed";
  if (hasPromptFirstControls) return "prompt-first";
  return null;
}

async function selectTaskDeliveryCentre(frame, panel, input) {
  const centre = "PRD WPP Production";
  await input.fill("");
  // Spectrum opens suggestions on keyboard input; fill() alone can leave the menu closed.
  await input.pressSequentially(centre, { delay: 30 });
  const option = frame.getByRole("option", { name: centre, exact: true }).first();
  try {
    await option.waitFor({ state: "visible", timeout: 15000 });
    await option.click();
  } catch (error) {
    throw new Error("Workfront did not offer the PRD WPP Production delivery-centre prompt value.", { cause: error });
  }
  await input.fill("");
  await panel.locator('[role="gridcell"]').filter({ hasText: /^PRD WPP Production$/ }).waitFor({ state: "visible", timeout: 15000 });
  const selectedValues = await panel.locator('[role="gridcell"]').allInnerTexts();
  if (selectedValues.length !== 1 || selectedValues[0].trim() !== centre) {
    throw new Error("The Workfront task report prompt is not restricted to PRD WPP Production.");
  }
}

async function configurePromptFirstTaskReport(frame) {
  const reportText = await frame.locator("main").innerText();
  if (!/Project[\s\S]*Delivery Centre/i.test(reportText)) {
    throw new Error("The initial Workfront task report does not expose its Project Delivery Centre prompt.");
  }

  const operator = frame.getByRole("button", { name: "-- Any --", exact: true });
  if (await operator.count() !== 1) {
    throw new Error("The initial Workfront task report delivery-centre operator is ambiguous.");
  }
  await operator.click();
  const equalOption = frame.getByRole("option", { name: "Equal", exact: true });
  if (!await equalOption.count()) {
    throw new Error("The initial Workfront task report does not offer an exact-match operator.");
  }
  await equalOption.first().click();

  const input = frame.getByRole("combobox").last();
  if (!await input.count()) {
    throw new Error("The initial Workfront task report delivery-centre value is unavailable.");
  }
  await selectTaskDeliveryCentre(frame, frame, input);
  await frame.getByRole("button", { name: "Run Report", exact: true }).click();
}

async function scrapeReport(page, url, label) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  const expectedReportId = url.match(/\/report\/([^/]+)/)?.[1];
  if (!expectedReportId) throw new Error(`${label} URL does not contain a Workfront report ID.`);
  const frame = await pageForReport(page, label, expectedReportId);
  const grid = frame.locator('[role="grid"]').first();
  const bodyLocator = grid.locator(".ReactVirtualized__Grid.table-list-body");
  if (await bodyLocator.count() !== 1) {
    throw new Error(`The ${label} report grid layout changed; no partial data was imported.`);
  }
  const body = bodyLocator.first();
  return collectVirtualGrid(
    () => frame.evaluate(() => {
      const gridElement = document.querySelector('[role="grid"]');
      const scrollBody = gridElement?.querySelector(".ReactVirtualized__Grid.table-list-body");
      if (!gridElement || !scrollBody) return null;
      const bodyRect = scrollBody.getBoundingClientRect();
      const sourceHeaders = [...gridElement.querySelectorAll('[role="columnheader"]')].map((item) => item.innerText.replace(/\s+/g, " ").trim());
      const projectNameIndex = sourceHeaders.indexOf("Project Name");
      const headers = projectNameIndex >= 0 ? [...sourceHeaders, "Workfront Project URL"] : sourceHeaders;
      const rows = [...scrollBody.querySelectorAll('[role="row"]')].flatMap((row) => {
        if (row.querySelector('[role="columnheader"]')) return [];
        const cells = [...row.querySelectorAll('[role="gridcell"]')];
        if (!cells.length) return [];
        const position = Math.round(row.getBoundingClientRect().top - bodyRect.top + scrollBody.scrollTop);
        const values = cells.map((cell) => cell.innerText.replace(/\s+/g, " ").trim());
        const projectUrl = projectNameIndex >= 0
          ? cells[projectNameIndex]?.querySelector('a[href*="/project/"]')?.href || ""
          : "";
        return [{ position, values: projectNameIndex >= 0 ? [...values, projectUrl] : values }];
      });
      const footer = document.body.innerText.match(/Showing\s+[\d,]+\s+items?/i)?.[0] || "";
      return {
        headers,
        rows,
        scrollTop: scrollBody.scrollTop,
        scrollHeight: scrollBody.scrollHeight,
        clientHeight: scrollBody.clientHeight,
        expectedCount: footer ? Number(footer.match(/[\d,]+/)[0].replaceAll(",", "")) : null
      };
    }),
    (top) => body.evaluate((element, value) => { element.scrollTop = value; }, top),
    () => page.waitForTimeout(40)
  );
}

async function scrapeTaskReport(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  const expectedReportId = url.match(/\/report\/([^/]+)/)?.[1];
  if (!expectedReportId) throw new Error("Workfront task report URL does not contain a report ID.");
  const deadline = Date.now() + 90000;
  let frame;
  let promptMode = null;
  let showFiltersClicked = false;
  while (Date.now() < deadline) {
    frame = findReportContentFrame(page.frames(), page.mainFrame(), expectedReportId);
    if (frame) {
      const hasPromptsTab = await frame.locator('[role="tab"]').filter({ hasText: "Prompts" }).count() > 0;
      const hasPromptFirstControls = await frame.getByRole("heading", { name: "What should we include in your Report?", exact: true }).count() > 0;
      promptMode = taskReportPromptMode({ hasPromptsTab, hasPromptFirstControls });
      if (promptMode) break;

      const showFilters = frame.getByRole("button", { name: /Show Filters and Prompts/i });
      if (!showFiltersClicked && await showFilters.count() && await showFilters.isVisible() && await showFilters.isEnabled()) {
        await showFilters.click({ timeout: 5000 });
        showFiltersClicked = true;
      }
    }
    await page.waitForTimeout(400);
  }
  if (!frame || !promptMode) {
    throw new Error(`The Workfront task report did not expose its prompt controls or report tabs. Workfront may be signed out or the report layout may have changed. ${WORKFRONT_LOGIN_HELP}`);
  }

  let previousRunLabel = "";
  if (promptMode === "prompt-first") {
    await configurePromptFirstTaskReport(frame);
  } else {
    if (!showFiltersClicked) {
      const showFilters = frame.getByRole("button", { name: /Show Filters and Prompts/i });
      if (await showFilters.count()) await showFilters.click({ timeout: 5000 });
    }
    const promptsTab = frame.locator('[role="tab"]').filter({ hasText: "Prompts" });
    await promptsTab.click();
    const promptPanel = frame.getByRole("tabpanel", { name: "Prompts" });
    const panelDeadline = Date.now() + 10000;
    while (Date.now() < panelDeadline && !await promptPanel.count()) await page.waitForTimeout(150);
    if (!await promptPanel.count()) throw new Error("The Workfront task report prompt panel is unavailable.");
    if (!/Delivery Centre/i.test(await promptPanel.innerText())) {
      throw new Error("The Workfront task report does not expose its delivery-centre prompt.");
    }

    for (let index = 0; index < 10; index += 1) {
      const removeButtons = promptPanel.locator('button[aria-label^="Remove"]');
      if (!await removeButtons.count()) break;
      await removeButtons.first().click();
    }
    if (await promptPanel.locator('button[aria-label^="Remove"]').count()) {
      throw new Error("The Workfront task report prompt values could not be reset.");
    }
    const operator = promptPanel.locator("button").filter({ hasText: /^(Equal|Not Equal|Contains|Does Not Contain|Is Blank|Is Not Blank)$/ });
    if (await operator.count() !== 1) throw new Error("The Workfront task report match operator is unavailable.");
    if ((await operator.first().innerText()).trim() !== "Equal") {
      await operator.first().click();
      const equalOption = frame.locator('[role="option"]').filter({ hasText: /^Equal$/ });
      if (!await equalOption.count()) throw new Error("Could not select the exact-match Workfront delivery-centre prompt.");
      await equalOption.first().click();
    }
    const input = promptPanel.locator('input[role="combobox"]').last();
    await selectTaskDeliveryCentre(frame, promptPanel, input);
    previousRunLabel = (await frame.locator("body").innerText()).match(/\bAs of [^\n]+/)?.[0] || "";
    await promptPanel.getByRole("button", { name: "Run Report" }).click();
    const refreshDeadline = Date.now() + 15000;
    let currentRunLabel = "";
    while (Date.now() < refreshDeadline) {
      currentRunLabel = (await frame.locator("body").innerText()).match(/\bAs of [^\n]+/)?.[0] || "";
      if (!previousRunLabel || currentRunLabel && currentRunLabel !== previousRunLabel) break;
      await page.waitForTimeout(300);
    }
    if (previousRunLabel && currentRunLabel === previousRunLabel) {
      throw new Error("The Workfront task report did not refresh after applying its prompt; no partial data was imported.");
    }
  }
  await page.waitForTimeout(500);

  const detailsTab = frame.locator('[role="tab"]').filter({ hasText: "Details" });
  const detailsTabDeadline = Date.now() + 90000;
  while (Date.now() < detailsTabDeadline && !await detailsTab.count()) await page.waitForTimeout(400);
  if (!await detailsTab.count()) throw new Error("The Workfront task report does not expose its detail view after running its prompt.");
  await detailsTab.click();
  const detailPanel = frame.getByRole("tabpanel", { name: "Details" });
  const detailDeadline = Date.now() + 90000;
  let detailGridReady = false;
  while (Date.now() < detailDeadline) {
    const grid = detailPanel.locator('[role="grid"]');
    detailGridReady = await grid.count() > 0 && await grid.locator(".ReactVirtualized__Grid.table-list-body").count() > 0;
    if (detailGridReady) break;
    await page.waitForTimeout(400);
  }
  if (!detailGridReady) {
    throw new Error("The Workfront task detail grid did not load after running its prompt.");
  }

  const expandAll = detailPanel.getByRole("button", { name: "Expand All" });
  if (await expandAll.count()) await expandAll.click();
  const collapseAll = detailPanel.getByRole("button", { name: "Collapse All" });
  await collapseAll.waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(500);
  const grid = detailPanel.locator('[role="grid"]').first();
  const bodyLocator = grid.locator(".ReactVirtualized__Grid.table-list-body");
  if (await bodyLocator.count() !== 1) throw new Error("The Workfront task report grid layout changed; no partial data was imported.");
  const body = bodyLocator.first();
  let expectedCount = null;
  const report = await collectVirtualGrid(
    async () => {
      const snapshot = await frame.evaluate(() => {
      const gridElement = document.querySelector('[role="tabpanel"] [role="grid"]');
      const scrollBody = gridElement?.querySelector(".ReactVirtualized__Grid.table-list-body");
      if (!gridElement || !scrollBody) return null;
      const bodyRect = scrollBody.getBoundingClientRect();
      const sourceHeaders = [...gridElement.querySelectorAll('[role="columnheader"]')].map((item) => item.innerText.replace(/\s+/g, " ").trim());
      const projectNameIndex = sourceHeaders.indexOf("Project: Name");
      const headers = projectNameIndex >= 0 ? [...sourceHeaders, "Workfront Project URL"] : sourceHeaders;
      const rows = [...scrollBody.querySelectorAll('[role="row"]')].flatMap((row) => {
        const cells = [...row.querySelectorAll('[role="gridcell"]')];
        if (cells.length !== sourceHeaders.length) return [];
        const rowId = row.getAttribute("data-row-id");
        const position = Number(row.getAttribute("aria-rowindex"));
        const values = cells.map((cell) => cell.innerText.replace(/\s+/g, " ").trim());
        const projectUrl = projectNameIndex >= 0
          ? cells[projectNameIndex]?.querySelector('a[href*="/project/"]')?.href || ""
          : "";
        return [{
          position: Number.isFinite(position) ? position : Math.round(row.getBoundingClientRect().top - bodyRect.top + scrollBody.scrollTop),
          identity: rowId,
          values: projectNameIndex >= 0 ? [...values, projectUrl] : values
        }];
      });
      const footer = document.body.innerText.match(/Showing\s+[\d,]+\s+items?/i)?.[0] || "";
      return {
        headers,
        rows,
        scrollTop: scrollBody.scrollTop,
        scrollHeight: scrollBody.scrollHeight,
        clientHeight: scrollBody.clientHeight,
        expectedCount: footer ? Number(footer.match(/[\d,]+/)[0].replaceAll(",", "")) : null
      };
      });
      if (snapshot?.expectedCount !== null && snapshot?.expectedCount !== undefined) expectedCount = snapshot.expectedCount;
      return snapshot;
    },
    (top) => body.evaluate((element, value) => { element.scrollTop = value; }, top),
    () => page.waitForTimeout(110),
    { useStableRowIds: true, scrollRatio: 0.5 }
  );
  if (!Number.isInteger(expectedCount) || expectedCount < 0) {
    throw new Error("Workfront did not display an item count for the task report; no partial data was imported.");
  }
  const uniqueIds = new Set(report.rowIds);
  if (uniqueIds.size !== report.rowIds.length) throw new Error("The Workfront task report contains duplicate task IDs; no partial data was imported.");
  return report;
}

async function scrapeWorkfrontReports(reportUrls = DEFAULT_REPORT_URLS, onDetailBatch = null, onProgress = null) {
  if (interactiveLoginContext) throw new Error("Close or finish the Workfront sign-in browser before starting a scrape.");
  for (const [label, url] of Object.entries(reportUrls)) {
    if (!["openProjects", "changeRounds", "tasks"].includes(label) || typeof url !== "string" || !url.startsWith("https://experience.adobe.com/")) {
      throw new Error("Workfront report URLs must use the trusted https://experience.adobe.com/ origin.");
    }
  }
  const context = await chromium.launchPersistentContext(ensureProfileDirectory(), {
    headless: true,
    args: ["--disable-background-networking"]
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    if (onProgress) await onProgress("Reading open projects");
    const openProjects = await scrapeReport(page, reportUrls.openProjects, "All Open Projects");
    if (onProgress) await onProgress("Reading change rounds");
    const changeRounds = await scrapeReport(page, reportUrls.changeRounds, "All Change Rounds");
    if (onProgress) await onProgress("Reading tasks");
    // Reusing the Experience shell can leave the task prompt's suggestion menu closed.
    const taskPage = await context.newPage();
    await page.close();
    const tasks = await scrapeTaskReport(taskPage, reportUrls.tasks);
    if (onProgress) await onProgress("Reading project and task details");
    const reports = { openProjects, changeRounds, tasks };
    await enrichWorkfrontReports(context, reports, onDetailBatch);
    if (reports.detailErrors.length) {
      throw new Error(`Workfront detail scraping was incomplete (${reports.detailErrors.length} failed records). ${reports.detailErrors[0]}`);
    }
    return reports;
  } finally {
    await context.close();
  }
}

function setReportFields(report, index, fields) {
  for (const [header, value] of Object.entries(fields)) {
    let column = report.headers.indexOf(header);
    if (column < 0) {
      column = report.headers.length;
      report.headers.push(header);
      for (const row of report.rows) row.push("");
    }
    report.rows[index][column] = value;
  }
}

async function workfrontDetailFrame(page, url, kind, id) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((item) => item !== page.mainFrame() && item.url().includes(`/${kind}/${id}/`));
    if (frame && await frame.locator(`#header-widget-status`).count()) return frame;
    await page.waitForTimeout(200);
  }
  throw new Error(`Workfront ${kind} ${id} details did not load; no partial data was imported. ${WORKFRONT_LOGIN_HELP}`);
}

async function readDetailFields(frame, project = false) {
  await frame.locator('[data-testid="field-plannedCompletionDate"]').first().waitFor({ state: "visible", timeout: 30000 });
  if (project) await frame.getByRole("button", { name: "Content Studio Project", exact: true }).waitFor({ state: "visible", timeout: 30000 });
  const sections = await frame.locator('button[data-testid^="clickable-"][aria-expanded="false"]').evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-testid")));
  for (const section of sections) {
    const button = frame.locator(`button[data-testid="${section}"]`);
    if (await button.isVisible()) {
      await button.click();
      await frame.page().waitForTimeout(500);
    }
  }
  await frame.page().waitForTimeout(1000);
  return frame.evaluate(() => {
    const fields = {};
    for (const container of document.querySelectorAll('[data-testid="view-mode-container"]')) {
      if (!container.getClientRects().length) continue;
      for (const field of container.querySelectorAll('[data-testid^="field-"]')) {
        const label = field.querySelector("h4, label");
        if (!label) continue;
        const name = label.innerText.trim().replace(/\*$/, "");
        const value = field.innerText.trim().slice(label.innerText.trim().length).trim();
        if (name && (!fields[name] || !Object.hasOwn(fields, name))) fields[name] = ["+Add", "N/A"].includes(value) ? "" : value;
      }
      for (const field of document.querySelectorAll('[data-testid="field-outer-cell"]')) {
        if (!field.getClientRects().length) continue;
        const label = field.querySelector('label[for$="-view"], [data-testid$="-label"]');
        if (!label || !label.getClientRects().length) continue;
        const name = label.innerText.trim().replace(/\*$/, "").trim();
        const value = field.innerText.trim().slice(label.innerText.trim().length).trim();
        const normalized = ["+Add", "N/A"].includes(value) ? "" : value;
        if (name && (normalized || !fields[name])) fields[name] = normalized;
      }
    }
    return fields;
  });
}

async function readSystemActivity(page, frame) {
  const updates = frame.locator('[data-rsp-slot="text"]').filter({ hasText: /^Updates$/ });
  if (!await updates.count()) throw new Error("Workfront Updates navigation is unavailable; no partial data was imported.");
  await updates.first().click();
  const tab = frame.getByRole("tab", { name: "System activity", exact: true });
  await tab.waitFor({ state: "visible", timeout: 30000 });
  await tab.click();
  const activities = frame.locator('[data-testid="activity-layout"]').filter({ hasNotText: /^\s*Update on\b/i });
  await frame.waitForFunction((started) => document.querySelector('[data-testid="activity-layout"]')
    || Date.now() - started >= 5000 && /No (?:system activity|system updates|updates|activity)|There (?:is|are) no (?:system activity|updates|activity)/i.test(document.body.innerText), Date.now(), { timeout: 30000 });
  const latest = activities.first();
  const statusChange = activities.filter({ hasText: /changed (?:the )?status(?:\s+from\b.*?)?\s+to\b/i }).first();
  const timestamp = async (activity) => {
    if (!await activity.count()) return "";
    const date = activity.locator('[data-omega-element="date"]');
    if (!await date.count()) throw new Error("Workfront activity timestamp is unavailable.");
    await date.hover();
    const tooltip = frame.locator('[role="tooltip"][class*="_is-open"]').last();
    await tooltip.waitFor({ state: "visible", timeout: 5000 });
    const text = await tooltip.innerText();
    if (!/\b\d{4}\b/.test(text) || Number.isNaN(new Date(text.replace(" at ", " ")).getTime())) {
      throw new Error("Workfront activity did not expose a complete timestamp with a year; its details were not imported.");
    }

    await page.mouse.move(0, 0);
    return text.replace(" at ", " ");
  };
  return {
    "Latest System Activity": await latest.count() ? (await latest.innerText()).replace(/\s+/g, " ").slice(0, 800) : "",
    "Latest System Activity Date": await timestamp(latest),
    "Last Status Changed": await timestamp(statusChange)
  };
}

async function readUserUpdates(page, frame) {
      const comments = frame.getByRole("tab", { name: "Comments", exact: true });
      if (!await comments.count()) return { "User Updates": "[]", "Updates Read Status": "Comments tab unavailable; audit/bug evidence not verified" };
      await comments.click();
      await page.waitForTimeout(1000);
      const rows = frame.locator('[data-testid="comment-layout"]');
      if (!await rows.count()) {
        const empty = await frame.getByText(/No (?:comments|updates)|Be the first to/i).count();
        return { "User Updates": "[]", "Updates Read Status": empty ? "No comments in loaded Updates" : "Comments layout unavailable; audit/bug evidence not verified" };
      }
      const updates = [];
      for (let index = 0; index < Math.min(await rows.count(), 100); index++) {
        const row = rows.nth(index);
        const content = row.locator('[data-testid="comment-text"]');
        if (!await content.count()) continue;
        const text = (await content.first().innerText()).trim().slice(0, 16000);
        const authorElement = row.locator('[data-testid="comment-author"]');
        const author = await authorElement.count() ? (await authorElement.first().innerText()).trim() : "";
        const dateElement = row.locator('[data-omega-element="date"]');
        let date = "";
        if (await dateElement.count()) {
          await dateElement.first().hover();
          const tooltip = frame.locator('[role="tooltip"][class*="_is-open"]').last();
          if (await tooltip.count()) {
            const value = (await tooltip.innerText()).replace(" at ", " ");
            if (/\b\d{4}\b/.test(value) && Number.isFinite(new Date(value).getTime())) date = new Date(value).toISOString();
          }
          await page.mouse.move(0, 0);
        }
        const id = await row.getAttribute("data-comment-id") || `${index}:${text.slice(0, 80)}`;
        if (text) updates.push({ id, author, date, text });
      }
      return { "User Updates": JSON.stringify(updates), "Updates Read Status": `Loaded comments only (${updates.length}); earlier/paginated updates may be unavailable` };
    }
async function enrichWorkfrontReports(context, reports, onDetailBatch = null) {
  const { openProjects, tasks } = reports;
  reports.detailErrors = [];
  const readWithRetry = async (operation, report, index, label) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await operation();
        setReportFields(report, index, { "Detail Error": "" });
        return result;
      } catch (error) {
        if (/safety limit|10,000-row/.test(error.message)) throw error;
        console.warn(`Workfront ${label} detail read ${attempt + 1}/2 failed: ${error.message}`);
        if (attempt === 0) continue;
        const message = `${label}: ${error.message}`.slice(0, 1000);
        reports.detailErrors.push(message);
        setReportFields(report, index, { "Detail Error": message, "Detail Synced At": "" });
        return null;
      }
    }
  };
  const knownIds = new Set(tasks.rowIds);
  const projects = openProjects.rows.map((row) => Object.fromEntries(openProjects.headers.map((header, index) => [header, row[index]])));
  const assignedProjectRefs = new Set(tasks.rows.map((row) => String(row[tasks.headers.indexOf("Project: Reference Number")]).toLowerCase()));
  const projectOrder = projects.map((_, index) => index).sort((left, right) =>
    Number(assignedProjectRefs.has(String(projects[right]["Reference Number"]).toLowerCase()))
    - Number(assignedProjectRefs.has(String(projects[left]["Reference Number"]).toLowerCase())));
  const enrichTask = async (page, index, parent) => {
    const id = tasks.rowIds[index];
    const url = DEFAULT_REPORT_URLS.tasks.replace(/\/report\/[^/]+\/detail/, `/task/${id}/overview`);
    const frame = await workfrontDetailFrame(page, url, "task", id);
    await frame.locator('[data-testid="view-mode-container"]:visible').first().waitFor({ state: "visible", timeout: 30000 });
    const fields = await readDetailFields(frame);
    let assignments = await frame.locator('#header-widget-assignments [data-testid="avatar"]').evaluateAll((avatars) => avatars.map((avatar) =>
      avatar.querySelector('img')?.alt || avatar.querySelector('[role="img"]')?.getAttribute("aria-label") || ""
    ).filter(Boolean));
    const wrapper = frame.locator('[data-testid="data-test-assignments-wrapper"]');
    let delegations = "Unavailable: assignments and delegations widget was not readable";
    if (await wrapper.count()) {
      await wrapper.click();
      const dialog = frame.locator('[data-testid="assignment-dialog"]');
      await frame.waitForFunction(() => {
        const dialog = document.querySelector('[data-testid="assignment-dialog"]');
        const expected = dialog?.querySelector('#assignment-search-input')?.getAttribute("aria-label")?.match(/(\d+)\s+selected/i);
        return expected && dialog.querySelectorAll('[data-testid="assignment-pill"] [role="option"]').length === Number(expected[1]);
      }, null, { timeout: 15000 });
      assignments = await dialog.locator('[data-testid="assignment-pill"] [role="option"]').evaluateAll((options) => options.map((option) => {
        const name = option.getAttribute("aria-label");
        return option.querySelector('img[src*="/user/avatar"]') ? name : `${name}, Role / team`;
      }));
      await dialog.getByRole("tab", { name: "Delegations", exact: true }).click();
      await page.waitForTimeout(500);
      const content = await dialog.locator('[data-testid="delegations-content"]').innerText();
      delegations = /People delegated to this task will display here/.test(content) ? "" : content.trim();
      await dialog.getByRole("tab", { name: "Assignments", exact: true }).click();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    const activity = await readSystemActivity(page, frame);
    const userUpdates = /^(?:bug fixing|asset audit)$/i.test(tasks.rows[index][tasks.headers.indexOf("Task Name")])
      ? await readUserUpdates(page, frame) : {};
    const statusChangedField = Object.keys(fields).find((key) => key.toLowerCase() === "last status changed");
    if (statusChangedField && fields[statusChangedField]) activity["Last Status Changed"] = fields[statusChangedField];
    for (const required of ["Status", "Planned Completion Date", "Planned Hours"]) {
      if (!Object.hasOwn(fields, required)) throw new Error(`Workfront task ${id} is missing ${required}; its details were not imported.`);
    }
    setReportFields(tasks, index, {
      ...activity, ...userUpdates, "Status": fields.Status, "Assignments": assignments.join("; "), "Delegations": delegations,
      "Planned Start Date": fields["Planned Start Date"] || "",
      "Planned Completion Date": fields["Planned Completion Date"],
      "Actual Completion Date": fields["Actual Completion Date"] || "",
      "Actual Start Date": fields["Actual Start Date"] || "",
      "Entry Date": fields["Entry Date"] || "",
      "Description": fields.Description || "",
      "Planned Hours": fields["Planned Hours"], "Actual Hours": fields["Actual Hours"] || "",
      "Last Update Date": fields["Last Update Date"] || "",
      "Material Expected Delivery Date": fields["Material Expected Delivery Date"] || parent["Material Expected Delivery Date"] || "",
      "Material Date Source": fields["Material Expected Delivery Date"] ? "Task" : "Parent project",
      "Detail Synced At": new Date().toISOString()
    });
  };
  let projectIndex = 0;
  const workers = Array.from({ length: Math.min(DETAIL_CONCURRENCY, projects.length) }, async () => {
    const page = await context.newPage();
    try {
      while (projectIndex < projects.length) {
        const index = projectOrder[projectIndex++];
        const project = projects[index];
        const checked = await readWithRetry(async () => {
        const url = project["Workfront Project URL"];
        if (!url || !/^https:\/\/(?:experience\.adobe\.com|[^/]+\.my\.workfront\.adobe\.com)\//.test(url)) {
          throw new Error(`Workfront project ${project["Reference Number"]} has no readable detail link.`);
        }
        const id = url.match(/\/project\/([A-Za-z0-9_-]+)/)?.[1];
        const projectUrl = DEFAULT_REPORT_URLS.tasks.replace(/\/report\/[^/]+\/detail/, `/project/${id}/tasks`);
        const frame = await workfrontDetailFrame(page, projectUrl, "project", id);
        await frame.locator('[data-rsp-slot="text"]').filter({ hasText: /^Tasks$/ }).first().click();
        await frame.locator('[data-testid="table-container"]').waitFor({ state: "visible", timeout: 30000 });
        await frame.locator(".ReactVirtualized__Grid.table-list-body").waitFor({ state: "visible", timeout: 30000 });
        const expand = frame.getByRole("button", { name: "Expand All", exact: true });
        if (await expand.count() && await expand.isVisible()) await expand.click();
        const collected = await collectVirtualGrid(
          () => frame.evaluate(() => {
            const body = document.querySelector(".ReactVirtualized__Grid.table-list-body");
            if (!body) return null;
            const rows = [...body.querySelectorAll('[role="row"]')].flatMap((row) => {
          const link = row.querySelector('a[href*="/task/"]');
          const name = link?.innerText.trim();
          const id = link?.href.match(/\/task\/([A-Za-z0-9_-]+)/)?.[1];
          if (!id || !name) return [];
          return [{ identity: id, position: row.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop, values: [id, name] }];
            });
            return { headers: ["Task ID", "Task Name"], rows, scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, expectedCount: null };
          }),
          (top) => frame.locator(".ReactVirtualized__Grid.table-list-body").evaluate((element, value) => { element.scrollTop = value; }, top),
          () => page.waitForTimeout(100),
          { useStableRowIds: true }
        );
        const discovered = collected.rows.map(([id, name]) => ({ id, name })).filter((task) => /^(Build|Bug Fixing)$/i.test(task.name));
        for (const task of discovered) {
          if (knownIds.has(task.id)) continue;
          if (tasks.rows.length >= 10000) throw new Error("Workfront task enrichment exceeds the 10,000-row safety limit.");
          knownIds.add(task.id);
          const row = tasks.headers.map((header) => ({
            "Project: Reference Number": project["Reference Number"],
            "Project: Name": project["Project Name"], "Task Name": task.name,
            "Status": "Unverified", "Assignments": "", "Project: Primary Material": project["Primary Material"],
            "Project: Delivery Centre": project["Delivery Centre"], "Workfront Project URL": url
          }[header] || ""));
          tasks.rows.push(row);
          tasks.rowIds.push(task.id);
        }
        await frame.locator('[data-rsp-slot="text"]').filter({ hasText: /^Project Details$/ }).first().click();
        await frame.locator('[data-testid="view-mode-container"]:visible').first().waitFor({ state: "visible", timeout: 30000 });
        const fields = await readDetailFields(frame, true);
        if (!Object.hasOwn(fields, "Planned Completion Date")) throw new Error(`Project ${project["Reference Number"]} planned completion is unavailable.`);
        if (!Object.keys(fields).some((key) => key.toLowerCase() === "priority")) throw new Error(`Project ${project["Reference Number"]} priority is unavailable in Project Details.`);
        const activity = await readSystemActivity(page, frame);
        const userUpdates = await readUserUpdates(page, frame);
        const values = { ...activity, ...userUpdates, Status: fields.Status || project.Status };
        for (const name of ["Planned Completion Date", "Actual Start Date", "Projected Start Date", "Planned Start Date", "Actual Completion Date", "Material Expected Delivery Date", "Last Update Date", "Number of Pages", "Complexity", "Last Status Changed", "Request Type", "Priority", "Project Owner", "Primary Channel", "Country", "Executor name", "Executor 2 Name", "QA Name", "First Round Quality Internal", "Total Number of Errors", "Number of QC Rounds", "Executor QC Score", "Executor 2 QC Score"]) {
          const field = Object.keys(fields).find((key) => key.replace(/\s+/g, "").toLowerCase() === name.replace(/\s+/g, "").toLowerCase());
          if (field && (name !== "Last Status Changed" || fields[field])) values[name] = fields[field];
        }
        values["Material Expected Delivery Date"] ??= "";
        values["Detail Synced At"] = new Date().toISOString();
        setReportFields(openProjects, index, values);
        return values;
        }, openProjects, index, `project ${project["Reference Number"]}`);
        const taskIndices = tasks.rows.flatMap((row, taskIndex) => String(row[tasks.headers.indexOf("Project: Reference Number")]).toLowerCase() === String(project["Reference Number"]).toLowerCase() ? [taskIndex] : []);
        if (checked) {
          for (const taskIndex of taskIndices) await readWithRetry(() => enrichTask(page, taskIndex, { ...project, ...checked }), tasks, taskIndex, `task ${tasks.rowIds[taskIndex]}`);
        }
        if (onDetailBatch) await onDetailBatch({
          totalProjects: projects.length,
          openProjects: { headers: [...openProjects.headers], rows: [[...openProjects.rows[index]]] },
          tasks: { headers: [...tasks.headers], rows: checked ? taskIndices.map((taskIndex) => [...tasks.rows[taskIndex]]) : [], rowIds: checked ? taskIndices.map((taskIndex) => tasks.rowIds[taskIndex]) : [] }
        });
      }
    } finally { await page.close(); }
  });
  await Promise.all(workers);
  const unchecked = tasks.rows.flatMap((row, index) => row[tasks.headers.indexOf("Detail Synced At")] || row[tasks.headers.indexOf("Detail Error")] ? [] : [index]);
  let uncheckedIndex = 0;
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, unchecked.length) }, async () => {
    const page = await context.newPage();
    try {
      while (uncheckedIndex < unchecked.length) {
        const index = unchecked[uncheckedIndex++];
        await readWithRetry(() => enrichTask(page, index, {}), tasks, index, `task ${tasks.rowIds[index]}`);
        if (onDetailBatch) await onDetailBatch({
          totalProjects: projects.length, openProjects: { headers: [], rows: [] },
          tasks: { headers: [...tasks.headers], rows: [[...tasks.rows[index]]], rowIds: [tasks.rowIds[index]] }
        });
      }
    } finally { await page.close(); }
  }));
}

module.exports = {
  DEFAULT_REPORT_URLS,
  closeWorkfrontLogin,
  collectVirtualGrid,
  enrichWorkfrontReports,
  readDetailFields,
  readUserUpdates,
  setReportFields,
  ensureProfileDirectory,
  findReportContentFrame,
  getWorkfrontLoginStatus,
  openWorkfrontLogin,
  pageForReport,
  profileDirectory,
  recordWorkfrontLoginScrapeResult,
  scrapeWorkfrontReports,
  selectTaskDeliveryCentre,
  taskReportPromptMode,
  workfrontLoginIsOpen
};
