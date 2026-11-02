"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("audit SLA separates Pre-Audit at 24 hours from Current asset audits at 4 hours", () => {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: "" });
    return elements.get(selector);
  };
  const context = vm.createContext({ document: { querySelector: element }, URL, console, Intl, Date });
  const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
  vm.runInContext(source.replace(/\nboot\(\);\s*$/, ""), context);
  const now = Date.now();
  context.projects = [
    { ref: "PRE-1", workfrontId: "PRE-1", title: "Pre-audit project", sourceStatus: "Pre-Audit", productionStage: "Awaiting Audit",
      lastUpdateDate: new Date(now - 25 * 60 * 60 * 1000).toISOString(), lastStatusChanged: new Date(now - 2 * 60 * 60 * 1000).toISOString() },
    { ref: "CURRENT-1", workfrontId: "CURRENT-1", title: "Current asset", sourceStatus: "Current", productionStage: "Awaiting Audit",
      lastUpdateDate: new Date(now - 6 * 60 * 60 * 1000).toISOString(), lastStatusChanged: new Date(now - 30 * 60 * 60 * 1000).toISOString() },
    { ref: "ONGOING-1", workfrontId: "ONGOING-1", title: "Audit underway", sourceStatus: "Audit Ongoing", productionStage: "Audit",
      lastStatusChanged: new Date(now - 5 * 60 * 60 * 1000).toISOString() }
  ];
  vm.runInContext("state.workfrontProjects = projects; state.roleCapabilities = { manageAudits: true }; renderAuditSlaQueues();", context);
  const preAudit = element("#audit-preaudit-queue").innerHTML;
  const currentAudit = element("#audit-current-queue").innerHTML;
  assert.match(preAudit, /PRE-1/);
  assert.match(preAudit, /Overdue by 1h/);
  assert.match(preAudit, /Last update/);
  assert.match(preAudit, /data-action="quick-preaudit" data-ref="PRE-1"/);
  assert.doesNotMatch(preAudit, /CURRENT-1|ONGOING-1/);
  assert.match(currentAudit, /CURRENT-1/);
  assert.match(currentAudit, /Overdue by 2h/);
  assert.match(currentAudit, /data-action="quick-current-audit" data-ref="CURRENT-1"/);
  assert.doesNotMatch(currentAudit, /PRE-1|ONGOING-1/);

  let selectedAudit;
  context.openAuditForm = (prefill) => { selectedAudit = prefill; };
  context.setView = () => {};
  context.auditPrefillFromWorkfront = (project) => ({ projectRef: project.ref, auditType: "Pre-Audit" });
  vm.runInContext('startWorkfrontCurrentAudit("CURRENT-1")', context);
  assert.deepEqual(selectedAudit, { projectRef: "CURRENT-1", auditType: "Audit" });
});
