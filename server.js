"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceStore, workspacePaths } = require("./workspace-store");
const { promisify } = require("node:util");
const readXlsxFile = require("read-excel-file/node");
const { effectiveWorkfrontPriority, isGdBannerDesignProject, productionOperations, recordAssignmentNotifications, sourceRemaining, productionType } = require("./production-ops");
const { processAdherence, executionDeliveries, qualityMatrix, hygieneFingerprint } = require("./workflow-reports");
const { qaExecutorName, qaProjectMatch, parseQAWorkbook, qaSourceValidation, qaPublishedRows, qaQualityRows, bugUpdateReport, qualityIdentity } = require("./qa-reports");
const { REPORTING_START, reportingDate, reportingWindow, slaReport, retainReportingHistory, mergeReportingRecord, kpiReport, kpiPeriodReport } = require("./operational-reports");
const { checklistTemplate, checklistWorkbook, roleTemplates } = require("./execution-checklists");
const processAudit = require("./process-audit");
const leadershipReports = require("./leadership-reports");
const { createOutlookNotifier, isWppProductionEmail } = require("./outlook-mail");
const outlookNotifier = createOutlookNotifier({ credentialsFile: process.env.OUTLOOK_CREDENTIALS_FILE || path.join(__dirname, "config", "outlook.local.json") });
const {
  closeWorkfrontLogin,
  getWorkfrontLoginStatus,
  openWorkfrontLogin,
  recordWorkfrontLoginScrapeResult,
  scrapeWorkfrontReports,
  workfrontLoginIsOpen
} = require("./workfront-dom");

const scrypt = promisify(crypto.scrypt);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const { legacyFile: DATA_FILE, databaseFile: SQLITE_FILE } = workspacePaths();
const VALIDATION_2026_MATRIX = require(path.join(ROOT, "config", "aht-validation-2026.json"));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const BODY_LIMIT = 1024 * 1024;
const WORKFRONT_BODY_LIMIT = 24 * 1024 * 1024;
const WORKFRONT_FILE_LIMIT = 8 * 1024 * 1024;
const WORKFRONT_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const WORKFRONT_CHANNELS = ["Banner", "Campaign", "eDetailer", "Email", "Illustration", "iPDF", "Landing Page", "Outbound WhatsApp [Not Yet Launched]", "Poster", "PPT/Gslide", "Print", "Social Media Post", "Video", "Website"];
const TASK_TYPES = [...new Set(["Localization", "New Build", "Adaptation", ...WORKFRONT_CHANNELS, "Email Banner", "Other"])];
const REQUEST_TYPES = ["Standard", "Rush", "Retain"];
const PROJECT_STATUSES = ["Not Started", "In Progress", "In Review", "Completed", "On Hold", "Archived"];
const TASK_CATEGORIES = ["Build", "CR", "Bug Fixing"];
const BUG_SCOPES = ["Build", "CR"];
const COMPLEXITY_LEVELS = ["Low", "Medium", "High"];
const AHT_MATRIX_MINUTE_FIELDS = [
  "pcTriageMinutes", "channelLeadMinutes", "designerMinutes", "buildMinutes",
  "qaLeadMinutes", "qaMinutes", "pcCloseMinutes", "crPcPlusMinutes",
  "crBuildMinutes", "crQaMinutes"
];
const TASK_PRIORITIES = ["Low", "Normal", "High", "Urgent"];
const LEAVE_TYPES = ["Annual leave", "Sick leave", "Personal leave", "Other"];
const HALF_DAY_OPTIONS = ["First half", "Second half"];
const DEFAULT_COMPLEXITY_MULTIPLIERS = { Low: 0.7, Medium: 1, High: 1.5 };
const DEFAULT_START_TIME = "12:30";
const EARLY_START_TIME = "11:30";
const SHIFT_END_TIME = "21:30";
const NEW_SHIFT_END_TIME = "20:30";
const AUDIT_TYPES = ["Pre-Audit", "Audit"];
const AUDIT_STATUSES = ["Pass", "Fail", "Ready with Conditions", "Not Ready", "Pending"];
const PRIORITIES = ["Low", "Normal", "High", "Urgent"];
const PHASES = ["Build", "CR1", "CR2", "Bug Fixing", "Quality Assurance", "Other"];
const FORMATS = ["Print", "iPDF", "Banner", "PPT", "GSlide", "Other"];
const USER_ROLES = ["manager", "teamManager", "leadership", "auditor", "executioner"];
const DEPARTMENTS = [
  { id: "email", name: "Email Team", assetTypes: ["Email", "Campaign", "Landing Page", "eDetailer"] },
  { id: "design", name: "Design Team", assetTypes: ["iPDF", "Print", "PPT/Gslide", "Banner", "Illustration", "Poster", "Social Media Post", "Outbound WhatsApp"] },
  { id: "web", name: "Web Team", assetTypes: ["Website", "Banner HTML"] },
  { id: "video", name: "Video Team", assetTypes: ["Video", "GIF", "Banner-GIF", "Banner-Animated"] },
  { id: "qa", name: "QA", assetTypes: ["All teams' work"] }
];
const DEPARTMENT_IDS = DEPARTMENTS.map((department) => department.id);
const PRODUCTION_TEAMS = [...DEPARTMENTS.map((department) => department.name), "Unassigned"];
const AUDIT_CHANNELS = [...new Set([...WORKFRONT_CHANNELS, "Landing Pages", "PPT", "Gslide", "AEM webpage", "Banner-Static", "Banner-GIF", "Banner-HTML", "Banner-Animated", "Banner-GD"])];
const AUDIT_REQUEST_TYPES = ["New Build", "Localization", "Update/Repurpose"];
const AUDIT_COMPLEXITIES = ["Simple", "Medium", "Complex"];

const initialTeam = [
  "Om Rathore", "Kriti Grover", "Diksha Bajpay", "Ashish Kumar",
  "Sarthak Gupta", "AnkurJyoti Sharma", "Ishita Mishra", "Manas Rawat"
];

const initialMarketMatrix = [
  ["Ghana", "Divya Sharma", "Somenath Roy", "Sandeep Dubey"],
  ["Nigeria", "Divya Sharma", "Somenath Roy", "Sandeep Dubey"],
  ["Algeria", "Shivani Sharma", "Suhail Ansari", "Sandeep Dubey"],
  ["Libya", "Shivani Sharma", "Suhail Ansari", "Sandeep Dubey"],
  ["Morocco", "Shivani Sharma", "Suhail Ansari", "Sandeep Dubey"],
  ["South Africa", "Shivani Sharma", "Suhail Ansari", "Sandeep Dubey"],
  ["Tunisia", "Shivani Sharma", "Suhail Ansari", "Sandeep Dubey"],
  ["Angola", "Suhail Ansari", "Shivani Sharma", "Sandeep Dubey"],
  ["Benin", "Suhail Ansari", "Shivani Sharma", "Sandeep Dubey"],
  ["Congo (RC)", "Suhail Ansari", "Shivani Sharma", "Sandeep Dubey"],
  ["Ivory Coast", "Suhail Ansari", "Shivani Sharma", "Sandeep Dubey"],
  ["Kenya", "Suhail Ansari", "Shivani Sharma", "Sandeep Dubey"],
  ["Mali", "Suhail Ansari", "Shivani Sharma", "Sandeep Dubey"],
  ["Mauritania", "Suhail Ansari", "Shivani Sharma", "Sandeep Dubey"],
  ["Mozambique", "Suhail Ansari", "Shivani Sharma", "Sandeep Dubey"],
  ["Principe", "Suhail Ansari", "Shivani Sharma", "Sandeep Dubey"],
  ["Senegal", "Suhail Ansari", "Shivani Sharma", "Sandeep Dubey"],
  ["Belarus", "Divya Sharma", "Sandeep Dubey", "Somenath Roy"],
  ["Bosnia & Herzegovina", "Divya Sharma", "Sandeep Dubey", "Somenath Roy"],
  ["Georgia", "Divya Sharma", "Sandeep Dubey", "Somenath Roy"],
  ["Albania", "Kamal Das", "Suhail Ansari", "Somenath Roy"],
  ["Kazakhstan", "Kamal Das", "Suhail Ansari", "Somenath Roy"],
  ["Kosovo", "Kamal Das", "Suhail Ansari", "Somenath Roy"],
  ["Mongolia", "Kamal Das", "Suhail Ansari", "Somenath Roy"],
  ["North Macedonia", "Kamal Das", "Suhail Ansari", "Somenath Roy"],
  ["Pakistan", "Kamal Das", "Suhail Ansari", "Somenath Roy"],
  ["Turkmenistan", "Kamal Das", "Suhail Ansari", "Somenath Roy"],
  ["Ukraine", "Kamal Das", "Suhail Ansari", "Somenath Roy"],
  ["Uzbekistan", "Kamal Das", "Suhail Ansari", "Somenath Roy"],
  ["India", "Somenath Roy", "Suhail Ansari", "Kamal Das"],
  ["Montenegro", "Somenath Roy", "Kamal Das", "Sandeep Dubey"],
  ["Serbia", "Somenath Roy", "Kamal Das", "Sandeep Dubey"],
  ["Turkey", "Suhail Ansari", "Somenath Roy", "Divya Sharma"],
  ["Romania", "Divya Sharma", "Kamal Das", "Shivani Sharma"],
  ["Slovakia", "Divya Sharma", "Kamal Das", "Shivani Sharma"],
  ["Belgium (Europe South)", "Divya Sharma", "Kamal Das", "Shivani Sharma"],
  ["Austria", "Kamal Das", "Divya Sharma", "Suhail Ansari"],
  ["Switzerland", "Kamal Das", "Divya Sharma", "Suhail Ansari"],
  ["Israel", "Sandeep Dubey", "Kamal Das", "Divya Sharma"],
  ["Slovenia", "Sandeep Dubey", "Kamal Das", "Divya Sharma"],
  ["Greece", "Somenath Roy", "Sandeep Dubey", "Divya Sharma"],
  ["Portugal", "Somenath Roy", "Sandeep Dubey", "Divya Sharma"],
  ["Hungary", "Somenath Roy", "Kamal Das", "Shivani Sharma"],
  ["Bulgaria", "Suhail Ansari", "Somenath Roy", "Kamal Das"],
  ["Belgium (Europe North)", "Sandeep Dubey", "Somenath Roy", "Kamal Das"],
  ["Ireland", "Sandeep Dubey", "Somenath Roy", "Kamal Das"],
  ["Luxembourg", "Sandeep Dubey", "Somenath Roy", "Kamal Das"],
  ["Netherlands", "Sandeep Dubey", "Somenath Roy", "Kamal Das"],
  ["Poland", "Sandeep Dubey", "Somenath Roy", "Kamal Das"],
  ["Finland", "Sandeep Dubey", "Suhail Ansari", "Divya Sharma"],
  ["Estonia", "Sandeep Dubey", "Somenath Roy", "Shivani Sharma"],
  ["Latvia", "Sandeep Dubey", "Somenath Roy", "Shivani Sharma"],
  ["Lithuania", "Sandeep Dubey", "Somenath Roy", "Shivani Sharma"],
  ["Croatia", "Sandeep Dubey", "Somenath Roy", "Shivani Sharma"],
  ["Czechia", "Suhail Ansari", "Sandeep Dubey", "Shivani Sharma"],
  ["Denmark", "Suhail Ansari", "Sandeep Dubey", "Shivani Sharma"],
  ["Norway", "Suhail Ansari", "Sandeep Dubey", "Shivani Sharma"],
  ["Sweden", "Suhail Ansari", "Sandeep Dubey", "Shivani Sharma"],
  ["Spain", "Sandeep Dubey", "Shivani Sharma", "Suhail Ansari"],
  ["France", "Somenath Roy", "Shivani Sharma", "Suhail Ansari"],
  ["Bahrain", "Suhail Ansari", "Shivani Sharma", "Somenath Roy"],
  ["Egypt", "Suhail Ansari", "Shivani Sharma", "Somenath Roy"],
  ["Iraq", "Suhail Ansari", "Shivani Sharma", "Somenath Roy"],
  ["Jordan", "Suhail Ansari", "Shivani Sharma", "Somenath Roy"],
  ["Kuwait", "Suhail Ansari", "Shivani Sharma", "Somenath Roy"],
  ["Lebanon", "Suhail Ansari", "Shivani Sharma", "Somenath Roy"],
  ["Oman", "Suhail Ansari", "Shivani Sharma", "Somenath Roy"],
  ["Saudi Arabia", "Suhail Ansari", "Shivani Sharma", "Somenath Roy"],
  ["Syrian Arab Republic", "Suhail Ansari", "Shivani Sharma", "Somenath Roy"],
  ["United Arab Emirates", "Suhail Ansari", "Shivani Sharma", "Somenath Roy"],
  ["Qatar", "Suhail Ansari", "Shivani Sharma", "Somenath Roy"],
  ["Onco", "Shivani Sharma", "Kamal Das", "Suhail Ansari"],
  ["Global - No Location (Linda Schuster)", "Shivani Sharma", "Suhail Ansari", "Somenath Roy"],
  ["Global - No Location (Petra Mrtkova)", "Shivani Sharma", "Sandeep Dubey", "Kamal Das"]
].map(([market, primaryDpm, backupDpm, secondaryBackupDpm]) => ({ market, primaryDpm, backupDpm, secondaryBackupDpm }));

const initialHolidays = [
  "2026-01-15", "2026-01-26", "2026-03-04", "2026-04-03",
  "2026-08-26", "2026-09-04", "2026-09-14", "2026-10-02",
  "2026-10-20", "2026-11-09", "2026-11-24", "2026-12-25"
].map((date) => ({ date, name: "" }));

function createInitialData() {
  return {
    version: 1,
    users: [],
    team: initialTeam.map((name) => ({ id: crypto.randomUUID(), name, shiftStart: EARLY_START_TIME, shiftEnd: NEW_SHIFT_END_TIME })),
    projects: [],
    audits: [],
    workLogs: [],
    tasks: [],
    marketMatrix: initialMarketMatrix,
    holidays: initialHolidays,
    leaves: [],
    workfrontProjects: [],
    processAuditReports: [],
    workfrontChangeRounds: [],
    workfrontTasks: [],
    workfrontSync: null,
    workfrontAutomation: {
      enabled: false, status: "idle", intervalMinutes: 15, lastAttemptAt: null,
      lastSuccessAt: null, nextSyncAt: null, lastError: ""
    },
    changeRounds: [],
    ahtMatrixOverrides: {},
    complexityMultipliers: { ...DEFAULT_COMPLEXITY_MULTIPLIERS },
    capacityHoursPerDay: 8
  };
}

function nextBusinessDate(date, holidays, includeCurrent = false) {
  const holidayDates = new Set(holidays.map((holiday) => holiday.date));
  const result = new Date(`${date}T00:00:00Z`);
  if (!includeCurrent) result.setUTCDate(result.getUTCDate() + 1);
  while (result.getUTCDay() === 0 || result.getUTCDay() === 6 || holidayDates.has(result.toISOString().slice(0, 10))) {
    result.setUTCDate(result.getUTCDate() + 1);
  }
  return result.toISOString().slice(0, 10);
}

function leaveDates(leave) {
  const dates = [];
  const current = new Date(`${leave.startDate}T00:00:00Z`);
  const end = new Date(`${leave.endDate}T00:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function scheduleCalendar(assignee) {
  if (!assignee) return data.holidays;
  const dates = new Map(data.holidays.map((holiday) => [holiday.date, holiday]));
  // Half-day leave reduces capacity in reports but does not block the whole day for scheduling.
  for (const leave of (data.leaves || []).filter((item) => item.assignee === assignee && item.status === "Approved" && !item.halfDay)) {
    for (const date of leaveDates(leave)) if (!dates.has(date)) dates.set(date, { date, name: "Team leave" });
  }
  return [...dates.values()];
}

function shiftStartFor(assignee) {
  return data.team.find((member) => member.name === assignee)?.shiftStart || EARLY_START_TIME;
}

function shiftEndFor(assignee) {
  return data.team.find((member) => member.name === assignee)?.shiftEnd || NEW_SHIFT_END_TIME;
}

let data;
let workspaceStore;
let workfrontSyncPromise = null;
let workfrontScheduler = null;
let shuttingDown = false;
const sessions = new Map();
const loginAttempts = new Map();
let setupInProgress = false;

function cleanText(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function requireText(value, label, maxLength = 500) {
  const text = cleanText(value, maxLength);
  if (!text) throw new HttpError(400, `${label} is required.`);
  return text;
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw new HttpError(400, `${label} is not valid.`);
  return value;
}

function positiveNumber(value, label, max = 100000) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > max) throw new HttpError(400, `${label} must be a positive number.`);
  return number;
}

function positiveInteger(value, label, max = 100000) {
  const number = positiveNumber(value, label, max);
  if (!Number.isInteger(number)) throw new HttpError(400, `${label} must be a whole number.`);
  return number;
}

function boundedNumber(value, label, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
  return number;
}

function validDate(value, label, optional = false) {
  const date = cleanText(value, 10);
  if (!date && optional) return "";
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new HttpError(400, `${label} must be a valid date.`);
  }
  return date;
}

function addBusinessDays(date, days, holidays) {
  const holidayDates = new Set(holidays.map((holiday) => holiday.date));
  const result = new Date(`${date}T00:00:00Z`);
  let added = 0;
  while (added < days) {
    result.setUTCDate(result.getUTCDate() + 1);
    const weekday = result.getUTCDay();
    const currentDate = result.toISOString().slice(0, 10);
    if (weekday !== 0 && weekday !== 6 && !holidayDates.has(currentDate)) added += 1;
  }
  return result.toISOString().slice(0, 10);
}

function addBusinessHours(startDate, hours, holidays) {
  const holidayDates = new Set(holidays.map((holiday) => holiday.date));
  const result = new Date(`${startDate}T00:00:00Z`);
  let remaining = hours;
  while (remaining > 0) {
    const date = result.toISOString().slice(0, 10);
    if (result.getUTCDay() !== 0 && result.getUTCDay() !== 6 && !holidayDates.has(date)) remaining -= 8;
    if (remaining > 0) result.setUTCDate(result.getUTCDate() + 1);
  }
  return result.toISOString().slice(0, 10);
}

function calculateTatDays(channel, requestType, complexity, count) {
  const rateChannel = ({
    "Landing Page": "Landing Pages",
    "PPT/Gslide": "PPT",
    Banner: "Banner-Static",
    Campaign: "Banner-Static",
    Illustration: "Banner-Static",
    Poster: "Banner-Static",
    "Social Media Post": "Banner-Static",
    "Outbound WhatsApp [Not Yet Launched]": "Banner-Static",
    Website: "AEM webpage"
  })[channel] || channel;
  const level = ["Simple", "Medium", "Complex"].indexOf(complexity);
  if (level < 0) throw new HttpError(400, "Complexity is not valid.");
  const requestIndex = ["New Build", "Localization", "Update/Repurpose"].indexOf(requestType);
  if (requestIndex < 0) throw new HttpError(400, "Request type is not valid.");
  const byLevel = (simple, medium, complex) => [simple, medium, complex][level];

  if (rateChannel === "Email") {
    const days = requestIndex === 0
      ? byLevel(1, 2, 3)
      : byLevel(1, 1, 2);
    return days + Math.max(0, count - 1);
  }
  if (rateChannel === "Landing Pages") {
    const days = requestIndex === 0
      ? byLevel(2, 3, 4)
      : byLevel(1, 2, 3);
    return days + Math.max(0, count - 1);
  }
  if (["eDetailer", "iPDF", "Print", "PPT", "Gslide"].includes(rateChannel)) {
    let days;
    if (count <= 5) {
      days = requestIndex === 0 ? byLevel(4, 5, 6)
        : requestIndex === 1 ? byLevel(3, 4, 5)
          : byLevel(3, 3, 4);
    } else if (count <= 10) {
      days = requestIndex === 0 ? byLevel(6, 7, 11)
        : requestIndex === 1 ? byLevel(5, 7, 9)
          : byLevel(4, 5, 7);
    } else {
      days = requestIndex === 0 ? byLevel(9, 12, 17)
        : requestIndex === 1 ? byLevel(7, 9, 12)
          : byLevel(6, 8, 10);
      if (count > 25) days += Math.ceil((count - 25) / 2);
    }
    return days;
  }
  if (rateChannel === "AEM webpage") {
    const days = requestIndex === 0
      ? byLevel(1, 2, 5)
      : byLevel(1, 2, 3);
    return count > 3 ? days + Math.ceil((count - 3) / 3) * (requestIndex === 2 ? 1 : 2) : days;
  }
  if (rateChannel.startsWith("Banner-")) {
    const days = requestIndex === 0 ? byLevel(3, 4, 5)
      : requestIndex === 1 ? byLevel(2, 3, 4)
        : byLevel(2, 3, 3);
    return count > 5 ? days + Math.ceil((count - 5) / 2) : days;
  }
  if (rateChannel === "Video") {
    return requestIndex === 0 ? byLevel(4, 6, 9)
      : requestIndex === 1 ? byLevel(3, 5, 8)
        : byLevel(3, 4, 5);
  }
  throw new HttpError(400, "Channel is not valid.");
}

function estimateTat(input) {
  const channel = enumValue(input.channel, AUDIT_CHANNELS, "Channel");
  const requestType = enumValue(input.requestType, AUDIT_REQUEST_TYPES, "Request type");
  const complexity = enumValue(input.complexity, AUDIT_COMPLEXITIES, "Complexity");
  const count = positiveInteger(input.pageCount, "Page / frame count", 100000);
  const startDate = validDate(input.startDate, "Start date");
  const days = calculateTatDays(channel, requestType, complexity, count);
  const rawTime = cleanText(input.startTime, 5);
  if (rawTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(rawTime)) throw new HttpError(400, "Start time must be valid.");
  const startMinutes = rawTime ? Number(rawTime.slice(0, 2)) * 60 + Number(rawTime.slice(3)) : 12 * 60 + 30;
  const etaMinutes = Math.max(12 * 60 + 30, Math.min(21 * 60 + 30, startMinutes));
  const etaTime = `${String(Math.floor(etaMinutes / 60)).padStart(2, "0")}:${String(etaMinutes % 60).padStart(2, "0")}`;
  return {
    tatDays: days,
    calculatedTat: `${days} Business Day(s)`,
    etaDate: addBusinessDays(startDate, days, data.holidays),
    etaTime
  };
}

function normalizeChangeRound(input, currentUser) {
  const projectRef = requireText(input.projectRef, "Project ID", 80);
  const project = data.projects.find((item) => item.ref.toLowerCase() === projectRef.toLowerCase());
  if (!project) throw new HttpError(404, "Project ID was not found.");
  const crId = requireText(input.crId, "Change round ID", 80);
  if (data.changeRounds.some((item) => item.projectId === project.id && item.crId.toLowerCase() === crId.toLowerCase())) {
    throw new HttpError(409, "That change round ID is already recorded for this project.");
  }
  const complexity = enumValue(input.complexity, ["Low", "Medium", "High"], "Complexity");
  const landedDate = validDate(input.landedDate, "Landed date");
  const landedTime = cleanText(input.landedTime, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(landedTime)) throw new HttpError(400, "Landed time must be valid.");
  const etaDate = addBusinessDays(landedDate, complexity === "High" ? 3 : 1, data.holidays);
  return {
    id: crypto.randomUUID(),
    projectId: project.id,
    projectRef: project.ref,
    projectTitle: project.title,
    crId,
    complexity,
    landedDate,
    landedTime,
    etaDate,
    etaTime: landedTime,
    createdBy: currentUser.name,
    createdAt: new Date().toISOString()
  };
}

function normalizeMarketMatrix(input) {
  if (!Array.isArray(input) || input.length > 500) throw new HttpError(400, "Market matrix must contain at most 500 rows.");
  const markets = new Set();
  return input.map((row) => {
    const market = requireText(row.market, "Market name", 120);
    const key = market.toLowerCase();
    if (markets.has(key)) throw new HttpError(409, `Market "${market}" appears more than once.`);
    markets.add(key);
    return {
      market,
      primaryDpm: requireText(row.primaryDpm, "Primary DPM", 100),
      backupDpm: cleanText(row.backupDpm, 100),
      secondaryBackupDpm: cleanText(row.secondaryBackupDpm, 100)
    };
  });
}

function normalizeHolidays(input) {
  if (!Array.isArray(input) || input.length > 500) throw new HttpError(400, "Holiday calendar must contain at most 500 dates.");
  const dates = new Set();
  return input.map((holiday) => {
    const date = validDate(holiday.date, "Holiday date");
    if (dates.has(date)) throw new HttpError(409, `Holiday ${date} appears more than once.`);
    dates.add(date);
    return { date, name: cleanText(holiday.name, 120) };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

function workfrontText(value, limit = 240) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim().slice(0, limit);
}

function workfrontId(value, label) {
  const text = workfrontText(value, 80);
  if (!text) throw new HttpError(400, `${label} is missing from the Workfront report.`);
  return text.replace(/^(\d+)\.0+$/, "$1");
}

function workfrontDate(value) {
  if (!value) return "";
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function workfrontTaskDate(value) {
  const text = workfrontText(value, 40);
  const namedDate = text.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (namedDate) {
    const parsed = new Date(`${namedDate[1]} ${namedDate[2]}, ${namedDate[3]} 12:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
  }
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return workfrontDate(value);
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return "";
  return parsed.toISOString().slice(0, 10);
}

