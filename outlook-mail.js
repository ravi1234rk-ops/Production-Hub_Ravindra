"use strict";

const fs = require("node:fs");

const GRAPH = "https://graph.microsoft.com/v1.0";
const SMALL_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
const UPLOAD_CHUNK_SIZE = 10 * 320 * 1024;

function isWppProductionEmail(value) {
  return typeof value === "string" && value.length <= 254
    && /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@wppproduction\.com$/i.test(value);
}

class OutlookError extends Error {}

// Environment variables win; the optional JSON file is re-read per send so edits need no restart.
function loadCredentials(env, credentialsFile) {
  const credentials = { tenant: env.OUTLOOK_TENANT_ID, client: env.OUTLOOK_CLIENT_ID, secret: env.OUTLOOK_CLIENT_SECRET };
  if (credentials.tenant && credentials.client && credentials.secret || !credentialsFile) return credentials;
  let stat;
  try {
    stat = fs.statSync(credentialsFile);
  } catch (error) {
    if (error.code === "ENOENT") return credentials;
    return { ...credentials, error: "Outlook credentials file could not be read." };
  }
  if (!stat.isFile()) return { ...credentials, error: "Outlook credentials path is not a file." };
  if (process.platform !== "win32" && stat.mode & 0o077) {
    return { ...credentials, error: "Outlook credentials file is readable by other users. Run: chmod 600 config/outlook.local.json" };
  }
  let file;
  try {
    file = JSON.parse(fs.readFileSync(credentialsFile, "utf8"));
  } catch {
    return { ...credentials, error: "Outlook credentials file is not valid JSON." };
  }
  const text = (value) => typeof value === "string" ? value.trim() : "";
  const pick = (current, value) => current || text(value);
  return { tenant: pick(credentials.tenant, file.tenantId), client: pick(credentials.client, file.clientId), secret: pick(credentials.secret, file.clientSecret) };
}

function createOutlookNotifier({ env = process.env, fetchImpl = globalThis.fetch, credentialsFile } = {}) {
  async function request(url, options, expected, stage) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, redirect: "error", signal: AbortSignal.timeout(30000) });
    } catch {
      throw new OutlookError(`${stage}: Microsoft connection failed or timed out.`);
    }
    if (!expected.includes(response.status)) throw new OutlookError(`${stage}: Microsoft returned HTTP ${response.status}.`);
    return response;
  }

  async function json(response, stage) {
    try {
      return await response.json();
    } catch {
      throw new OutlookError(`${stage}: Microsoft returned an invalid response.`);
    }
  }

  async function notify(issue, recipient, sender) {
    const base = { sender: sender || "", recipient: recipient || "", attemptedAt: new Date().toISOString() };
    if (!isWppProductionEmail(sender)) return { ...base, status: "missing_sender", message: "Not emailed: set the logging manager's WPP Production email in Teams." };
    if (!isWppProductionEmail(recipient)) return { ...base, status: "missing_recipient", message: "Not emailed: set this member's WPP Production email in Teams." };
    const { tenant, client, secret, error } = loadCredentials(env, credentialsFile);
    if (error) return { ...base, status: "not_configured", message: `Not emailed: ${error}` };
    if (!tenant || !client || !secret) return { ...base, status: "not_configured", message: "Not emailed: Outlook application credentials are not configured on the server." };
    if (!/^[a-f0-9-]{36}$/i.test(tenant)) {
      return { ...base, status: "failed", message: "Not emailed: invalid Outlook tenant ID configuration." };
    }
    let draftId;
    let stage = "Outlook authentication";
    try {
      const tokenResponse = await request(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: "POST",
        body: new URLSearchParams({ client_id: client, client_secret: secret, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" })
      }, [200], stage);
      const token = (await json(tokenResponse, stage)).access_token;
      if (typeof token !== "string" || !token) throw new OutlookError("Outlook authentication: Microsoft did not return an access token.");
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const mailbox = `${GRAPH}/users/${encodeURIComponent(sender)}`;
      const post = (url, body, expected, label) => request(url, { method: "POST", headers, body: JSON.stringify(body) }, expected, label);
      stage = "Creating Outlook draft";
      const draft = await json(await post(`${mailbox}/messages`, {
        subject: `KPI issue: ${issue.category} - ${issue.memberName} (${issue.date})`,
        body: { contentType: "Text", content: [
          `Hello ${issue.memberName},`, "", "A KPI issue has been logged for you.",
          `Date: ${issue.date}`, `Category: ${issue.category}`, `Project: ${issue.projectRef || "General"}`,
          `Delivery: ${issue.deliveryKey || "Not linked"}`, `Logged by: ${issue.createdBy}`,
          "", issue.note, "", `Issue reference: ${issue.id}`, "Evidence files are attached when supplied."
        ].join("\n") },
        toRecipients: [{ emailAddress: { address: recipient } }]
      }, [201], stage), stage);
      draftId = draft.id;
      if (typeof draftId !== "string" || !draftId) throw new OutlookError("Creating Outlook draft: Microsoft did not return a message ID.");
      const message = `${mailbox}/messages/${encodeURIComponent(draftId)}`;
      for (const file of issue.attachments || []) {
        stage = "Attaching KPI evidence";
        const content = Buffer.from(file.contentBase64, "base64");
        if (content.length < SMALL_ATTACHMENT_LIMIT) {
          await post(`${message}/attachments`, {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: file.name, contentType: "application/octet-stream", contentBytes: file.contentBase64
          }, [201], stage);
        } else {
          const session = await json(await post(`${message}/attachments/createUploadSession`, {
            AttachmentItem: { attachmentType: "file", name: file.name, size: content.length }
          }, [201], stage), stage);
          let uploadUrl;
          try { uploadUrl = new URL(session.uploadUrl); } catch { throw new OutlookError("Attaching KPI evidence: Microsoft returned an invalid upload URL."); }
          if (uploadUrl.protocol !== "https:" || uploadUrl.hostname !== "outlook.office.com" || uploadUrl.port || uploadUrl.username || uploadUrl.password) {
            throw new OutlookError("Attaching KPI evidence: Microsoft returned an unexpected upload host.");
          }
          for (let start = 0; start < content.length; start += UPLOAD_CHUNK_SIZE) {
            const end = Math.min(start + UPLOAD_CHUNK_SIZE, content.length);
            await request(uploadUrl.href, {
              method: "PUT",
              headers: { "Content-Type": "application/octet-stream", "Content-Length": String(end - start), "Content-Range": `bytes ${start}-${end - 1}/${content.length}` },
              body: content.subarray(start, end)
            }, end === content.length ? [201] : [200], stage);
          }
        }
      }
      stage = "Submitting Outlook email";
      await request(`${message}/send`, { method: "POST", headers }, [202], stage);
      return { ...base, status: "accepted", acceptedAt: new Date().toISOString(), message: "Accepted by Outlook for sending; delivery is not confirmed." };
    } catch (error) {
      if (!(error instanceof OutlookError)) throw error;
      return { ...base, status: "failed", draftId,
        message: `${error.message} No automatic retry. Check the sender's Sent Items and Drafts before sending manually.` };
    }
  }

  return { notify };
}

module.exports = { createOutlookNotifier, isWppProductionEmail };
