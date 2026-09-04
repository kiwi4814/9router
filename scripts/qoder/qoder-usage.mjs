#!/usr/bin/env node
/**
 * qoder-usage.mjs — read-only QoderCN Enterprise VPC credit usage snapshot.
 *
 * Reads the local provider connection (owner-only data.sqlite), performs the
 * PAT→job-token exchange in memory, and prints the current quota. Prints NO
 * tokens, cookies, or secrets.
 *
 * Usage:
 *   node scripts/qoder/qoder-usage.mjs [--db <path>] [--show-identity]
 *     dbPath defaults to $HOME/.9router/db/data.sqlite
 *
 * Run with the same Node used to build this repo's native deps (node@lts):
 *   mise x node@lts -- node scripts/qoder/qoder-usage.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
let dbPath = `${process.env.HOME}/.9router/db/data.sqlite`;
let showIdentity = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--show-identity") {
    showIdentity = true;
  } else if (args[i] === "--db" && args[i + 1]) {
    dbPath = args[++i];
  } else if (!args[i].startsWith("-")) {
    dbPath = args[i];
  }
}

const req = createRequire(path.join(REPO, "package.json"));
const Database = req("better-sqlite3");

const { getQoderUsage } = await import(path.join(REPO, "open-sse/services/usage/misc.js"));
const { resolveQoderCredentials } = await import(path.join(REPO, "open-sse/services/qoderModels.js"));

const db = new Database(dbPath, { readonly: true });
const row = db.prepare("SELECT * FROM providerConnections WHERE provider = ?").get("qoder");
db.close();
if (!row) throw new Error("No qoder provider connection found in DB: " + dbPath);

const conn = {
  ...JSON.parse(row.data),
  id: row.id,
  provider: row.provider,
  authType: row.authType,
  email: row.email,
};
const creds = await resolveQoderCredentials(conn);
const usage = await getQoderUsage(creds.accessToken);

const org = (usage.quotas && usage.quotas.organization) || {};
const user = (usage.quotas && usage.quotas.user) || {};
const lines = [];
lines.push("QoderCN Enterprise VPC 额度快照");
lines.push("==============================");
if (showIdentity) {
  const identity = conn.email
    ? `${conn.displayName || "Qoder user"} <${conn.email}>`
    : (conn.displayName || "Qoder user");
  lines.push(`账号:           ${identity} (${usage.userType || "enterprise"})`);
} else {
  lines.push(`账号类型:       ${usage.userType || "enterprise"}`);
}
if (org.total) lines.push("组织配额总量:   " + org.total + " credits");
if (org.used != null) lines.push("已用(本月):     " + org.used + " credits");
if (org.remaining != null) lines.push("剩余:           " + org.remaining + " credits");
if (org.resetAt) lines.push("额度重置时间:   " + org.resetAt);
if (user.total || user.remaining != null) {
  lines.push("个人额度:       total=" + (user.total ?? "-") + " used=" + (user.used ?? "-") + " remaining=" + (user.remaining ?? "-"));
}
if (usage.isQuotaExceeded) lines.push("超限警告:       是 (额度已用完)");
console.log(lines.join("\n"));