function workfrontDateTime(value) {
  if (!value) return "";
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function workfrontClock(value, fallback = "09:00") {
  if (value instanceof Date) return `${String(value.getUTCHours()).padStart(2, "0")}:${String(value.getUTCMinutes()).padStart(2, "0")}`;
  const text = workfrontText(value, 30);
  const match = text.match(/(?:T|\s)(\d{1,2}):(\d{2})/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : fallback;
}

function workfrontChannel(assetType, title = "") {
  const asset = assetType.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const aliases = new Map([
    ["landing pages", "Landing Page"], ["landing page", "Landing Page"], ["e detailer", "eDetailer"],
    ["ppt", "PPT/Gslide"], ["gslide", "PPT/Gslide"], ["ppt gslide", "PPT/Gslide"],
    ["banner static", "Banner"], ["banner gif", "Banner"], ["banner html", "Banner"], ["banner animated", "Banner"], ["banner gd", "Banner"],
    ["social media", "Social Media Post"], ["social media post", "Social Media Post"],
    ["outbound whatsapp", "Outbound WhatsApp [Not Yet Launched]"], ["whatsapp", "Outbound WhatsApp [Not Yet Launched]"],
    ["gif", "Video"]
  ]);
  if (aliases.has(asset)) return aliases.get(asset);
  const match = WORKFRONT_CHANNELS.find((channel) => channel.toLowerCase() === asset);
  if (match) return match;
  if (asset === "campaign") {
    const context = `${title} ${assetType}`.toLowerCase();
    const detected = WORKFRONT_CHANNELS.find((channel) => channel !== "Campaign" && context.includes(channel.toLowerCase()));
    return detected || "Campaign";
  }
  return assetType || "Unmapped";
}

function workfrontIsCampaignAsset(assetType) {
  return /\bcampaign\b/.test(String(assetType || "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim());
}

function workfrontBannerTeam(text) {
  const normalized = String(text || "").toLowerCase();
  if (/html/.test(normalized)) return "Web Team";
  if (/\b(gifs?|animat\w*)\b/.test(normalized)) return "Video Team";
  return "Design Team";
}

function workfrontAssetTeam(assetType, title = "") {
  const rawAsset = assetType.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (workfrontIsCampaignAsset(rawAsset)) return "Email Team";
  if (/\b(banner gif|banner animated|animated banner|gif banner)\b/.test(rawAsset)) return "Video Team";
  if (/\b(banner html|html banner|banner web)\b/.test(rawAsset)) return "Web Team";
  const channel = workfrontChannel(assetType, title).toLowerCase();
  if (channel === "banner") return workfrontBannerTeam(title.replace(/[_-]+/g, " "));
  if (channel === "video") return "Video Team";
  if (channel === "website") return "Web Team";
  if (["email", "landing page", "edetailer"].includes(channel)) return "Email Team";
  if (WORKFRONT_CHANNELS.some((item) => item.toLowerCase() === channel)) return "Design Team";
  return "Unmapped";
}

function departmentIdForChannel(channel, assetType = "") {
  const text = `${channel || ""} ${assetType || ""}`.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (/\bcampaign\b/.test(text)) return "email";
  if (/\b(video|gif|banner animated|animated banner|banner gif)\b/.test(text)) return "video";
  if (/\b(website|banner html|html banner|banner web)\b/.test(text)) return "web";
  if (/\b(email|landing page|landing pages|edetailer|e detailer)\b/.test(text)) return "email";
  if (/\b(ipdf|print|ppt|gslide|illustration|poster|social media post|whatsapp|banner)\b/.test(text)) return "design";
  return "";
}

function departmentIdForMatrixChannel(channel) {
  const normalized = String(channel || "").trim().toLowerCase();
  if (normalized.startsWith("edetail")) return "email";
  if (normalized.startsWith("ipdf")) return "design";
  if (normalized === "aem webpage") return "web";
  return departmentIdForChannel(channel);
}

function departmentIdForTeam(team) {
  return DEPARTMENTS.find((department) => department.name === team)?.id || "";
}

function validDepartmentIds(input, label = "Team / department") {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > DEPARTMENT_IDS.length || input.some((id) => !DEPARTMENT_IDS.includes(id))) {
    throw new HttpError(400, `${label} selection is not valid.`);
  }
  return [...new Set(input)];
}

function projectDepartmentId(project) {
  if (!project) return "";
  if (DEPARTMENT_IDS.includes(project.productionTeamId)) return project.productionTeamId;
  const source = project.workfrontId && data.workfrontProjects.find((item) => item.workfrontId === project.workfrontId);
  if (source && DEPARTMENT_IDS.includes(source.productionTeamId)) return source.productionTeamId;
  return departmentIdForChannel(project.channel, project.taskType);
}

function userHasDepartment(user, departmentId) {
  return ["manager", "leadership"].includes(user.role)
    || (user.teamIds || []).includes("qa")
    || Boolean(departmentId && (user.teamIds || []).includes(departmentId));
}

function memberHasDepartment(member, departmentId) {
  const account = data.users.find((user) => user.name.toLowerCase() === member.name.toLowerCase());
  const teamIds = member.teamIds || account?.teamIds || [];
  return teamIds.includes("qa") || Boolean(departmentId && teamIds.includes(departmentId));
}

function userCanManageMember(user, member) {
  if (user.role === "manager") return true;
  if (user.role !== "teamManager" || !member) return false;
  return user.teamIds.includes("qa")
    || user.teamIds.some((departmentId) => departmentId !== "qa" && memberHasDepartment(member, departmentId));
}

function userCanAccessProject(user, project) {
  return userHasDepartment(user, projectDepartmentId(project));
}

function requireProjectAccess(user, project) {
  if (!userCanAccessProject(user, project)) {
    throw new HttpError(403, "This project is outside your assigned team / department.");
  }
}

// The Workfront scraper labels every assignee without a profile photo as "Name, Role / team", so only
// pipe-delimited job roles (e.g. "ROC | Developer") and explicit Job Role/Team entries are treated as roles.
function parseWorkfrontAssignments(value) {
  const unique = new Map();
  for (const entry of String(value || "").split(";")) {
    const trimmed = entry.trim();
    if (!trimmed || /,\s*(Job Role|Team)$/i.test(trimmed)) continue;
    const name = trimmed.replace(/,\s*Role \/ team$/i, "").trim();
    if (!name || name.includes("|") || name.toLowerCase() === "unassigned") continue;
    if (!unique.has(name.toLowerCase())) unique.set(name.toLowerCase(), name);
  }
  return [...unique.values()];
}

function workfrontNameKeys(name) {
  const tokens = String(name || "").toLowerCase().replace(/\.[a-z]{1,4}\d+$/, "").split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.length ? [tokens.join(""), [...tokens].sort().join(" ")] : [];
}

function normalizeWorkfrontIds(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[,;\n]/);
  const unique = new Map();
  for (const item of list) {
    const text = cleanText(item, 120);
    if (text && !unique.has(text.toLowerCase())) unique.set(text.toLowerCase(), text);
  }
  if (unique.size > 10) throw new HttpError(400, "Add at most 10 Workfront IDs / names per team member.");
  return [...unique.values()];
}

function rosterNameForWorkfront(name) {
  const exact = String(name || "").trim().toLowerCase();
  if (!exact) return "";
  const aliasMatch = data.team.find((member) => (member.workfrontIds || []).some((id) => id.toLowerCase() === exact));
  if (aliasMatch) return aliasMatch.name;
  const keys = workfrontNameKeys(name);
  const keyMatch = data.team.find((member) => [member.name, ...(member.workfrontIds || [])]
    .some((candidate) => workfrontNameKeys(candidate).some((key) => keys.includes(key))));
  return keyMatch?.name || "";
}

function mappedAssignmentNames(task) {
  const unique = new Map();
  for (const name of task.assignmentNames || []) {
    const mapped = rosterNameForWorkfront(name) || name;
    if (!unique.has(mapped.toLowerCase())) unique.set(mapped.toLowerCase(), mapped);
  }
  return [...unique.values()];
}

function isWorkfrontAssignee(task, name) {
  return mappedAssignmentNames(task).some((item) => item.toLowerCase() === String(name || "").toLowerCase());
}

function requireAssigneeDepartment(assignee, projectDepartment) {
  if (!assignee) return;
  if (!projectDepartment) throw new HttpError(400, "Assign a team / department to this project before assigning production work.");
  const member = data.team.find((item) => item.name === assignee);
  const account = data.users.find((item) => item.name.toLowerCase() === assignee.toLowerCase());
  if (!member || !memberHasDepartment(member, projectDepartment) || account && account.role !== "executioner") {
    throw new HttpError(400, "The assignee must be an executioner / designer assigned to this project's department (or QA).");
  }
}

function workfrontIsTargetDeliveryCentre(deliveryCentre) {
  const normalized = workfrontText(deliveryCentre, 120).trim();
  if (!normalized) return true;
  return normalized.toLocaleLowerCase() === "prd wpp production";
}

function workfrontInitialStage(status) {
  const normalized = status.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (["current", "pre-audit"].includes(normalized)) return "Awaiting Audit";
  if (normalized === "audit ongoing") return "Audit";
  if (normalized === "awaiting execution") return "Awaiting Execution";
  if (normalized === "pre-audit complete") return "Pre-Audit Complete";
  if (normalized === "execution in progress") return "Execution in progress";
  if (normalized === "cr in execution") return "CR in Execution";
  if (["in qc", "assigned to qa", "qa in progress", "execution complete"].includes(normalized)) return "In QC";
  if (["qa completed", "completed", "complete"].includes(normalized)) return "Complete";
  if (normalized === "on hold") return "On Hold";
  if (["in review", "pending review", "cr in review", "cr pending review", "vo in progress"].includes(normalized)) return "Client-side hold";
  if (normalized === "pending clarification") return "Pending Clarification";
  if (normalized === "planning") return "Planning";
  return "Awaiting triage";
}

function workfrontStatusIsClientBlocked(status) {
  return ["in review", "on hold", "pending review", "pre-audit complete", "vo in progress", "cr in review", "cr pending review"]
    .includes(String(status || "").trim().toLocaleLowerCase().replace(/\s+/g, " "));
}

function workfrontCanContinue(project) {
  return !workfrontStatusIsClientBlocked(project.sourceStatus);
}

function workfrontIsQa(status) {
  return /\b(qa|qc)\b|quality assurance/i.test(status);
}

function normalizeWorkfrontProjectUrl(value) {
  const candidate = workfrontText(value, 1000);
  if (!candidate) return "";
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return "";
  }
  const trustedHost = url.hostname === "experience.adobe.com" || url.hostname.endsWith(".my.workfront.adobe.com");
  const route = `${url.pathname}${url.hash}`;
  if (url.protocol !== "https:" || !trustedHost || !/\/project\/[A-Za-z0-9_-]+(?:\/|$|[?#])/i.test(route)) return "";
  return url.href;
}

function workfrontExecutionAssignment(round) {
  const assignee = round.assignee.trim().toLocaleLowerCase();
  const account = data.users.find((user) => user.name.trim().toLocaleLowerCase() === assignee);
  const managerOrAuditor = account && ["manager", "teamManager", "leadership", "auditor"].includes(account.role);
  const sourceStatus = round.sourceStatus.trim().toLocaleLowerCase();
  if (sourceStatus === "assigned to execution") {
    return !assignee || managerOrAuditor ? "Needs executioner assignment" : "Assigned to executioner";
  }
  if (sourceStatus === "new") return !assignee || managerOrAuditor ? "New / not yet assigned" : "New / executioner not confirmed";
  return "Other workflow status";
}

function workfrontCountsBy(items, key) {
  const counts = new Map();
  for (const item of items) {
    const label = key(item) || "Unspecified";
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function workfrontHeaders(sheet, required, label, { allowEmpty = false } = {}) {
  if (!sheet || !Array.isArray(sheet.data) || sheet.data.length < (allowEmpty ? 1 : 2) || !Array.isArray(sheet.data[0])) {
    throw new HttpError(400, `${label} report is empty or unreadable.`);
  }
  const headers = sheet.data[0].map((item) => workfrontText(item, 200));
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length) throw new HttpError(400, `${label} report is missing required columns: ${missing.join(", ")}.`);
  if (sheet.data.length > 10001) throw new HttpError(413, `${label} report exceeds 10,000 rows.`);
  return (row) => {
    const value = (header, occurrence = 0) => {
      let index = -1;
      for (let count = 0; count <= occurrence; count += 1) {
        index = headers.indexOf(header, index + 1);
        if (index < 0) return undefined;
      }
      return row[index];
    };
    return value;
  };
}

async function readWorkbookUpload(upload, label) {
  if (!upload || typeof upload.name !== "string" || !upload.name.toLowerCase().endsWith(".xlsx")) {
    throw new HttpError(400, `${label} must be an .xlsx Workfront export.`);
  }
  const base64 = upload.contentBase64;
  if (typeof base64 !== "string" || base64.length > Math.ceil(WORKFRONT_FILE_LIMIT * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new HttpError(400, `${label} is missing or is not a valid base64 upload.`);
  }
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length || buffer.length > WORKFRONT_FILE_LIMIT || buffer.subarray(0, 2).toString() !== "PK") {
    throw new HttpError(400, `${label} must be a valid XLSX file smaller than 8 MB.`);
  }
  let sheets;
  try {
    sheets = await readXlsxFile(buffer);
  } catch (error) {
    throw new HttpError(400, `${label} could not be read as an XLSX report: ${error.message}`);
  }
  return sheets;
}

async function readWorkfrontUpload(upload, label, requiredHeaders) {
  const sheets = await readWorkbookUpload(upload, label);
  const sheet = sheets[0];
  const valueAt = workfrontHeaders(sheet, requiredHeaders, label);
  const parsedRows = [];
  for (const row of sheet.data.slice(1)) {
    if (!row.some((item) => item !== null && item !== undefined && item !== "")) continue;
    parsedRows.push(valueAt(row));
  }
  return {
    name: path.basename(upload.name).slice(0, 180),
    sheetName: workfrontText(sheet.sheet, 100),
    headers: sheet.data[0].map((item) => workfrontText(item, 200)),
    rawRows: sheet.data.slice(1).filter((row) => row.some((item) => item !== null && item !== undefined && item !== "")),
    rows: parsedRows
  };
}

const WORKFRONT_PROJECT_OPTIONAL_COLUMNS = {
  entryDate: "Entry Date",
  actualStartDate: "Actual Start Date",
  lastUpdateDate: "Last Update Date",
  detailSyncedAt: "Detail Synced At",
  lastStatusChanged: "Last Status Changed",
  latestSystemActivity: "Latest System Activity",
  latestSystemActivityDate: "Latest System Activity Date",
  dueDate: "Planned Completion Date",
  projectedStartDate: "Projected Start Date",
  plannedStartDate: "Planned Start Date",
  actualCompletionDate: "Actual Completion Date",
  materialExpectedDate: "Material Expected Delivery Date",
  pages: "Number of Pages",
  complexity: "Complexity",
  therapeuticArea: "Therapeutic Area",
  workStream: "Work Stream",
  requestType: "Request Type",
  priority: "Priority",
  region: "Calc Region",
  owner: "Owner: Name",
  lem: "LEM",
  bulkRequest: "ROC | Part of Bulk Request?",
  userUpdates: "User Updates",
  updatesStatus: "Updates Read Status",
  executorName: "Executor name", executor2Name: "Executor 2 Name", qaName: "QA Name",
  qaTotalErrors: "Total Number of Errors", qaRounds: "Number of QC Rounds", qaFirstRound: "First Round Quality Internal",
  executorQCScore: "Executor QC Score", executor2QCScore: "Executor 2 QC Score"
};

function sourceUserUpdates(value) {
  if (!value) return [];
  let rows;
  try { rows = JSON.parse(String(value)); } catch { throw new HttpError(400, "Workfront User Updates must be a JSON array of authored updates."); }
  if (!Array.isArray(rows) || rows.length > 100 || rows.some((row) => typeof row.text !== "string" || typeof row.author !== "string")) throw new HttpError(400, "Invalid Workfront User Updates evidence.");
  return rows.map((row, index) => ({ id: workfrontText(row.id || index, 240), text: workfrontText(row.text, 16000),
    author: workfrontText(row.author, 160), date: workfrontDateTime(row.date) }));
}

function mapWorkfrontProjectRow(valueAt, availableHeaders = null) {
  const ref = workfrontId(valueAt("Reference Number"), "Project reference ID");
  const title = requireText(workfrontText(valueAt("Project Name")), "Project name", 240);
  const status = workfrontText(valueAt("Status"), 120);
  const assetType = workfrontText(valueAt("Primary Material"), 100);
  const pages = Number(valueAt("Number of Pages"));
  const project = {
    workfrontId: ref,
    ref,
    title,
    sourceStatus: status,
    workfrontUrl: normalizeWorkfrontProjectUrl(valueAt("Workfront Project URL")),
    assetType,
    channel: workfrontText(valueAt("Primary Channel"), 100) || workfrontChannel(assetType, title),
    deliveryCentre: workfrontText(valueAt("Delivery Centre"), 120),
    workfrontTeam: workfrontAssetTeam(assetType, title),
    productionTeamId: departmentIdForTeam(workfrontAssetTeam(assetType, title)),
    productionStage: workfrontInitialStage(status),
    qaQueue: workfrontIsQa(status),
    entryDate: workfrontDateTime(valueAt("Entry Date")),
    actualStartDate: workfrontDateTime(valueAt("Actual Start Date")),
    userUpdates: sourceUserUpdates(valueAt("User Updates")),
    updatesStatus: workfrontText(valueAt("Updates Read Status"), 300),
    executorName: workfrontText(valueAt("Executor name"), 160),
    executor2Name: workfrontText(valueAt("Executor 2 Name"), 160),
    qaName: workfrontText(valueAt("QA Name"), 160),
    qaTotalErrors: workfrontText(valueAt("Total Number of Errors"), 40),
    qaRounds: workfrontText(valueAt("Number of QC Rounds"), 40),
    qaFirstRound: workfrontText(valueAt("First Round Quality Internal"), 120),
    executorQCScore: workfrontText(valueAt("Executor QC Score"), 120),
    executor2QCScore: workfrontText(valueAt("Executor 2 QC Score"), 120),
    lastUpdateDate: workfrontDateTime(valueAt("Last Update Date")),
    detailSyncedAt: workfrontDateTime(valueAt("Detail Synced At")),
    lastStatusChanged: workfrontDateTime(valueAt("Last Status Changed")),
    latestSystemActivity: workfrontText(valueAt("Latest System Activity"), 1000),
    latestSystemActivityDate: workfrontDateTime(valueAt("Latest System Activity Date")),
    dueDate: (availableHeaders ? workfrontTaskDate : workfrontDate)(valueAt("Planned Completion Date")),
    projectedStartDate: workfrontTaskDate(valueAt("Projected Start Date")),
    plannedStartDate: workfrontTaskDate(valueAt("Planned Start Date")),
    actualCompletionDate: workfrontTaskDate(valueAt("Actual Completion Date")),
    materialExpectedDate: (availableHeaders ? workfrontTaskDate : workfrontDate)(valueAt("Material Expected Delivery Date")),
    pages: Number.isSafeInteger(pages) && pages > 0 ? pages : null,
    complexity: workfrontText(valueAt("Complexity"), 40),
    country: workfrontText(valueAt("Country"), 120),
    therapeuticArea: workfrontText(valueAt("Therapeutic Area"), 120),
    workStream: workfrontText(valueAt("Work Stream"), 100),
    requestType: workfrontText(valueAt("Request Type"), 100),
    priority: workfrontText(valueAt("Priority"), 120),
    region: workfrontText(valueAt("Calc Region"), 100),
    owner: workfrontText(valueAt("Owner: Name"), 120),
    projectOwner: workfrontText(valueAt("Project Owner") || valueAt("Owner: Name"), 120),
    lem: workfrontText(valueAt("LEM"), 120),
    bulkRequest: workfrontText(valueAt("ROC | Part of Bulk Request?"), 20)
  };
  if (availableHeaders) {
    for (const [field, column] of Object.entries(WORKFRONT_PROJECT_OPTIONAL_COLUMNS)) {
      if (!availableHeaders.includes(column)) delete project[field];
    }
  }
  if (!availableHeaders && valueAt("Priority") === undefined) delete project.priority;
  if (valueAt("Detail Error") && !project.priority) delete project.priority;
  return project;
}

function mapWorkfrontChangeRow(valueAt) {
  const projectRef = workfrontId(valueAt("Project Ref #"), "Parent project ID");
  const workfrontRefId = workfrontId(valueAt("Reference Number"), "Change-round reference ID");
  const crId = requireText(workfrontText(valueAt("Name"), 80), "CR ID", 80);
  const title = workfrontText(valueAt("Project Name"), 240);
  const status = workfrontText(valueAt("Status"), 120);
  const assetType = workfrontText(valueAt("Project: Primary Material"), 100);
  return {
    workfrontId: workfrontRefId,
    projectRef,
    title,
    crId,
    assignee: workfrontText(valueAt("Assigned To: Name"), 120),
    issueType: workfrontText(valueAt("ROC | Issue Type"), 100),
    assetType,
    channel: workfrontChannel(assetType, title),
    workfrontTeam: workfrontAssetTeam(assetType, title),
    productionTeamId: departmentIdForTeam(workfrontAssetTeam(assetType, title)),
    qaQueue: workfrontIsQa(status),
    complexity: workfrontText(valueAt("Project: Complexity"), 40),
    country: workfrontText(valueAt("Project: Country"), 120),
    sourceStatus: status,
    workfrontUrl: normalizeWorkfrontProjectUrl(valueAt("Workfront Project URL")),
    entryDate: workfrontDateTime(valueAt("Entry Date")),
    expectedDeliveryDate: workfrontDateTime(valueAt("Change Request Expected Delivery Date")),
    acceptanceDate: workfrontDateTime(valueAt("Change Request Acceptance Date")),
    completionDate: workfrontDateTime(valueAt("Change Request Completion Date") || valueAt("CR Completion Date") || valueAt("Actual Completion Date")),
    deliveryCentre: workfrontText(valueAt("Project: Delivery Centre"), 120),
    enteredBy: workfrontText(valueAt("Entered By: Name"), 120),
    projectOwner: workfrontText(valueAt("Project Owner"), 120),
    materialExpectedDate: workfrontDate(valueAt("Material Expected Delivery Date"))
  };
}

function mapWorkfrontTaskRows(report) {
  if (!report || !Array.isArray(report.headers) || !Array.isArray(report.rows) || !Array.isArray(report.rowIds) || report.rowIds.length !== report.rows.length) {
    throw new HttpError(400, "The Workfront task report is missing stable task IDs; no partial data was imported.");
  }
  if (report.rows.length > 10000) throw new HttpError(413, "The Workfront task report exceeds 10,000 rows.");
  const sheet = { sheet: "Workfront DOM", data: [report.headers, ...report.rows] };
  const valueAt = workfrontHeaders(sheet, [
    "Project: Reference Number", "Project: Name", "Task Name", "Status", "Assignments",
    "Project: Primary Material", "Planned Start Date", "Planned Completion Date",
    "Project: Delivery Centre", "% Complete"
  ], "WPP Production Task Assignment", { allowEmpty: true });
  const taskIds = new Set();
  return report.rows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== report.headers.length) {
      throw new HttpError(400, "A Workfront task row does not match the report columns; no partial data was imported.");
    }
    const taskId = workfrontId(report.rowIds[index], "Workfront task ID");
    if (taskIds.has(taskId)) throw new HttpError(409, `Workfront task ID ${taskId} is repeated in the task report.`);
    taskIds.add(taskId);
    const get = valueAt(row);
    const projectRef = workfrontId(get("Project: Reference Number"), "Parent project ID");
    const projectName = requireText(workfrontText(get("Project: Name"), 240), "Project name", 240);
    const taskName = requireText(workfrontText(get("Task Name"), 240), "Task name", 240);
    const taskStatus = requireText(workfrontText(get("Status"), 120), "Task status", 120);
    const assetType = workfrontText(get("Project: Primary Material"), 100);
    const workfrontTeam = workfrontAssetTeam(assetType, projectName);
    const progressValues = [...workfrontText(get("% Complete"), 60).matchAll(/(\d+(?:\.\d+)?)\s*%/g)]
      .map((match) => Number(match[1]));
    const uniqueProgressValues = [...new Set(progressValues)];
    if (uniqueProgressValues.length > 1 || uniqueProgressValues.some((value) => value < 0 || value > 100)) {
      throw new HttpError(400, `Workfront task ${taskId} has an ambiguous progress value.`);
    }
    return {
      workfrontId: taskId,
      projectRef,
      projectName,
      taskName,
      crId: workfrontText(get("CR ID"), 80),
      taskStatus,
      ...(report.headers.includes("User Updates") ? { userUpdates: sourceUserUpdates(get("User Updates")) } : {}),
      ...(report.headers.includes("Updates Read Status") ? { updatesStatus: workfrontText(get("Updates Read Status"), 300) } : {}),
      ...(report.headers.includes("Description") ? { description: workfrontText(get("Description"), 12000) } : {}),
      ...(report.headers.includes("Actual Start Date") ? { actualStartDate: workfrontDateTime(get("Actual Start Date")) } : {}),
      workfrontUrl: normalizeWorkfrontProjectUrl(get("Workfront Project URL")),
      assignees: workfrontText(get("Assignments"), 300),
      assignmentNames: parseWorkfrontAssignments(workfrontText(get("Assignments"), 1000)),
      delegations: workfrontText(get("Delegations"), 1000),
      plannedHours: workfrontHours(get("Planned Hours")),
      actualHours: workfrontHours(get("Actual Hours")),
      lastStatusChanged: workfrontDateTime(get("Last Status Changed")),
      latestSystemActivity: workfrontText(get("Latest System Activity"), 1000),
      latestSystemActivityDate: workfrontDateTime(get("Latest System Activity Date")),
      materialExpectedDate: workfrontTaskDate(get("Material Expected Delivery Date")),
      materialDateSource: workfrontText(get("Material Date Source"), 40),
      detailSyncedAt: workfrontDateTime(get("Detail Synced At")),
      assetType,
      workfrontTeam,
      productionTeamId: departmentIdForTeam(workfrontTeam),
      qaQueue: workfrontIsQa(taskStatus),
      plannedStartDate: workfrontTaskDate(get("Planned Start Date")),
      plannedCompletionDate: workfrontTaskDate(get("Planned Completion Date")),
      actualCompletionDate: workfrontTaskDate(get("Actual Completion Date")),
      entryDate: workfrontDateTime(get("Entry Date")),
      deliveryCentre: workfrontText(get("Project: Delivery Centre"), 120),
      percentComplete: uniqueProgressValues.length ? uniqueProgressValues[0] : null
    };
  });
}

function workfrontHours(value) {
  const text = workfrontText(value, 80).replaceAll(",", "");
  if (!text) return null;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(?:Hours?|Hrs?)?$/i);
  if (!match) throw new HttpError(400, `Workfront effort value "${text}" is not a readable number of hours.`);
  return Number(match[1]);
}

async function syncWorkfrontReports(input) {
  const [projectsReport, changeRoundsReport] = await Promise.all([
    readWorkfrontUpload(input.openProjects, "All Open Projects", [
      "Reference Number", "Project Name", "Status", "Planned Completion Date",
      "Number of Pages", "Complexity", "Primary Material", "Country", "LEM", "Delivery Centre", "Last Update Date", "Request Type"
    ]),
    readWorkfrontUpload(input.changeRounds, "All Change Rounds", [
      "Project Ref #", "Project Name", "Reference Number", "Name",
      "Assigned To: Name", "Project: Primary Material", "Project: Complexity", "Status", "Project: Delivery Centre"
    ])
  ]);
  return mergeWorkfrontReports(projectsReport, changeRoundsReport);
}

function workfrontGridReport(report, name, label, requiredHeaders) {
  if (!report || !Array.isArray(report.headers) || !Array.isArray(report.rows)) {
    throw new HttpError(400, `${label} report did not return readable grid data.`);
  }
  const sheet = { sheet: "Workfront DOM", data: [report.headers, ...report.rows] };
  const valueAt = workfrontHeaders(sheet, requiredHeaders, label);
  const rows = sheet.data.slice(1).filter((row) => row.some((item) => item !== null && item !== undefined && item !== "")).map(valueAt);
  return { name, sheetName: sheet.sheet, rows, headers: report.headers };
}

function workfrontDomReports(input) {
  const projectReport = input.openProjects && {
    ...input.openProjects,
    headers: input.openProjects.headers?.map((header) => header === "ROC | Request Type" ? "Request Type" : header)
  };
  return {
    projects: workfrontGridReport(projectReport, "WPP Production - Execution - Production Project Manager wise Projects (DOM)", "WPP Production Projects", [
      "Reference Number", "Project Name", "Status", "Primary Material", "Country", "Delivery Centre"
    ]),
    changeRounds: workfrontGridReport(input.changeRounds, "All Change Rounds (DOM)", "All Change Rounds", [
      "Project Ref #", "Project Name", "Reference Number", "Name",
      "Assigned To: Name", "Project: Primary Material", "Project: Complexity", "Status", "Project: Delivery Centre"
    ])
  };
}

async function syncWorkfrontDomReports(input) {
  const reports = workfrontDomReports(input);
  return mergeWorkfrontReports(reports.projects, reports.changeRounds, input.tasks);
}

async function mergeWorkfrontReports(projectsReport, changeRoundsReport, tasksReport) {
  retainReportingHistory(data);
  const projects = projectsReport.rows
    .filter((valueAt) => workfrontIsTargetDeliveryCentre(workfrontText(valueAt("Delivery Centre"), 120)))
    .map((valueAt) => mapWorkfrontProjectRow(valueAt, projectsReport.headers));
  const changeRounds = changeRoundsReport.rows
    .filter((valueAt) => workfrontIsTargetDeliveryCentre(workfrontText(valueAt("Project: Delivery Centre"), 120)))
    .map(mapWorkfrontChangeRow);
  const taskRows = tasksReport ? mapWorkfrontTaskRows(tasksReport) : null;
  const tasks = taskRows?.filter((task) => workfrontIsTargetDeliveryCentre(task.deliveryCentre)) || [];
  const taskProjectUrls = new Map();
  for (const task of tasks) {
    if (task.workfrontUrl && !taskProjectUrls.has(task.projectRef.toLowerCase())) {
      taskProjectUrls.set(task.projectRef.toLowerCase(), task.workfrontUrl);
    }
  }
  for (const project of projects) {
    project.workfrontUrl ||= taskProjectUrls.get(project.ref.toLowerCase()) || "";
  }
  const projectUrls = new Map(projects.map((project) => [project.ref.toLowerCase(), project.workfrontUrl]));
  for (const round of changeRounds) {
    round.workfrontUrl ||= projectUrls.get(round.projectRef.toLowerCase()) || "";
  }
  for (const round of changeRounds) round.executionAssignment = workfrontExecutionAssignment(round);
  const projectIds = new Set();
  for (const project of projects) {
    if (projectIds.has(project.workfrontId)) throw new HttpError(409, `Project ID ${project.workfrontId} is repeated in the open-project report.`);
    projectIds.add(project.workfrontId);
  }
  const changeIds = new Set();
  const changeKeys = new Set();
  for (const round of changeRounds) {
    const key = `${round.projectRef.toLowerCase()}\u0000${round.crId.toLowerCase()}`;
    if (changeIds.has(round.workfrontId)) throw new HttpError(409, `Workfront CR record ID ${round.workfrontId} is repeated in the change-round report.`);
    if (changeKeys.has(key)) throw new HttpError(409, `CR ID ${round.crId} is repeated for project ${round.projectRef} in the change-round report.`);
    changeIds.add(round.workfrontId);
    changeKeys.add(key);
  }
  const taskIds = new Set();
  for (const task of tasks) {
    if (taskIds.has(task.workfrontId)) throw new HttpError(409, `Workfront task ID ${task.workfrontId} is repeated in the task report.`);
    taskIds.add(task.workfrontId);
  }

  const workspaceChangeKeys = new Set((data.changeRounds || []).map((round) => `${round.projectRef.toLowerCase()}\u0000${round.crId.toLowerCase()}`));
  const previousProjects = data.workfrontProjects || [];
  const previousRounds = data.workfrontChangeRounds || [];
  const previousTasks = data.workfrontTasks || [];
  const nextProjects = [];
  const nextRounds = [];
  const nextTasks = [];
  const projectCounts = { total: projects.length, excludedDeliveryCentre: projectsReport.rows.length - projects.length, added: 0, updated: 0, alreadyInWorkspace: 0 };
  const changeCounts = { total: changeRounds.length, excludedDeliveryCentre: changeRoundsReport.rows.length - changeRounds.length, added: 0, updated: 0, alreadyInWorkspace: 0 };
  const taskCounts = tasksReport ? { total: tasks.length, excludedDeliveryCentre: taskRows.length - tasks.length, added: 0, updated: 0 } : null;

  for (const project of projects) {
    const existing = previousProjects.find((item) => item.workfrontId === project.workfrontId);
    const nativeProject = data.projects.find((item) => item.ref.toLowerCase() === project.ref.toLowerCase());
    if (nativeProject && nativeProject.workfrontId !== project.workfrontId) {
      projectCounts.alreadyInWorkspace += 1;
      continue;
    }
    const merged = {
      ...existing,
      ...project,
      workfrontUrl: project.workfrontUrl || existing?.workfrontUrl || "",
      id: existing?.id || crypto.randomUUID()
    };
    if (existing && existing.sourceStatus === project.sourceStatus) merged.productionStage = existing.productionStage || project.productionStage;
    if (nativeProject) merged.productionStage = nativeProject.productionStage || merged.productionStage;
    nextProjects.push(merged);
    projectCounts[existing ? "updated" : "added"] += 1;
  }
  for (const round of changeRounds) {
    const duplicateKey = `${round.projectRef.toLowerCase()}\u0000${round.crId.toLowerCase()}`;
    if (workspaceChangeKeys.has(duplicateKey)) {
      changeCounts.alreadyInWorkspace += 1;
      continue;
    }
    const existing = previousRounds.find((item) => item.workfrontId === round.workfrontId);
    nextRounds.push({
      ...existing,
      ...round,
      workfrontUrl: round.workfrontUrl || existing?.workfrontUrl || "",
      id: existing?.id || crypto.randomUUID()
    });
    changeCounts[existing ? "updated" : "added"] += 1;
  }
  if (tasksReport) {
    for (const task of tasks) {
      const existing = previousTasks.find((item) => item.workfrontId === task.workfrontId);
      nextTasks.push({
        ...existing,
        ...task,
        workfrontUrl: task.workfrontUrl || existing?.workfrontUrl || "",
        id: existing?.id || crypto.randomUUID()
      });
      taskCounts[existing ? "updated" : "added"] += 1;
    }
  } else {
    nextTasks.push(...previousTasks);
  }
  const departments = Object.fromEntries(workfrontCountsBy(projects, (project) => project.workfrontTeam).map(({ label, count }) => [label, count]));
  const qaProjects = projects.filter((project) => project.qaQueue).length;
  const qaRounds = changeRounds.filter((round) => round.qaQueue).length;
  const projectStatusCounts = workfrontCountsBy(projects, (project) => project.sourceStatus);
  const projectTeamStatusCounts = workfrontCountsBy(projects, (project) => `${project.workfrontTeam} · ${project.sourceStatus}`);
  const changeRoundStatusCounts = workfrontCountsBy(changeRounds, (round) => round.sourceStatus);
  const changeRoundExecutionCounts = workfrontCountsBy(changeRounds, (round) => round.executionAssignment);
  const currentProjectRefs = nextProjects.filter((project) => project.productionStage === "Awaiting Audit").map((project) => project.ref);
  const knownProjectRefs = new Set([
    ...data.projects.map((project) => project.ref.toLowerCase()),
    ...projects.map((project) => project.ref.toLowerCase())
  ]);
  const changeRoundsWithoutProject = changeRounds.filter((round) => !knownProjectRefs.has(round.projectRef.toLowerCase())).length;
  const syncedAt = new Date().toISOString();
  const summary = {
    syncedAt,
    openProjectsFile: projectsReport.name,
    changeRoundsFile: changeRoundsReport.name,
    projectSheet: projectsReport.sheetName,
    changeRoundsSheet: changeRoundsReport.sheetName,
    projects: projectCounts,
    changeRounds: changeCounts,
    projectDepartments: departments,
    projectStatusCounts,
    projectTeamStatusCounts,
    changeRoundStatusCounts,
    changeRoundExecutionCounts,
    tasks: taskCounts || data.workfrontSync?.tasks || { total: nextTasks.length },
    taskSyncedAt: tasksReport ? syncedAt : data.workfrontSync?.taskSyncedAt || null,
    currentProjectRefs,
    projectProductionStageCounts: workfrontCountsBy(nextProjects, (project) => project.productionStage),
    projectSourceStatuses: [...new Set(projects.map((project) => project.sourceStatus).filter(Boolean))].sort(),
    changeRoundSourceStatuses: [...new Set(changeRounds.map((round) => round.sourceStatus).filter(Boolean))].sort(),
    projectsInQa: qaProjects,
    changeRoundsInQa: qaRounds,
    changeRoundsWithoutProject
  };
  if (projectsReport.headers) {
    summary.projectMissingColumns = Object.values(WORKFRONT_PROJECT_OPTIONAL_COLUMNS)
      .filter((column) => !projectsReport.headers.includes(column));
  }
  data.workfrontProjects = nextProjects;
  data.workfrontChangeRounds = nextRounds;
  data.workfrontTasks = nextTasks;
  data.workfrontSync = summary;
  await persist();
  return summary;
}

function publicWorkfrontAutomation() {
  const automation = data.workfrontAutomation || {};
  return {
    enabled: automation.enabled === true,
    status: automation.status || "idle",
    intervalMinutes: 15,
    lastAttemptAt: automation.lastAttemptAt || null,
    lastSuccessAt: automation.lastSuccessAt || null,
    nextSyncAt: automation.enabled ? automation.nextSyncAt || null : null,
    lastError: automation.lastError || "",
    phase: automation.phase || "",
    detailsCompleted: automation.detailsCompleted || 0,
    detailsTotal: automation.detailsTotal || 0
  };
}

async function applyWorkfrontDetailBatch(batch) {
  const row = batch.openProjects.rows[0];
  if (row) {
    const project = mapWorkfrontProjectRow((header) => row[batch.openProjects.headers.indexOf(header)], batch.openProjects.headers);
    const current = data.workfrontProjects.find((item) => item.ref.toLowerCase() === project.ref.toLowerCase());
    if (current) {
      if (String(current.sourceStatus).trim().toLowerCase() !== String(project.sourceStatus).trim().toLowerCase()) {
        current.productionStage = project.productionStage;
        current.qaQueue = project.qaQueue;
      }
      current.sourceStatus = project.sourceStatus;
      for (const field of ["dueDate", "actualStartDate", "projectedStartDate", "plannedStartDate", "actualCompletionDate", "materialExpectedDate", "lastStatusChanged", "latestSystemActivity", "latestSystemActivityDate", "lastUpdateDate", "pages", "complexity", "detailSyncedAt", "priority", "requestType", "projectOwner", "channel", "country", "userUpdates", "updatesStatus", "executorName", "executor2Name", "qaName", "qaTotalErrors", "qaRounds", "qaFirstRound", "executorQCScore", "executor2QCScore"]) {
        if (Object.hasOwn(project, field)) current[field] = project[field];
      }
    }
  }
  for (const task of mapWorkfrontTaskRows(batch.tasks)) {
    if (task.deliveryCentre !== "PRD WPP Production") continue;
    const existing = data.workfrontTasks.find((item) => item.workfrontId === task.workfrontId);
    if (existing) Object.assign(existing, task);
    else data.workfrontTasks.push({ ...task, id: crypto.randomUUID() });
  }
  data.workfrontAutomation.detailsCompleted = (data.workfrontAutomation.detailsCompleted || 0) + (row ? 1 : 0);
  data.workfrontAutomation.detailsTotal = batch.totalProjects;
  await persist();
}

function withWorkfrontSync(operation) {
  if (workfrontSyncPromise) throw new HttpError(409, "A Workfront sync is already running.");
  const running = Promise.resolve().then(operation);
  workfrontSyncPromise = running;
  return running.finally(() => {
    if (workfrontSyncPromise === running) workfrontSyncPromise = null;
  });
}

async function runWorkfrontDomSync() {
  try {
    if (workfrontLoginIsOpen()) throw new HttpError(409, "Finish or cancel the open Workfront sign-in before scraping.");
    return await withWorkfrontSync(async () => {
      const attemptedAt = new Date().toISOString();
      data.workfrontAutomation = {
        ...data.workfrontAutomation,
        status: "syncing",
        lastAttemptAt: attemptedAt,
        lastError: "",
        phase: "Starting browser",
        detailsCompleted: 0,
        detailsTotal: 0,
        nextSyncAt: null
      };
      if (workfrontScheduler) clearTimeout(workfrontScheduler);
      workfrontScheduler = null;
      await persist();
      try {
        const reports = await scrapeWorkfrontReports(undefined, applyWorkfrontDetailBatch, async (phase) => {
          data.workfrontAutomation.phase = phase;
          await persist();
        });
        const summary = await syncWorkfrontDomReports(reports);
        data.workfrontAutomation = {
          ...data.workfrontAutomation,
          status: "success",
          phase: "",
          lastSuccessAt: summary.syncedAt,
          nextSyncAt: data.workfrontAutomation.enabled ? data.workfrontAutomation.nextSyncAt : null,
          lastError: ""
        };
        await persist();
        return summary;
      } catch (error) {
        data.workfrontAutomation = {
          ...data.workfrontAutomation,
          status: "error",
          phase: "",
          nextSyncAt: data.workfrontAutomation.enabled ? data.workfrontAutomation.nextSyncAt : null,
          lastError: String(error.message || "Workfront DOM sync failed.").slice(0, 500)
        };
        await persist();
        throw error;
      }
    });
  } finally {
    if (!workfrontSyncPromise && (!data.workfrontAutomation?.enabled || !workfrontScheduler)) scheduleWorkfrontSync();
  }
}

function scheduleWorkfrontSync(delay = WORKFRONT_SYNC_INTERVAL_MS) {
  if (workfrontScheduler) clearTimeout(workfrontScheduler);
  workfrontScheduler = null;
  if (shuttingDown) return;
  if (!data.workfrontAutomation?.enabled) return;
  workfrontScheduler = setTimeout(() => {
    workfrontScheduler = null;
    runWorkfrontDomSync().catch((error) => console.error("Scheduled Workfront sync failed:", error.message));
  }, delay);
  workfrontScheduler.unref();
  data.workfrontAutomation.nextSyncAt = new Date(Date.now() + delay).toISOString();
  persist().catch((error) => console.error("Could not save the next Workfront sync time:", error.message));
}

function startWorkfrontScheduler() {
  if (data.workfrontAutomation?.enabled) {
    scheduleWorkfrontSync(1000);
  }
}

function normalizeLeave(input, currentUser) {
  const requestedAssignee = cleanText(input.assignee, 100);
  const canManageLeave = ["manager", "teamManager"].includes(currentUser.role);
  if (!canManageLeave && requestedAssignee && requestedAssignee.toLowerCase() !== currentUser.name.toLowerCase()) {
    throw new HttpError(403, "You can only request leave for yourself.");
  }
  const assignee = canManageLeave && requestedAssignee ? requireText(requestedAssignee, "Team member", 100) : currentUser.name;
  const member = data.team.find((item) => item.name === assignee);
  if (!member) throw new HttpError(400, "Team member is not in the roster.");
  if (currentUser.role === "teamManager" && !userCanManageMember(currentUser, member)) {
    throw new HttpError(403, "You can only request leave for members in your assigned team / department.");
  }
  const startDate = validDate(input.startDate, "Leave start date");
  const endDate = validDate(input.endDate, "Leave end date");
  if (endDate < startDate) throw new HttpError(400, "Leave end date cannot be before the start date.");
  const duration = (new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`)) / 86400000;
  if (duration > 365) throw new HttpError(400, "A leave entry cannot exceed 366 calendar days.");
  const halfDay = input.halfDay ? enumValue(input.halfDay, HALF_DAY_OPTIONS, "Half-day leave") : "";
  if (halfDay && endDate !== startDate) throw new HttpError(400, "Half-day leave must start and end on the same date.");
  // Two half-days on the same date (first + second half) may coexist; anything else overlapping conflicts.
  if ((data.leaves || []).some((leave) => leave.assignee === assignee && leave.status !== "Declined" && startDate <= leave.endDate && endDate >= leave.startDate
    && !(halfDay && leave.halfDay && leave.halfDay !== halfDay))) {
    throw new HttpError(409, "This leave request overlaps another pending or approved entry.");
  }
  return {
    id: crypto.randomUUID(),
    assignee,
    startDate,
    endDate,
    type: enumValue(input.type, LEAVE_TYPES, "Leave type"),
    halfDay,
    note: cleanText(input.note, 500),
    createdBy: currentUser.name,
    status: "Pending",
    requestedAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
}

function publicLeave(leave, user) {
  if (["manager", "teamManager"].includes(user.role)) return leave;
  if (leave.status !== "Approved" && leave.assignee.toLowerCase() !== user.name.toLowerCase()) return null;
  if (leave.assignee.toLowerCase() === user.name.toLowerCase() && leave.status !== "Approved") {
    return { id: leave.id, assignee: leave.assignee, startDate: leave.startDate, endDate: leave.endDate, type: leave.type, halfDay: leave.halfDay || "", status: leave.status };
  }
  return { id: leave.id, assignee: leave.assignee, startDate: leave.startDate, endDate: leave.endDate, type: "Away", halfDay: leave.halfDay || "", status: leave.status };
}

function normalizeProject(input, existing = {}) {
  const ref = requireText(input.ref, "Project reference", 80);
  const title = requireText(input.title, "Project title", 240);
  const pages = positiveNumber(input.pages, "Page count", 100000);
  const progress = boundedNumber(input.progress, "Progress", 0, 100);
  const complexity = boundedNumber(input.complexity ?? 1, "Complexity", 0.1, 10);
  const assignee = cleanText(input.assignee, 100);
  if (assignee && !data.team.some((member) => member.name === assignee)) throw new HttpError(400, "Assignee is not in the team roster.");
  const taskType = enumValue(input.taskType, TASK_TYPES, "Task type");
  const requestedTeam = cleanText(input.productionTeamId || existing.productionTeamId, 40);
  const inferredTeam = String(input.channel || "").trim().toLowerCase() === "banner"
    ? departmentIdForTeam(workfrontBannerTeam(`${title} ${taskType}`.replace(/[_-]+/g, " ")))
    : departmentIdForChannel(input.channel, taskType);
  const productionTeamId = requestedTeam
    ? enumValue(requestedTeam, [...DEPARTMENT_IDS, "unassigned"], "Production department")
    : inferredTeam || "unassigned";
  const requestType = enumValue(input.requestType, REQUEST_TYPES, "Request type");
  let status = enumValue(input.status, PROJECT_STATUSES, "Project status");
  if (progress === 100 && status !== "Archived" && status !== "On Hold") status = "Completed";
  if (status === "Completed" && progress < 100) throw new HttpError(400, "Completed projects must have 100% progress.");
  return {
    ...existing,
    ref, title,
    market: cleanText(input.market, 100),
    channel: cleanText(input.channel, 100),
    workfrontRequestType: cleanText(input.workfrontRequestType ?? existing.workfrontRequestType, 100),
    productionTeamId,
    assignee, taskType, requestType, pages, complexity, progress, status,
    tatDate: validDate(input.tatDate, "Turnaround date", true),
    dueDate: validDate(input.dueDate, "Due date"),
    plannedHours: existing.plannedHours || 0,
    plannedStartDate: existing.plannedStartDate || "",
    plannedEndDate: existing.plannedEndDate || "",
    notes: cleanText(input.notes, 2000),
    updatedAt: new Date().toISOString()
  };
}

function normalizeClock(value, label, fallback = "") {
  const time = cleanText(value, 5) || fallback;
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, `${label} must be a valid time.`);
  return time;
}

function scheduledFinish(startDate, startTime, plannedHours, holidays = data.holidays, assignee = "") {
  const start = new Date(`${startDate}T${startTime}:00Z`);
  let remaining = plannedHours;
  let date = startDate;
  let time = startTime;
  while (remaining > 0) {
    const minuteOfDay = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
    const shiftEnd = shiftEndFor(assignee);
    const endMinutes = Number(shiftEnd.slice(0, 2)) * 60 + Number(shiftEnd.slice(3));
    const dailyHours = Math.max(0, Math.min(8, (endMinutes - minuteOfDay) / 60));
    if (dailyHours > 0) {
      remaining -= dailyHours;
      if (remaining <= 0) {
        const endMinute = minuteOfDay + Math.round((dailyHours + remaining) * 60);
        return { date, time: `${String(Math.floor(endMinute / 60)).padStart(2, "0")}:${String(endMinute % 60).padStart(2, "0")}` };
      }
    }
    date = nextBusinessDate(date, holidays);
    time = shiftStartFor(assignee);
  }
  return { date: start.toISOString().slice(0, 10), time: startTime };
}

// Bug fixing is sized as a share of the project's Build effort (10-15%); 15% is the upper bound.
const BUG_FIX_EFFORT_SHARE = 0.15;

function bugFixEffortHours(ownHours, buildHours) {
  const cap = Number(buildHours) > 0 ? Number(buildHours) * BUG_FIX_EFFORT_SHARE : null;
  if (cap === null) return ownHours ?? null;
  return Number(Math.min(ownHours ?? cap, cap).toFixed(2));
}

// Campaigns have no AHT matrix row; the agreed end-to-end SLA (build through QA) is a flat 4 hours per campaign.
const CAMPAIGN_END_TO_END_HOURS = 4;

function validationMatrixEstimate(taskType, requestType, complexity, units, taskCategory, bugScope) {
  if (workfrontIsCampaignAsset(taskType)) {
    return { productionHours: CAMPAIGN_END_TO_END_HOURS, qaHours: 0, ahtHoursPerUnit: CAMPAIGN_END_TO_END_HOURS, matrixRowNumber: null, matrixAddOnRowNumber: null, source: "Campaign end-to-end SLA (4 hrs)" };
  }
  const channelAliases = {
    email: ["Email"],
    "landing page": ["Landing Pages"],
    "landing pages": ["Landing Pages"],
    edetailer: ["eDetail(1 - 5 pages)", "eDetail(6 - 10 pages)", "eDetail (11 - 25 pages)"],
    website: ["AEM webpage"],
    "aem webpage": ["AEM webpage"],
    banner: ["Banners Static / 3D packshot / Social Media Post"],
    "social media post": ["Banners Static / 3D packshot / Social Media Post"],
    video: ["Video"],
    ipdf: ["iPDF (1 - 5 pages)", "iPDF (6 - 10 pages)", "iPDF(11 - 25 pages)"],
    print: ["Print"]
  };
  const assetKey = String(taskType || "").trim().toLowerCase();
  const channels = channelAliases[/^(ppt|gslide|gslides|ppt\/gslide|ppt\/gslides|powerpoint|google slides)$/.test(assetKey) ? "ipdf" : assetKey];
  if (!channels) return null;

  const normalizedRequest = String(requestType || "").trim().toLowerCase();
  const requestTypes = normalizedRequest === "new build"
    ? ["New Build"]
    : normalizedRequest.includes("local")
      ? ["Localization/Updates", "Updates", "Update"]
      : normalizedRequest.includes("update")
        ? ["Updates", "Update", "Localization/Updates"]
        : [];
  if (!requestTypes.length) return null;

  const matrix = getValidationMatrixData();
  const normalizedComplexity = String(complexity || "").trim().toLowerCase();
  const targetComplexity = normalizedComplexity === "low" || normalizedComplexity === "simple" ? "Simple"
    : normalizedComplexity === "high" || normalizedComplexity === "complex" ? "Complex" : "Medium";
  const ranks = { Simple: 0, Medium: 1, Complex: 2 };
  const channelRecords = matrix.records.filter((record) => channels.includes(record.channel));
  const matchedRequest = requestTypes.find((candidate) => channelRecords.some((record) => record.requestType === candidate));
  if (!matchedRequest) return null;
  const requestRecords = channelRecords.filter((record) => record.requestType === matchedRequest);
  const nearestComplexityDistance = Math.min(...requestRecords.map((record) => Math.abs(ranks[record.complexity] - ranks[targetComplexity])));
  const complexityRecords = requestRecords.filter((record) => Math.abs(ranks[record.complexity] - ranks[targetComplexity]) === nearestComplexityDistance);
  const unitCount = Number(units);
  const distanceFromBand = (record) => unitCount < record.min ? record.min - unitCount : unitCount > record.max ? unitCount - record.max : 0;
  const base = [...complexityRecords].sort((a, b) =>
    distanceFromBand(a) - distanceFromBand(b)
      || (a.max - a.min) - (b.max - b.min)
      || a.rowNumber - b.rowNumber
  )[0];
  if (!base) return null;

  const crTask = taskCategory === "CR" || taskCategory === "Bug Fixing" && bugScope === "CR";
  const minutesFor = (record) => crTask
    ? Number(record.crBuildMinutes || 0)
    : Number(record.designerMinutes || 0) + Number(record.buildMinutes || 0);
  const qaMinutesFor = (record) => crTask ? Number(record.crQaMinutes || 0) : Number(record.qaLeadMinutes || 0) + Number(record.qaMinutes || 0);
  const baseMinutes = minutesFor(base);
  if (!Number.isFinite(baseMinutes) || baseMinutes <= 0) return null;
  let productionMinutes = baseMinutes;
  let qaMinutes = qaMinutesFor(base);
  let auditMinutes = Number(base.channelLeadMinutes || 0);
  let addOnRowNumber = null;
  if (unitCount > base.max) {
    const addOn = matrix.addOns.find((record) => record.channel === base.channel && record.requestType === base.requestType);
    const addOnMinutes = addOn ? minutesFor(addOn) : 0;
    if (addOnMinutes > 0) {
      productionMinutes += Math.ceil((unitCount - base.max) / addOn.additionalUnits) * addOnMinutes;
      auditMinutes += Math.ceil((unitCount - base.max) / addOn.additionalUnits) * Number(addOn.channelLeadMinutes || 0);
      qaMinutes += Math.ceil((unitCount - base.max) / addOn.additionalUnits) * qaMinutesFor(addOn);
      addOnRowNumber = addOn.rowNumber;
    } else {
      productionMinutes *= unitCount / Math.max(1, base.max);
      auditMinutes *= unitCount / Math.max(1, base.max);
      qaMinutes *= unitCount / Math.max(1, base.max);
    }
  }
  const matrixComplexityMultiplier = {
    Simple: Number(data.complexityMultipliers?.Low || DEFAULT_COMPLEXITY_MULTIPLIERS.Low),
    Medium: Number(data.complexityMultipliers?.Medium || DEFAULT_COMPLEXITY_MULTIPLIERS.Medium),
    Complex: Number(data.complexityMultipliers?.High || DEFAULT_COMPLEXITY_MULTIPLIERS.High)
  };
  if (base.complexity !== targetComplexity) {
    productionMinutes *= matrixComplexityMultiplier[targetComplexity] / matrixComplexityMultiplier[base.complexity];
    auditMinutes *= matrixComplexityMultiplier[targetComplexity] / matrixComplexityMultiplier[base.complexity];
    qaMinutes *= matrixComplexityMultiplier[targetComplexity] / matrixComplexityMultiplier[base.complexity];
  }
  const productionHours = Number((productionMinutes / 60).toFixed(2));
  return {
    productionHours,
    qaHours: Number((qaMinutes / 60).toFixed(2)),
    auditHours: Number((auditMinutes / 60).toFixed(2)),
    ahtHoursPerUnit: Number((productionHours / unitCount).toFixed(2)),
    matrixRowNumber: base.rowNumber,
    matrixAddOnRowNumber: addOnRowNumber
  };
}

function getValidationMatrixData() {
  const applyOverrides = (row) => {
    const effective = { ...row, ...(data.ahtMatrixOverrides?.[String(row.rowNumber)] || {}) };
    effective.totalMinutes = [
      effective.pcTriageMinutes, effective.channelLeadMinutes, effective.designerMinutes,
      effective.buildMinutes, effective.qaLeadMinutes, effective.qaMinutes, effective.pcCloseMinutes
    ].reduce((sum, minutes) => sum + Number(minutes || 0), 0);
    effective.crTotalMinutes = [
      effective.crPcPlusMinutes, effective.crBuildMinutes, effective.crQaMinutes
    ].reduce((sum, minutes) => sum + Number(minutes || 0), 0);
    effective.overallMinutes = effective.totalMinutes + effective.crTotalMinutes;
    effective.totalHours = effective.totalMinutes / 60;
    effective.crTotalHours = effective.crTotalMinutes / 60;
    effective.overallHours = effective.overallMinutes / 60;
    return effective;
  };
  return {
    records: VALIDATION_2026_MATRIX.records.map(applyOverrides),
    addOns: VALIDATION_2026_MATRIX.addOns.map(applyOverrides)
  };
}

function estimateTaskEffort(taskCategory, taskType, units, complexity, projectIds = null, requestType = "", bugScope = "") {
  const aht = getAhtSummary(projectIds);
  const taskTypeAht = aht.categories.find((item) => item.taskType === taskType)?.hoursPerUnit || aht.teamAverage || 1.3;
  const multiplier = Number(data.complexityMultipliers?.[complexity] || DEFAULT_COMPLEXITY_MULTIPLIERS[complexity]);
  const matrixEstimate = validationMatrixEstimate(taskType, requestType, complexity, units, taskCategory, bugScope);
  const productionHours = matrixEstimate?.productionHours
    || Math.max(0.1, Number((taskTypeAht * units * multiplier).toFixed(2)));
  const qaHours = matrixEstimate?.qaHours ?? 0;
  const scheduledHours = Number((productionHours + qaHours).toFixed(2));
  return {
    productionHours,
    qaBufferHours: qaHours,
    qaEstimateUnavailable: !matrixEstimate || Boolean(matrixEstimate.source),
    plannedHours: scheduledHours,
    ahtHoursPerUnit: matrixEstimate?.ahtHoursPerUnit || taskTypeAht,
    complexityMultiplier: matrixEstimate ? 1 : multiplier,
    estimateSource: matrixEstimate?.source || (matrixEstimate ? VALIDATION_2026_MATRIX.sourceSheet : "Logged AHT / baseline"),
    matrixRowNumber: matrixEstimate?.matrixRowNumber || null,
    matrixAddOnRowNumber: matrixEstimate?.matrixAddOnRowNumber || null
  };
}

function normalizeTask(input, currentUser, existing = null) {
  const projectId = requireText(input.projectId, "Project", 80);
  const project = data.projects.find((item) => item.id === projectId || item.ref.toLowerCase() === projectId.toLowerCase());
  if (!project) throw new HttpError(404, "Project was not found.");
  const category = enumValue(input.category, TASK_CATEGORIES, "Task category");
  const bugScope = category === "Bug Fixing" ? enumValue(input.bugScope, BUG_SCOPES, "Bug-fixing scope") : "";
  const crId = category === "CR" || (category === "Bug Fixing" && bugScope === "CR")
    ? requireText(input.crId, "CR ID", 80)
    : "";
  if (crId && data.tasks.some((task) => task.id !== existing?.id && task.projectId === project.id && task.crId.toLowerCase() === crId.toLowerCase() && task.category === "CR")) {
    throw new HttpError(409, "That CR ID is already recorded for this project.");
  }
  const complexity = enumValue(input.complexity, COMPLEXITY_LEVELS, "Complexity");
  const units = positiveNumber(input.units ?? project.pages, "Pages / units", 100000);
  const taskType = enumValue(input.taskType || project.taskType, TASK_TYPES, "Task type");
  const assignee = cleanText(input.assignee || (currentUser.role === "executioner" ? currentUser.name : ""), 100);
  if (assignee && !data.team.some((member) => member.name === assignee)) throw new HttpError(400, "Assignee is not in the team roster.");
  if (currentUser.role === "executioner" && assignee !== currentUser.name) throw new HttpError(403, "Executioners can only create or assign tasks to themselves.");
  requireAssigneeDepartment(assignee, projectDepartmentId(project), currentUser);
  const estimate = estimateTaskEffort(category, taskType, units, complexity, new Set(
    data.projects.filter((item) => projectDepartmentId(item) === projectDepartmentId(project)).map((item) => item.id)
  ), projectPlanningRequestType(project), bugScope);
  const customProduction = input.productionHours === undefined || input.productionHours === "" ? estimate.productionHours : positiveNumber(input.productionHours, "Production hours", 100000);
  const qaHours = estimate.qaBufferHours;
  const plannedHours = Number((customProduction + qaHours).toFixed(2));
  const requestedStart = validDate(input.startDate || existing?.startDate || new Date().toISOString().slice(0, 10), "Planned start date");
  const calendar = scheduleCalendar(assignee);
  const startDate = nextBusinessDate(requestedStart, calendar, true);
  const startTime = normalizeClock(input.startTime || existing?.startTime, "Planned start time", shiftStartFor(assignee));
  const startMinutes = Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3));
  const earliestMinutes = Number(shiftStartFor(assignee).slice(0, 2)) * 60 + Number(shiftStartFor(assignee).slice(3));
  const shiftEnd = shiftEndFor(assignee);
  const latestMinutes = Number(shiftEnd.slice(0, 2)) * 60 + Number(shiftEnd.slice(3));
  if (startMinutes < Number(EARLY_START_TIME.slice(0, 2)) * 60 + Number(EARLY_START_TIME.slice(3)) || startMinutes >= latestMinutes
    || assignee && startMinutes < earliestMinutes) {
    throw new HttpError(400, `Planned start time must be within ${assignee ? shiftStartFor(assignee) : EARLY_START_TIME}–${shiftEnd}${assignee ? ` for ${assignee}` : ""}.`);
  }
  const finish = scheduledFinish(startDate, startTime, plannedHours, calendar, assignee);
  const etaOverride = currentUser.role === "executioner" ? false : Object.hasOwn(input, "etaOverride")
    ? input.etaOverride === true || input.etaOverride === "on"
    : existing?.etaOverride === true;
  const etaDate = etaOverride ? validDate(input.etaDate || existing?.etaDate || finish.date, "Capacity ETA") : finish.date;
  const etaTime = etaOverride ? normalizeClock(input.etaTime || existing?.etaTime || finish.time, "Capacity ETA time") : finish.time;
  if (etaOverride && (etaTime < shiftStartFor(assignee) || etaTime > shiftEnd)) {
    throw new HttpError(400, `Capacity ETA time must be within ${shiftStartFor(assignee)}–${shiftEnd}.`);
  }
  if (etaOverride && (etaDate < startDate || (etaDate === startDate && etaTime < startTime))) {
    throw new HttpError(400, "An overridden capacity ETA cannot precede the planned start.");
  }
  const priority = enumValue(currentUser.role === "executioner" ? "Normal" : input.priority || existing?.priority || "Normal", TASK_PRIORITIES, "Priority");
  const priorityOrder = currentUser.role === "executioner" ? 3 : boundedNumber(input.priorityOrder ?? existing?.priorityOrder ?? 3, "Priority order", 1, 9);
  const progress = boundedNumber(currentUser.role === "executioner" ? 0 : input.progress ?? existing?.progress ?? 0, "Progress", 0, 100);
  let status = enumValue(currentUser.role === "executioner" ? "Not Started" : input.status || existing?.status || "Not Started", PROJECT_STATUSES.filter((value) => value !== "Archived"), "Task status");
  if (progress === 100 || status === "Completed") status = "Completed";
  const taskPrefix = category === "Bug Fixing" ? `Bug ${bugScope}` : category;
  const title = cleanText(input.title || existing?.title, 240) || `${taskPrefix}${crId ? ` ${crId}` : ""} · ${project.title}`;
  return {
    ...existing,
    id: existing?.id || crypto.randomUUID(),
    projectId: project.id,
    projectRef: project.ref,
    projectTitle: project.title,
    market: project.market || "",
    channel: project.channel || "",
    primaryDpm: data.audits.find((audit) => audit.projectRef.toLowerCase() === project.ref.toLowerCase())?.primaryDpm || "",
    category,
    bugScope,
    crId,
    title,
    observations: cleanText(input.observations ?? existing?.observations, 2000),
    taskType,
    units,
    complexity,
    complexityMultiplier: Number(data.complexityMultipliers?.[complexity] || DEFAULT_COMPLEXITY_MULTIPLIERS[complexity]),
    productionHours: customProduction,
    qaBufferHours: qaHours,
    qaEstimateUnavailable: estimate.qaEstimateUnavailable,
    qaModel: "aht-v1",
    plannedHours,
    loggedHours: data.workLogs.filter((log) => log.taskId === existing?.id).reduce((sum, log) => sum + Number(log.hours || 0), 0),
    assignee,
    startDate,
    startTime,
    etaDate,
    etaTime,
    capacityEtaDate: finish.date,
    capacityEtaTime: finish.time,
    dueDate: validDate(input.dueDate || input.etaDate || existing?.dueDate || finish.date, "Task due date"),
    contractualEtaDate: validDate(input.contractualEtaDate || existing?.contractualEtaDate || project.tatDate, "Contractual TAT date", true),
    etaOverride,
    priority,
    priorityOrder,
    progress: status === "Completed" ? 100 : progress,
    status,
    createdBy: existing?.createdBy || currentUser.name,
    updatedAt: new Date().toISOString(),
    createdAt: existing?.createdAt || new Date().toISOString()
  };
}

function normalizeAudit(input, currentUser) {
  const projectRef = requireText(input.projectRef, "Project ID", 80);
  const auditType = enumValue(input.auditType, AUDIT_TYPES, "Audit type");
  const auditStatus = enumValue(input.auditStatus, AUDIT_STATUSES, "Audit status");
  const priority = enumValue(input.priority, PRIORITIES, "Priority");
  const sourceFile = enumValue(input.sourceFile, ["Available", "Not available"], "Source file status");
  const channel = enumValue(input.channel, AUDIT_CHANNELS, "Channel");
  const requestType = enumValue(input.requestType, AUDIT_REQUEST_TYPES, "Request type");
  const workfrontId = cleanText(input.workfrontId, 80);
  if (workfrontId) {
    const workfrontProject = data.workfrontProjects.find((project) => project.workfrontId === workfrontId);
    if (!workfrontProject || workfrontProject.ref.toLowerCase() !== projectRef.toLowerCase()) {
      throw new HttpError(400, "The linked Workfront project must match the audited Project ID.");
    }
  }
  const complexity = enumValue(input.complexity, AUDIT_COMPLEXITIES, "Complexity");
  const pageCount = positiveInteger(input.pageCount, "Page / frame count", 100000);
  const tat = calculateTatDays(channel, requestType, complexity, pageCount);
  const outputFormat = cleanText(input.outputFormat, 40);
  if (outputFormat && !FORMATS.includes(outputFormat)) throw new HttpError(400, "Output format is not valid.");
  const etaTime = cleanText(input.etaTime, 5);
  if (etaTime) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(etaTime)) throw new HttpError(400, "ETA time must be valid.");
    const minutes = Number(etaTime.slice(0, 2)) * 60 + Number(etaTime.slice(3));
    if (minutes < 11 * 60 + 30 || minutes > 21 * 60 + 30) throw new HttpError(400, "ETA time must be within shift hours (11:30–21:30).");
  }
  const startTime = cleanText(input.startTime, 5);
  if (startTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) throw new HttpError(400, "Start time must be valid.");
  const inputDocuments = Array.isArray(input.documents) ? input.documents : [];
  if (inputDocuments.length > 40) throw new HttpError(400, "An audit can contain at most 40 input documents.");
  const documents = inputDocuments.map((document) => {
    const name = requireText(document.name, "Input document name", 240);
    const link = requireText(document.link, "Input document link", 1000);
    let parsedLink;
    try {
      parsedLink = new URL(link);
    } catch {
      throw new HttpError(400, "Input document link must be an HTTP or HTTPS URL.");
    }
    if (!["http:", "https:"].includes(parsedLink.protocol)) throw new HttpError(400, "Input document link must be an HTTP or HTTPS URL.");
    return { id: crypto.randomUUID(), name, link: parsedLink.href };
  });
  const legacyFileLink = cleanText(input.fileLink, 1000);
  if (!documents.length && legacyFileLink) {
    try {
      const parsedLink = new URL(legacyFileLink);
      if (!["http:", "https:"].includes(parsedLink.protocol)) throw new Error("Invalid protocol");
      documents.push({ id: crypto.randomUUID(), name: cleanText(input.fileName, 240) || "Input document", link: parsedLink.href });
    } catch {
      throw new HttpError(400, "Input document link must be an HTTP or HTTPS URL.");
    }
  }
  return {
    id: crypto.randomUUID(),
    auditType, projectRef, workfrontId, crId: cleanText(input.crId, 80),
    projectName: cleanText(input.projectName, 240),
    market: cleanText(input.market, 100),
    channel,
    requestType,
    minorUpdate: requestType === "Update/Repurpose" ? enumValue(input.minorUpdate, ["Yes", "No"], "Minor update") : "",
    complexity,
    pageCount,
    tatDays: tat,
    calculatedTat: `${tat} Business Day(s)`,
    auditor: currentUser.name,
    startDate: validDate(input.startDate, "Start date", true),
    startTime, etaDate: validDate(input.etaDate, "ETA date", true), etaTime,
    capacityEstimate: input.capacityRequested === "true" ? estimateAuditCapacity(input, currentUser) : null,
    auditStatus, sourceFile, priority,
    primaryDpm: cleanText(input.primaryDpm, 100),
    backupDpm: cleanText(input.backupDpm, 100),
    secondaryBackupDpm: cleanText(input.secondaryBackupDpm, 100),
    primaryOnLeave: input.primaryOnLeave === true || input.primaryOnLeave === "on",
    observations: cleanText(input.observations, 5000),
    dependencies: cleanText(input.dependencies, 3000),
    requirements: cleanText(input.requirements, 5000),
    outputFormat,
    fileName: cleanText(input.fileName, 240),
    fileLink: documents[0]?.link || "",
    documents,
    functionalDoc: cleanText(input.functionalDoc, 1000),
    styleGuideDoc: cleanText(input.styleGuideDoc, 1000),
    signOffName: cleanText(input.signOffName, 100),
    createdAt: new Date().toISOString()
  };
}

function normalizeWorkLog(input, user) {
  const projectId = requireText(input.projectId, "Project", 80);
  const project = data.projects.find((item) => item.id === projectId);
  if (!project) throw new HttpError(404, "Project was not found.");
  requireProjectAccess(user, project);
  const requestedTaskId = cleanText(input.taskId, 80);
  const task = requestedTaskId
    ? data.tasks.find((item) => item.id === requestedTaskId && item.projectId === project.id)
    : data.tasks.find((item) => item.projectId === project.id && item.category === "Build");
  if (!task) throw new HttpError(404, "Production task was not found for this project.");
  if (user.role === "executioner" && task.assignee !== user.name) throw new HttpError(403, "You can only log hours against tasks assigned to you.");
  const hours = boundedNumber(input.hours, "Hours", 0.1, 24);
  const progress = boundedNumber(input.progress, "Progress", 0, 100);
  const phase = enumValue(input.phase, PHASES, "Work phase");
  let status = enumValue(input.status, PROJECT_STATUSES.filter((item) => item !== "Archived"), "Project status");
  if (progress === 100 && status !== "On Hold") status = "Completed";
  if (status === "Completed" && progress < 100) throw new HttpError(400, "Completed projects must have 100% progress.");
  return {
    id: crypto.randomUUID(), projectId, taskId: task.id, taskCategory: task.category, crId: task.crId, projectRef: project.ref, projectTitle: task.title,
    userId: user.id, userName: user.name, date: validDate(input.date, "Work date"),
    hours, phase, progress, status, note: cleanText(input.note, 2000),
    createdAt: new Date().toISOString()
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req, bodyLimit = BODY_LIMIT) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > bodyLimit) throw new HttpError(413, "Request body is too large.");
  }
  if (!body) return {};
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
    return value;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(value));
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function setSessionCookie(res, token, secure) {
  res.setHeader("Set-Cookie", `teamhub_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`);
}

function clearSessionCookie(res, secure) {
  res.setHeader("Set-Cookie", `teamhub_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`);
}

function getSession(req) {
  const cookies = (req.headers.cookie || "").split(";").map((part) => part.trim());
  const token = cookies.find((part) => part.startsWith("teamhub_session="))?.slice("teamhub_session=".length);
  if (!token) return null;
  const key = crypto.createHash("sha256").update(token).digest("hex");
  const session = sessions.get(key);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(key);
    return null;
  }
  return { ...session, sessionKey: key };
}

function requireUser(req) {
  const session = getSession(req);
  if (!session) throw new HttpError(401, "Sign in to continue.");
  const user = data.users.find((item) => item.id === session.userId);
  if (!user) throw new HttpError(401, "Your account is no longer available. Sign in again.");
  return { id: user.id, username: user.username, name: user.name, role: user.role, teamIds: user.teamIds || [], sessionKey: session.sessionKey };
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "Request origin is not allowed.");
}

async function persist() {
  retainReportingHistory(data);
  recordAssignmentNotifications(data);
  workspaceStore.save(data);
}

async function loadData() {
  workspaceStore = new WorkspaceStore(SQLITE_FILE);
  const imported = workspaceStore.importLegacy(DATA_FILE);
  if (imported) console.log(`Migrated workspace to SQLite: ${SQLITE_FILE}. Legacy JSON preserved.`);
  const parsed = workspaceStore.load();
  if (parsed) {
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.users) || !Array.isArray(parsed.projects) || !Array.isArray(parsed.audits) || !Array.isArray(parsed.workLogs) || !Array.isArray(parsed.team)) {
      throw new Error("Data file has an unsupported or invalid structure.");
    }
    data = parsed;
    let migrated = false;
    if (!Array.isArray(data.processAuditReports)) { data.processAuditReports = []; migrated = true; }
    if (!data.reportingHistory) { retainReportingHistory(data); migrated = true; }
    if (!Array.isArray(data.marketMatrix)) {
      data.marketMatrix = initialMarketMatrix;
      migrated = true;
    }
    if (!Array.isArray(data.holidays)) {
      data.holidays = initialHolidays;
      migrated = true;
    }
    if (!Array.isArray(data.leaves)) {
      data.leaves = [];
      migrated = true;
    }
    // Hema Rawat is an auditor who also executes Design work; count her as an executor in Quality/FTR/KPI reports only.
    for (const member of data.team) {
      if (member.name.toLowerCase() === "hema rawat" && member.reportExecutor === undefined) { member.reportExecutor = true; migrated = true; }
    }
    for (const leave of data.leaves) {
      if (!leave.status) {
        leave.status = "Approved";
        leave.approvedBy = leave.createdBy || "Legacy workspace";
        leave.approvedAt = leave.createdAt || new Date().toISOString();
        migrated = true;
      }
    }
    if (!Array.isArray(data.workfrontProjects)) {
      data.workfrontProjects = [];
      migrated = true;
    }
    const originalProjectCacheSize = data.workfrontProjects.length;
    data.workfrontProjects = data.workfrontProjects.filter((project) => workfrontIsTargetDeliveryCentre(project.deliveryCentre));
    if (data.workfrontProjects.length !== originalProjectCacheSize) migrated = true;
    if (!Array.isArray(data.workfrontChangeRounds)) {
      data.workfrontChangeRounds = [];
      migrated = true;
    }
    const originalChangeCacheSize = data.workfrontChangeRounds.length;
    data.workfrontChangeRounds = data.workfrontChangeRounds.filter((round) => workfrontIsTargetDeliveryCentre(round.deliveryCentre));
    if (data.workfrontChangeRounds.length !== originalChangeCacheSize) migrated = true;
    if (!Array.isArray(data.workfrontTasks)) {
      data.workfrontTasks = [];
      migrated = true;
    }
    const originalTaskCacheSize = data.workfrontTasks.length;
    data.workfrontTasks = data.workfrontTasks.filter((task) => workfrontIsTargetDeliveryCentre(task.deliveryCentre));
    if (data.workfrontTasks.length !== originalTaskCacheSize) migrated = true;
    for (const record of [...data.workfrontProjects, ...data.workfrontChangeRounds, ...data.workfrontTasks]) {
      if (!workfrontIsCampaignAsset(record.assetType)) continue;
      if (record.workfrontTeam !== "Email Team" || record.productionTeamId !== "email") {
        record.workfrontTeam = "Email Team";
        record.productionTeamId = "email";
        migrated = true;
      }
    }
    for (const record of [...data.workfrontProjects, ...data.workfrontChangeRounds, ...data.workfrontTasks]) {
      const title = record.title || record.projectName || "";
      if (workfrontIsCampaignAsset(record.assetType) || workfrontChannel(record.assetType || "", title) !== "Banner") continue;
      const team = workfrontAssetTeam(record.assetType || "", title);
      if (record.workfrontTeam !== team || record.productionTeamId !== departmentIdForTeam(team)) {
        record.workfrontTeam = team;
        record.productionTeamId = departmentIdForTeam(team);
        migrated = true;
      }
    }
    for (const project of data.workfrontProjects) {
      const mappedStage = workfrontInitialStage(project.sourceStatus || "");
      const legacyAuditStage = project.productionStage === "Pre-Audit" && ["current", "pre-audit"].includes(String(project.sourceStatus || "").trim().toLocaleLowerCase().replace(/\s+/g, " "));
      if (!project.productionStage || (project.productionStage === "Awaiting triage" && mappedStage !== "Awaiting triage") || legacyAuditStage) {
        project.productionStage = mappedStage;
        migrated = true;
      }
    }
    for (const task of data.workfrontTasks || []) {
      const names = parseWorkfrontAssignments([...(task.assignmentNames || []), task.assignees].join("; "));
      if (JSON.stringify(names) !== JSON.stringify(task.assignmentNames || [])) {
        task.assignmentNames = names;
        migrated = true;
      }
    }
    for (const project of data.projects) {
      if (project.workfrontId && !project.productionStage) {
        project.productionStage = "Execution in progress";
        migrated = true;
      }
    }
    if (data.workfrontSync && migrated) {
      data.workfrontSync.currentProjectRefs = data.workfrontProjects.filter((project) => project.productionStage === "Awaiting Audit").map((project) => project.ref);
      data.workfrontSync.projectProductionStageCounts = workfrontCountsBy(data.workfrontProjects, (project) => project.productionStage);
      data.workfrontSync.projects = { ...(data.workfrontSync.projects || {}), total: data.workfrontProjects.length };
      data.workfrontSync.changeRounds = { ...(data.workfrontSync.changeRounds || {}), total: data.workfrontChangeRounds.length };
      data.workfrontSync.tasks = { ...(data.workfrontSync.tasks || {}), total: data.workfrontTasks.length };
      data.workfrontSync.projectDepartments = Object.fromEntries(workfrontCountsBy(data.workfrontProjects, (project) => project.workfrontTeam).map(({ label, count }) => [label, count]));
      data.workfrontSync.projectStatusCounts = workfrontCountsBy(data.workfrontProjects, (project) => project.sourceStatus);
      data.workfrontSync.projectTeamStatusCounts = workfrontCountsBy(data.workfrontProjects, (project) => `${project.workfrontTeam} · ${project.sourceStatus}`);
      data.workfrontSync.changeRoundStatusCounts = workfrontCountsBy(data.workfrontChangeRounds, (round) => round.sourceStatus);
      data.workfrontSync.changeRoundExecutionCounts = workfrontCountsBy(data.workfrontChangeRounds, (round) => round.executionAssignment);
      data.workfrontSync.projectSourceStatuses = [...new Set(data.workfrontProjects.map((project) => project.sourceStatus).filter(Boolean))].sort();
      data.workfrontSync.changeRoundSourceStatuses = [...new Set(data.workfrontChangeRounds.map((round) => round.sourceStatus).filter(Boolean))].sort();
    }
    if (!Object.hasOwn(data, "workfrontSync")) {
      data.workfrontSync = null;
      migrated = true;
    }
    if (!data.workfrontAutomation || typeof data.workfrontAutomation !== "object" || Array.isArray(data.workfrontAutomation)) {
      data.workfrontAutomation = {
        enabled: false, status: "idle", intervalMinutes: 15, lastAttemptAt: null,
        lastSuccessAt: null, nextSyncAt: null, lastError: ""
      };
      migrated = true;
    } else {
      data.workfrontAutomation = {
        ...data.workfrontAutomation,
        enabled: data.workfrontAutomation.enabled === true,
        intervalMinutes: 15,
        status: ["idle", "syncing", "success", "error"].includes(data.workfrontAutomation.status) ? data.workfrontAutomation.status : "idle",
        lastError: typeof data.workfrontAutomation.lastError === "string" ? data.workfrontAutomation.lastError.slice(0, 500) : ""
      };
    }
    if (!Array.isArray(data.changeRounds)) {
      data.changeRounds = [];
      migrated = true;
    }
    if (!Array.isArray(data.tasks)) {
      data.tasks = [];
      migrated = true;
    }
    if (!data.complexityMultipliers || typeof data.complexityMultipliers !== "object") {
      data.complexityMultipliers = { ...DEFAULT_COMPLEXITY_MULTIPLIERS };
      migrated = true;
    }
    if (!data.ahtMatrixOverrides || typeof data.ahtMatrixOverrides !== "object" || Array.isArray(data.ahtMatrixOverrides)) {
      data.ahtMatrixOverrides = {};
      migrated = true;
    }
    if (!Number(data.capacityHoursPerDay)) {
      data.capacityHoursPerDay = 8;
      migrated = true;
    }
    for (const user of data.users) {
      const role = user.role === "admin" ? "manager" : user.role === "member" ? "executioner" : user.role;
      if (role !== user.role) {
        user.role = role;
        migrated = true;
      }
      if (!Array.isArray(user.teamIds)) {
        user.teamIds = user.role === "manager" ? [...DEPARTMENT_IDS] : [];
        migrated = true;
      }
    }
    for (const member of data.team) {
      const account = data.users.find((user) => user.name.toLowerCase() === member.name.toLowerCase());
      if (!Array.isArray(member.teamIds)) {
        member.teamIds = account?.teamIds || [];
        migrated = true;
      }
      if (![DEFAULT_START_TIME, EARLY_START_TIME].includes(member.shiftStart)) {
        member.shiftStart = DEFAULT_START_TIME;
        migrated = true;
      }
      if (![SHIFT_END_TIME, NEW_SHIFT_END_TIME].includes(member.shiftEnd)) {
        member.shiftEnd = SHIFT_END_TIME;
        migrated = true;
      }
    }
    if (migrated) {
      const nextDates = new Map();
      for (const project of [...data.projects].filter((item) => item.assignee && !["Completed", "Archived"].includes(item.status)).sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"))) {
        if (!project.plannedStartDate || !project.plannedEndDate) {
          const startDate = nextDates.get(project.assignee) || nextBusinessDate(new Date().toISOString().slice(0, 10), data.holidays, true);
          project.plannedStartDate = startDate;
          project.plannedEndDate = addBusinessHours(startDate, Number(project.plannedHours), data.holidays);
        }
        nextDates.set(project.assignee, nextBusinessDate(project.plannedEndDate, data.holidays));
      }
    }
    for (const audit of data.audits) {
      if (!Array.isArray(audit.documents)) {
        audit.documents = audit.fileLink ? [{ id: crypto.randomUUID(), name: audit.fileName || "Input document", link: audit.fileLink }] : [];
        migrated = true;
      }
    }
    for (const project of data.projects) {
      const bannerSource = project.workfrontId && data.workfrontProjects.find((item) => item.workfrontId === project.workfrontId && item.channel === "Banner");
      if (bannerSource && DEPARTMENT_IDS.includes(bannerSource.productionTeamId) && project.productionTeamId !== bannerSource.productionTeamId) {
        project.productionTeamId = bannerSource.productionTeamId;
        migrated = true;
      }
      if (!project.productionTeamId) {
        const source = project.workfrontId && data.workfrontProjects.find((item) => item.workfrontId === project.workfrontId);
        project.productionTeamId = source?.productionTeamId || departmentIdForChannel(project.channel, project.taskType) || "unassigned";
        migrated = true;
      }
      if (!Number(project.plannedHours) || !project.plannedStartDate || !project.plannedEndDate) {
        const estimate = estimateProjectHours(project);
        const startDate = project.status === "Completed" ? project.dueDate || new Date().toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
        project.plannedHours = estimate;
        project.plannedStartDate = startDate;
        project.plannedEndDate = addBusinessHours(startDate, estimate, data.holidays);
        migrated = true;
      }
    }
    for (const project of data.projects) {
      if (!data.tasks.some((task) => task.projectId === project.id && task.category === "Build")) {
        createBuildTask(project);
        migrated = true;
      } else {
        const build = data.tasks.find((task) => task.projectId === project.id && task.category === "Build");
        project.buildTaskId = build.id;
      }
    }
    for (const log of data.workLogs) {
      if (!log.taskId) {
        const build = data.tasks.find((task) => task.projectId === log.projectId && task.category === "Build");
        if (build) {
          log.taskId = build.id;
          log.taskCategory = "Build";
          migrated = true;
        }
      }
    }
    for (const task of data.tasks) {
      const loggedHours = data.workLogs.filter((log) => log.taskId === task.id).reduce((sum, log) => sum + Number(log.hours || 0), 0);
      if (task.loggedHours !== loggedHours) {
        task.loggedHours = loggedHours;
        migrated = true;
      }
    }
    for (const round of data.changeRounds) {
      if (!data.tasks.some((task) => task.category === "CR" && task.projectId === round.projectId && task.crId === round.crId)) {
        const project = data.projects.find((item) => item.id === round.projectId);
        if (project) {
          const complexity = COMPLEXITY_LEVELS.includes(round.complexity) ? round.complexity : "Medium";
          const task = normalizeTask({
            projectId: project.id, category: "CR", crId: round.crId, complexity, units: 1,
            startDate: round.landedDate, startTime: round.landedTime,
            etaDate: round.etaDate, etaTime: round.etaTime,
            contractualEtaDate: round.etaDate, priority: "Normal", priorityOrder: 5,
            title: `CR ${round.crId} · ${project.title}`
          }, { name: round.createdBy || "Workspace", role: "manager" });
          data.tasks.push(task);
          round.taskId = task.id;
          migrated = true;
        }
      }
    }
    if (data.qaModel !== "aht-v1") {
      const reassigned = new Set();
      for (const task of data.tasks.filter((item) => item.progress === 0 && !item.loggedHours && !["Completed", "Archived"].includes(item.status))) {
        const project = data.projects.find((item) => item.id === task.projectId);
        if (!project) continue;
        const effort = estimateTaskEffort(task.category, task.taskType, task.units, task.complexity, null, projectPlanningRequestType(project), task.bugScope);
        task.qaBufferHours = effort.qaBufferHours;
        task.qaEstimateUnavailable = effort.qaEstimateUnavailable;
        task.qaModel = "aht-v1";
        task.plannedHours = Number((task.productionHours + effort.qaBufferHours).toFixed(2));
        reassigned.add(task.assignee);
      }
      for (const name of reassigned) reflowAssigneeTasks(name);
      data.qaModel = "aht-v1";
      migrated = true;
    }
    const priorAssignments = JSON.stringify(data.assignmentState);
    const priorNotificationCount = (data.notifications || []).length;
    recordAssignmentNotifications(data);
    if (priorAssignments !== JSON.stringify(data.assignmentState) || priorNotificationCount !== data.notifications.length) migrated = true;
    if (migrated) await persist();
  } else {
    data = createInitialData();
    for (const project of data.projects) {
      const today = new Date().toISOString().slice(0, 10);
      project.plannedHours = estimateProjectHours(project);
      project.plannedStartDate = project.status === "Completed" ? project.dueDate || today : today;
      project.plannedEndDate = addBusinessHours(project.plannedStartDate, project.plannedHours, data.holidays);
    }
    const nextDates = new Map();
    for (const project of [...data.projects].filter((item) => item.assignee && !["Completed", "Archived"].includes(item.status)).sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"))) {
      const startDate = nextDates.get(project.assignee) || nextBusinessDate(new Date().toISOString().slice(0, 10), data.holidays, true);
      project.plannedStartDate = startDate;
      project.plannedEndDate = addBusinessHours(startDate, Number(project.plannedHours), data.holidays);
      nextDates.set(project.assignee, nextBusinessDate(project.plannedEndDate, data.holidays));
    }
    data.tasks = [];
    for (const project of data.projects) createBuildTask(project);
    await persist();
  }
}

function publicUser(user) {
  return { id: user.id, username: user.username, name: user.name, role: user.role, teamIds: user.teamIds || [], createdAt: user.createdAt };
}

function requireRole(user, roles) {
  if (!roles.includes(user.role)) throw new HttpError(403, "Your account does not have permission to perform this action.");
}

function requireProjectManager(user) {
  requireRole(user, ["manager", "teamManager", "auditor"]);
}

function canManageProjects(user) {
  return ["manager", "teamManager", "auditor"].includes(user.role);
}

function canManageWorkspace(user) {
  return user.role === "manager";
}

function getAhtSummary(projectIds = null) {
  const completedProjects = data.projects.filter((project) => project.status === "Completed" && (!projectIds || projectIds.has(project.id)));
  const estimates = new Map();
  const overall = { projects: new Set(), hours: 0, units: 0 };
  for (const project of completedProjects) {
    const logs = data.workLogs.filter((entry) => entry.projectId === project.id && (!projectIds || projectIds.has(entry.projectId)));
    const hours = logs.reduce((sum, entry) => sum + Number(entry.hours || 0), 0);
    if (!hours) continue;
    overall.hours += hours;
    overall.units += Number(project.pages || 0);
    overall.projects.add(project.id);
    const entry = estimates.get(project.taskType) || { taskType: project.taskType, projects: new Set(), hours: 0, units: 0 };
    entry.projects.add(project.id);
    entry.hours += hours;
    entry.units += Number(project.pages || 0);
    estimates.set(project.taskType, entry);
  }
  const teamAht = overall.units ? overall.hours / overall.units : 1.3;
  const categories = TASK_TYPES.map((taskType) => {
    const item = estimates.get(taskType);
    return {
      taskType,
      sampleProjects: item?.projects.size || 0,
      sampleUnits: item?.units || 0,
      loggedHours: Number((item?.hours || 0).toFixed(2)),
      hoursPerUnit: Number((item?.units ? item.hours / item.units : teamAht).toFixed(2)),
      source: item?.units ? "actual" : overall.units ? "team-average" : "baseline"
    };
  });
  const matrix = getValidationMatrixData();
  return {
    categories,
    teamAverage: Number(teamAht.toFixed(2)),
    completedProjects: overall.projects.size,
    completedUnits: overall.units,
    loggedHours: Number(overall.hours.toFixed(2)),
    baselineHoursPerUnit: 1.3,
    validationMatrix: {
      sourceWorkbook: VALIDATION_2026_MATRIX.sourceWorkbook,
      sourceSheet: VALIDATION_2026_MATRIX.sourceSheet,
      records: matrix.records,
      addOns: matrix.addOns
    }
  };
}

function estimateProjectHours(project, summary = getAhtSummary()) {
  const complexity = Number(project.complexity) <= 0.7 ? "Low" : Number(project.complexity) >= 1.5 ? "High" : "Medium";
  const effort = estimateTaskEffort(
    "Build", project.taskType, Number(project.pages || 1), complexity, null,
    projectPlanningRequestType(project)
  );
  if (effort.estimateSource === VALIDATION_2026_MATRIX.sourceSheet) return effort.plannedHours;
  const aht = summary.categories.find((item) => item.taskType === project.taskType)?.hoursPerUnit || summary.teamAverage || 1.3;
  const multiplier = Number(data.complexityMultipliers?.[complexity] || DEFAULT_COMPLEXITY_MULTIPLIERS[complexity]);
  const production = Math.max(0.1, aht * Number(project.pages || 1) * multiplier);
  return Number((production / 0.6).toFixed(2));
}

function projectLoggedHours(projectId) {
  return data.workLogs.filter((entry) => entry.projectId === projectId).reduce((sum, entry) => sum + Number(entry.hours || 0), 0);
}

function projectPlanningRequestType(project) {
  if (project.workfrontRequestType) return project.workfrontRequestType;
  const projectRef = String(project.ref || "").toLowerCase();
  const audit = projectRef && data.audits.find((entry) => entry.projectRef.toLowerCase() === projectRef && entry.requestType);
  return audit?.requestType || project.requestType;
}

function calculateResourceSuggestions(project) {
  const departmentId = projectDepartmentId(project);
  const departmentProjectIds = new Set(data.projects.filter((item) => projectDepartmentId(item) === departmentId).map((item) => item.id));
  const complexity = Number(project.complexity) <= 0.7 ? "Low" : Number(project.complexity) >= 1.5 ? "High" : "Medium";
  const effort = estimateTaskEffort("Build", project.taskType, Number(project.pages || 1), complexity, departmentProjectIds, projectPlanningRequestType(project));
  const plannedHours = effort.plannedHours;
  const today = new Date().toISOString().slice(0, 10);
  const openTasks = data.tasks.filter((task) => task.projectId !== project.id && task.assignee && !["Completed", "Archived"].includes(task.status));
  const assignments = data.team.filter((member) => {
    const account = data.users.find((user) => user.name.toLowerCase() === member.name.toLowerCase());
    return Boolean(departmentId) && memberHasDepartment(member, departmentId) && (!account || account.role === "executioner");
  }).map((member) => {
    const holidays = scheduleCalendar(member.name);
    const open = openTasks.filter((item) => item.assignee === member.name);
    const remaining = open.reduce((sum, item) => {
      return sum + Math.max(0, Number(item.plannedHours) - Number(item.loggedHours || 0));
    }, 0);
    let startDate = "";
    let remainingCapacity = 0;
    const firstDayRequiredCapacity = Math.min(8, plannedHours);
    for (let day = 0; day < 35; day += 1) {
      const date = nextBusinessDate(today, holidays, day === 0);
      const dailyLoad = open.reduce((sum, item) => {
        if (item.startDate && item.etaDate && date >= item.startDate && date <= item.etaDate) {
          return sum + Math.max(0, Number(item.plannedHours) / Math.max(1, businessDaysBetween(item.startDate, item.etaDate, holidays)) - Number(item.loggedHours || 0) / Math.max(1, businessDaysBetween(item.startDate, item.etaDate, holidays)));
        }
        return sum;
      }, 0);
      const available = Math.max(0, 8 - dailyLoad);
      if (!startDate && available >= firstDayRequiredCapacity) startDate = date;
      remainingCapacity += available;
      if (remainingCapacity >= plannedHours) break;
    }
    if (!startDate) startDate = nextBusinessDate(today, holidays, true);
    const workDays = Math.max(1, Math.ceil(plannedHours / 8));
    const memberStartTime = shiftStartFor(member.name);
    const finish = scheduledFinish(startDate, memberStartTime, plannedHours, holidays, member.name);
    const totalOpenHours = Number(remaining.toFixed(1));
    return {
      name: member.name,
      openProjects: open.length,
      openTasks: open.length,
      remainingHours: totalOpenHours,
      onLeaveToday: (data.leaves || []).some((leave) => leave.status === "Approved" && leave.assignee === member.name && leave.startDate <= today && today <= leave.endDate),
      nextLeave: (() => {
        const leave = (data.leaves || []).filter((item) => item.status === "Approved" && item.assignee === member.name && item.endDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
        return leave ? publicLeave(leave, { role: "manager" }) : null;
      })(),
      availableTodayHours: Number(Math.max(0, (holidays.some((holiday) => holiday.date === today) ? 0 : 8) - open.reduce((sum, item) => {
        if (item.startDate && item.etaDate && today >= item.startDate && today <= item.etaDate) {
          const days = Math.max(1, businessDaysBetween(item.startDate, item.etaDate, holidays));
          return sum + Math.max(0, Number(item.plannedHours) / days - Number(item.loggedHours || 0) / days);
        }
        return sum;
      }, 0)).toFixed(1)),
      utilization: Number((Math.min(100, remaining / Math.max(8, workDays * 8) * 100)).toFixed(0)),
      plannedStartDate: startDate,
      plannedStartTime: memberStartTime,
      plannedEndDate: finish.date,
      plannedEndTime: finish.time,
      recommended: false
    };
  }).sort((a, b) => a.plannedStartDate.localeCompare(b.plannedStartDate) || a.remainingHours - b.remainingHours);
  if (assignments.length) assignments[0].recommended = true;
  return { ...effort, resources: assignments };
}

function estimateAuditCapacity(input, user) {
  const projectRef = requireText(input.projectRef, "Project ID", 80);
  const snapshot = publicSnapshot(publicUser(data.users.find((item) => item.id === user.id)));
  const project = snapshot.projects.find((item) => item.ref.toLowerCase() === projectRef.toLowerCase())
    || snapshot.workfrontProjects.find((item) => item.ref.toLowerCase() === projectRef.toLowerCase());
  if (!project) throw new HttpError(404, "An accessible project is required for a capacity estimate.");
  const departmentId = project.productionTeamId || projectDepartmentId(project);
  const channel = enumValue(input.channel, AUDIT_CHANNELS, "Channel");
  const requestType = enumValue(input.requestType, AUDIT_REQUEST_TYPES, "Request type");
  const complexity = enumValue(input.complexity, AUDIT_COMPLEXITIES, "Complexity");
  const units = positiveInteger(input.pageCount, "Page / frame count", 100000);
  const start = validDate(input.startDate, "Start date");
  const startTime = normalizeClock(input.startTime, "Start time", DEFAULT_START_TIME);
  const today = new Date().toISOString().slice(0, 10);
  const effort = estimateTaskEffort("Build", channel, units, { Simple: "Low", Medium: "Medium", Complex: "High" }[complexity], null, requestType);
  const warnings = new Set();
  if (effort.qaEstimateUnavailable) warnings.add("QA AHT is unavailable for this request; no complete production delivery estimate can be confirmed.");
  const candidates = data.team.filter((member) => memberHasDepartment(member, departmentId) && (() => {
    const account = data.users.find((item) => item.name.toLowerCase() === member.name.toLowerCase());
    return !account || account.role === "executioner";
  })()).map((member) => {
    const local = new Map();
    const source = new Map();
    const key = (ref, category) => `${String(ref).toLowerCase()}:${String(category).toLowerCase()}`;
    for (const task of data.tasks.filter((item) => item.assignee === member.name && !["Completed", "Archived"].includes(item.status))) {
      const parent = data.projects.find((item) => item.id === task.projectId);
      const id = key(parent?.ref || task.projectId, task.category);
      local.set(id, (local.get(id) || 0) + Math.max(0, Number(task.plannedHours) - Number(task.loggedHours || 0)));
    }
    let unknownHours = false;
    for (const task of snapshot.workfrontTasks.filter((item) => !["complete", "completed", "cancelled", "canceled"].includes(String(item.executionStatus || item.taskStatus).toLowerCase()))) {
      const names = task.assignmentNames || [];
      if (String(task.delegations || "").startsWith("Unavailable:")) warnings.add("Some Workfront assignment/delegation details could not be read; resource coverage may be incomplete.");
      else if (String(task.delegations || "").trim()) warnings.add("Workfront delegations are displayed, but delegate dates and effort shares are unavailable; delegated workload is not allocated in this estimate.");
      if (!task.detailSyncedAt && String(task.assignees || "").toLowerCase().includes(member.name.toLowerCase())) {
        unknownHours = true;
        warnings.add(`Workfront details for ${member.name}'s assigned work have not been checked yet; refresh workload before estimating this resource.`);
        continue;
      }
      if (task.productionTeamId === departmentId && !names.some((name) => data.team.some((person) => person.name.toLowerCase() === name.toLowerCase()))) {
        warnings.add("Some Workfront work is role-only, unassigned, or not mapped to the roster; its capacity impact cannot be allocated.");
      }
      if (!names.some((name) => name.toLowerCase() === member.name.toLowerCase())) continue;
      if (!task.detailSyncedAt || task.plannedHours === null || task.plannedHours === undefined) {
        unknownHours = true;
        warnings.add(`Planned hours are unavailable for ${member.name}; no delivery date can be calculated for this resource.`);
        continue;
      }
      if (names.filter((name) => data.team.some((person) => person.name.toLowerCase() === name.toLowerCase())).length > 1) {
        warnings.add("Multi-person Workfront tasks reserve the full remaining task effort for each person because individual effort shares are not provided.");
      }
      const remaining = sourceRemaining(task);
      const id = key(task.projectRef, task.taskName);
      source.set(id, (source.get(id) || 0) + remaining);
    }
    const backlog = mergedWorkloadHours(local, source);
    const forecast = new Map(source);
    const targetBuild = key(projectRef, "Build");
    forecast.set(targetBuild, Math.max(forecast.get(targetBuild) || 0, effort.plannedHours));
    const forecastHours = mergedWorkloadHours(local, forecast);
    const calendar = scheduleCalendar(member.name);
    const date = nextBusinessDate(start > today ? start : today, calendar, true);
    const time = [shiftStartFor(member.name), date === start ? startTime : "", date === today ? new Date().toTimeString().slice(0, 5) : ""].sort().at(-1);
    const finish = unknownHours || effort.qaEstimateUnavailable ? null : scheduledFinish(date, time, forecastHours, calendar, member.name);
    return { name: member.name, backlogHours: Number(backlog.toFixed(2)), tentativeDate: finish?.date || "", tentativeTime: finish?.time || "" };
  }).sort((a, b) => (a.tentativeDate || "9999").localeCompare(b.tentativeDate || "9999") || a.tentativeTime.localeCompare(b.tentativeTime));
  if (!candidates.length) warnings.add("No eligible production resources are mapped to this project's team.");
  if (!data.workfrontSync?.syncedAt || Date.now() - new Date(data.workfrontSync.syncedAt).getTime() > 30 * 60 * 1000) warnings.add("Workfront workload may be stale; refresh it before committing to a delivery date.");
  return { calculatedAt: new Date().toISOString(), projectRef, plannedHours: effort.plannedHours, candidates, warnings: [...warnings],
    assumption: "Tentative FIFO estimate: remaining local + Workfront work and proposed Build effort including supplied AHT QA minutes, 8-hour working days, member shifts, holidays and approved leave. Matching local/source project-task totals and the proposed project's existing Build use the larger effort rather than counting it twice. Dates are not contractual commitments." };
}

