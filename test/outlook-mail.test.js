"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createOutlookNotifier, isWppProductionEmail } = require("../outlook-mail");

const env = { OUTLOOK_TENANT_ID: "11111111-1111-1111-1111-111111111111", OUTLOOK_CLIENT_ID: "test-client", OUTLOOK_CLIENT_SECRET: "test-secret" };
const sender = "manager@wppproduction.com";
const recipient = "member@wppproduction.com";
const issue = { id: "issue-1", memberName: "Member One", category: "Quality", date: "2026-10-03", projectRef: "PROJECT-1",
  deliveryKey: "delivery-1", createdBy: "Manager One", note: "Evidence-backed issue.", attachments: [] };
const reply = (status, data) => new Response(data === undefined ? null : JSON.stringify(data), { status });

test("credentials file is used without restart, env wins, and unsafe or invalid files are rejected", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "outlook-credentials-"));
  const file = path.join(directory, "outlook.local.json");
  const tokens = [];
  const fetchImpl = async (url, options) => {
    if (url.includes("/token")) { tokens.push({ url, body: new URLSearchParams(options.body) }); return reply(401); }
    throw new Error("Unexpected request");
  };
  try {
    const notifier = createOutlookNotifier({ env: {}, fetchImpl, credentialsFile: file });
    assert.equal((await notifier.notify(issue, recipient, sender)).status, "not_configured");
    fs.writeFileSync(file, JSON.stringify({ tenantId: env.OUTLOOK_TENANT_ID, clientId: "file-client", clientSecret: "file-secret" }), { mode: 0o644 });
    if (process.platform !== "win32") {
      assert.match((await notifier.notify(issue, recipient, sender)).message, /readable by other users/);
      assert.equal(tokens.length, 0);
    }
    fs.chmodSync(file, 0o600);
    assert.equal((await notifier.notify(issue, recipient, sender)).status, "failed");
    assert.equal(tokens[0].body.get("client_id"), "file-client");
    assert.equal(tokens[0].body.get("client_secret"), "file-secret");
    const withEnv = createOutlookNotifier({ env, fetchImpl, credentialsFile: file });
    await withEnv.notify(issue, recipient, sender);
    assert.equal(tokens[1].body.get("client_id"), "test-client");
    fs.writeFileSync(file, "{ not json", { mode: 0o600 });
    const invalid = await notifier.notify(issue, recipient, sender);
    assert.equal(invalid.status, "not_configured");
    assert.match(invalid.message, /not valid JSON/);
    assert.doesNotMatch(JSON.stringify(invalid), /file-secret/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("WPP mailbox validation rejects lists, controls, external domains and invalid local parts", () => {
  for (const address of ["a@wppproduction.com", "First.Last@WPPProduction.com", "a+b@wppproduction.com"]) assert.ok(isWppProductionEmail(address));
  for (const address of ["a@example.com", "a@wppproduction.com.evil.com", "a@wppproduction.com,b@wppproduction.com",
    "a\r\n@wppproduction.com", "..a@wppproduction.com", ".a@wppproduction.com", "", null]) assert.equal(isWppProductionEmail(address), false);
});

test("missing sender, recipient and credentials produce explicit states without contacting Microsoft", async () => {
  const notifier = createOutlookNotifier({ env: {}, fetchImpl: () => { throw new Error("Must not make a network request"); } });
  assert.equal((await notifier.notify(issue, recipient)).status, "missing_sender");
  assert.equal((await notifier.notify(issue, "", sender)).status, "missing_recipient");
  assert.equal((await notifier.notify(issue, recipient, sender)).status, "not_configured");
});

test("Outlook sends from each logging manager's mailbox, includes details and all small attachments", async () => {
  const calls = [];
  const notifier = createOutlookNotifier({ env, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.includes("/token")) return reply(200, { access_token: "mock-token" });
    if (url.endsWith("/messages")) return reply(201, { id: "draft/id" });
    if (url.endsWith("/attachments")) return reply(201, { id: "attachment" });
    if (url.endsWith("/send")) return reply(202);
    throw new Error("Unexpected request");
  } });
  const attachments = ["first.txt", "second.txt"].map((name) => ({ name, contentBase64: Buffer.from(name).toString("base64") }));
  for (const from of [sender, "second.manager@wppproduction.com"]) {
    const start = calls.length;
    const result = await notifier.notify({ ...issue, attachments }, recipient, from);
    assert.equal(result.status, "accepted");
    assert.equal(result.sender, from);
    assert.match(result.message, /delivery is not confirmed/);
    const draftCall = calls[start + 1];
    assert.equal(draftCall.url, `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/messages`);
    const draft = JSON.parse(draftCall.options.body);
    assert.deepEqual(draft.toRecipients, [{ emailAddress: { address: recipient } }]);
    for (const detail of [issue.note, issue.createdBy, issue.date, issue.category, issue.projectRef, issue.id, issue.deliveryKey]) {
      assert.ok(draft.body.content.includes(detail));
    }
    assert.equal(draft.body.contentType, "Text");
    assert.deepEqual(calls.slice(start + 2, start + 4).map((call) => JSON.parse(call.options.body).contentBytes), attachments.map((file) => file.contentBase64));
    assert.ok(calls[start + 4].url.endsWith("/messages/draft%2Fid/send"));
  }
  assert.equal(new URLSearchParams(calls[0].options.body).get("scope"), "https://graph.microsoft.com/.default");
});

