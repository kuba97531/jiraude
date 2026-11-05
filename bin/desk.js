#!/usr/bin/env node
// Claude's side of the desk, on this machine: node <desk>/bin/desk.js <command>
//   list [--waiting <who>] [--all]                       open tickets (all with --all)
//   show Q64 [--last N]                                  a ticket and its messages
//   since <ISO time>                                     the others' messages after it
//   new --title "..." --file msg.md [--waiting <owner>] [--steps B3,B4]
//   post Q64 --file msg.md [--waiting <owner>] [--status done] [--decision "..."]
//   set Q64 [--waiting ..] [--status ..] [--decision ..] [--title ..] [--blocks Q1,Q2] [--blocked-by ..] [--steps ..]
//           [--archive | --unarchive]
// A message file may hold ```svg blocks: the page draws them as diagrams.
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const TOKEN = fs.readFileSync(path.join(ROOT, "data", "token"), "utf8").trim();
const CONFIG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  } catch {
    return {};
  }
})();
const PORT = Number(process.env.PORT || CONFIG.port || 3002);

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: url, method, headers: { "X-Desk-Token": TOKEN, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try { json = JSON.parse(text); } catch { json = { error: text }; }
          if (res.statusCode >= 400) reject(new Error(`${res.statusCode}: ${json.error || text}`));
          else resolve(json);
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next == null || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}
const csv = (v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
function fields(f) {
  const body = {};
  if (typeof f.waiting === "string") body.waitingOn = f.waiting;
  if (typeof f.status === "string") body.status = f.status;
  if (typeof f.decision === "string") body.decision = f.decision;
  if (typeof f.title === "string") body.title = f.title;
  if (f.blocks !== undefined) body.blocks = csv(f.blocks) || [];
  if (f["blocked-by"] !== undefined) body.blockedBy = csv(f["blocked-by"]) || [];
  if (f.steps !== undefined) body.steps = csv(f.steps) || [];
  if (f.archive) body.archived = true;
  if (f.unarchive) body.archived = false;
  return body;
}
function text(f) {
  if (typeof f.file !== "string") throw new Error("--file <message file> is required");
  // a file written on Windows has CRLF line ends; messages keep LF only (code and svg fences need it)
  return fs.readFileSync(f.file, "utf8").replace(/\r\n?/g, "\n");
}
const byNum = (a, b) => (a[1].num || 0) - (b[1].num || 0);

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  if (cmd === "list") {
    const s = await call("GET", "/api/state");
    for (const [id, t] of Object.entries(s.tickets).sort(byNum)) {
      const open = t.status !== "done" && t.status !== "deferred" && !t.archived;
      if (!f.all && !open) continue;
      if (typeof f.waiting === "string" && t.waitingOn !== f.waiting) continue;
      const last = s.messages.filter((m) => m.q === id).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
      console.log(`${id}\t${t.waitingOn}\t${t.status}\t${t.title}\t${last ? last.from + " " + last.at : "-"}`);
    }
  } else if (cmd === "show") {
    const id = f._[0];
    const s = await call("GET", "/api/state");
    const t = s.tickets[id];
    if (!t) throw new Error("No such ticket: " + id);
    console.log(JSON.stringify({ id, ...t }, null, 1));
    let ms = s.messages.filter((m) => m.q === id).sort((a, b) => (a.at < b.at ? -1 : 1));
    if (f.last) ms = ms.slice(-Number(f.last));
    for (const m of ms) console.log(`\n--- ${m.from} ${m.at} (${m.id})\n${m.text}`);
  } else if (cmd === "since") {
    const since = f._[0] || "";
    const s = await call("GET", "/api/state");
    for (const m of s.messages.filter((x) => x.from !== "claude" && x.at > since).sort((a, b) => (a.at < b.at ? -1 : 1)))
      console.log(`\n--- ${m.q} ${m.from} ${m.at}\n${m.text}`);
  } else if (cmd === "new") {
    const r = await call("POST", "/api/tickets", { title: f.title, text: text(f), ...fields(f) });
    console.log(r.id, r.message.at);
  } else if (cmd === "post") {
    const r = await call("POST", `/api/tickets/${f._[0]}/messages`, { text: text(f), ...fields(f) });
    console.log(r.message.id, r.message.at);
  } else if (cmd === "set") {
    const r = await call("PATCH", `/api/tickets/${f._[0]}`, fields(f));
    console.log(JSON.stringify(r.ticket));
  } else {
    console.error(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 10).join("\n"));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