function mergedWorkloadHours(local, source) {
  let hours = 0;
  for (const id of new Set([...local.keys(), ...source.keys()])) hours += Math.max(local.get(id) || 0, source.get(id) || 0);
  return hours;
}

function workfrontRemainingHours(task) {
  const unlogged = Math.max(0, task.plannedHours - (task.actualHours || 0));
  return task.percentComplete === null || task.percentComplete === undefined
    ? unlogged : Math.min(unlogged, task.plannedHours * (1 - task.percentComplete / 100));
}

function businessDaysBetween(start, end, holidays) {
  const holidayDates = new Set(holidays.map((holiday) => holiday.date));
  const current = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  let count = 0;
  while (current <= endDate) {
    const date = current.toISOString().slice(0, 10);
    if (current.getUTCDay() !== 0 && current.getUTCDay() !== 6 && !holidayDates.has(date)) count += 1;
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return count;
}

function planAssignedProject(project, assignee, allocation = {}) {
  const projectWithAssignee = { ...project, assignee };
  const suggestion = calculateResourceSuggestions(projectWithAssignee);
  const resource = suggestion.resources.find((item) => item.name === assignee);
  if (!resource) throw new HttpError(400, "Assignee is not in the team roster.");
  project.assignee = assignee;
  const complexity = project.complexity <= 0.7 ? "Low" : project.complexity >= 1.5 ? "High" : "Medium";
  const effort = estimateTaskEffort("Build", project.taskType, project.pages, complexity, null, projectPlanningRequestType(project));
  project.plannedHours = effort.plannedHours;
  const calendar = scheduleCalendar(assignee);
  project.plannedStartDate = nextBusinessDate(validDate(allocation.plannedStartDate || resource.plannedStartDate, "Planned start date"), calendar, true);
  const projectStartTime = normalizeClock(allocation.startTime, "Planned start time", shiftStartFor(assignee));
  const finish = scheduledFinish(project.plannedStartDate, projectStartTime, project.plannedHours, calendar, assignee);
  project.plannedEndDate = finish.date;
  project.plannedStartTime = projectStartTime;
  project.plannedEndTime = finish.time;
  project.updatedAt = new Date().toISOString();
  const buildTask = data.tasks.find((task) => task.projectId === project.id && task.category === "Build");
  if (buildTask) {
    const updated = normalizeTask({
      projectId: project.id, category: "Build", taskType: project.taskType, units: project.pages,
      complexity, assignee, progress: project.progress, status: project.status,
      startDate: project.plannedStartDate, startTime: project.plannedStartTime,
      etaDate: project.plannedEndDate, etaTime: project.plannedEndTime, priorityOrder: buildTask.priorityOrder
    }, { name: project.updatedBy || "Workspace", role: "manager" }, buildTask);
    Object.assign(buildTask, updated);
  }
  return { ...resource, plannedHours: effort.plannedHours, qaBufferHours: effort.qaBufferHours, productionHours: effort.productionHours, ahtHoursPerUnit: effort.ahtHoursPerUnit, plannedStartDate: project.plannedStartDate, plannedStartTime: project.plannedStartTime, plannedEndDate: project.plannedEndDate, plannedEndTime: project.plannedEndTime };
}

function createBuildTask(project, currentUser = { name: "Workspace", role: "manager" }) {
  const existing = data.tasks.find((task) => task.projectId === project.id && task.category === "Build");
  const complexity = project.complexity <= 0.7 ? "Low" : project.complexity >= 1.5 ? "High" : "Medium";
  if (existing) {
    const build = normalizeTask({
      ...existing,
      projectId: project.id, category: "Build", title: `Build · ${project.title}`, taskType: project.taskType,
      units: project.pages, complexity, assignee: project.assignee, progress: project.progress,
      status: project.status, startDate: project.plannedStartDate || existing.startDate,
      startTime: project.plannedStartTime || existing.startTime, dueDate: project.dueDate,
      contractualEtaDate: project.tatDate
    }, currentUser, existing);
    Object.assign(existing, build);
    project.buildTaskId = existing.id;
    project.plannedHours = existing.plannedHours;
    project.plannedStartDate = existing.startDate;
    project.plannedStartTime = existing.startTime;
    project.plannedEndDate = existing.etaDate;
    project.plannedEndTime = existing.etaTime;
    return existing;
  }
  const calendar = scheduleCalendar(project.assignee);
  const startDate = nextBusinessDate(project.plannedStartDate || new Date().toISOString().slice(0, 10), calendar, true);
  const startTime = project.plannedStartTime || shiftStartFor(project.assignee);
  const estimate = estimateTaskEffort("Build", project.taskType, project.pages, complexity, null, projectPlanningRequestType(project));
  const finish = scheduledFinish(startDate, startTime, estimate.plannedHours, calendar, project.assignee);
  const build = normalizeTask({
    projectId: project.id, category: "Build", title: `Build · ${project.title}`, taskType: project.taskType,
    units: project.pages, complexity, assignee: project.assignee, progress: project.progress,
    status: project.status, startDate, startTime, etaDate: finish.date,
    etaTime: finish.time, dueDate: project.dueDate,
    contractualEtaDate: project.tatDate
  }, currentUser, existing);
  data.tasks.push(build);
  project.buildTaskId = build.id;
  project.plannedHours = build.plannedHours;
  project.plannedStartDate = build.startDate;
  project.plannedStartTime = build.startTime;
  project.plannedEndDate = build.etaDate;
  project.plannedEndTime = build.etaTime;
  return build;
}

function workfrontProjectById(workfrontId) {
  return data.workfrontProjects.find((project) => project.workfrontId === workfrontId);
}

function setWorkfrontProductionStage(source, stage) {
  source.productionStage = stage;
  source.stageUpdatedAt = new Date().toISOString();
  const project = data.projects.find((item) => item.workfrontId === source.workfrontId);
  if (project) project.productionStage = stage;
  if (data.workfrontSync) {
    data.workfrontSync.currentProjectRefs = data.workfrontProjects
    .filter((item) => item.productionStage === "Awaiting Audit")
      .map((item) => item.ref);
    data.workfrontSync.projectProductionStageCounts = workfrontCountsBy(data.workfrontProjects, (item) => item.productionStage);
  }
}

function syncWorkfrontTaskStage(task) {
  const project = data.projects.find((item) => item.id === task.projectId);
  if (!project?.workfrontId) return;
  const source = workfrontProjectById(project.workfrontId);
  if (!source) return;
  const activeTasks = data.tasks.filter((item) => item.projectId === project.id && !["Completed", "Archived"].includes(item.status));
  setWorkfrontProductionStage(source, activeTasks.length ? "Execution in progress" : "In QC");
  if (task.category === "Build") {
    project.status = task.status === "Completed" ? "In Review" : task.status;
    project.progress = task.progress;
  }
}

function workfrontComplexityFactor(complexity) {
  const value = String(complexity || "").trim().toLowerCase();
  if (value === "low" || value === "simple") return 0.7;
  if (value === "high" || value === "complex") return 1.5;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 1;
}

function makeNativeWorkfrontProject(source, assignee, startDate, startTime, user) {
  let project = data.projects.find((item) => item.workfrontId === source.workfrontId);
  const today = new Date().toISOString().slice(0, 10);
  if (!project) {
    project = normalizeProject({
      ref: source.ref,
      title: source.title,
      channel: source.channel || source.assetType,
      productionTeamId: source.productionTeamId || "unassigned",
      taskType: TASK_TYPES.includes(source.channel) ? source.channel : "Other",
      requestType: "Standard",
      pages: source.pages || 1,
      complexity: workfrontComplexityFactor(source.complexity),
      progress: 0,
      status: "In Progress",
      dueDate: source.dueDate || today,
      tatDate: source.dueDate || today,
      assignee,
      notes: `Workfront request type: ${source.requestType || "Unspecified"}`
    });
    project.id = crypto.randomUUID();
    project.workfrontId = source.workfrontId;
    project.workfrontRequestType = source.requestType || "";
    project.productionStage = "Execution in progress";
    project.createdAt = new Date().toISOString();
    data.projects.unshift(project);
  } else {
    project.assignee = assignee;
  }
  planAssignedProject(project, assignee, { plannedStartDate: startDate, startTime });
  const task = createBuildTask(project, user);
  source.nativeProjectId = project.id;
  source.nativeTaskId = task.id;
  setWorkfrontProductionStage(source, "Execution in progress");
  return { project, task };
}

function availableStartForAssignee(assignee, plannedHours, preferredDate = new Date().toISOString().slice(0, 10)) {
  const calendar = scheduleCalendar(assignee);
  const ownTasks = data.tasks.filter((task) => task.assignee === assignee && !["Completed", "Archived"].includes(task.status) && task.startDate && task.etaDate);
  let startDate = nextBusinessDate(preferredDate, calendar, true);
  if (ownTasks.length) {
    const latestEnd = ownTasks.map((task) => task.etaDate).sort().at(-1);
    const candidate = nextBusinessDate(latestEnd, calendar);
    if (candidate > startDate) startDate = candidate;
  }
  const dailyCapacity = Number(data.capacityHoursPerDay || 8);
  const startTime = shiftStartFor(assignee);
  return { startDate, startTime, ...scheduledFinish(startDate, startTime, plannedHours / 8 * dailyCapacity, calendar, assignee) };
}

function syncBuildTaskToProject(task) {
  if (task.category !== "Build") return;
  const project = data.projects.find((item) => item.id === task.projectId);
  if (!project) return;
  project.assignee = task.assignee;
  project.plannedHours = task.plannedHours;
  project.plannedStartDate = task.startDate;
  project.plannedStartTime = task.startTime;
  project.plannedEndDate = task.etaDate;
  project.plannedEndTime = task.etaTime;
  project.progress = task.progress;
  project.status = project.workfrontId && task.status === "Completed" ? "In Review" : task.status;
  project.updatedAt = task.updatedAt;
  if (project.workfrontId) syncWorkfrontTaskStage(task);
}

function reflowAssigneeTasks(assignee) {
  if (!assignee) return;
  const assigned = data.tasks.filter((task) => task.assignee === assignee && !["Completed", "Archived"].includes(task.status))
    .sort((a, b) => a.priorityOrder - b.priorityOrder
      || TASK_PRIORITIES.indexOf(b.priority) - TASK_PRIORITIES.indexOf(a.priority)
      || a.startDate.localeCompare(b.startDate)
      || a.createdAt.localeCompare(b.createdAt));
  if (!assigned.length) return;
  const calendar = scheduleCalendar(assignee);
  const today = nextBusinessDate(new Date().toISOString().slice(0, 10), calendar, true);
  let cursor = assigned.map((task) => task.startDate).filter((date) => date >= today).sort()[0] || today;
  for (const task of assigned) {
    if (task.progress > 0 && task.startDate <= today) {
      const finish = scheduledFinish(task.startDate, task.startTime || shiftStartFor(assignee), task.plannedHours, calendar, assignee);
      if (`${finish.date}T${finish.time}` > `${task.etaDate}T${task.etaTime}` && !task.etaOverride) {
        task.etaDate = finish.date;
        task.etaTime = finish.time;
      }
      task.capacityEtaDate = finish.date;
      task.capacityEtaTime = finish.time;
      syncBuildTaskToProject(task);
      if (task.etaDate >= cursor) cursor = nextBusinessDate(task.etaDate, calendar);
      continue;
    }
    const preferredDate = task.startDate > cursor ? task.startDate : cursor;
    const startDate = nextBusinessDate(preferredDate, calendar, true);
    const finish = scheduledFinish(startDate, task.startTime || shiftStartFor(assignee), task.plannedHours, calendar, assignee);
    task.startDate = startDate;
    if (!task.etaOverride) {
      task.etaDate = finish.date;
      task.etaTime = finish.time;
    }
    task.capacityEtaDate = finish.date;
    task.capacityEtaTime = finish.time;
    task.updatedAt = new Date().toISOString();
    syncBuildTaskToProject(task);
    const endDate = task.etaOverride && task.etaDate > finish.date ? task.etaDate : finish.date;
    cursor = nextBusinessDate(endDate, calendar);
  }
}

function taskMetrics(tasks) {
  return tasks.reduce((summary, task) => {
    summary.count += 1;
    summary.plannedHours += Number(task.plannedHours || 0);
    summary.loggedHours += Number(task.loggedHours || 0);
    if (task.status === "Completed") summary.completed += 1;
    else summary.open += 1;
    return summary;
  }, { count: 0, plannedHours: 0, loggedHours: 0, completed: 0, open: 0 });
}

function groupedTaskMetrics(tasks, key) {
  const groups = new Map();
  for (const task of tasks) {
    const label = key(task) || "Unspecified";
    const entry = groups.get(label) || { label, ...taskMetrics([]) };
    entry.count += 1;
    entry.plannedHours += Number(task.plannedHours || 0);
    entry.loggedHours += Number(task.loggedHours || 0);
    if (task.status === "Completed") entry.completed += 1;
    else entry.open += 1;
    groups.set(label, entry);
  }
  return [...groups.values()].map((item) => ({
    ...item,
    plannedHours: Number(item.plannedHours.toFixed(1)),
    loggedHours: Number(item.loggedHours.toFixed(1))
  })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function getProductionInsights(tasks, audits = data.audits) {
  const taskByProject = new Map(data.projects.map((project) => [project.id, project]));
  const auditRows = audits.map((audit) => ({ ...audit, status: audit.auditStatus, plannedHours: 0, loggedHours: 0 }));
  const auditStatuses = groupedTaskMetrics(auditRows, (audit) => audit.status);
  const withDimensions = tasks.map((task) => {
    const project = taskByProject.get(task.projectId);
    return { ...task, market: project?.market || task.market, channel: project?.channel || task.channel };
  });
  return {
    totals: taskMetrics(tasks),
    byCategory: groupedTaskMetrics(tasks, (task) => task.category),
    byCategoryStatus: groupedTaskMetrics(tasks, (task) => `${task.category} · ${task.status}`),
    byStatus: groupedTaskMetrics(tasks, (task) => task.status),
    byChannel: groupedTaskMetrics(withDimensions, (task) => task.channel),
    byComplexity: groupedTaskMetrics(tasks, (task) => task.complexity),
    byDesigner: groupedTaskMetrics(tasks, (task) => task.assignee),
    byCountry: groupedTaskMetrics(withDimensions, (task) => task.market),
    byDpm: groupedTaskMetrics(withDimensions, (task) => task.primaryDpm),
    auditsByStatus: auditStatuses,
    auditsByChannel: groupedTaskMetrics(auditRows, (audit) => audit.channel),
    auditsByComplexity: groupedTaskMetrics(auditRows, (audit) => audit.complexity),
    auditsByCountry: groupedTaskMetrics(auditRows, (audit) => audit.market),
    auditsByDpm: groupedTaskMetrics(auditRows, (audit) => audit.primaryDpm),
    auditsByAuditor: groupedTaskMetrics(auditRows, (audit) => audit.auditor)
  };
}

function settleAuditSession(session, action, user, now = new Date()) {
  if (session.state === "running") {
    let cursor = new Date(session.startedAt);
    if (!Number.isFinite(cursor.getTime()) || cursor > now) throw new HttpError(409, "Audit clock timestamps are invalid; contact your manager.");
    session.elapsedMs += now - cursor;
    while (cursor < now) {
      const midnight = new Date(cursor);
      midnight.setHours(24, 0, 0, 0);
      const end = new Date(Math.min(midnight.getTime(), now.getTime()));
      (data.auditTimeLogs ||= []).push({ id: crypto.randomUUID(), sessionId: session.id, userId: user.id, userName: user.name,
        projectRef: session.projectRef, crId: session.crId, taskCategory: "Asset Audit", date: cursor.toLocaleDateString("en-CA"),
        hours: (end - cursor) / 3600000, note: `Audit ${action}`, createdAt: now.toISOString() });
      cursor = end;
    }

  }
  session.state = action === "hold" ? "held" : "stopped";
  session.startedAt = null;
  session.updatedAt = now.toISOString();
  if (session.state === "stopped") session.endedAt = now.toISOString();
}

// An auditor flagged as a report executor is treated as an executioner in Quality/FTR/KPI reports; accounts, access and Capacity are unchanged.
function reportRole(member) {
  const accountRole = data.users.find((account) => account.name.toLowerCase() === member.name.toLowerCase())?.role;
  return member.reportExecutor === true && accountRole === "auditor" ? "executioner" : accountRole || "executioner";
}

function qaContext(user) {
  const merge = (name, current) => {
    const rows = new Map((data.reportingHistory?.[name] || []).map((row) => [row.workfrontId, row]));
    for (const row of current) rows.set(row.workfrontId, mergeReportingRecord(rows.get(row.workfrontId), row));
    return [...rows.values()];
  };
  return { projects: merge("projects", data.workfrontProjects).filter((project) => userHasDepartment(user, project.productionTeamId))
    .map((project) => ({ ...project, executorSourceName: project.executorName, executor2SourceName: project.executor2Name,
      executorName: rosterNameForWorkfront(project.executorName) || project.executorName,
      executor2Name: rosterNameForWorkfront(project.executor2Name) || project.executor2Name })),
    tasks: merge("tasks", data.workfrontTasks).map((task) => ({ ...task, assignmentNames: mappedAssignmentNames(task) })),
    rounds: merge("rounds", data.workfrontChangeRounds).map((round) => ({ ...round, assignee: rosterNameForWorkfront(round.assignee) || round.assignee })),
    members: data.team.map((member) => ({ ...member, role: reportRole(member) })) };
}

function weeklyQAWorkspace(user) {
  if (!userHasDepartment(user, "design")) return { reports: [], members: [], bugs: [], coverage: "Design team only" };
  const context = qaContext(user);
  const manager = ["manager", "teamManager"].includes(user.role);
  const qaRead = manager || user.role === "leadership" || user.role === "auditor";
  const executionerNames = new Set(context.members.filter((member) => member.role === "executioner" && member.teamIds?.includes("design")).map((member) => member.name));
  const reports = (data.weeklyQAReports || []).filter((report) => qaRead || report.status === "Published").map((report) => ({
    ...report, rows: report.rows.map((row) => ({ ...row, executor: qaExecutorName(row.executor, context.members) }))
      .filter((row) => qaRead || row.executor === user.name).map((row) => ({ ...row, sourceCheck: qaSourceValidation(row, context) }))
  })).filter((report) => qaRead || report.rows.length);
  return { reports, members: context.members.filter((member) => member.role === "executioner" && member.teamIds?.includes("design") && (qaRead || member.name === user.name)),
    bugs: bugUpdateReport(context.tasks, context.projects).map((row) => ({ ...row, assignmentNames: row.assignmentNames.filter((name) => executionerNames.has(name)) }))
      .filter((row) => row.assignmentNames.length && (qaRead || row.assignmentNames.includes(user.name))),
    coverage: "Design only. Published QA bulletin results count directly toward Quality KPI and FTR without mandatory Workfront verification. Bugs mark linked deliveries as rework/FTR failures; manual verification and corrections remain available through a corrected draft. Loaded Workfront Updates are separate review evidence." };
}

function operationalSnapshot(user, anchor = new Date().toLocaleDateString("en-CA"), period = "quarterly") {
  const manager = ["manager", "teamManager"].includes(user.role);
  const teamRead = manager || user.role === "leadership";
  const qualityReviewer = user.role !== "executioner" && user.teamIds?.includes("qa");
  const history = data.reportingHistory || {};
  const merge = (old, current) => {
    const records = new Map((old || []).map((item) => [item.workfrontId, item]));
    for (const item of current) records.set(item.workfrontId, mergeReportingRecord(records.get(item.workfrontId), item));
    return [...records.values()];
  };
  const projects = merge(history.projects, data.workfrontProjects).filter((project) => userHasDepartment(user, project.productionTeamId));
  const projectByRef = new Map(projects.map((project) => [project.ref.toLowerCase(), project]));
  const sourceTasks = merge(history.tasks, data.workfrontTasks).filter((task) => {
    const department = task.productionTeamId || projectByRef.get(task.projectRef.toLowerCase())?.productionTeamId;
    return userHasDepartment(user, department)
      && !(/^engagement lead review$/i.test(task.taskName) && /^in progress$/i.test(task.taskStatus));
  }).map((task) => {
    const latest = (data.sourceWorkLogs || []).filter((log) => log.taskId === task.workfrontId && !log.timerEntry).at(-1);
    const parent = projectByRef.get(task.projectRef.toLowerCase());
    const estimate = parent?.requestType && parent?.pages > 0 && parent?.complexity && !/^bug fixing$/i.test(task.taskName)
      ? validationMatrixEstimate(task.assetType || parent.assetType, parent.requestType, parent.complexity, parent.pages, /^build$/i.test(task.taskName) ? "Build" : "CR") : null;
    return { ...task, assignmentNames: mappedAssignmentNames(task), executionStatus: latest?.status || "",
      ahtHours: task.ahtHours ?? (/^(build|cr(?:\s*\d+)?)$/i.test(task.taskName) ? estimate?.productionHours ?? null : null),
      actualCompletionDate: task.actualCompletionDate || (latest?.status === "Completed" ? latest.date : "") };
  }).filter((task) => !/^bug fixing$/i.test(task.taskName) || task.assignmentNames.some((name) =>
    data.team.some((member) => member.name === name && memberHasDepartment(member, task.productionTeamId || projectByRef.get(task.projectRef.toLowerCase())?.productionTeamId))));
  const rounds = merge(history.rounds, data.workfrontChangeRounds).filter((round) =>
    userHasDepartment(user, round.productionTeamId || projectByRef.get(round.projectRef.toLowerCase())?.productionTeamId))
    .map((round) => {
      const latest = (data.sourceWorkLogs || []).filter((entry) => entry.taskId === round.workfrontId && !entry.timerEntry).at(-1);
      return { ...round, assignee: rosterNameForWorkfront(round.assignee) || round.assignee,
        sourceStatus: latest?.status || round.sourceStatus, completionDate: round.completionDate || (latest?.status === "Completed" ? latest.date : "") };
    });
  const localProjects = data.projects.filter((project) => userCanAccessProject(user, project));
  const projectIds = new Set(localProjects.map((project) => project.id));
  const deliveries = executionDeliveries({ workfrontProjects: projects, workfrontTasks: sourceTasks, workfrontChangeRounds: rounds,
    projects: localProjects, tasks: data.tasks.filter((task) => projectIds.has(task.projectId)) });
  const quality = qualityMatrix(deliveries, data.qaResults || []);
  const qaRows = userHasDepartment(user, "design")
    ? qaQualityRows(qaPublishedRows(data.weeklyQAReports || [], qaContext(user)), projects) : [];
  quality.rows = quality.rows.flatMap((row) => {
    const qa = qaRows.filter((item) => qualityIdentity(item.ref, item.crId) === qualityIdentity(row.ref, row.crId)
      && /^cr/i.test(item.type) === /^cr/i.test(row.type));
    if (!qa.length) return [row];
    const validatedNames = new Set(qa.flatMap((item) => item.names));
    const remaining = row.names.filter((name) => !validatedNames.has(name));
    return [...(remaining.length ? [{ ...row, names: remaining }] : []), ...qa.map((item) => ({ ...row, ...item,
      // The bulletin's delivered date is authoritative for bulletin deliveries, so weekly counts match the published report.
      key: `${row.key}:qa:${item.names[0]}`, completedAt: item.completedAt || row.completedAt,
      completionTimestamp: item.completedAt || row.completionTimestamp,
      plannedCompletionDate: row.plannedCompletionDate || item.plannedCompletionDate }))];
  });
  const additionalQA = qaRows.filter((row) => !quality.rows.some((item) => qualityIdentity(item.ref, item.crId) === qualityIdentity(row.ref, row.crId)
    && /^cr/i.test(item.type) === /^cr/i.test(row.type)));
  quality.rows.push(...additionalQA);
  const members = data.team.map((member) => {
    const account = data.users.find((item) => item.name.toLowerCase() === member.name.toLowerCase());
    return { ...member, id: account?.id || member.id, role: reportRole(member) };
  }).filter((member) => ["executioner", "auditor"].includes(member.role)
    && (user.role === "manager" || member.teamIds?.some((team) => userHasDepartment(user, team))));
  const window = reportingWindow(period, anchor);
  const scoreWindow = reportingWindow("quarterly", anchor);
  const memberIds = new Set(members.map((member) => member.id));
  const issues = (data.kpiIssues || []).filter((issue) => memberIds.has(issue.memberId));
  const reviews = (data.kpiReviews || []).filter((review) => memberIds.has(review.memberId));
  const logs = [...data.workLogs, ...(data.sourceWorkLogs || []), ...(data.auditTimeLogs || [])];
  const scopeLog = (log) => log.userId === user.id || teamRead && data.users.some((account) => account.id === log.userId
    && (user.role === "manager" || (account.teamIds || []).some((team) => userHasDepartment(user, team))));
  const activityLogs = (data.nonProductiveLogs || []).filter(scopeLog);
  const publications = (data.kpiPublications || []).filter((publication) => memberIds.has(publication.memberId));
  const args = { members, deliveries, quality, issues, reviews, workLogs: logs, nonProductiveLogs: activityLogs, requirePublishedDesignQA: true };
  const today = new Date().toLocaleDateString("en-CA");
  const asOf = window.to < today ? window.to : today;
  const quarterRows = kpiReport({ ...args, ...scoreWindow, to: period === "monthly" ? asOf : scoreWindow.to,
    reviewTo: period === "monthly" ? asOf : scoreWindow.to, reviewPeriod: period === "monthly" ? "monthly" : "quarterly" });
  const kpis = kpiPeriodReport({ window, quarterRows, periodRows: kpiReport({ ...args, ...window }), publications });
  const productionNames = new Set(members.filter((member) => member.role === "executioner").map((member) => member.name));
  const ownQuality = quality.rows.map((row) => ({ ...row, names: row.names.filter((name) => productionNames.has(name)) }))
    .filter((row) => row.names.length ? manager || qualityReviewer || user.role === "leadership" || row.names.includes(user.name)
      // Published bulletin deliveries count toward team FTR even when the executor is not a rostered production member.
      : (manager || qualityReviewer || user.role === "leadership") && row.qaPublished && !row.deliveryMissing);
  return { start: REPORTING_START, window, scoreWindow, asOf,
    coverage: "Available imported records only. Missing historical projects, dates or QA confirmations require a historical Workfront import / evidence review. Never inferred from absence of bugs.",
    members: teamRead ? members : members.filter((member) => member.id === user.id),
    deliveries: (manager || qualityReviewer || user.role === "leadership" ? deliveries : deliveries.filter((row) => row.names.includes(user.name))),
    quality: { rows: leadershipReports.qualitySummary(ownQuality).deliveries },
    qualityDeliveries: [...deliveries, ...additionalQA].map((row) => ({ ...row, names: row.names.filter((name) => productionNames.has(name)) }))
      .filter((row) => row.names.length && (manager || qualityReviewer || user.role === "leadership" || row.names.includes(user.name))),
    weeklyQA: weeklyQAWorkspace(user), sla: teamRead || user.role === "auditor" ? slaReport(projects) : [],
    kpis: kpis.filter((row) => teamRead || row.memberId === user.id),
    issues: issues.filter((issue) => teamRead || issue.memberId === user.id).map((issue) => ({ ...issue,
      attachments: (issue.attachments || []).map(({ id, name, size }) => ({ id, name, size })) })),
    feedback: (data.projectFeedback || []).filter((item) => item.userId === user.id || manager && userHasDepartment(user, item.teamId)),
    bestPractices: (data.projectFeedback || []).filter((item) => item.bestPractice && userHasDepartment(user, item.teamId)),
    publications: publications.filter((publication) => teamRead || publication.memberId === user.id),
    productiveLogs: logs.filter(scopeLog),
    activityLogs, checklistTemplates: roleTemplates(user.role) };
}

let leadershipReportScheduler;
let leadershipReportError = "";
function prepareLeadershipReports(now = new Date(), refreshId = "") {
  if (!data.users.length) return false;
  const windows = leadershipReports.dueWindows(now);
  const refresh = refreshId && (data.leadershipReports || []).find((report) => report.id === refreshId);
  if (refresh && !windows.some((window) => `${window.kind}-${window.from}-${window.to}` === refreshId)) windows.push({ kind: refresh.kind, from: refresh.from, to: refresh.to });
  const missing = windows.filter((window) => !(data.leadershipReports || []).some((report) =>
    report.id === `${window.kind}-${window.from}-${window.to}`) || `${window.kind}-${window.from}-${window.to}` === refreshId);
  if (!missing.length) return false;
  const reader = { id: "scheduled-report", name: "Scheduled reports", role: "manager", teamIds: [] };
  const snapshot = operationalSnapshot(reader);
  let preparedReports = [...(data.leadershipReports || [])];
  const reportHistory = [...(data.leadershipReportHistory || [])];
  for (const window of missing) {
    const id = `${window.kind}-${window.from}-${window.to}`;
    const previous = preparedReports.find((report) => report.id === id);
    const report = leadershipReports.buildReport({ window, departments: DEPARTMENTS, members: snapshot.members,
      deliveries: snapshot.deliveries, qualityRows: snapshot.quality.rows,
      logs: snapshot.productiveLogs, activityLogs: snapshot.activityLogs,
      holidays: data.holidays, leaves: data.leaves, capacityHoursPerDay: Number(data.capacityHoursPerDay || 8), now,
      source: { status: data.workfrontAutomation?.status || "Unknown", lastSuccessAt: data.workfrontAutomation?.lastSuccessAt || "" } });
    Object.assign(report, { id, version: (previous?.version || 0) + 1 });
    if (previous) {
      reportHistory.push(previous);
      preparedReports = preparedReports.filter((item) => item.id !== id);
    }
    preparedReports.push(report);
  }
  workspaceStore.save({ ...data, leadershipReports: preparedReports, leadershipReportHistory: reportHistory });
  data.leadershipReports = preparedReports;
  data.leadershipReportHistory = reportHistory;
  leadershipReportError = "";
  return true;
}

function scopedLeadershipReport(user, report) {
  const global = ["manager", "leadership"].includes(user.role);
  const teams = (global ? report.teams : report.teams.filter((team) => (user.teamIds || []).includes(team.id)))
    .map((team) => team.id === "email" ? { ...team, name: "Email + eDetailer Team" } : team);
  return { ...report, teams, totals: leadershipReports.reportTotals(teams),
    coverage: `${report.coverage}${global ? "" : " Scoped team view: Shared/unmapped capacity is excluded; totals are not studio totals."}` };
}

function runLeadershipReportSchedule() {
  try { prepareLeadershipReports(); }
  catch (error) {
    leadershipReportError = "Automatic report preparation failed. Ask a Manager to retry.";
    console.error("Leadership report preparation failed:", error);
  }
}

function processAuditRowAccess(user, row) {
  if (user.role === "manager") return true;
  if (!["teamManager", "auditor"].includes(user.role)) return false;
  if (user.role === "auditor" && row.assetAuditorName.trim().toLowerCase() !== user.name.trim().toLowerCase()) return false;
  const project = [...data.workfrontProjects, ...data.projects].find((item) =>
    [item.ref, item.id, item.workfrontId].some((id) => id && String(id).toLowerCase() === row.projectId.toLowerCase()));
  if (project) return userCanAccessProject(user, project);
  const account = data.users.find((item) => item.name.trim().toLowerCase() === row.assetAuditorName.trim().toLowerCase());
  return Boolean(account && (user.role === "auditor" && account.id === user.id
    || user.role === "teamManager" && userCanManageMember(user, account)));
}

function scopedProcessAudit(user, report) {
  const rows = report.rows.filter((row) => processAuditRowAccess(user, row));
  if (!rows.length) return null;
  return user.role === "manager" ? { ...report, rows } : {
    month: report.month, generatedAt: report.generatedAt, importedAt: report.importedAt,
    ...(report.workloadTeam ? { workloadTeam: report.workloadTeam } : {}),
    sourceFile: "Monthly reviewed JSON evidence report",
    coverageNote: "Only rows within your role and team scope are shown. Source-wide coverage details are restricted to the workspace manager.",
    rows
  };
}

function processAuditMonths(user) {
  if (!["manager", "teamManager", "auditor"].includes(user.role)) return [];
  return (data.processAuditReports || []).map((report) => scopedProcessAudit(user, report)).filter(Boolean)
    .map(processAudit.summarize).sort((a, b) => b.month.localeCompare(a.month));
}

function auditInput(operation) {
  try { return operation(); } catch (error) {
    if (error.status === 400) throw new HttpError(400, error.message);
    throw error;
  }
}

function publicSnapshot(user) {
  const isExecutioner = user.role === "executioner";
  const isAuditor = user.role === "auditor";
  const canViewWorkfront = ["manager", "teamManager", "leadership", "executioner"].includes(user.role) || isAuditor;
  const projectPriorities = new Map(data.workfrontProjects.map((project) => [
    project.ref.toLowerCase(), effectiveWorkfrontPriority(project)
  ]));
  const projects = data.projects.filter((project) => userCanAccessProject(user, project)
    && (!isExecutioner || project.assignee === user.name || data.tasks.some((task) => task.projectId === project.id && task.assignee === user.name)))
    .map((project) => ({ ...project, projectPriority: projectPriorities.get(project.ref.toLowerCase()) || "" }));
  const visibleProjectIds = new Set(projects.map((project) => project.id));
  const prioritiesByProjectId = new Map(projects.map((project) => [project.id, project.projectPriority]));
  const tasks = data.tasks.filter((task) => visibleProjectIds.has(task.projectId) && (!isExecutioner || task.assignee === user.name))
    .map((task) => ({ ...task, projectPriority: prioritiesByProjectId.get(task.projectId) || "" }));
  const visibleAudits = data.audits.filter((audit) => {
    if (["manager", "leadership"].includes(user.role)) return true;
    const project = data.projects.find((item) => item.ref.toLowerCase() === audit.projectRef.toLowerCase());
    const workfront = data.workfrontProjects.find((item) => item.ref.toLowerCase() === audit.projectRef.toLowerCase());
    const departmentId = project ? projectDepartmentId(project) : workfront?.productionTeamId || departmentIdForChannel(audit.channel);
    return userHasDepartment(user, departmentId);
  });
  const visibleWorkfrontProjects = canViewWorkfront
    ? data.workfrontProjects.filter((project) => userHasDepartment(user, project.productionTeamId)
      && (!isExecutioner || data.workfrontTasks.some((task) => task.projectRef.toLowerCase() === project.ref.toLowerCase() && isWorkfrontAssignee(task, user.name))
        || data.workfrontChangeRounds.some((round) => round.projectRef.toLowerCase() === project.ref.toLowerCase() && rosterNameForWorkfront(round.assignee) === user.name)))
      .map((project) => ({ ...project,
        priority: projectPriorities.get(project.ref.toLowerCase()) || "",
        priorityPolicy: isGdBannerDesignProject(project) ? "GD Banner email-dependent rule" : ""
      }))
    : [];
  const visibleWorkfrontRounds = canViewWorkfront
    ? data.workfrontChangeRounds.filter((round) => {
      const parent = data.workfrontProjects.find((project) => project.ref.toLowerCase() === round.projectRef.toLowerCase());
      return userHasDepartment(user, round.productionTeamId || parent?.productionTeamId)
        && (!isExecutioner || rosterNameForWorkfront(round.assignee) === user.name);
    }).map((round) => {
      const parent = data.workfrontProjects.find((project) => project.ref.toLowerCase() === round.projectRef.toLowerCase());
      const estimate = parent?.requestType && parent?.pages > 0
        ? validationMatrixEstimate(round.assetType || parent.assetType, parent.requestType, round.complexity || parent.complexity, parent.pages, "CR")
        : null;
      const latest = (data.sourceWorkLogs || []).filter((entry) => entry.taskId === round.workfrontId && !entry.timerEntry).at(-1);
      return { ...round, assignee: rosterNameForWorkfront(round.assignee) || round.assignee, projectPriority: projectPriorities.get(round.projectRef.toLowerCase()) || "", projectStatus: parent?.sourceStatus || "", ahtHours: estimate?.productionHours ?? null, qaAhtHours: estimate?.qaHours ?? null,
        executionStatus: latest?.status || "", executionProgress: latest?.progress ?? null,
        actualCompletionDate: round.completionDate || (latest?.status === "Completed" ? latest.date : "") };
    })
    : [];
  const visibleWorkfrontTasks = canViewWorkfront
    ? data.workfrontTasks.flatMap((task) => {
      const parent = data.workfrontProjects.find((project) => project.ref.toLowerCase() === task.projectRef.toLowerCase());
      if (!userHasDepartment(user, task.productionTeamId || parent?.productionTeamId)) return [];
      if (/^engagement lead review$/i.test(task.taskName) && /^in progress$/i.test(task.taskStatus)) return [];
      if (/^bug fixing$/i.test(task.taskName) && !mappedAssignmentNames(task).some((name) =>
        data.team.some((member) => member.name === name && memberHasDepartment(member, task.productionTeamId || parent?.productionTeamId)))) return [];
      if (isExecutioner && !isWorkfrontAssignee(task, user.name)) return [];
      const logs = (data.sourceWorkLogs || []).filter((entry) => entry.taskId === task.workfrontId);
      const latest = logs.filter((entry) => !entry.timerEntry).at(-1);
      const campaign = workfrontIsCampaignAsset(task.assetType || parent?.assetType);
      const estimate = (campaign || parent?.requestType && parent?.pages > 0 && parent?.complexity) && task.taskName !== "Bug Fixing"
        ? validationMatrixEstimate(task.assetType || parent?.assetType, parent?.requestType, parent?.complexity, parent?.pages, task.taskName === "Build" ? "Build" : "CR")
        : null;
      const productionEstimate = task.taskName === "Bug Fixing" && !campaign && parent?.requestType && parent?.pages > 0 && parent?.complexity
        ? validationMatrixEstimate(task.assetType, parent.requestType, parent.complexity, parent.pages, "CR")
        : null;
      let bugFixHours = null;
      if (task.taskName === "Bug Fixing") {
        const buildEstimate = campaign || parent?.requestType && parent?.pages > 0 && parent?.complexity
          ? validationMatrixEstimate(task.assetType || parent?.assetType, parent?.requestType, parent?.complexity, parent?.pages, "Build")
          : null;
        const buildTask = data.workfrontTasks.find((item) => item.taskName === "Build" && item.projectRef.toLowerCase() === task.projectRef.toLowerCase());
        const buildHours = buildEstimate?.productionHours ?? (Number(buildTask?.plannedHours) || null);
        bugFixHours = bugFixEffortHours(productionEstimate?.productionHours ?? null, buildHours);
      }
      return [{ ...task, workfrontAssignmentNames: task.assignmentNames || [], assignmentNames: mappedAssignmentNames(task), projectStatus: parent?.sourceStatus || "", projectPriority: projectPriorities.get(task.projectRef.toLowerCase()) || "", executionLoggedHours: logs.reduce((sum, entry) => sum + entry.hours, 0),
        executionProgress: latest?.progress ?? null, executionStatus: latest?.status || "",
        actualCompletionDate: task.actualCompletionDate || (latest?.status === "Completed" ? latest.date : ""), qaAhtHours: estimate?.qaHours ?? null,
        ahtHours: task.taskName === "Bug Fixing" ? bugFixHours : estimate?.productionHours ?? null,
        auditAhtHours: /^asset audit$/i.test(task.taskName) && !campaign && parent?.requestType && parent?.pages > 0 && parent?.complexity
          ? validationMatrixEstimate(task.assetType || parent.assetType, parent.requestType, parent.complexity, parent.pages, "Build")?.auditHours ?? null
          : null }];
    })
    : [];
  const visibleWorkfrontGanttTasks = canViewWorkfront
    ? data.workfrontTasks.filter((task) => {
      if (!/^bug fixing$/i.test(task.taskName)) return false;
      const parent = data.workfrontProjects.find((project) => project.ref.toLowerCase() === task.projectRef.toLowerCase());
      if (!userHasDepartment(user, task.productionTeamId || parent?.productionTeamId)) return false;
      if (isExecutioner && !isWorkfrontAssignee(task, user.name)) return false;
      return !visibleWorkfrontTasks.some((visibleTask) => visibleTask.workfrontId === task.workfrontId);
    }).map((task) => {
      const parent = data.workfrontProjects.find((project) => project.ref.toLowerCase() === task.projectRef.toLowerCase());
      const logs = (data.sourceWorkLogs || []).filter((entry) => entry.taskId === task.workfrontId);
      const latest = logs.filter((entry) => !entry.timerEntry).at(-1);
      return { ...task, assignmentNames: mappedAssignmentNames(task), workfrontAssignmentNames: task.assignmentNames || [],
        projectStatus: parent?.sourceStatus || "", projectPriority: projectPriorities.get(task.projectRef.toLowerCase()) || "",
        executionLoggedHours: logs.reduce((sum, entry) => sum + entry.hours, 0),
        executionProgress: latest?.progress ?? null, executionStatus: latest?.status || "",
        actualCompletionDate: task.actualCompletionDate || (latest?.status === "Completed" ? latest.date : "") };
    })
    : [];
  const visibleLeaves = (data.leaves || []).filter((leave) => {
    if (["manager", "leadership"].includes(user.role)) return true;
    const member = data.team.find((item) => item.name.toLowerCase() === leave.assignee.toLowerCase());
    if (leave.status !== "Approved") {
      if (leave.assignee.toLowerCase() === user.name.toLowerCase()) return true;
        return userCanManageMember(user, member);
    }
    return leave.assignee.toLowerCase() === user.name.toLowerCase()
      || (member?.teamIds || []).some((departmentId) => userHasDepartment(user, departmentId));
  }).map((leave) => {
    const visibleLeave = publicLeave(leave, user);
    if (visibleLeave?.impacts && user.role === "teamManager") {
      const visibleTaskIds = new Set(tasks.map((task) => task.id));
      return { ...visibleLeave, impacts: visibleLeave.impacts.filter((impact) => visibleTaskIds.has(impact.taskId)) };
    }
    return visibleLeave;
  }).filter(Boolean);
  const visibleTeam = ["manager", "leadership"].includes(user.role) ? data.team : data.team.filter((member) =>
    member.name.toLowerCase() === user.name.toLowerCase()
    || (member.teamIds || []).some((departmentId) => userHasDepartment(user, departmentId))
  );
  const visibleLogs = data.workLogs.filter((entry) => visibleProjectIds.has(entry.projectId) && (!isExecutioner || entry.userId === user.id));
  const visibleChangeRounds = isExecutioner ? [] : data.changeRounds.filter((round) => visibleProjectIds.has(round.projectId));
  const visibleWorkfrontSync = canViewWorkfront && data.workfrontSync ? {
    ...(userHasDepartment(user, "") ? data.workfrontSync : {}),
    syncedAt: data.workfrontSync.syncedAt,
    projectMissingColumns: data.workfrontSync.projectMissingColumns || [],
    currentProjectRefs: visibleWorkfrontProjects.filter((project) => project.productionStage === "Awaiting Audit").map((project) => project.ref),
    projectDepartments: Object.fromEntries(workfrontCountsBy(visibleWorkfrontProjects, (project) => project.workfrontTeam).map(({ label, count }) => [label, count])),
    projectStatusCounts: workfrontCountsBy(visibleWorkfrontProjects, (project) => project.sourceStatus),
    projectTeamStatusCounts: workfrontCountsBy(visibleWorkfrontProjects, (project) => `${project.workfrontTeam} · ${project.sourceStatus}`),
    changeRoundStatusCounts: workfrontCountsBy(visibleWorkfrontRounds, (round) => round.sourceStatus),
    changeRoundExecutionCounts: workfrontCountsBy(visibleWorkfrontRounds, (round) => round.executionAssignment),
    tasks: userHasDepartment(user, "") ? { ...(data.workfrontSync.tasks || {}), total: visibleWorkfrontTasks.length } : { total: visibleWorkfrontTasks.length },
    projectProductionStageCounts: workfrontCountsBy(visibleWorkfrontProjects, (project) => project.productionStage),
    projects: userHasDepartment(user, "") ? { ...(data.workfrontSync.projects || {}), total: visibleWorkfrontProjects.length } : { total: visibleWorkfrontProjects.length },
    changeRounds: userHasDepartment(user, "") ? { ...(data.workfrontSync.changeRounds || {}), total: visibleWorkfrontRounds.length } : { total: visibleWorkfrontRounds.length },
    projectsInQa: visibleWorkfrontProjects.filter((project) => project.qaQueue).length,
    changeRoundsInQa: visibleWorkfrontRounds.filter((round) => round.qaQueue).length
  } : null;
  const aht = isExecutioner ? null : getAhtSummary(visibleProjectIds);
  if (aht && !userHasDepartment(user, "")) {
    const canViewMatrixChannel = (row) => userHasDepartment(user, departmentIdForMatrixChannel(row.channel));
    aht.validationMatrix.records = aht.validationMatrix.records.filter(canViewMatrixChannel);
    aht.validationMatrix.addOns = aht.validationMatrix.addOns.filter(canViewMatrixChannel);
  }
  const snapshotNow = new Date();
  const operations = productionOperations({ projects, tasks, workfrontProjects: visibleWorkfrontProjects, workfrontTasks: visibleWorkfrontTasks,
    team: visibleTeam.map((member) => ({ ...member, role: data.users.find((account) => account.name.toLowerCase() === member.name.toLowerCase())?.role || "executioner" })),
    leaves: visibleLeaves, holidays: data.holidays, capacityHoursPerDay: data.capacityHoursPerDay }, snapshotNow.toLocaleDateString("en-CA"), snapshotNow);
  for (const resource of operations.resources) {
    if (resource.unknownTasks) continue;
    const today = new Date().toLocaleDateString("en-CA");
    const calendar = scheduleCalendar(resource.name);
    let start = nextBusinessDate(today, calendar, true);
    let time = start === today ? [shiftStartFor(resource.name), new Date().toTimeString().slice(0, 5)].sort().at(-1) : shiftStartFor(resource.name);
    if (time >= shiftEndFor(resource.name)) {
      start = nextBusinessDate(start, calendar, false);
      time = shiftStartFor(resource.name);
    }
    const finish = scheduledFinish(start, time, resource.remainingHours, calendar, resource.name);
    resource.availableDate = finish.date;
    resource.availableTime = finish.time;
  }
  return {
    user,
    operationsWorkspace: operationalSnapshot(user),
    users: user.role === "manager" ? data.users.map(publicUser) : [],
    team: visibleTeam.map((member) => ({
      ...member,
      role: data.users.find((account) => account.name.toLowerCase() === member.name.toLowerCase())?.role || "executioner"
    })),
    departments: DEPARTMENTS,
    unmappedWorkfrontAssignees: user.role === "manager"
      ? [...new Set(data.workfrontTasks.flatMap((task) => (task.assignmentNames || []).filter((name) => !rosterNameForWorkfront(name))))].sort((a, b) => a.localeCompare(b))
      : [],
    projects,
    tasks,
    audits: isExecutioner ? [] : visibleAudits,
    processAuditMonths: processAuditMonths(user),
    hygiene: !isExecutioner && ["manager", "teamManager", "auditor"].includes(user.role)
      ? processAdherence(visibleWorkfrontProjects, visibleWorkfrontTasks, visibleAudits, { verifications: data.hygieneVerifications || [], rounds: visibleWorkfrontRounds,
        auditorNames: data.users.filter((account) => ["auditor", "manager", "teamManager"].includes(account.role)).map((account) => account.name) }) : [],
    auditSessions: (data.auditSessions || []).filter((entry) => entry.userId === user.id || ["manager", "teamManager"].includes(user.role) && userHasDepartment(user, entry.teamId)),
    execution: (() => {
      const deliveries = executionDeliveries({ projects, tasks, workfrontProjects: visibleWorkfrontProjects,
        workfrontTasks: visibleWorkfrontTasks, workfrontChangeRounds: visibleWorkfrontRounds });
      const own = (isExecutioner || isAuditor ? deliveries.filter((row) => row.names.includes(user.name)) : deliveries).map((row) => {
        const audit = visibleAudits.filter((item) => item.projectRef.toLowerCase() === row.ref.toLowerCase()
          && (item.crId || "") === (row.crId || "")).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
        return { ...row, handoff: { inputDocuments: audit?.documents || [],
          functionalLink: /^https:\/\//i.test(audit?.functionalDoc || "") ? audit.functionalDoc : "",
          styleLink: /^https:\/\//i.test(audit?.styleGuideDoc || "") ? audit.styleGuideDoc : "" } };
      });
      return { deliveries: own, quality: qualityMatrix(own, data.qaResults || []),
        timer: (data.executionTimers || []).find((timer) => timer.userId === user.id) || null,
        checklists: (data.executionChecklists || []).filter((item) => item.userId === user.id && own.some((row) => row.key === item.deliveryKey)) };
    })(),
    workLogs: isExecutioner ? data.workLogs.filter((entry) => entry.userId === user.id && visibleProjectIds.has(entry.projectId)) : visibleLogs,
    marketMatrix: ["manager", "teamManager"].includes(user.role) || isAuditor ? data.marketMatrix : [],
    holidays: data.holidays,
    leaves: visibleLeaves,
    workfrontProjects: visibleWorkfrontProjects.map((project) => ({ ...project,
      auditAhtHours: !workfrontIsCampaignAsset(project.assetType) && project.requestType && project.pages > 0 && project.complexity
        ? validationMatrixEstimate(project.assetType, project.requestType, project.complexity, project.pages, "Build")?.auditHours ?? null
        : null })),
    workfrontChangeRounds: visibleWorkfrontRounds,
    workfrontTasks: visibleWorkfrontTasks,
    workfrontGanttTasks: visibleWorkfrontGanttTasks,
    sourceWorkLogs: (data.sourceWorkLogs || []).filter((entry) => (visibleWorkfrontTasks.some((task) => task.workfrontId === entry.taskId)
      || visibleWorkfrontRounds.some((round) => round.workfrontId === entry.taskId)) && (!isExecutioner || entry.userId === user.id)),
    notifications: (data.notifications || []).filter((entry) => entry.userId === user.id),
    operations,
    workfrontSync: visibleWorkfrontSync,
    workfrontAutomation: canViewWorkfront ? publicWorkfrontAutomation() : null,
    workfrontLogin: user.role === "manager" ? getWorkfrontLoginStatus() : null,
    changeRounds: visibleChangeRounds,
    aht,
    ganttLogs: data.workLogs.filter((entry) => visibleProjectIds.has(entry.projectId) && (!isExecutioner || entry.userId === user.id)),
    performance: getUserPerformance(user, visibleProjectIds),
    productionInsights: isExecutioner ? null : getProductionInsights(tasks, visibleAudits),
    capacityHoursPerDay: Number(data.capacityHoursPerDay || 8),
    complexityMultipliers: isExecutioner ? null : data.complexityMultipliers,
    roleCapabilities: {
      manageWorkspace: user.role === "manager",
      manageProjects: ["manager", "teamManager"].includes(user.role) || isAuditor,
      manageAudits: ["manager", "teamManager"].includes(user.role) || isAuditor,
      manageTeamLeave: ["manager", "teamManager"].includes(user.role),
      applyForLeave: true,
      viewWorkfront: canViewWorkfront,
      manageWorkfrontSync: user.role === "manager",
      viewManagerReports: ["manager", "teamManager", "leadership"].includes(user.role),
      allocateTasks: ["manager", "teamManager"].includes(user.role) || isAuditor,
      selfAssign: user.role === "executioner",
      viewAllPerformance: user.role !== "executioner",
      viewAht: user.role !== "executioner",
      viewPerformance: true,
      viewAudits: !isExecutioner,
      viewChangeRounds: !isExecutioner,
      viewMarketMatrix: user.role === "manager",
      manageHolidays: ["manager", "teamManager"].includes(user.role),
      viewHygiene: ["manager", "teamManager", "auditor"].includes(user.role),
      viewQuality: true,
      confirmQuality: (user.teamIds || []).includes("qa") && user.role !== "executioner",
      viewExecution: isExecutioner || isAuditor,
      viewAllProjects: !isExecutioner,
      createOwnTasks: true
    }
  };
}

function getUserPerformance(user, projectIds = null) {
  const logs = data.workLogs.filter((entry) => (user.role === "executioner" ? entry.userId === user.id : true)
    && (!projectIds || projectIds.has(entry.projectId)));
  const hours = logs.reduce((sum, entry) => sum + Number(entry.hours || 0), 0);
  const projects = new Set(logs.map((entry) => entry.projectId));
  const completed = new Set(logs.filter((entry) => entry.progress >= 100 || entry.status === "Completed").map((entry) => entry.projectId));
  return { hours: Number(hours.toFixed(2)), logCount: logs.length, activeProjects: projects.size - completed.size, completedProjects: completed.size };
}

async function createAccount(input, role = "executioner") {
  const username = requireText(input.username, "Username", 32);
  const name = requireText(input.name, "Full name", 100);
  const password = typeof input.password === "string" ? input.password : "";
  if (!USERNAME_RE.test(username)) throw new HttpError(400, "Username must be 3-32 characters: letters, numbers, dot, underscore or hyphen.");
  if (password.length < 10 || password.length > 200) throw new HttpError(400, "Password must be at least 10 characters.");
  if (data.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) throw new HttpError(409, "That username is already in use.");
  const salt = crypto.randomBytes(16);
  const passwordHash = await scrypt(password, salt, 64);
  const normalizedRole = enumValue(role, USER_ROLES, "Account role");
  const teamIds = normalizedRole === "manager" ? [...DEPARTMENT_IDS]
    : normalizedRole === "leadership" ? []
      : validDepartmentIds(input.teamIds);
  if (!["manager", "leadership"].includes(normalizedRole) && !teamIds.length) {
    throw new HttpError(400, "Assign at least one team / department to this account.");
  }
  const user = { id: crypto.randomUUID(), username, name, role: normalizedRole, teamIds, salt: salt.toString("hex"), passwordHash: passwordHash.toString("hex"), createdAt: new Date().toISOString() };
  data.users.push(user);
  const member = data.team.find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (!member) data.team.push({ id: crypto.randomUUID(), name, shiftStart: EARLY_START_TIME, shiftEnd: NEW_SHIFT_END_TIME, teamIds: [...teamIds] });
  else member.teamIds = [...teamIds];
  await persist();
  return user;
}

function startSession(res, user, secure) {
  const token = crypto.randomBytes(32).toString("base64url");
  const key = crypto.createHash("sha256").update(token).digest("hex");
  sessions.set(key, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  setSessionCookie(res, token, secure);
}

function enforceLoginLimit(ip) {
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (attempts.length >= 10) throw new HttpError(429, "Too many sign-in attempts. Wait 15 minutes and try again.");
  attempts.push(now);
  loginAttempts.set(ip, attempts);
}

async function routeApi(req, res, url, secure) {
  const method = req.method;
  const pathname = url.pathname;
  if (method === "GET" && pathname === "/api/auth/status") {
    const session = getSession(req);
    const user = session ? data.users.find((item) => item.id === session.userId) : null;
    return sendJson(res, 200, { setupRequired: data.users.length === 0, user: user ? publicUser(user) : null });
  }

  if (method === "POST") checkOrigin(req);
  if (method === "POST" && pathname === "/api/auth/setup") {
    if (data.users.length !== 0 || setupInProgress) throw new HttpError(409, "Initial setup is already complete.");
    setupInProgress = true;
    try {
      const user = await createAccount(await readJson(req), "manager");
      startSession(res, user, secure);
      return sendJson(res, 201, { user: publicUser(user) });
    } finally {
      setupInProgress = false;
    }
  }
  if (method === "POST" && pathname === "/api/auth/login") {
    enforceLoginLimit(req.socket.remoteAddress || "unknown");
    const input = await readJson(req);
    const username = cleanText(input.username, 32);
    const password = typeof input.password === "string" ? input.password : "";
    const user = data.users.find((item) => item.username.toLowerCase() === username.toLowerCase());
    const salt = user ? Buffer.from(user.salt, "hex") : Buffer.alloc(16);
    const expected = user ? Buffer.from(user.passwordHash, "hex") : Buffer.alloc(64);
    const actual = await scrypt(password, salt, 64);
    if (!user || !crypto.timingSafeEqual(expected, actual)) throw new HttpError(401, "Username or password is incorrect.");
    loginAttempts.delete(req.socket.remoteAddress || "unknown");
    startSession(res, user, secure);
    return sendJson(res, 200, { user: publicUser(user) });
  }
  if (method === "POST" && pathname === "/api/auth/logout") {
    const user = requireUser(req);
    sessions.delete(user.sessionKey);
    clearSessionCookie(res, secure);
    return sendJson(res, 200, { ok: true });
  }

  const user = requireUser(req);
  if (pathname === "/api/process-audit-reports" && method === "GET") {
    requireRole(user, ["manager", "teamManager", "auditor"]);
    return sendJson(res, 200, { months: processAuditMonths(user), categories: processAudit.CATEGORIES, statuses: processAudit.STATUSES });
  }
  if (pathname === "/api/process-audit-reports" && method === "POST") {
    requireRole(user, ["manager", "teamManager"]);
    const input = await readJson(req, processAudit.REPORT_LIMIT + 1024);
    const report = auditInput(() => processAudit.validateReport(input.report));
    const previous = (data.processAuditReports || []).find((item) => item.month === report.month);
    if (previous && input.replaceExisting !== true) throw new HttpError(409, "This month already exists. Explicitly confirm whole-month replacement.");
    if ([...report.rows, ...(previous?.rows || [])].some((row) => !processAuditRowAccess(user, row))) {
      throw new HttpError(403, "Monthly import/replacement includes projects outside your team. A workspace manager must import this whole month.");
    }
    const entry = { ...report, importedAt: new Date().toISOString(), importedBy: user.id };
    data.processAuditReports = [...(data.processAuditReports || []).filter((item) => item.month !== report.month), entry];
    await persist();
    return sendJson(res, previous ? 200 : 201, processAudit.summarize(entry));
  }
  const processAuditMatch = pathname.match(/^\/api\/process-audit-reports\/([^/]+)(\/xlsx)?$/);
  if (processAuditMatch && method === "GET") {
    requireRole(user, ["manager", "teamManager", "auditor"]);
    const month = auditInput(() => processAudit.validMonth(processAuditMatch[1]));
    const stored = (data.processAuditReports || []).find((item) => item.month === month);
    const report = stored && scopedProcessAudit(user, stored);
    if (!report) throw new HttpError(404, "No monthly Process Audit report in your scope.");
    const rows = auditInput(() => processAudit.filterRows(report.rows, {
      search: url.searchParams.get("search") || "", category: url.searchParams.get("category") || "", status: url.searchParams.get("status") || ""
    }));
    if (!processAuditMatch[2]) return sendJson(res, 200, { ...report,
      rows: rows.map((row) => ({ ...row, finding: processAudit.findingSummary(row, report.workloadTeam) })),
      summary: processAudit.summarize(report), filteredRowCount: rows.length });
    const workbook = await processAudit.reportWorkbook(report, rows);
    res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="process-audit-${month}.xlsx"`, "Content-Length": workbook.length, "Cache-Control": "no-store" });
    return res.end(workbook);
  }
  if (method === "POST" && pathname === "/api/leadership-reports/prepare") {
    requireRole(user, ["manager"]);
    await readJson(req);
    prepareLeadershipReports();
    return sendJson(res, 200, { prepared: true });
  }
  if (method === "GET" && pathname === "/api/leadership-reports") {
    requireRole(user, ["manager", "teamManager", "leadership"]);
    return sendJson(res, 200, { schedule: "09:00 Asia/Kolkata daily; Mondays include the previous Monday–Sunday. Startup catches up the latest due periods. App must be running; reports are not emailed.",
      error: leadershipReportError, reports: (data.leadershipReports || []).map((report) => scopedLeadershipReport(user, report))
        .filter((report) => report.teams.length).sort((a, b) => b.to.localeCompare(a.to) || a.kind.localeCompare(b.kind))
        .map(({ id, kind, from, to, generatedAt, version, teams }) => ({ id, kind, from, to, generatedAt, version,
          reviewed: teams.every((team) => team.reviewedAt) })) });
  }
  const leadershipMatch = pathname.match(/^\/api\/leadership-reports\/([a-z0-9-]+)(?:\/(xlsx|review|refresh))?$/);
  if (leadershipMatch) {
    requireRole(user, ["manager", "teamManager", "leadership"]);
    const stored = (data.leadershipReports || []).find((report) => report.id === leadershipMatch[1]);
    if (!stored) throw new HttpError(404, "Report not found.");
    let report = scopedLeadershipReport(user, stored);
    if (!report.teams.length) throw new HttpError(404, "Report not in your scope.");
    const teamId = url.searchParams.get("team");
    if (teamId) {
      report.teams = report.teams.filter((team) => team.id === teamId);
      if (!report.teams.length) throw new HttpError(403, "Team is outside your report scope.");
      report.totals = leadershipReports.reportTotals(report.teams);
    }
    if (method === "POST" && leadershipMatch[2] === "refresh") {
      requireRole(user, ["manager"]);
      const input = await readJson(req);
      if (input.version !== stored.version) throw new HttpError(409, "Report version changed. Reload before preparing a revision.");
      const note = requireText(input.note, "Reason for preparing a new version", 2000);
      prepareLeadershipReports(new Date(), stored.id);
      const updated = data.leadershipReports.find((item) => item.id === stored.id);
      updated.revisionNote = note;
      updated.revisedBy = user.name;
      await persist();
      return sendJson(res, 200, scopedLeadershipReport(user, updated));
    }
    if (method === "POST" && leadershipMatch[2] === "review") {
      requireRole(user, ["manager", "teamManager"]);
      const input = await readJson(req);
      if (input.version !== stored.version) throw new HttpError(409, "Report version changed. Reload before reviewing.");
      const note = requireText(input.note, "Review note", 2000);
      const teams = report.teams;
      for (const team of stored.teams.filter((team) => teams.some((entry) => entry.id === team.id))) {
        (team.reviewHistory ||= []).push({ by: user.name, at: new Date().toISOString(), note });
        team.reviewedBy = user.name;
        team.reviewedAt = new Date().toISOString();
        team.reviewNote = note;
      }
      await persist();
      return sendJson(res, 200, { reviewed: true });
    }
    if (method === "GET" && !leadershipMatch[2]) return sendJson(res, 200, { ...report, bulletin: leadershipReports.bulletin(report) });
    if (method === "GET" && leadershipMatch[2] === "xlsx") {
      const workbook = await leadershipReports.reportWorkbook(report);
      res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${stored.id}${teamId ? `-${report.teams[0].id}` : ""}.xlsx"`,
        "Content-Length": workbook.length, "Cache-Control": "no-store" });
      return res.end(workbook);
    }
    throw new HttpError(405, "Unsupported report action.");
  }
  if (method === "GET" && pathname === "/api/data") return sendJson(res, 200, publicSnapshot(publicUser(data.users.find((item) => item.id === user.id))));
  if (method === "GET" && pathname === "/api/operations") {
    const anchor = validDate(url.searchParams.get("date") || new Date().toLocaleDateString("en-CA"), "Reporting date");
    if (anchor < REPORTING_START) throw new HttpError(400, "Reporting starts on 1 July 2026.");
    const period = enumValue(url.searchParams.get("period") || "quarterly", ["monthly", "quarterly", "half-yearly", "yearly"], "KPI period");
    return sendJson(res, 200, operationalSnapshot(user, anchor, period));
  }
  if (method === "POST" && ["/api/weekly-qa", "/api/weekly-qa/import"].includes(pathname)) {
    requireRole(user, ["manager", "teamManager", "auditor"]);
    if (!userHasDepartment(user, "design")) throw new HttpError(403, "Weekly Quality reports are restricted to Design.");
    const input = await readJson(req, WORKFRONT_BODY_LIMIT);
    const from = validDate(input.from, "Week start");
    const to = validDate(input.to, "Week end");
    const week = reportingWindow("weekly", from);
    if (from < REPORTING_START || from !== week.from || to !== week.to) throw new HttpError(400, "Select a Monday–Sunday week from 1 July 2026.");
    let parsed = { deliveries: [], bugs: [] };
    if (pathname.endsWith("/import")) {
      const sheets = await readWorkbookUpload(input.file, "Weekly QA");
      try { parsed = parseQAWorkbook(sheets); } catch (error) { throw new HttpError(400, error.message); }
      if (parsed.deliveries.some((row) => row.deliveredDate < from || row.deliveredDate > to)) throw new HttpError(400, "Every delivery date must fall within the selected report week.");
    }
    const sourceHash = input.file ? crypto.createHash("sha256").update(input.file.contentBase64).digest("hex") : "";
    if (sourceHash && (data.weeklyQAReports || []).some((report) => report.sourceHash === sourceHash && report.from === from)) throw new HttpError(409, "This QA workbook/week was already imported. Open its draft or create a revision.");
    const context = qaContext(user);
    const unmatched = parsed.unmatchedBugs || [];
    const orphanDeliveries = [...new Map(unmatched.map((bug) => [`${bug.qaTaskId}:${bug.projectRef}`, { ...bug, executor: "", deliveryMissing: true, bugCreated: true }])).values()];
    const candidates = [...parsed.deliveries, ...orphanDeliveries];
    const rows = candidates.flatMap((row) => {
      const project = qaProjectMatch(context.projects, row.projectRef);
      const executor = qaExecutorName(rosterNameForWorkfront(row.executor) || row.executor, context.members);
      const designMember = context.members.some((member) => member.name === executor && member.teamIds?.includes("design"));
      const designChannel = /^(print|ipdf|ppt|ppt\/gslide|static banner)$/i.test(row.channel);
      if (project ? project.productionTeamId !== "design" : !designMember && !designChannel) return [];
      const bugs = parsed.bugs.filter((bug) => bug.qaTaskId === row.qaTaskId && bug.projectRef === row.projectRef);
      return [{ ...row, sourceProjectRef: row.projectRef, projectRef: project?.ref || row.projectRef,
        id: crypto.randomUUID(), originalExecutor: row.executor, executor, crId: "", validation: null,
        sourceBugCreated: row.bugCreated, bugCreated: row.bugCreated || bugs.length > 0, bugs }];
    });
    const entry = { id: crypto.randomUUID(), from, to, status: "Draft", version: 0, rows, sourceHash,
      sourceFile: cleanText(input.file?.name, 240), importedAt: new Date().toISOString(), importedBy: user.name,
      note: requireText(input.note, "QA source / report note", 4000), sourceTotals: { deliveries: parsed.deliveries.length, bugRows: parsed.bugs.length,
        affectedDeliveries: parsed.deliveries.filter((row) => row.bugCreated).length, unmatchedBugRows: unmatched.length,
        designCandidates: rows.length, excludedOtherTeams: candidates.length - rows.length } };
    (data.weeklyQAReports ||= []).push(entry);
    await persist();
    return sendJson(res, 201, entry);
  }
  const weeklyMatch = pathname.match(/^\/api\/weekly-qa\/([a-f0-9-]{36})\/(rows|match|publish|revise|recall)(?:\/([a-f0-9-]{36}))?$/i);
  if (weeklyMatch && ["POST", "PUT"].includes(method)) {
    requireRole(user, ["manager", "teamManager", "auditor"]);
    if (!userHasDepartment(user, "design")) throw new HttpError(403, "Weekly Quality reports are restricted to Design.");
    const report = (data.weeklyQAReports || []).find((item) => item.id === weeklyMatch[1]);
    if (!report) throw new HttpError(404, "Weekly QA report not found.");
    const action = weeklyMatch[2];
    const input = await readJson(req);
    if (["match", "publish", "recall", "revise"].includes(action)) requireRole(user, ["manager", "teamManager"]);
    if (action === "revise" && method === "POST") {
      if (report.status !== "Published") throw new HttpError(409, "Only a published report can be revised.");
      const note = requireText(input.note, "Revision reason", 4000);
      const revision = { ...JSON.parse(JSON.stringify(report)), id: crypto.randomUUID(), status: "Draft", version: 0, note, revises: report.id,
        rows: report.rows.map((row) => ({ ...row, id: crypto.randomUUID(), validation: null })), importedAt: new Date().toISOString(), importedBy: user.name };
      delete revision.publishedAt; delete revision.publishedBy; delete revision.recalledAt; delete revision.recallReason;
      data.weeklyQAReports.push(revision);
      await persist();
      return sendJson(res, 201, revision);
    }
    if (action === "recall" && method === "POST") {
      if (report.status !== "Published" || report.recalledAt) throw new HttpError(409, "Only a live published report can be recalled.");
      Object.assign(report, { recalledAt: new Date().toISOString(), recallBy: user.name, recallReason: requireText(input.note, "Recall reason", 4000) });
      await persist();
      return sendJson(res, 200, report);
    }
    if (report.status !== "Draft") throw new HttpError(409, "Published QA snapshots are immutable; create a revision.");
    const context = qaContext(user);
    if (action === "match" && method === "POST" && !weeklyMatch[3]) {
      let matched = 0;
      for (const row of report.rows.filter((item) => !item.excluded)) {
        const candidate = { ...row, executor: qaExecutorName(row.executor, context.members),
          projectRef: qaProjectMatch(context.projects, row.projectRef)?.ref || row.projectRef };
        const original = qaExecutorName(rosterNameForWorkfront(row.originalExecutor) || row.originalExecutor, context.members);
        if (candidate.executor !== original && !row.validation?.aliasConfirmed) continue;
        const check = qaSourceValidation(candidate, context);
        if (check.status !== "Matched") continue;
        Object.assign(row, candidate, { validation: { ...row.validation, by: user.name, at: new Date().toISOString(),
          note: "Manager matched Workfront ID, original executor and individual CR where applicable.",
          originalExecutor: row.originalExecutor, fingerprint: check.fingerprint } });
        matched++;
      }
      await persist();
      return sendJson(res, 200, { matched, needsAttention: report.rows.filter((row) => !row.excluded
        && (!row.validation || qaSourceValidation(row, context).status !== "Matched")).length });
    }
    if (action === "rows" && method === "POST" && !weeklyMatch[3]) {
      const sourceProjectRef = requireText(input.projectRef, "Workfront ID", 80);
      const projectRef = qaProjectMatch(context.projects, sourceProjectRef)?.ref || sourceProjectRef;
      const qaTaskId = requireText(input.qaTaskId, "QA task / evidence ID", 120);
      if (report.rows.some((row) => !row.excluded && row.qaTaskId === qaTaskId)) throw new HttpError(409, "QA evidence ID already exists in this draft. Exclude an incorrect row before replacing it.");
      const deliveredDate = validDate(input.deliveredDate, "QA delivery date");
      if (deliveredDate < report.from || deliveredDate > report.to) throw new HttpError(400, "QA delivery date must be within the selected week.");
      const executor = requireText(input.executor, "Original executor", 160);
      if (!context.projects.some((project) => project.ref === projectRef && project.productionTeamId === "design")
        || !context.members.some((member) => member.name === executor && member.role === "executioner" && member.teamIds?.includes("design"))) {
        throw new HttpError(400, "Select a Workfront Design project and an original Design executioner.");
      }
      const totalBugs = boundedNumber(input.totalBugs || 0, "Defect count", 0, 100000);
      if (!Number.isInteger(totalBugs)) throw new HttpError(400, "Defect count must be an integer.");
      const bugCreated = input.bugCreated === true;
      if (totalBugs && !bugCreated) throw new HttpError(400, "A delivery with defects cannot be marked FTR.");
      const note = requireText(input.note, "QA result / bug evidence", 4000);
      const row = { id: crypto.randomUUID(), sourceProjectRef, projectRef, qaTaskId, executor, originalExecutor: executor,
        requestType: enumValue(input.requestType || "D1", ["D1", "CR"], "QA request type"), crId: cleanText(input.crId, 80), deliveredDate, bugCreated,
        sourceStatus: "Completed", channel: context.projects.find((project) => project.ref === projectRef)?.channel || "",
        bugs: bugCreated ? [{ bugDate: validDate(input.bugDate || deliveredDate, "Bug date"), totalBugs, description: note,
          bugAssignee: cleanText(input.bugAssignee, 160), categories: {} }] : [], note, validation: null };
      report.rows.push(row);
    } else if (action === "rows" && method === "PUT" && weeklyMatch[3]) {
      requireRole(user, ["manager", "teamManager"]);
      const row = report.rows.find((item) => item.id === weeklyMatch[3]);
      if (!row) throw new HttpError(404, "QA row not found.");
      const note = requireText(input.note, "Validation / exclusion evidence", 4000);
      if (input.exclude === true) Object.assign(row, { excluded: true, exclusionNote: note, validation: null });
      else {
        const executor = qaExecutorName(requireText(input.executor || row.executor, "Original executor", 160), context.members);
        const original = qaExecutorName(rosterNameForWorkfront(row.originalExecutor) || row.originalExecutor, context.members);
        if (executor !== original && input.aliasConfirmed !== true) throw new HttpError(409, "Confirm that the selected name is an alias of the original QA executor; do not attribute to the bug assignee.");
        if (executor !== row.executor && !context.members.some((member) => member.name === executor
          && member.role === "executioner" && member.teamIds?.includes("design"))) throw new HttpError(400, "Select an original Design executioner.");
        if (input.bugCreated !== undefined && typeof input.bugCreated !== "boolean") throw new HttpError(400, "QA bug result must be true or false.");
        const sourceProjectRef = requireText(input.projectRef || row.projectRef, "Workfront ID", 80);
        const candidate = { ...row, executor, projectRef: qaProjectMatch(context.projects, sourceProjectRef)?.ref || sourceProjectRef,
          crId: cleanText(input.crId, 80), bugCreated: typeof input.bugCreated === "boolean" ? input.bugCreated : row.bugCreated, validation: null };
        const check = qaSourceValidation(candidate, context);
        Object.assign(row, candidate, { excluded: false, validation: { by: user.name, at: new Date().toISOString(), note,
          originalExecutor: row.originalExecutor, aliasConfirmed: input.aliasConfirmed === true, fingerprint: check.fingerprint } });
      }
    } else if (action === "publish" && method === "POST") {
      const rows = report.rows.filter((row) => !row.excluded);
      if (!rows.length) throw new HttpError(409, "Include at least one QA bulletin row before publishing.");
      const note = requireText(input.note, "Publication / revision note", 4000);
      Object.assign(report, { status: "Published", note, version: Math.max(0, ...(data.weeklyQAReports || [])
        .filter((item) => item.from === report.from).map((item) => item.version)) + 1, publishedBy: user.name, publishedAt: new Date().toISOString() });
    } else throw new HttpError(400, "Unsupported weekly QA action.");
    await persist();
    return sendJson(res, 200, report);
  }
  if (method === "POST" && pathname === "/api/operations/history") {
    requireRole(user, ["manager"]);
    const input = await readJson(req);
    const type = enumValue(input.type, ["projects", "tasks", "rounds"], "Historical report type");
    const required = type === "tasks"
      ? ["Task ID", "Project: Reference Number", "Project: Name", "Task Name", "Status", "Assignments",
        "Project: Primary Material", "Planned Start Date", "Planned Completion Date", "Project: Delivery Centre", "% Complete", "Actual Completion Date"]
      : type === "projects" ? ["Reference Number", "Project Name", "Status", "Primary Material", "Delivery Centre", "Planned Completion Date", "Actual Start Date", "Actual Completion Date"]
        : ["Project Ref #", "Reference Number", "Name", "Project Name", "Status", "Assigned To: Name", "Project: Primary Material", "Project: Delivery Centre", "Change Request Completion Date"];
    const report = await readWorkfrontUpload(input.file, "Historical Workfront", required);
    const records = type === "tasks" ? mapWorkfrontTaskRows({ headers: report.headers,
      rows: report.rawRows.map((row) => report.headers.map((_, index) => row[index] ?? null)), rowIds: report.rows.map((get) => get("Task ID")) })
      : report.rows.map((get) => type === "projects" ? mapWorkfrontProjectRow(get, report.headers) : mapWorkfrontChangeRow(get));
    const filtered = records.filter((record) => workfrontIsTargetDeliveryCentre(record.deliveryCentre));
    if (!filtered.length) throw new HttpError(400, "The report contains no PRD WPP Production records.");
    if (new Set(filtered.map((record) => record.workfrontId)).size !== filtered.length) throw new HttpError(409, "Historical report contains duplicate record IDs.");
    retainReportingHistory(data);
    const stored = new Map(data.reportingHistory[type].map((record) => [record.workfrontId, record]));
    for (const record of filtered) stored.set(record.workfrontId, mergeReportingRecord(stored.get(record.workfrontId), record));
    data.reportingHistory[type] = [...stored.values()];
    const entry = { type, file: report.name, imported: filtered.length, importedBy: user.name, importedAt: new Date().toISOString() };
    (data.reportingImports ||= []).push(entry);
    await persist();
    return sendJson(res, 201, entry);
  }
  if (method === "POST" && pathname === "/api/project-feedback") {
    requireRole(user, ["executioner", "auditor", "manager", "teamManager"]);
    const input = await readJson(req);
    const delivery = operationalSnapshot(user).deliveries.find((row) => row.ref === input.projectRef
      && (["manager", "teamManager"].includes(user.role) || row.names.includes(user.name)));
    if (!delivery) throw new HttpError(403, "Choose a project assigned to you or in your management scope.");
    const entry = { id: crypto.randomUUID(), userId: user.id, userName: user.name, projectRef: delivery.ref,
      teamId: delivery.teamId || delivery.project?.productionTeamId || "",
      category: enumValue(input.category, ["Learning", "Challenge", "Feedback"], "Feedback category"),
      message: requireText(input.message, "Details", 4000), status: "Open", response: "", createdAt: new Date().toISOString() };
    (data.projectFeedback ||= []).push(entry);
    await persist();
    return sendJson(res, 201, entry);
  }
  const feedbackMatch = pathname.match(/^\/api\/project-feedback\/([a-f0-9-]{36})$/i);
  if (method === "PUT" && feedbackMatch) {
    requireRole(user, ["manager", "teamManager"]);
    const entry = (data.projectFeedback || []).find((item) => item.id === feedbackMatch[1]);
    if (!entry || !userHasDepartment(user, entry.teamId)) throw new HttpError(403, "Feedback is outside your management scope.");
    const input = await readJson(req);
    const response = requireText(input.response, "Manager response", 4000);
    const status = enumValue(input.status, ["Open", "Reviewed", "Actioned"], "Feedback status");
    const bestPractice = input.bestPractice === true;
    if (bestPractice && entry.category === "Challenge" && status !== "Actioned") throw new HttpError(400, "Resolve the challenge and mark it Actioned before publishing a best practice.");
    const practiceTitle = bestPractice ? requireText(input.practiceTitle, "Best-practice title", 240) : "";
    Object.assign(entry, { response, status, bestPractice, practiceTitle, reviewedBy: user.name, updatedAt: new Date().toISOString() });
    await persist();
    return sendJson(res, 200, entry);
  }
  if (method === "POST" && pathname === "/api/non-productive-logs") {
    requireRole(user, ["executioner", "auditor", "manager", "teamManager"]);
    const input = await readJson(req);
    const date = validDate(input.date, "Activity date");
    if (date < REPORTING_START || date > new Date().toLocaleDateString("en-CA")) throw new HttpError(400, "Activity date must be from 1 July 2026 through today.");
    const hours = boundedNumber(input.hours, "Hours", 0.01, 24);
    const logged = [...data.workLogs, ...(data.sourceWorkLogs || []), ...(data.auditTimeLogs || []), ...(data.nonProductiveLogs || [])]
      .filter((entry) => entry.userId === user.id && entry.date === date).reduce((sum, entry) => sum + entry.hours, 0);
    if (logged + hours > 24) throw new HttpError(409, "Productive and non-productive logs cannot exceed 24 hours in a day.");
    const entry = { id: crypto.randomUUID(), userId: user.id, userName: user.name, date, hours,
      category: enumValue(input.category, ["Training", "Meeting", "Other"], "Activity"),
      note: requireText(input.note, "Activity details", 2000), createdAt: new Date().toISOString() };
    (data.nonProductiveLogs ||= []).push(entry);
    await persist();
    return sendJson(res, 201, entry);
  }
  if (method === "POST" && pathname === "/api/execution/progress") {
    requireRole(user, ["executioner", "auditor"]);
    const input = await readJson(req);
    const delivery = publicSnapshot(publicUser(user)).execution.deliveries.find((row) => row.key === input.deliveryKey && row.names.includes(user.name));
    if (!delivery) throw new HttpError(403, "Only your assigned work can be updated.");
    const date = validDate(input.date, "Progress date");
    if (date < REPORTING_START || date > new Date().toLocaleDateString("en-CA")) throw new HttpError(400, "Progress date must be from 1 July 2026 through today.");
    const progress = boundedNumber(input.progress, "Progress", 0, 100);
    if (progress === 100 && (data.executionTimers || []).some((timer) => timer.userId === user.id && timer.deliveryKey === delivery.key && timer.state !== "stopped")) {
      throw new HttpError(409, "Stop the assignment timer to save all elapsed time before completing work.");
    }
    const status = progress === 100 ? "Completed" : enumValue(input.status, ["Not Started", "In Progress", "In Review", "On Hold"], "Progress status");
    const entry = { id: crypto.randomUUID(), taskId: delivery.id, projectRef: delivery.ref, userId: user.id, userName: user.name,
      date, progress, status, hours: 0, progressEntry: true, note: requireText(input.note, "Progress evidence", 2000), createdAt: new Date().toISOString() };
    if (delivery.source === "local") {
      const task = data.tasks.find((item) => item.id === delivery.id);
      Object.assign(task, { progress, status, actualCompletionDate: progress === 100 ? date : "", updatedAt: entry.createdAt });
      entry.projectId = task.projectId;
      data.workLogs.push(entry);
    } else (data.sourceWorkLogs ||= []).push(entry);
    await persist();
    return sendJson(res, 201, entry);
  }
  if (method === "POST" && pathname === "/api/kpi-issues") {
    requireRole(user, ["manager", "teamManager"]);
    const input = await readJson(req, WORKFRONT_BODY_LIMIT);
    const scope = operationalSnapshot(user);
    const member = scope.members.find((item) => item.id === input.memberId);
    if (!member) throw new HttpError(403, "Member is outside your management scope.");
    const date = validDate(input.date, "Issue date");
    if (date < REPORTING_START || date > new Date().toLocaleDateString("en-CA")) throw new HttpError(400, "Issue date must be from 1 July 2026 through today.");
    const deliveryKey = cleanText(input.deliveryKey, 120);
    const delivery = deliveryKey ? scope.deliveries.find((row) => row.key === deliveryKey && row.names.includes(member.name)) : null;
    if (deliveryKey && !delivery) throw new HttpError(400, "The linked assignment must belong to this member.");
    const canonical = delivery && /^(build|cr(?:\s*\d+)?|change rounds?|bug fixing)$/i.test(delivery.type)
      && scope.quality.rows.find((row) => row.ref === delivery.ref && (row.crId || "") === (delivery.crId || "") && row.names.includes(member.name));
    const files = input.attachments === undefined ? [] : input.attachments;
    if (!Array.isArray(files) || files.length > 10) throw new HttpError(400, "Upload at most 10 evidence files per issue.");
    let totalSize = 0;
    const attachments = files.map((file) => {
      if (!file || typeof file !== "object") throw new HttpError(400, "Invalid evidence file.");
      const name = requireText(file.name, "Evidence filename", 240);
      if (/[/\\\x00-\x1f\x7f]/.test(name)) throw new HttpError(400, "Evidence filename cannot contain paths or control characters.");
      if (typeof file.contentBase64 !== "string" || !file.contentBase64.length
        || /[^A-Za-z0-9+/=]/.test(file.contentBase64)) throw new HttpError(400, "Evidence file content must be valid base64.");
      const content = Buffer.from(file.contentBase64, "base64");
      if (content.toString("base64") !== file.contentBase64) throw new HttpError(400, "Evidence file content must be valid base64.");
      if (!content.length) throw new HttpError(400, "Evidence files cannot be empty.");
      if (content.length > 5 * 1024 * 1024) throw new HttpError(400, "Each evidence file must be at most 5 MB.");
      totalSize += content.length;
      if (totalSize > 10 * 1024 * 1024) throw new HttpError(400, "Combined evidence files must be at most 10 MB.");
      return { id: crypto.randomUUID(), name, size: content.length, contentBase64: content.toString("base64") };
    });
    const entry = { id: crypto.randomUUID(), memberId: member.id, memberName: member.name, date,
      category: enumValue(input.category, ["Quality", "On-time Delivery", "Process adherence", "Manager feedback"], "KPI category"),
      deliveryKey: canonical?.key || deliveryKey, projectRef: delivery?.ref || "", note: requireText(input.note, "Issue / evidence", 4000),
      status: "Validated", attachments, createdBy: user.name, createdAt: new Date().toISOString(),
      emailNotification: { status: "sending", message: "Outlook sending started. If interrupted, check the sender's Sent Items and Drafts; no automatic retry." } };
    (data.kpiIssues ||= []).push(entry);
    await persist();
    // KPI member IDs may be account IDs rather than roster IDs. Never guess a recipient.
    const roster = data.team.filter((item) => item.name.toLowerCase() === member.name.toLowerCase());
    const senderRoster = data.team.filter((item) => item.name.toLowerCase() === user.name.toLowerCase());
    try {
      entry.emailNotification = await outlookNotifier.notify(entry,
        roster.length === 1 ? roster[0].wppProductionEmail : "",
        senderRoster.length === 1 ? senderRoster[0].wppProductionEmail : "");
    } catch (error) {
      console.error(`KPI Outlook notification failed for issue ${entry.id}:`, error);
      entry.emailNotification = { status: "failed", message: "Outlook notification failed unexpectedly. Issue saved; check the sender's Sent Items and Drafts before sending manually." };
    }
    if (entry.emailNotification.status !== "accepted") console.warn(`KPI issue ${entry.id}: ${entry.emailNotification.message}`);
    await persist();
    return sendJson(res, 201, { ...entry, attachments: attachments.map(({ id, name, size }) => ({ id, name, size })) });
  }
  const issueEvidenceMatch = pathname.match(/^\/api\/kpi-issues\/([a-f0-9-]{36})\/attachments\/([a-f0-9-]{36})$/i);
  if (method === "GET" && issueEvidenceMatch) {
    const entry = (data.kpiIssues || []).find((item) => item.id === issueEvidenceMatch[1]);
    if (!entry || !operationalSnapshot(user).issues.some((issue) => issue.id === entry.id)) throw new HttpError(403, "Evidence is outside your KPI issue scope.");
    const file = (entry.attachments || []).find((item) => item.id === issueEvidenceMatch[2]);
    if (!file) throw new HttpError(404, "Evidence file not found.");
    const content = Buffer.from(file.contentBase64, "base64");
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": content.length,
      "Content-Disposition": `attachment; filename="evidence"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
    return res.end(content);
  }
  const issueMatch = pathname.match(/^\/api\/kpi-issues\/([a-f0-9-]{36})$/i);
  if (method === "PUT" && issueMatch) {
    requireRole(user, ["manager", "teamManager"]);
    const entry = (data.kpiIssues || []).find((item) => item.id === issueMatch[1]);
    if (!entry || !operationalSnapshot(user).members.some((member) => member.id === entry.memberId)) throw new HttpError(403, "Issue is outside your management scope.");
    const input = await readJson(req);
    const reason = requireText(input.reason, "Withdrawal reason", 2000);
    Object.assign(entry, { status: "Withdrawn", reason, withdrawnBy: user.name, updatedAt: new Date().toISOString() });
    await persist();
    return sendJson(res, 200, { ...entry, attachments: (entry.attachments || []).map(({ id, name, size }) => ({ id, name, size })) });
  }
  if (method === "PUT" && pathname === "/api/kpi-reviews") {
    requireRole(user, ["manager", "teamManager"]);
    const input = await readJson(req);
    const anchor = validDate(input.date, "Review date");
    if (anchor < REPORTING_START) throw new HttpError(400, "Reviews start on 1 July 2026.");
    const period = enumValue(input.period || "quarterly", ["monthly", "quarterly"], "Review period");
    const scope = operationalSnapshot(user, anchor, period);
    if (!scope.members.some((member) => member.id === input.memberId)) throw new HttpError(403, "Member is outside your management scope.");
    if (!Array.isArray(input.feedback) || input.feedback.length !== 4 || input.feedback.some((value) => value !== null && typeof value !== "boolean")) {
      throw new HttpError(400, "Review the four Manager criteria as Met, Not met or Not reviewed.");
    }
    const entry = { memberId: input.memberId, period, from: scope.scoreWindow.from, to: period === "monthly" ? scope.asOf : scope.window.to, feedback: input.feedback,
      overallRating: input.overallRating === "" || input.overallRating === undefined ? null : positiveInteger(input.overallRating, "Overall rating", 5),
      qualityVerified: input.qualityVerified === true, processVerified: input.processVerified === true,
      deliveryVerified: input.deliveryVerified === true, coverageConfirmed: input.coverageConfirmed === true,
      note: requireText(input.note, "Review evidence", 4000), finalized: false, reviewedBy: user.name, updatedAt: new Date().toISOString() };
    const previous = data.kpiReviews || [];
    const reviews = previous.filter((item) => item.memberId !== entry.memberId || item.from !== entry.from || item.to !== entry.to || (item.period || "quarterly") !== period);
    data.kpiReviews = reviews.concat(entry);
    const calculated = operationalSnapshot(user, anchor, period).kpis.find((row) => row.memberId === entry.memberId);
    if (input.finalized && (!entry.coverageConfirmed || !entry.qualityVerified || !entry.processVerified || !entry.deliveryVerified || calculated.provisionalTotal === null || entry.overallRating === null || calculated.unknownCompletionDates > 0)) {
      data.kpiReviews = previous;
      throw new HttpError(409, "Resolve unknown completion dates, complete all evidence reviews, choose an overall rating and review the four feedback criteria before confirming.");
    }
    entry.finalized = input.finalized === true;
    entry.evidence = calculated.scoreEvidence || calculated.evidence;
    (data.kpiReviewHistory ||= []).push({ ...entry });
    await persist();
    return sendJson(res, 200, entry);
  }
  if (method === "POST" && pathname === "/api/kpi-publications") {
    requireRole(user, ["manager", "teamManager"]);
    const input = await readJson(req);
    const anchor = validDate(input.date, "Publication date");
    if (anchor < REPORTING_START) throw new HttpError(400, "KPI reporting starts on 1 July 2026.");
    const period = enumValue(input.period, ["monthly", "quarterly", "half-yearly", "yearly"], "Publication period");
    const scope = operationalSnapshot(user, anchor, period);
    const row = scope.kpis.find((item) => item.memberId === input.memberId);
    if (!row) throw new HttpError(403, "Member is outside your management scope.");
    const today = new Date().toLocaleDateString("en-CA");
    const final = row.confirmed && scope.window.to < today;
    if (!final && input.allowIncomplete !== true) throw new HttpError(409, "The period is open or evidence/reviews are incomplete. Explicitly publish a provisional report or finish the period review.");
    const versions = (data.kpiPublications || []).filter((item) => item.memberId === row.memberId && item.period === period
      && item.from === scope.window.from && item.to === scope.window.to);
    const entry = { id: crypto.randomUUID(), memberId: row.memberId, memberName: row.name, period, from: scope.window.from, to: scope.window.to,
      asOf: scope.asOf, final, version: Math.max(0, ...versions.map((item) => item.version)) + 1,
      snapshot: JSON.parse(JSON.stringify(row)), note: requireText(input.note, "Publication / revision note", 4000),
      publishedBy: user.name, publishedAt: new Date().toISOString() };
    (data.kpiPublications ||= []).push(entry);
    await persist();
    return sendJson(res, 201, entry);
  }
  const publicationMatch = pathname.match(/^\/api\/kpi-publications\/([a-f0-9-]{36})$/i);
  if (method === "PUT" && publicationMatch) {
    requireRole(user, ["manager", "teamManager"]);
    const entry = (data.kpiPublications || []).find((item) => item.id === publicationMatch[1]);
    if (!entry || !operationalSnapshot(user).members.some((member) => member.id === entry.memberId)) throw new HttpError(403, "Publication is outside your management scope.");
    const input = await readJson(req);
    const reason = requireText(input.reason, "Recall reason", 2000);
    if (entry.recalledAt) throw new HttpError(409, "This report was already recalled.");
    Object.assign(entry, { recalledAt: new Date().toISOString(), recalledBy: user.name, recallReason: reason });
    await persist();
    return sendJson(res, 200, entry);
  }
  if (method === "GET" && pathname === "/api/execution/checklist.xlsx") {
    requireRole(user, ["executioner", "auditor"]);
    const key = url.searchParams.get("deliveryKey");
    const delivery = operationalSnapshot(user).deliveries.find((row) => row.key === key && row.names.includes(user.name));
    const checklist = (data.executionChecklists || []).find((item) => item.deliveryKey === key && item.userId === user.id);
    if (!delivery || !checklist) throw new HttpError(404, "Save your assigned checklist before downloading it.");
    const template = checklistTemplate(delivery.project?.assetType || delivery.project?.channel, user.role);
    const items = template ? [...template.items.map((item) => ({ ...item, ...(checklist.items.find((saved) => saved.id === item.id) || {}) })),
      ...checklist.items.filter((item) => !item.id)] : checklist.items.filter((item) => !item.id);
    const buffer = await checklistWorkbook(delivery, { ...checklist, items, worksheet: template?.assetType }, user.name);
    res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${delivery.ref.replace(/[^a-z0-9_-]/gi, "_")}-checklist.xlsx"` });
    return res.end(buffer);
  }
  if (method === "POST" && pathname === "/api/tat-estimate") {
    return sendJson(res, 200, estimateTat(await readJson(req)));
  }
  if (method === "POST" && pathname === "/api/audit-capacity-estimate") {
    requireRole(user, ["manager", "teamManager", "auditor"]);
    return sendJson(res, 200, estimateAuditCapacity(await readJson(req), user));
  }
  if (method === "GET" && pathname === "/api/export") {
    requireRole(user, ["manager", "teamManager", "leadership", "auditor"]);
    return sendJson(res, 200, { exportedAt: new Date().toISOString(), ...publicSnapshot(publicUser(data.users.find((item) => item.id === user.id))) });
  }
  if (method === "POST" && pathname === "/api/workfront/sync") {
    requireRole(user, ["manager"]);
    const input = await readJson(req, WORKFRONT_BODY_LIMIT);
    const summary = await withWorkfrontSync(() => syncWorkfrontReports(input));
    return sendJson(res, 200, summary);
  }
  if (method === "POST" && pathname === "/api/workfront/dom-sync") {
    requireRole(user, ["manager"]);
    return sendJson(res, 200, await runWorkfrontDomSync());
  }
  if (method === "POST" && pathname === "/api/workfront/login") {
    requireRole(user, ["manager"]);
    if (workfrontSyncPromise) throw new HttpError(409, "Wait for the current Workfront sync to finish before signing in.");
    if (workfrontLoginIsOpen()) throw new HttpError(409, "A Workfront sign-in browser is already open.");
    return sendJson(res, 200, { workfrontLogin: await openWorkfrontLogin() });
  }
  if (method === "POST" && pathname === "/api/workfront/login/complete") {
    requireRole(user, ["manager"]);
    if (workfrontSyncPromise) throw new HttpError(409, "A Workfront sync is already running.");
    await closeWorkfrontLogin();
    try {
      const summary = await runWorkfrontDomSync();
      recordWorkfrontLoginScrapeResult();
      return sendJson(res, 200, { workfrontLogin: getWorkfrontLoginStatus(), summary });
    } catch (error) {
      recordWorkfrontLoginScrapeResult(error);
      throw error;
    }
  }
  if (method === "POST" && pathname === "/api/workfront/login/cancel") {
    requireRole(user, ["manager"]);
    await closeWorkfrontLogin({ cancel: true });
    return sendJson(res, 200, { workfrontLogin: getWorkfrontLoginStatus() });
  }
  if (method === "POST" && pathname === "/api/workfront/automation") {
    requireRole(user, ["manager"]);
    const input = await readJson(req);
    if (typeof input.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false.");
    data.workfrontAutomation = {
      ...data.workfrontAutomation,
      enabled: input.enabled,
      status: data.workfrontAutomation.status === "idle" && input.enabled ? "idle" : data.workfrontAutomation.status,
      nextSyncAt: input.enabled ? data.workfrontAutomation.nextSyncAt : null
    };
    await persist();
    if (input.enabled) {
      if (workfrontLoginIsOpen()) scheduleWorkfrontSync();
      else runWorkfrontDomSync().catch((error) => console.error("Workfront sync failed:", error.message));
    } else scheduleWorkfrontSync();
    return sendJson(res, 200, { workfrontAutomation: publicWorkfrontAutomation() });
  }
  const workfrontMatch = pathname.match(/^\/api\/workfront\/([A-Za-z0-9_-]+)\/(suggestions|allocate|qc-complete|rework)$/);
  if (workfrontMatch) {
    const [, workfrontId, action] = workfrontMatch;
    const source = workfrontProjectById(workfrontId);
    if (!source) throw new HttpError(404, "Workfront project was not found in the current PRD report.");
    if (action === "suggestions" && method === "POST") {
      requireProjectManager(user);
      requireProjectAccess(user, source);
      const project = data.projects.find((item) => item.workfrontId === source.workfrontId) || {
        id: "", ref: source.ref, workfrontRequestType: source.requestType || "",
        pages: source.pages || 1, taskType: TASK_TYPES.includes(source.channel) ? source.channel : "Other",
        complexity: workfrontComplexityFactor(source.complexity), productionTeamId: source.productionTeamId || "unassigned"
      };
      return sendJson(res, 200, calculateResourceSuggestions(project));
    }
    if (action === "allocate" && method === "POST") {
      requireProjectManager(user);
      requireProjectAccess(user, source);
      if (!workfrontCanContinue(source)) throw new HttpError(409, "This Workfront status is client-side blocked; wait for a status update before allocating.");
      if (source.productionStage !== "Awaiting Execution") throw new HttpError(409, "A passed pre-audit is required before allocation.");
      const audit = data.audits.find((item) => item.workfrontId === source.workfrontId && item.auditType === "Pre-Audit" && item.auditStatus === "Pass");
      if (!audit) throw new HttpError(409, "A passed pre-audit is required before allocation.");
      const input = await readJson(req);
      const assignee = requireText(input.assignee, "Assignee", 100);
      if (!data.team.some((member) => member.name === assignee)) throw new HttpError(400, "Assignee is not in the team roster.");
      requireAssigneeDepartment(assignee, source.productionTeamId, user);
      const startDate = validDate(input.plannedStartDate || new Date().toISOString().slice(0, 10), "Planned start date");
      const startTime = normalizeClock(input.startTime, "Planned start time", shiftStartFor(assignee));
      const { project, task } = makeNativeWorkfrontProject(source, assignee, startDate, startTime, user);
      reflowAssigneeTasks(assignee);
      audit.allocation = { assignee, allocatedBy: user.name, allocatedAt: new Date().toISOString() };
      await persist();
      return sendJson(res, 201, { project, task, productionStage: source.productionStage });
    }
    if (action === "qc-complete" && method === "POST") {
      requireProjectManager(user);
      requireProjectAccess(user, source);
      if (!workfrontCanContinue(source)) throw new HttpError(409, "This Workfront status is client-side blocked; wait for a status update before completing QC.");
      const project = data.projects.find((item) => item.workfrontId === source.workfrontId);
      if (!project || source.productionStage !== "In QC") throw new HttpError(409, "This project must be in QC before it can be completed.");
      if (data.tasks.some((task) => task.projectId === project.id && !["Completed", "Archived"].includes(task.status))) {
        throw new HttpError(409, "Complete or close every active production and rework task before marking QC complete.");
      }
      project.status = "Completed";
      project.progress = 100;
      project.updatedAt = new Date().toISOString();
      setWorkfrontProductionStage(source, "Complete");
      await persist();
      return sendJson(res, 200, { project, productionStage: source.productionStage });
    }
    if (action === "rework" && method === "POST") {
      requireProjectManager(user);
      requireProjectAccess(user, source);
      if (!workfrontCanContinue(source)) throw new HttpError(409, "This Workfront status is client-side blocked; wait for a status update before opening rework.");
      if (!["In QC", "Complete"].includes(source.productionStage)) throw new HttpError(409, "Rework can only be opened from QC or a completed Workfront project.");
      const project = data.projects.find((item) => item.workfrontId === source.workfrontId);
      if (!project) throw new HttpError(409, "Allocate the Workfront project before opening rework.");
      const input = await readJson(req);
      const category = enumValue(input.category || "Bug Fixing", ["CR", "Bug Fixing"], "Rework category");
      const assignee = requireText(input.assignee, "Assignee", 100);
      if (!data.team.some((member) => member.name === assignee)) throw new HttpError(400, "Assignee is not in the team roster.");
      requireAssigneeDepartment(assignee, projectDepartmentId(project), user);
      const rounds = data.tasks.filter((task) => task.projectId === project.id && task.category === category).length;
      const crId = category === "CR" ? requireText(input.crId, "CR ID", 80) : "";
      const bugScope = category === "Bug Fixing" ? enumValue(input.bugScope || "Build", BUG_SCOPES, "Bug-fixing scope") : "";
      const startDate = validDate(input.startDate || new Date().toISOString().slice(0, 10), "Planned start date");
      const startTime = normalizeClock(input.startTime, "Planned start time", shiftStartFor(assignee));
      const task = normalizeTask({
        projectId: project.id, category, bugScope, crId, taskType: project.taskType, units: 1,
        complexity: input.complexity || "Medium", assignee, progress: 0, status: "Not Started",
        startDate, startTime, observations: input.observations,
        title: `Rework ${rounds + 1}${crId ? ` · ${crId}` : ""} · ${project.title}`
      }, user);
      if (category === "CR") {
        const round = normalizeChangeRound({
          projectRef: project.ref, crId, complexity: task.complexity, landedDate: task.startDate, landedTime: task.startTime
        }, user);
        round.taskId = task.id;
        round.capacityEtaDate = task.etaDate;
        round.capacityEtaTime = task.etaTime;
        data.changeRounds.unshift(round);
        task.contractualEtaDate = round.etaDate;
      }
      data.tasks.push(task);
      project.status = "In Progress";
      project.progress = 0;
      syncWorkfrontTaskStage(task);
      reflowAssigneeTasks(assignee);
      await persist();
      return sendJson(res, 201, { task, productionStage: source.productionStage, estimatedHours: task.plannedHours });
    }
  }
  if (method === "POST" && pathname === "/api/leaves") {
    const leave = normalizeLeave(await readJson(req), user);
    data.leaves.unshift(leave);
    await persist();
    return sendJson(res, 201, { leave, impacts: leave.impacts || [] });
  }
  const leaveMatch = pathname.match(/^\/api\/leaves\/([a-f0-9-]{36})$/i);
  if (leaveMatch && method === "PUT") {
    requireRole(user, ["manager", "teamManager"]);
    const leave = data.leaves.find((item) => item.id === leaveMatch[1]);
    if (!leave) throw new HttpError(404, "Leave request was not found.");
    if (leave.status !== "Pending") throw new HttpError(409, "Only pending leave requests can be approved or declined.");
    const leaveMember = data.team.find((item) => item.name.toLowerCase() === leave.assignee.toLowerCase());
    if (!userCanManageMember(user, leaveMember)) throw new HttpError(403, "You cannot manage leave outside your assigned team / department.");
    const action = enumValue((await readJson(req)).action, ["approve", "decline"], "Leave decision");
    if (action === "decline") {
      leave.status = "Declined";
      leave.decidedBy = user.name;
      leave.decidedAt = new Date().toISOString();
      await persist();
      return sendJson(res, 200, { leave });
    }
    if (data.leaves.some((item) => item.id !== leave.id && item.assignee === leave.assignee && item.status === "Approved"
      && leave.startDate <= item.endDate && leave.endDate >= item.startDate)) {
      throw new HttpError(409, "This request overlaps approved leave. Resolve the conflict before approving it.");
    }
    leave.status = "Approved";
    leave.approvedBy = user.name;
    leave.approvedAt = new Date().toISOString();
    const affected = data.tasks.filter((task) => task.assignee === leave.assignee && !["Completed", "Archived"].includes(task.status));
    leave.impacts = affected.map((task) => ({
      taskId: task.id, title: task.title, beforeStartDate: task.startDate, beforeEtaDate: task.etaDate
    }));
    reflowAssigneeTasks(leave.assignee);
    leave.impacts = leave.impacts.map((impact) => {
      const task = data.tasks.find((item) => item.id === impact.taskId);
      return { ...impact, afterStartDate: task?.startDate || impact.beforeStartDate, afterEtaDate: task?.etaDate || impact.beforeEtaDate };
    });
    await persist();
    return sendJson(res, 200, { leave, impacts: leave.impacts });
  }
  if (leaveMatch && method === "DELETE") {
    const index = data.leaves.findIndex((item) => item.id === leaveMatch[1]);
    if (index < 0) throw new HttpError(404, "Leave entry was not found.");
    const leave = data.leaves[index];
    const leaveMember = data.team.find((item) => item.name.toLowerCase() === leave.assignee.toLowerCase());
    if (!userCanManageMember(user, leaveMember) && !(leave.status === "Pending" && leave.assignee.toLowerCase() === user.name.toLowerCase())) {
      throw new HttpError(403, "You can cancel only your own pending leave request.");
    }
    data.leaves.splice(index, 1);
    if (leave.status === "Approved") {
      for (const impact of leave.impacts || []) {
        const task = data.tasks.find((item) => item.id === impact.taskId && item.assignee === leave.assignee);
        if (task && task.startDate === impact.afterStartDate && task.etaDate === impact.afterEtaDate) {
          task.startDate = impact.beforeStartDate;
          task.etaDate = impact.beforeEtaDate;
        }
      }
      reflowAssigneeTasks(leave.assignee);
    }
    await persist();
    return sendJson(res, 200, { deleted: true, assignee: leave.assignee });
  }
  if (method === "POST" && pathname === "/api/projects") {
    requireProjectManager(user);
    const input = await readJson(req);
    if (data.projects.some((project) => project.ref.toLowerCase() === cleanText(input.ref, 80).toLowerCase())) throw new HttpError(409, "A project with that reference already exists.");
    const now = new Date().toISOString();
    const project = normalizeProject(input);
    requireProjectAccess(user, project);
    requireAssigneeDepartment(project.assignee, projectDepartmentId(project), user);
    project.id = crypto.randomUUID();
    project.createdAt = now;
    data.projects.unshift(project);
    if (project.assignee) planAssignedProject(project, project.assignee);
    const build = createBuildTask(project, user);
    reflowAssigneeTasks(build.assignee);
    await persist();
    return sendJson(res, 201, project);
  }
  const projectMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]{36})$/i);
  if (projectMatch && method === "PUT") {
    requireProjectManager(user);
    const project = data.projects.find((item) => item.id === projectMatch[1]);
    if (!project) throw new HttpError(404, "Project was not found.");
    requireProjectAccess(user, project);
    const input = await readJson(req);
    if (data.projects.some((item) => item.id !== project.id && item.ref.toLowerCase() === cleanText(input.ref, 80).toLowerCase())) throw new HttpError(409, "A project with that reference already exists.");
    const previousAssignee = project.assignee;
    const shouldReplan = previousAssignee !== cleanText(input.assignee, 100)
      || project.pages !== Number(input.pages)
      || project.taskType !== input.taskType
      || project.complexity !== Number(input.complexity);
    const updated = normalizeProject(input, project);
    requireProjectAccess(user, updated);
    requireAssigneeDepartment(updated.assignee, projectDepartmentId(updated), user);
    Object.assign(project, updated);
    if (project.assignee && shouldReplan) planAssignedProject(project, updated.assignee);
    const build = createBuildTask(project, user);
    if (previousAssignee !== build.assignee) reflowAssigneeTasks(previousAssignee);
    reflowAssigneeTasks(build.assignee);
    await persist();
    return sendJson(res, 200, project);
  }
  const allocationMatch = pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/allocation$/i);
  if (allocationMatch && method === "POST") {
    const project = data.projects.find((item) => item.id === allocationMatch[1]);
    if (!project) throw new HttpError(404, "Project was not found.");
    requireProjectAccess(user, project);
    if (["Completed", "Archived"].includes(project.status)) throw new HttpError(409, "Completed or archived projects cannot be assigned.");
    const input = await readJson(req);
    let audit = null;
    if (user.role === "executioner") {
      if (project.assignee) throw new HttpError(409, "This project is already assigned.");
      if (cleanText(input.assignee, 100) !== user.name) throw new HttpError(403, "You can only assign an unassigned project to yourself.");
    } else {
      requireProjectManager(user);
      const auditId = cleanText(input.auditId, 80);
      audit = auditId ? data.audits.find((item) => item.id === auditId) : null;
      if (auditId && (!audit || audit.auditType !== "Audit" || audit.auditStatus !== "Pass" || audit.projectRef.toLowerCase() !== project.ref.toLowerCase())) {
        throw new HttpError(400, "A passed audit for this project is required before allocation.");
      }
    }
    const assignee = requireText(input.assignee, "Assignee", 100);
    if (!data.team.some((member) => member.name === assignee)) throw new HttpError(400, "Assignee is not in the team roster.");
    requireAssigneeDepartment(assignee, projectDepartmentId(project), user);
    const dueDate = validDate(input.dueDate || project.dueDate, "Due date");
    const allocation = planAssignedProject(project, assignee, input);
    reflowAssigneeTasks(assignee);
    project.dueDate = dueDate;
    if (project.status === "Not Started") project.status = "In Progress";
    if (audit) audit.allocation = { assignee, dueDate, allocatedBy: user.name, allocatedAt: project.updatedAt };
    await persist();
    return sendJson(res, 200, { project, audit, allocation });
  }
  if (method === "POST" && pathname === "/api/tasks") {
    requireRole(user, ["manager", "teamManager", "auditor", "executioner"]);
    const input = await readJson(req);
    const category = enumValue(input.category, TASK_CATEGORIES, "Task category");
    if (category === "Build") throw new HttpError(400, "Build tasks are created with their fresh project.");
    const sourceProject = data.projects.find((project) => project.id === input.projectId || project.ref.toLowerCase() === String(input.projectId || "").toLowerCase());
    if (!sourceProject) throw new HttpError(404, "Project was not found.");
    requireProjectAccess(user, sourceProject);
    const provisionalEffort = estimateTaskEffort(
      category, input.taskType || sourceProject.taskType, Number(input.units || 1),
      enumValue(input.complexity, COMPLEXITY_LEVELS, "Complexity"), null,
      projectPlanningRequestType(sourceProject),
      category === "Bug Fixing" ? enumValue(input.bugScope, BUG_SCOPES, "Bug-fixing scope") : ""
    );
    const scheduled = input.assignee && !input.startDate ? availableStartForAssignee(input.assignee, provisionalEffort.plannedHours) : null;
    const taskInput = scheduled ? { ...input, startDate: scheduled.startDate, startTime: scheduled.startTime } : input;
    const task = normalizeTask(taskInput, user);
    let round = null;
    if (task.category === "CR") {
      round = data.changeRounds.find((entry) => entry.projectId === task.projectId
        && entry.crId.toLowerCase() === task.crId.toLowerCase()) || null;
      if (round?.taskId && data.tasks.some((entry) => entry.id === round.taskId)) {
        throw new HttpError(409, "That change round already has a production task.");
      }
      if (!round) {
        round = normalizeChangeRound({
          projectRef: task.projectRef, crId: task.crId, complexity: task.complexity,
          landedDate: task.startDate, landedTime: task.startTime
        }, user);
        data.changeRounds.unshift(round);
      }
      round.taskId = task.id;
      round.capacityEtaDate = task.etaDate;
      round.capacityEtaTime = task.etaTime;
      round.capacityEtaOverride = task.etaOverride;
      task.contractualEtaDate = round.etaDate;
    }
    data.tasks.unshift(task);
    reflowAssigneeTasks(task.assignee);
    if (task.category === "Build") syncBuildTaskToProject(task);
    else syncWorkfrontTaskStage(task);
    if (round) {
      round.capacityEtaDate = task.etaDate;
      round.capacityEtaTime = task.etaTime;
    }
    await persist();
    return sendJson(res, 201, { task, changeRound: round });
  }
  const taskMatch = pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})$/i);
  if (taskMatch && method === "PUT") {
    const task = data.tasks.find((item) => item.id === taskMatch[1]);
    if (!task) throw new HttpError(404, "Task was not found.");
    const taskProject = data.projects.find((project) => project.id === task.projectId);
    requireProjectAccess(user, taskProject);
    const input = await readJson(req);
    requireProjectManager(user);
    const previousAssignee = task.assignee;
    const merged = { ...task, ...input };
    const estimateChanged = ["category", "taskType", "units", "complexity"].some((field) => Object.hasOwn(input, field) && input[field] !== task[field]);
    if (estimateChanged) delete merged.productionHours;
    const scheduleChanged = ["assignee", "startDate", "startTime"].some((field) => Object.hasOwn(input, field) && input[field] !== task[field]);
    if ((scheduleChanged || estimateChanged) && !merged.etaOverride && !Object.hasOwn(input, "etaDate")) {
      delete merged.etaDate;
      delete merged.etaTime;
    }
    const updated = normalizeTask(merged, user, task);
    requireAssigneeDepartment(updated.assignee, projectDepartmentId(taskProject), user);
    Object.assign(task, updated);
    if (previousAssignee !== task.assignee) reflowAssigneeTasks(previousAssignee);
    reflowAssigneeTasks(task.assignee);
    syncBuildTaskToProject(task);
    if (task.category !== "Build") syncWorkfrontTaskStage(task);
    if (task.category === "CR") {
      const round = data.changeRounds.find((entry) => entry.taskId === task.id);
      if (round) {
        round.capacityEtaDate = task.etaDate;
        round.capacityEtaTime = task.etaTime;
        round.capacityEtaOverride = task.etaOverride;
      }
    }
    await persist();
    return sendJson(res, 200, task);
  }
  if (method === "POST" && pathname === "/api/planner/suggestions") {
    requireProjectManager(user);
    const input = await readJson(req);
    const project = data.projects.find((item) => item.id === cleanText(input.projectId, 80));
    if (!project) throw new HttpError(404, "Project was not found.");
    requireProjectAccess(user, project);
    return sendJson(res, 200, calculateResourceSuggestions(project));
  }
  if (method === "POST" && pathname === "/api/planner/task-suggestions") {
    requireRole(user, ["manager", "teamManager", "auditor", "executioner"]);
    const input = await readJson(req);
    const project = data.projects.find((item) => item.id === cleanText(input.projectId, 80));
    if (!project) throw new HttpError(404, "Project was not found.");
    requireProjectAccess(user, project);
    const category = enumValue(input.category, TASK_CATEGORIES, "Task category");
    const complexity = enumValue(input.complexity, COMPLEXITY_LEVELS, "Complexity");
    const units = positiveNumber(input.units || 1, "Pages / units", 100000);
    const effort = estimateTaskEffort(
      category, project.taskType, units, complexity, null,
      projectPlanningRequestType(project),
      category === "Bug Fixing" ? enumValue(input.bugScope, BUG_SCOPES, "Bug-fixing scope") : ""
    );
    const resources = data.team.filter((member) => {
      if (!projectDepartmentId(project)) return false;
      if (user.role === "executioner") return member.name === user.name;
      const account = data.users.find((item) => item.name.toLowerCase() === member.name.toLowerCase());
      return memberHasDepartment(member, projectDepartmentId(project)) && (!account || account.role === "executioner");
    }).map((member) => {
      const schedule = availableStartForAssignee(member.name, effort.plannedHours);
      const calendar = scheduleCalendar(member.name);
      const assigned = data.tasks.filter((task) => task.assignee === member.name && !["Completed", "Archived"].includes(task.status));
      const remainingHours = assigned.reduce((sum, task) => sum + Math.max(0, Number(task.plannedHours) - Number(task.loggedHours || 0)), 0);
      const today = new Date().toISOString().slice(0, 10);
      return {
        name: member.name, openTasks: assigned.length,
        plannedHours: Number(remainingHours.toFixed(1)),
        remainingHours: Number(remainingHours.toFixed(1)),
        onLeaveToday: (data.leaves || []).some((leave) => leave.assignee === member.name && leave.startDate <= today && today <= leave.endDate),
        nextLeave: (() => {
          const leave = (data.leaves || []).filter((item) => item.assignee === member.name && item.endDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
          return leave ? publicLeave(leave, user) : null;
        })(),
        availableTodayHours: Number(Math.max(0, (calendar.some((item) => item.date === today) ? 0 : Number(data.capacityHoursPerDay || 8)) - assigned.filter((task) => task.startDate <= today && task.etaDate >= today).reduce((sum, task) => sum + Number(task.plannedHours || 0) / Math.max(1, businessDaysBetween(task.startDate, task.etaDate, calendar)), 0)).toFixed(1)),
        plannedStartDate: schedule.startDate, plannedStartTime: schedule.startTime,
        plannedEndDate: schedule.date, plannedEndTime: schedule.time,
        recommended: false
      };
    }).sort((a, b) => a.plannedStartDate.localeCompare(b.plannedStartDate) || a.plannedHours - b.plannedHours);
    if (resources.length) resources[0].recommended = true;
    return sendJson(res, 200, { ...effort, resources });
  }
  if (method === "POST" && pathname === "/api/worklogs") {
    requireRole(user, ["manager", "teamManager", "auditor", "executioner"]);
    const entry = normalizeWorkLog(await readJson(req), user);
    const project = data.projects.find((item) => item.id === entry.projectId);
    const task = data.tasks.find((item) => item.id === entry.taskId);
    task.progress = entry.progress;
    task.status = entry.status;
    task.loggedHours += entry.hours;
    task.updatedAt = new Date().toISOString();
    task.actualCompletionDate = entry.status === "Completed" ? entry.date : "";
    task.completedBy = entry.status === "Completed" ? user.name : "";
    syncBuildTaskToProject(task);
    if (task.category !== "Build") syncWorkfrontTaskStage(task);
    if (task.category !== "Build") project.updatedAt = task.updatedAt;
    data.workLogs.unshift(entry);
    await persist();
    return sendJson(res, 201, entry);
  }
  if (method === "POST" && pathname === "/api/execution/timer") {
    requireRole(user, ["executioner", "auditor"]);
    const input = await readJson(req);
    const action = enumValue(input.action, ["start", "hold", "stop"], "Timer action");
    const snapshot = publicSnapshot(publicUser(user));
    const current = (data.executionTimers || []).find((timer) => timer.userId === user.id);
    const assigned = snapshot.execution.deliveries.find((row) => row.key === input.deliveryKey && row.names.includes(user.name));
    const delivery = assigned || (action !== "start" && current?.deliveryKey === input.deliveryKey ? current.delivery : null);
    if (!delivery) throw new HttpError(403, "This delivery is not assigned to you.");
    const now = new Date();
    const timestamp = now.toISOString();
    if (action === "start") {
      if (/^(complete|completed|archived|cancelled)$/i.test(delivery.status)) throw new HttpError(409, "Completed work cannot start a timer.");
      if ((data.auditSessions || []).some((session) => session.userId === user.id && session.state === "running")) throw new HttpError(409, "Hold or stop your audit clock before starting an execution timer.");
      if (current?.state === "running") throw new HttpError(409, "Hold or stop your running timer before starting another.");
      if (current?.state === "held" && current.deliveryKey !== delivery.key) throw new HttpError(409, "Stop the held timer before starting another delivery.");
      data.executionTimers ||= [];
      const next = { userId: user.id, deliveryKey: delivery.key, state: "running", startedAt: timestamp,
        elapsedMs: current?.deliveryKey === delivery.key && current.state === "held" ? current.elapsedMs : 0,
        delivery: { key: delivery.key, id: delivery.id, source: delivery.source, ref: delivery.ref, type: delivery.type,
          progress: delivery.progress, projectId: delivery.project?.id } };
      data.executionTimers = data.executionTimers.filter((timer) => timer.userId !== user.id).concat(next);
    } else {
      if (!current || current.deliveryKey !== delivery.key || current.state === "stopped") throw new HttpError(409, "No active timer exists for this delivery.");
      if (action === "hold" && current.state !== "running") throw new HttpError(409, "The timer is already on hold.");
      if (current.state === "running") {
        const start = new Date(current.startedAt);
        if (!Number.isFinite(start.getTime()) || start > now) throw new HttpError(409, "Timer timestamps are invalid; contact your manager.");
        const elapsedMs = now - start;
        // Split actual elapsed time at local midnight so daily utilization remains accurate.
        let cursor = start;
        const entries = [];
        while (cursor < now) {
          const midnight = new Date(cursor);
          midnight.setHours(24, 0, 0, 0);
          const end = new Date(Math.min(midnight.getTime(), now.getTime()));
          const entry = { id: crypto.randomUUID(), taskId: delivery.id, projectRef: delivery.ref,
            taskCategory: delivery.type, userId: user.id, userName: user.name,
            date: cursor.toLocaleDateString("en-CA"), hours: (end - cursor) / 3600000,
            progress: Number(delivery.progress || 0), status: action === "hold" ? "On Hold" : "In Progress",
            phase: /^bug fixing$/i.test(delivery.type) ? "Bug Fixing" : /^cr/i.test(delivery.type) ? "CR1"
              : /^(qa\b|quality assurance)/i.test(delivery.type) ? "Quality Assurance" : /^build$/i.test(delivery.type) ? "Build" : "Other",
            note: `Timer ${action}; task completion unchanged`, createdAt: timestamp, timerEntry: true };
          if (delivery.source === "local") {
            const task = data.tasks.find((item) => item.id === delivery.id);
            entry.projectId = task?.projectId || delivery.projectId;
          }
          entries.push(entry);
          cursor = end;
        }
        if (delivery.source === "local") {
          data.workLogs.push(...entries);
          const task = data.tasks.find((item) => item.id === delivery.id);
          if (task) {
            task.loggedHours = Number(task.loggedHours || 0) + entries.reduce((sum, entry) => sum + entry.hours, 0);
            task.updatedAt = timestamp;
          }
        }
        else (data.sourceWorkLogs ||= []).push(...entries);
        current.elapsedMs += elapsedMs;
      }
      current.state = action === "hold" ? "held" : "stopped";
      current.startedAt = null;
      current.updatedAt = timestamp;
    }
    await persist();
    return sendJson(res, 200, { timer: data.executionTimers.find((timer) => timer.userId === user.id) });
  }
  if (method === "PUT" && pathname === "/api/execution/checklist") {
    requireRole(user, ["executioner", "auditor"]);
    const input = await readJson(req);
    const delivery = publicSnapshot(publicUser(user)).execution.deliveries.find((row) => row.key === input.deliveryKey && row.names.includes(user.name));
    if (!delivery) throw new HttpError(403, "This delivery is not assigned to you.");
    if (!Array.isArray(input.items) || input.items.length > 100 || input.items.some((item) => typeof item?.label !== "string" || typeof item.done !== "boolean")) {
      throw new HttpError(400, "Checklist must contain up to 100 labelled checks.");
    }
    const documents = {};
    for (const field of ["inputLink", "outputLink", "functionalLink", "styleLink", "checklistLink"]) {
      const value = cleanText(input[field], 2000);
      if (value) {
        let url;
        try { url = new URL(value); } catch { throw new HttpError(400, `${field} must be a valid HTTPS URL.`); }
        if (url.protocol !== "https:") throw new HttpError(400, `${field} must use HTTPS.`);
      }
      documents[field] = value;
    }
    for (const field of ["inputDocuments", "outputDocuments"]) {
      if (!Array.isArray(input[field]) || input[field].length > 20) throw new HttpError(400, "Provide up to 20 input and output document links.");
      documents[field] = input[field].map((document) => {
        const link = requireText(document.link, "Document URL", 2000);
        let url;
        try { url = new URL(link); } catch { throw new HttpError(400, "Document links must be valid HTTPS URLs."); }
        if (url.protocol !== "https:") throw new HttpError(400, "Document links must use HTTPS.");
        return { name: requireText(document.name, "Document name", 240), link };
      });
    }
    const template = checklistTemplate(delivery.project?.assetType || delivery.project?.channel, user.role);
    const checkIds = input.items.map((item) => item.id).filter(Boolean);
    if (new Set(checkIds).size !== checkIds.length) throw new HttpError(400, "Checklist checkpoint IDs must be unique.");
    if (template && template.items.some((expected) => !input.items.some((item) => item.id === expected.id))) {
      throw new HttpError(400, "Include every approved asset checkpoint. Use N.A. with a comment where a check is not applicable.");
    }
    const entry = { deliveryKey: delivery.key, userId: user.id, items: input.items.map((item) => {
      const approved = template?.items.find((expected) => expected.id === item.id);
      if (item.id && !approved) throw new HttpError(400, "This checkpoint is not part of your role's approved worksheet. Reopen the checklist to refresh it.");
      const result = enumValue(item.result || (item.done ? "Done" : "Pending"), ["Done", "N.A.", "Pending", "In Progress"], "Self QA result");
      const comment = cleanText(item.comment, 2000);
      if (result === "N.A." && !comment) throw new HttpError(400, "Explain why a checkpoint is not applicable.");
      return { id: cleanText(item.id, 120), section: approved?.section || cleanText(item.section, 120),
        label: approved?.label || requireText(item.label, "Checklist item", 4000), detail: approved?.detail || "",
        result, done: result === "Done", comment };
    }),
      ...documents, observations: cleanText(input.observations, 4000), updatedAt: new Date().toISOString() };
    data.executionChecklists = (data.executionChecklists || []).filter((item) => item.deliveryKey !== delivery.key || item.userId !== user.id).concat(entry);
    await persist();
    return sendJson(res, 200, entry);
  }
  if (method === "POST" && pathname === "/api/quality-results") {
    if (!publicSnapshot(publicUser(user)).roleCapabilities.confirmQuality) throw new HttpError(403, "A QA manager or auditor must explicitly confirm the QA result.");
    const input = await readJson(req);
    const snapshot = publicSnapshot(publicUser(user));
    const delivery = snapshot.operationsWorkspace.deliveries.find((row) => row.key === input.deliveryKey && /^(build|cr(?:\s*\d+)?|change rounds?)$/i.test(row.type));
    if (!delivery) throw new HttpError(404, "Delivery is not in your permitted scope.");
    const result = enumValue(input.result, ["Pass", "Rework"], "QA result");
    const entry = { id: crypto.randomUUID(), deliveryKey: delivery.key, result,
      firstTime: result === "Pass" && input.firstTime === true, confirmedBy: user.name, userId: user.id,
      note: requireText(input.note, "QA evidence / note", 2000), createdAt: new Date().toISOString() };
    entry.date = validDate(input.date || new Date().toLocaleDateString("en-CA"), "QA result date");
    if (entry.date < REPORTING_START || entry.date > new Date().toLocaleDateString("en-CA")) throw new HttpError(400, "QA evidence date must be from 1 July 2026 through today.");
    (data.qaResults ||= []).push(entry);
    await persist();
    return sendJson(res, 201, entry);
  }
  if (method === "POST" && pathname === "/api/workfront-worklogs") {
    requireRole(user, ["executioner"]);
    const input = await readJson(req);
    const taskId = requireText(input.taskId, "Workfront task", 80);
    const task = data.workfrontTasks.find((item) => item.workfrontId === taskId);
    if (!task) throw new HttpError(404, "Workfront task was not found.");
    if (!userHasDepartment(user, task.productionTeamId) || !isWorkfrontAssignee(task, user.name)) {
      throw new HttpError(403, "You can only log Workfront work assigned to your name in your department.");
    }
    if (!productionType(task.taskName)) throw new HttpError(400, "Only Build, CR and Bug Fixing production tasks accept work logs.");
    const progress = boundedNumber(input.progress, "Progress", 0, 100);
    const requestedStatus = enumValue(input.status, PROJECT_STATUSES.filter((status) => status !== "Archived"), "Execution status");
    const status = progress === 100 && requestedStatus !== "On Hold" ? "Completed" : requestedStatus;
    if (status === "Completed" && progress < 100) throw new HttpError(400, "Completed work requires 100% progress.");
    const date = validDate(input.date, "Work date");
    if (date > new Date().toLocaleDateString("en-CA")) throw new HttpError(400, "Actual work cannot be recorded for a future date.");
    const entry = { id: crypto.randomUUID(), taskId, projectRef: task.projectRef, taskCategory: task.taskName,
      userId: user.id, userName: user.name, date, hours: boundedNumber(input.hours, "Hours", 0.1, 24),
      progress, status, phase: enumValue(input.phase, PHASES, "Work phase"), note: cleanText(input.note, 2000), createdAt: new Date().toISOString() };
    (data.sourceWorkLogs ||= []).push(entry);
    await persist();
    return sendJson(res, 201, entry);
  }
  const notificationMatch = pathname.match(/^\/api\/notifications\/([a-f0-9-]{36})\/read$/i);
  if (method === "POST" && notificationMatch) {
    const notification = (data.notifications || []).find((entry) => entry.id === notificationMatch[1] && entry.userId === user.id);
    if (!notification) throw new HttpError(404, "Notification was not found.");
    notification.readAt = new Date().toISOString();
    await persist();
    return sendJson(res, 200, notification);
  }
  if (method === "POST" && pathname === "/api/ops-assistant") {
    const question = requireText((await readJson(req)).question, "Question", 500);
    const snapshot = publicSnapshot(publicUser(user));
    const ops = snapshot.operations;
    const query = question.toLowerCase();
    let answer;
    if (/capacity|available|availability|workload/.test(query)) {
      const matched = ops.resources.filter((member) => query.includes(member.name.toLowerCase()));
      answer = (matched.length ? matched : ops.resources).map((member) => `${member.name}: ${member.remainingHours}h remaining, ${member.dailyCapacity}h capacity today, ${member.unknownTasks ? `${member.unknownTasks} tasks with unknown hours; availability cannot be confirmed` : `${member.backlogDays} productive days backlog`}`).join("\n") || "No eligible resources in your scope.";
    } else if (/risk|overdue|alert/.test(query)) {
      answer = ops.risks.slice(0, 20).map((risk) => `${risk.projectRef} · ${risk.taskName}: ${risk.labels.join("; ")}`).join("\n") || "No detected production risks in your permitted data.";
      if (ops.risks.length > 20) answer += `\n${ops.risks.length - 20} more risks are listed in Production risks.`;
    } else if (/assignment|assigned|my tasks/.test(query)) {
      answer = `${ops.assignedTasks} active roster-assigned production tasks; ${ops.unassignedTasks} unassigned or role-only tasks. Open the resource timeline for assignments.`;
    } else {
      const matches = ops.projects.filter((project) => query.includes(project.ref.toLowerCase()) || query.length >= 4 && project.title?.toLowerCase().includes(query)).slice(0, 10);
      answer = matches.length ? matches.map((project) => `${project.ref} · ${project.title}\nStatus: ${project.status || "Unavailable"}\nCompletion: ${project.dueDate || "Unavailable"} · Material expected: ${project.materialExpectedDate || "Unavailable"}\nLatest system activity: ${project.latestSystemActivity || "Unavailable"}`).join("\n\n")
        : "I can answer from your permitted app records: ask about capacity, workload, production risks, assignments, or a project reference. I cannot modify records or infer missing data.";
    }
    return sendJson(res, 200, { answer, checkedAt: new Date().toISOString(), source: "Local app snapshot; no external AI", syncStatus: snapshot.workfrontAutomation?.status || "Unavailable" });
  }
  if (method === "PUT" && pathname === "/api/planner-settings") {
    requireRole(user, ["manager"]);
    const input = await readJson(req);
    const marketMatrix = normalizeMarketMatrix(input.rows);
    const holidays = normalizeHolidays(input.holidays);
    data.marketMatrix = marketMatrix;
    data.holidays = holidays;
    await persist();
    return sendJson(res, 200, { marketMatrix, holidays });
  }
  if (method === "PUT" && pathname === "/api/holidays") {
    requireRole(user, ["manager", "teamManager"]);
    const input = await readJson(req);
    data.holidays = normalizeHolidays(input.holidays);
    await persist();
    return sendJson(res, 200, { holidays: data.holidays });
  }
  if (method === "PUT" && pathname === "/api/capacity-settings") {
    requireRole(user, ["manager"]);
    const input = await readJson(req);
    const multipliers = {};
    for (const level of COMPLEXITY_LEVELS) multipliers[level] = boundedNumber(input.complexityMultipliers?.[level], `${level} multiplier`, 0.1, 10);
    data.complexityMultipliers = multipliers;
    await persist();
    return sendJson(res, 200, { complexityMultipliers: multipliers });
  }
  if (method === "PUT" && pathname === "/api/aht-matrix") {
    requireRole(user, ["manager"]);
    const input = await readJson(req);
    if (!input.overrides || typeof input.overrides !== "object" || Array.isArray(input.overrides)) {
      throw new HttpError(400, "AHT matrix overrides must be an object.");
    }
    const sourceRows = new Map(
      [...VALIDATION_2026_MATRIX.records, ...VALIDATION_2026_MATRIX.addOns].map((row) => [String(row.rowNumber), row])
    );
    const allowedFields = new Set([...AHT_MATRIX_MINUTE_FIELDS, "notes"]);
    const overrides = { ...data.ahtMatrixOverrides };
    for (const [rowNumber, values] of Object.entries(input.overrides)) {
      const source = sourceRows.get(rowNumber);
      if (!source) throw new HttpError(400, `AHT matrix row ${rowNumber} is not valid.`);
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        throw new HttpError(400, `AHT matrix row ${rowNumber} must contain editable values.`);
      }
      const fields = Object.keys(values);
      if (fields.some((field) => !allowedFields.has(field))) {
        throw new HttpError(400, `AHT matrix row ${rowNumber} contains a non-editable field.`);
      }
      const rowOverrides = { ...(overrides[rowNumber] || {}) };
      for (const field of fields) {
        const value = field === "notes"
          ? cleanText(values[field], 2000)
          : boundedNumber(values[field], `${field} on AHT matrix row ${rowNumber}`, 0, 60000);
        if (value === (field === "notes" ? String(source[field] || "") : Number(source[field] || 0))) {
          delete rowOverrides[field];
        } else {
          rowOverrides[field] = value;
        }
      }
      if (Object.keys(rowOverrides).length) overrides[rowNumber] = rowOverrides;
      else delete overrides[rowNumber];
    }
    data.ahtMatrixOverrides = overrides;
    await persist();
    return sendJson(res, 200, { validationMatrix: getAhtSummary().validationMatrix });
  }
  if (method === "POST" && pathname === "/api/change-rounds") {
    requireProjectManager(user);
    const input = await readJson(req);
    const entry = normalizeChangeRound(input, user);
    const project = data.projects.find((item) => item.id === entry.projectId);
    requireProjectAccess(user, project);
    const complexity = enumValue(input.complexity, COMPLEXITY_LEVELS, "Complexity");
    const requestedAssignee = cleanText(input.assignee, 100);
    requireAssigneeDepartment(requestedAssignee, projectDepartmentId(project), user);
    const estimate = estimateTaskEffort("CR", project.taskType, Number(input.units || 1), complexity, null, projectPlanningRequestType(project));
    const schedule = requestedAssignee && !input.startDate ? availableStartForAssignee(requestedAssignee, estimate.plannedHours, entry.landedDate) : null;
    const task = normalizeTask({
      projectId: project.id, category: "CR", crId: entry.crId, complexity, units: input.units || 1,
      taskType: project.taskType, assignee: requestedAssignee,
      startDate: input.startDate || schedule?.startDate || entry.landedDate,
      startTime: input.startTime || schedule?.startTime || entry.landedTime,
      etaDate: input.etaDate || schedule?.date || entry.etaDate,
      etaTime: input.etaTime || schedule?.time || entry.etaTime,
      dueDate: input.etaDate || schedule?.date || entry.etaDate,
      contractualEtaDate: entry.etaDate, etaOverride: input.etaOverride,
      priority: input.priority || "Normal", priorityOrder: input.priorityOrder || 3
    }, user);
    task.etaOverride = input.etaOverride === true || input.etaOverride === "on";
    entry.taskId = task.id;
    entry.capacityEtaDate = task.etaDate;
    entry.capacityEtaTime = task.etaTime;
    entry.capacityEtaOverride = task.etaOverride;
    data.tasks.unshift(task);
    data.changeRounds.unshift(entry);
    reflowAssigneeTasks(task.assignee);
    entry.capacityEtaDate = task.etaDate;
    entry.capacityEtaTime = task.etaTime;
    await persist();
    return sendJson(res, 201, { ...entry, task });
  }
  if (method === "POST" && pathname === "/api/audits") {
    requireProjectManager(user);
    const entry = normalizeAudit(await readJson(req), user);
    const linkedWorkfrontSource = entry.workfrontId ? workfrontProjectById(entry.workfrontId) : null;
    if (entry.workfrontId && !linkedWorkfrontSource) throw new HttpError(404, "The linked Workfront project is not in the current PRD report.");
    if (entry.crId) {
      const round = data.workfrontChangeRounds.find((item) => item.projectRef.toLowerCase() === entry.projectRef.toLowerCase()
        && item.crId.toLowerCase().replace(/\s+/g, "") === entry.crId.toLowerCase().replace(/\s+/g, ""));
      const assignee = round && (rosterNameForWorkfront(round.assignee) || round.assignee);
      const account = data.users.find((item) => item.name === assignee && ["manager", "teamManager", "auditor"].includes(item.role));
      if (!round || !account || round.acceptanceDate || round.completionDate || /^(complete|completed|cancelled|canceled|archived)$/i.test(round.sourceStatus)) {
        throw new HttpError(409, "This CR is not awaiting audit by a named manager or auditor.");
      }
    }
    if (linkedWorkfrontSource && !entry.crId && !workfrontCanContinue(linkedWorkfrontSource)) {
      throw new HttpError(409, "This Workfront status is client-side blocked; wait for a status update before recording an audit.");
    }
    if (linkedWorkfrontSource && !entry.crId && entry.auditType === "Pre-Audit" && linkedWorkfrontSource.productionStage !== "Awaiting Audit") {
      throw new HttpError(409, "Pre-audits can only be recorded for Current / Pre-Audit Workfront projects.");
    }
    const currentAssetAudit = linkedWorkfrontSource && linkedWorkfrontSource.productionStage === "Awaiting Audit"
      && String(linkedWorkfrontSource.sourceStatus || "").trim().toLocaleLowerCase().replace(/\s+/g, " ") === "current";
    if (linkedWorkfrontSource && !entry.crId && entry.auditType === "Audit" && !currentAssetAudit && !["Audit", "In QC"].includes(linkedWorkfrontSource.productionStage)) {
      throw new HttpError(409, "Asset audits can only be recorded for Current projects or Workfront assets in the Audit / QC queue.");
    }
    const finalAuditSource = !entry.crId && entry.auditType === "Audit" && entry.auditStatus === "Pass" && entry.workfrontId
      ? workfrontProjectById(entry.workfrontId)
      : null;
    const currentFinalAudit = finalAuditSource && finalAuditSource.productionStage === "Awaiting Audit"
      && String(finalAuditSource.sourceStatus || "").trim().toLocaleLowerCase().replace(/\s+/g, " ") === "current";
    if (finalAuditSource && !currentFinalAudit && !["Audit", "In QC"].includes(finalAuditSource.productionStage)) {
      throw new HttpError(409, "A final audit can only complete a Current project or a Workfront asset in the Audit / QC queue.");
    }
    const finalAuditProject = finalAuditSource
      ? data.projects.find((item) => item.workfrontId === finalAuditSource.workfrontId)
      : null;
    if (finalAuditProject && data.tasks.some((task) => task.projectId === finalAuditProject.id && !["Completed", "Archived"].includes(task.status))) {
      throw new HttpError(409, "Complete or close every active production and rework task before passing the final audit.");
    }
    if (user.role !== "manager") {
      const project = data.projects.find((item) => item.ref.toLowerCase() === entry.projectRef.toLowerCase());
      const workfront = data.workfrontProjects.find((item) => item.ref.toLowerCase() === entry.projectRef.toLowerCase());
      if (project) requireProjectAccess(user, project);
      else if (!userHasDepartment(user, workfront?.productionTeamId || departmentIdForChannel(entry.channel))) {
        throw new HttpError(403, "This audit is outside your assigned team / department.");
      }
    }
    const session = (data.auditSessions || []).find((item) => item.userId === user.id && item.state !== "stopped"
      && item.projectRef.toLowerCase() === entry.projectRef.toLowerCase() && item.crId === entry.crId);
    if (session) {
      settleAuditSession(session, "stop", user);
      entry.sessionId = session.id;
      entry.startedAt = session.firstStartedAt;
      entry.endedAt = session.endedAt;
      entry.elapsedMs = session.elapsedMs;
      session.auditId = entry.id;
    }
    data.audits.unshift(entry);
    if (entry.workfrontId && !entry.crId && entry.auditType === "Pre-Audit" && entry.auditStatus === "Pass") {
      const source = workfrontProjectById(entry.workfrontId);
      if (source) {
        const isPreAuditStatus = String(source.sourceStatus || "").trim().toLocaleLowerCase().replace(/\s+/g, " ") === "pre-audit";
        setWorkfrontProductionStage(source, isPreAuditStatus ? "Pre-Audit Complete" : "Awaiting Execution");
      }
    } else if (entry.workfrontId && !entry.crId && entry.auditType === "Audit" && entry.auditStatus === "Pass") {
      const source = workfrontProjectById(entry.workfrontId);
      if (source) {
        if (finalAuditProject) {
          finalAuditProject.status = "Completed";
          finalAuditProject.progress = 100;
          finalAuditProject.updatedAt = new Date().toISOString();
        }
        setWorkfrontProductionStage(source, "Complete");
      }
    }
    await persist();
    return sendJson(res, 201, entry);
  }
  if (method === "POST" && pathname === "/api/hygiene-verifications") {
    requireRole(user, ["manager", "teamManager", "auditor"]);
    const input = await readJson(req);
    const project = data.workfrontProjects.find((item) => item.ref === input.projectRef);
    if (!project || !userHasDepartment(user, project.productionTeamId)) throw new HttpError(403, "Project is outside your team.");
    if (input.action === "recheck") {
      const now = new Date().toISOString();
      for (const entry of data.hygieneVerifications || []) {
        if (entry.projectRef === project.ref && !entry.invalidatedAt) {
          entry.invalidatedAt = now;
          entry.invalidatedBy = user.name;
        }
      }
      await persist();
      return sendJson(res, 200, { projectRef: project.ref, recheckedAt: now, message: "Rechecked latest imported Workfront details; local manual overrides cleared. Sync Workfront first for remote changes." });
    }
    const allowed = processAdherence([project], data.workfrontTasks, data.audits)[0].checks
      .map((check) => check.rule).filter((rule) => ["Primary material", "Material expected delivery", "Planned completion / SLA", "Page count", "Complexity", "Request type"].includes(rule));
    if (!Array.isArray(input.checks) || !input.checks.length || input.checks.length > allowed.length
      || input.checks.some((check) => !check || !allowed.includes(check.rule) || !["Manually verified", "Action required", "Not verified"].includes(check.status))
      || new Set(input.checks.map((check) => check.rule)).size !== input.checks.length) {
      throw new HttpError(400, "Record at least one unique project-field outcome: Manually verified, Action required or Not verified.");
    }
    const entry = { id: crypto.randomUUID(), projectRef: project.ref, fingerprint: hygieneFingerprint(project, data.workfrontTasks, data.audits),
      checks: input.checks.map(({ rule, status }) => ({ rule, status })), note: requireText(input.note, "Observed audited values / evidence", 4000),
      verifiedBy: user.name, verifiedAt: new Date().toISOString() };
    (data.hygieneVerifications ||= []).push(entry);
    await persist();
    return sendJson(res, 201, entry);
  }
  if (method === "POST" && pathname === "/api/audit-sessions") {
    requireProjectManager(user);
    const input = await readJson(req);
    const action = enumValue(input.action, ["start", "hold", "stop"], "Audit clock action");
    const project = data.workfrontProjects.find((item) => item.ref === input.projectRef) || data.projects.find((item) => item.ref === input.projectRef);
    if (!project || !userHasDepartment(user, project.productionTeamId || projectDepartmentId(project))) throw new HttpError(403, "Select a project in your team before starting the audit clock.");
    const crId = cleanText(input.crId, 80);
    const current = (data.auditSessions || []).find((item) => item.userId === user.id && item.state !== "stopped");
    const now = new Date().toISOString();
    if (action === "start") {
      if ((data.executionTimers || []).some((timer) => timer.userId === user.id && timer.state === "running")) throw new HttpError(409, "Hold your execution timer before starting an audit clock.");
      if (current && (current.projectRef !== project.ref || current.crId !== crId || current.state === "running")) throw new HttpError(409, "Hold or stop the active audit before starting another.");
      if (current) Object.assign(current, { state: "running", startedAt: now, updatedAt: now });
      else (data.auditSessions ||= []).push({ id: crypto.randomUUID(), userId: user.id, userName: user.name, teamId: project.productionTeamId || projectDepartmentId(project),
        projectRef: project.ref, crId, state: "running", startedAt: now, firstStartedAt: now, elapsedMs: 0 });
    } else {
      if (!current || current.projectRef !== project.ref || current.crId !== crId || action === "hold" && current.state !== "running") throw new HttpError(409, "No matching running audit clock.");
      settleAuditSession(current, action, user);
    }
    await persist();
    return sendJson(res, 200, { sessions: (data.auditSessions || []).filter((item) => item.userId === user.id) });
  }
  if (method === "POST" && pathname === "/api/cr-audits") {
    requireProjectManager(user);
    const input = await readJson(req);
    const round = data.workfrontChangeRounds.find((item) => item.workfrontId === input.roundId);
    const project = round && data.workfrontProjects.find((item) => item.ref === round.projectRef);
    if (!project || !userHasDepartment(user, project.productionTeamId)) throw new HttpError(403, "CR is outside your team.");
    const assignee = rosterNameForWorkfront(round.assignee) || round.assignee;
    if (!data.users.some((account) => account.name === assignee && ["manager", "teamManager", "auditor"].includes(account.role))
      || round.acceptanceDate || round.completionDate || /^(complete|completed|cancelled|canceled|archived)$/i.test(round.sourceStatus)) throw new HttpError(409, "This CR is no longer awaiting an auditor / manager audit.");
    if (data.audits.some((audit) => audit.projectRef === round.projectRef && audit.crId === round.crId && audit.auditStatus === "Pass")) throw new HttpError(409, "This CR audit is already recorded.");
    const complexity = enumValue(input.complexity, AUDIT_COMPLEXITIES, "CR complexity");
    const startDate = validDate(input.startDate, "CR start date");
    const days = complexity === "Complex" ? 3 : 1;
    const session = (data.auditSessions || []).find((item) => item.userId === user.id && item.state !== "stopped" && item.projectRef === round.projectRef && item.crId === round.crId);
    const entry = { id: crypto.randomUUID(), crId: round.crId, workfrontId: project.workfrontId, projectRef: project.ref, projectName: project.title,
      channel: project.channel || project.assetType, market: project.country || project.market, primaryDpm: project.projectOwner, requestType: project.requestType,
      pageCount: project.pages, complexity, auditType: "Audit", auditStatus: "Pass", startDate, tatDays: days,
      calculatedTat: `${days} Business Day(s)`, etaDate: addBusinessDays(startDate, days, data.holidays), createdAt: new Date().toISOString(),
      signOffName: user.name, auditor: user.name, observations: cleanText(input.note, 4000), compactCR: true };
    if (session) {
      settleAuditSession(session, "stop", user);
      Object.assign(entry, { sessionId: session.id, startedAt: session.firstStartedAt, endedAt: session.endedAt, elapsedMs: session.elapsedMs });
      session.auditId = entry.id;
    }
    data.audits.unshift(entry);
    await persist();
    return sendJson(res, 201, entry);
  }
  if (method === "POST" && pathname === "/api/team") {
    requireRole(user, ["manager"]);
    const name = requireText((await readJson(req)).name, "Team member name", 100);
    if (data.team.some((member) => member.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, "That team member already exists.");
    const member = { id: crypto.randomUUID(), name, shiftStart: EARLY_START_TIME, shiftEnd: NEW_SHIFT_END_TIME, teamIds: [] };
    data.team.push(member);
    await persist();
    return sendJson(res, 201, member);
  }
  const teamEmailMatch = pathname.match(/^\/api\/team\/([a-f0-9-]{36})\/wpp-email$/i);
  if (teamEmailMatch && method === "PUT") {
    requireRole(user, ["manager"]);
    const member = data.team.find((item) => item.id === teamEmailMatch[1]);
    if (!member) throw new HttpError(404, "Team member was not found.");
    const input = (await readJson(req)).wppProductionEmail;
    if (typeof input !== "string") throw new HttpError(400, "WPP Production email must be text.");
    const email = input.trim().toLowerCase();
    if (email && !isWppProductionEmail(email)) throw new HttpError(400, "Enter one valid @wppproduction.com email address, or leave blank to disable notifications.");
    if (email && data.team.some((item) => item.id !== member.id && item.wppProductionEmail?.toLowerCase() === email)) {
      throw new HttpError(409, "That WPP Production email is already assigned to another member.");
    }
    member.wppProductionEmail = email;
    await persist();
    return sendJson(res, 200, member);
  }
  const teamExecutorMatch = pathname.match(/^\/api\/team\/([a-f0-9-]{36})\/report-executor$/i);
  if (teamExecutorMatch && method === "PUT") {
    requireRole(user, ["manager"]);
    const member = data.team.find((item) => item.id === teamExecutorMatch[1]);
    if (!member) throw new HttpError(404, "Team member was not found.");
    const { reportExecutor } = await readJson(req);
    if (typeof reportExecutor !== "boolean") throw new HttpError(400, "Report executor must be true or false.");
    member.reportExecutor = reportExecutor;
    await persist();
    return sendJson(res, 200, member);
  }
  const teamShiftMatch = pathname.match(/^\/api\/team\/([a-f0-9-]{36})\/shift$/i);
  if (teamShiftMatch && method === "PUT") {
    requireRole(user, ["manager"]);
    const member = data.team.find((item) => item.id === teamShiftMatch[1]);
    if (!member) throw new HttpError(404, "Team member was not found.");
    const input = await readJson(req);
    const shiftStart = enumValue(input.shiftStart, [DEFAULT_START_TIME, EARLY_START_TIME], "Shift start");
    const shiftEnd = enumValue(input.shiftEnd || SHIFT_END_TIME, [SHIFT_END_TIME, NEW_SHIFT_END_TIME], "Shift end");
    if (shiftEnd === NEW_SHIFT_END_TIME && shiftStart !== EARLY_START_TIME) {
      throw new HttpError(400, "The 20:30 shift end requires an 11:30 shift start.");
    }
    member.shiftStart = shiftStart;
    member.shiftEnd = shiftEnd;
    for (const task of data.tasks.filter((item) => item.assignee === member.name && item.progress === 0 && !["Completed", "Archived"].includes(item.status))) {
      task.startTime = shiftStart;
      if (task.etaOverride) {
        task.etaTime = task.etaTime < shiftStart ? shiftStart : task.etaTime > shiftEnd ? shiftEnd : task.etaTime;
      }
    }
    reflowAssigneeTasks(member.name);
    await persist();
    return sendJson(res, 200, member);
  }
  const teamWorkfrontMatch = pathname.match(/^\/api\/team\/([a-f0-9-]{36})\/workfront$/i);
  if (teamWorkfrontMatch && method === "PUT") {
    requireRole(user, ["manager"]);
    const member = data.team.find((item) => item.id === teamWorkfrontMatch[1]);
    if (!member) throw new HttpError(404, "Team member was not found.");
    const workfrontIds = normalizeWorkfrontIds((await readJson(req)).workfrontIds);
    for (const id of workfrontIds) {
      const owner = data.team.find((other) => other.id !== member.id
        && [other.name, ...(other.workfrontIds || [])].some((candidate) => candidate.toLowerCase() === id.toLowerCase()));
      if (owner) throw new HttpError(409, `Workfront ID / name "${id}" is already mapped to ${owner.name}.`);
    }
    member.workfrontIds = workfrontIds;
    await persist();
    return sendJson(res, 200, member);
  }
  const teamDepartmentMatch = pathname.match(/^\/api\/team\/([a-f0-9-]{36})\/departments$/i);
  if (teamDepartmentMatch && method === "PUT") {
    requireRole(user, ["manager"]);
    const member = data.team.find((item) => item.id === teamDepartmentMatch[1]);
    if (!member) throw new HttpError(404, "Team member was not found.");
    const input = await readJson(req);
    const teamIds = validDepartmentIds(input.teamIds);
    const losesAssignedWork = data.tasks.some((task) => {
      if ((task.assignee || "").toLowerCase() !== member.name.toLowerCase() || ["Completed", "Archived"].includes(task.status)) return false;
      const project = data.projects.find((item) => item.id === task.projectId);
      const departmentId = projectDepartmentId(project);
      return departmentId && !teamIds.includes("qa") && !teamIds.includes(departmentId);
    });
    if (losesAssignedWork) throw new HttpError(409, "Reassign this member's active tasks before removing access to their production department.");
    member.teamIds = teamIds;
    const account = data.users.find((item) => item.name.toLowerCase() === member.name.toLowerCase());
    if (account && account.role !== "manager") account.teamIds = [...teamIds];
    await persist();
    return sendJson(res, 200, { member, account: account ? publicUser(account) : null });
  }
  if (method === "POST" && pathname === "/api/users") {
    requireRole(user, ["manager"]);
    const input = await readJson(req);
    const account = await createAccount(input, input.role || "executioner");
    return sendJson(res, 201, publicUser(account));
  }
  const userAccessMatch = pathname.match(/^\/api\/users\/([a-f0-9-]{36})\/access$/i);
  if (userAccessMatch && method === "PUT") {
    requireRole(user, ["manager"]);
    const account = data.users.find((item) => item.id === userAccessMatch[1]);
    if (!account) throw new HttpError(404, "Workspace account was not found.");
    const input = await readJson(req);
    const role = enumValue(input.role, USER_ROLES, "Account role");
    if (account.role === "manager" && role !== "manager" && !data.users.some((item) => item.id !== account.id && item.role === "manager")) {
      throw new HttpError(409, "The last Manager account cannot be demoted.");
    }
    const member = data.team.find((item) => item.name.toLowerCase() === account.name.toLowerCase());
    const teamIds = role === "manager" ? [...DEPARTMENT_IDS]
      : role === "leadership" ? []
        : validDepartmentIds(member?.teamIds ?? account.teamIds);
    if (!["manager", "leadership"].includes(role) && !teamIds.length) {
      throw new HttpError(400, "Assign at least one team / department before changing this account role.");
    }
    const assignedTasks = data.tasks.filter((task) => (task.assignee || "").toLowerCase() === account.name.toLowerCase()
      && !["Completed", "Archived"].includes(task.status));
    if (role !== "executioner" && assignedTasks.length) {
      throw new HttpError(409, "Reassign this account's active production tasks before changing it from Executioner / Designer.");
    }
    if (role === "executioner" && assignedTasks.some((task) => {
      const project = data.projects.find((item) => item.id === task.projectId);
      const departmentId = projectDepartmentId(project);
      return departmentId && !teamIds.includes("qa") && !teamIds.includes(departmentId);
    })) {
      throw new HttpError(409, "Assign this account to every department containing its active tasks before changing the role.");
    }
    account.role = role;
    account.teamIds = teamIds;
    if (member) member.teamIds = [...teamIds];
    await persist();
    return sendJson(res, 200, publicUser(account));
  }

  throw new HttpError(404, "API endpoint was not found.");
}