test("large evidence uses bounded sequential upload chunks, without leaking the bearer token", async () => {
  const content = Buffer.alloc(5 * 1024 * 1024, 97);
  const chunks = [];
  const notifier = createOutlookNotifier({ env, fetchImpl: async (url, options) => {
    if (url.includes("/token")) return reply(200, { access_token: "mock-token" });
    if (url.endsWith("/messages")) return reply(201, { id: "draft" });
    if (url.endsWith("/createUploadSession")) {
      assert.deepEqual(JSON.parse(options.body), { AttachmentItem: { attachmentType: "file", name: "large.pdf", size: content.length } });
      return reply(201, { uploadUrl: "https://outlook.office.com/upload?token=private" });
    }
    if (options.method === "PUT") {
      chunks.push(options);
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.redirect, "error");
      return reply(chunks.length === 2 ? 201 : 200);
    }
    if (url.endsWith("/send")) {
      assert.equal(chunks.length, 2, "send only after all evidence uploaded");
      return reply(202);
    }
    throw new Error("Unexpected request");
  } });
  const result = await notifier.notify({ ...issue, attachments: [{ name: "large.pdf", contentBase64: content.toString("base64") }] }, recipient, sender);
  assert.equal(result.status, "accepted");
  assert.deepEqual(Buffer.concat(chunks.map((chunk) => chunk.body)), content);
  assert.equal(chunks[0].headers["Content-Range"], `bytes 0-3276799/${content.length}`);
  assert.equal(chunks[1].headers["Content-Range"], `bytes 3276800-${content.length - 1}/${content.length}`);
});

test("authentication, evidence and send failures are explicit, redacted, and never retried", async () => {
  for (const failure of ["auth", "attachment", "send", "timeout"]) {
    const calls = [];
    const notifier = createOutlookNotifier({ env, fetchImpl: async (url) => {
      calls.push(url);
      if (failure === "timeout") throw new Error("sensitive-secret");
      if (url.includes("/token")) return failure === "auth" ? reply(401, { error: "sensitive-secret" }) : reply(200, { access_token: "token" });
      if (url.endsWith("/messages")) return reply(201, { id: "draft" });
      if (url.endsWith("/attachments")) return failure === "attachment" ? reply(403, { error: "sensitive-secret" }) : reply(201, {});
      if (url.endsWith("/send")) return reply(503, { error: "sensitive-secret" });
      throw new Error("Unexpected request");
    } });
    const result = await notifier.notify({ ...issue, attachments: [{ name: "evidence.txt", contentBase64: "YQ==" }] }, recipient, sender);
    assert.equal(result.status, "failed");
    assert.match(result.message, /No automatic retry/);
    assert.doesNotMatch(JSON.stringify(result), /sensitive-secret|contentBase64|access_token/);
    assert.equal(calls.filter((url) => url.endsWith("/send")).length, failure === "send" ? 1 : 0);
  }
});

test("upload host validation prevents evidence being sent to an unexpected host", async () => {
  let uploaded = false;
  const notifier = createOutlookNotifier({ env, fetchImpl: async (url, options) => {
    if (url.includes("/token")) return reply(200, { access_token: "token" });
    if (url.endsWith("/messages")) return reply(201, { id: "draft" });
    if (url.endsWith("/createUploadSession")) return reply(201, { uploadUrl: "https://example.com/upload" });
    uploaded = true;
    throw new Error("Unexpected request");
  } });
  const result = await notifier.notify({ ...issue, attachments: [{ name: "evidence", contentBase64: Buffer.alloc(3 * 1024 * 1024).toString("base64") }] }, recipient, sender);
  assert.equal(result.status, "failed");
  assert.equal(uploaded, false);
  assert.match(result.message, /unexpected upload host/);
});

test("malformed Microsoft responses cannot be reported as a successful send", async () => {
  for (const stage of ["token", "draft", "session"]) {
    let sent = false;
    const notifier = createOutlookNotifier({ env, fetchImpl: async (url) => {
      if (url.includes("/token")) return reply(200, stage === "token" ? {} : { access_token: "token" });
      if (url.endsWith("/messages")) return reply(201, stage === "draft" ? {} : { id: "draft" });
      if (url.endsWith("/createUploadSession")) return reply(201, {});
      sent = true;
      throw new Error("Unexpected request");
    } });
    const result = await notifier.notify({ ...issue, attachments: [{ name: "evidence", contentBase64: Buffer.alloc(3 * 1024 * 1024).toString("base64") }] }, recipient, sender);
    assert.equal(result.status, "failed");
    assert.equal(sent, false);
  }
});