function staticFile(pathname, res) {
  const routeFiles = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/workflow-ui.js": "workflow-ui.js",
    "/operations-ui.js": "operations-ui.js",
    "/process-audit-ui.js": "process-audit-ui.js",
    "/leadership-reports-ui.js": "leadership-reports-ui.js",
    "/fflate.js": "../node_modules/fflate/umd/index.js",
    "/styles.css": "styles.css"
  };
  const fileName = routeFiles[pathname];
  if (!fileName) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  const filePath = path.join(PUBLIC_DIR, fileName);
  const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  fs.createReadStream(filePath)
    .on("error", (error) => {
      console.error("Could not read application asset:", error.message);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Application asset could not be loaded.");
    })
    .on("open", () => res.setHeader("Content-Type", contentTypes[path.extname(filePath)]))
    .pipe(res);
}

async function handleRequest(req, res) {
  setSecurityHeaders(res);
  const secure = Boolean(req.socket.encrypted);
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url, secure);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed.");
    staticFile(url.pathname, res);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error("Request failed:", error);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? "An internal server error occurred." : error.message });
    else res.end();
  }
}

async function main() {
  await loadData();
  runLeadershipReportSchedule();
  leadershipReportScheduler = setInterval(runLeadershipReportSchedule, 60000);
  leadershipReportScheduler.unref();
  startWorkfrontScheduler();
  let server;
  if (process.env.TLS_CERT_FILE || process.env.TLS_KEY_FILE) {
    if (!process.env.TLS_CERT_FILE || !process.env.TLS_KEY_FILE) throw new Error("Set both TLS_CERT_FILE and TLS_KEY_FILE to enable HTTPS.");
    server = https.createServer({
      cert: fs.readFileSync(process.env.TLS_CERT_FILE),
      key: fs.readFileSync(process.env.TLS_KEY_FILE)
    }, handleRequest);
  } else {
    server = http.createServer(handleRequest);
  }
  server.listen(PORT, HOST, () => {
    const address = server.address();
    const protocol = server instanceof https.Server ? "https" : "http";
    console.log(`Creative Lab listening at ${protocol}://localhost:${address.port}`);
    if (HOST === "0.0.0.0" && protocol === "http") {
      for (const interfaces of Object.values(os.networkInterfaces())) {
        for (const network of interfaces || []) {
          if (network.family === "IPv4" && !network.internal) console.log(`Team access: http://${network.address}:${address.port}`);
        }
      }
    }
    if (protocol === "http") console.warn("HTTP is not encrypted. Use HTTPS with TLS_CERT_FILE and TLS_KEY_FILE when credentials cross an untrusted network.");
  });
  const close = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (workfrontScheduler) clearTimeout(workfrontScheduler);
    if (leadershipReportScheduler) clearInterval(leadershipReportScheduler);
    server.close(async (error) => {
      if (error) {
        console.error("Could not stop server cleanly:", error);
        process.exitCode = 1;
      }
      try {
        if (workfrontSyncPromise) await workfrontSyncPromise;
      } catch (syncError) {
        console.error("Workfront sync failed during shutdown:", syncError);
        process.exitCode = 1;
      } finally {
        workspaceStore.close();
      }
    });
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

module.exports = { mapWorkfrontProjectRow, mapWorkfrontTaskRows, workfrontDomReports, mergedWorkloadHours, workfrontRemainingHours, parseWorkfrontAssignments, workfrontNameKeys, bugFixEffortHours, validationMatrixEstimate };

if (require.main === module) {
  main().catch((error) => {
    console.error("Could not start Creative Lab:", error);
    process.exitCode = 1;
  });
}
