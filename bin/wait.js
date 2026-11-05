#!/usr/bin/env node
// Waits, with no polling, until the owner writes on the desk, then prints what they did and exits.
// Claude runs it in the background: its exit wakes the Claude Code session. It works only
// while that session is open; the page shows "Claude is listening" while one waits.
// A message, a new ticket, or a ticket handed to Claude wakes it. It starts where the last
// one stopped (data/listener-offset), so nothing written in between is missed.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const EVENTS = path.join(DATA, "events.jsonl");
const STORE = path.join(DATA, "chat.json");
const LISTENER = path.join(DATA, "listener.json");
const OFFSET = path.join(DATA, "listener-offset");
const OWNER = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8")).owner.id).toLowerCase();
  } catch {
    return "owner";
  }
})();

const size = () => (fs.existsSync(EVENTS) ? fs.statSync(EVENTS).size : 0);
let offset = Number(fs.existsSync(OFFSET) ? fs.readFileSync(OFFSET, "utf8") : size()) || 0;

fs.writeFileSync(LISTENER, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), { mode: 0o600 });
function cleanup() {
  try {
    if (JSON.parse(fs.readFileSync(LISTENER, "utf8")).pid === process.pid) fs.unlinkSync(LISTENER);
  } catch {}
}
process.on("exit", cleanup);
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => process.exit(0));

function waitsOnClaude(q) {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8")).tickets[q]?.waitingOn === "claude";
  } catch {
    return false;
  }
}

function check() {
  const end = size();
  if (end < offset) offset = 0;
  if (end === offset) return;
  const fd = fs.openSync(EVENTS, "r");
  const buf = Buffer.alloc(end - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  // Only whole lines: a write still going on is read next time
  const text = buf.toString("utf8");
  const whole = text.lastIndexOf("\n") + 1;
  offset += Buffer.byteLength(text.slice(0, whole));
  const hits = text
    .slice(0, whole)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(
      (e) =>
        e != null &&
        e.from === OWNER &&
        (e.kind === "message" ||
          e.kind === "ticket" ||
          (e.kind === "update" && (e.fields || []).includes("waitingOn") && waitsOnClaude(e.q)))
    );
  fs.writeFileSync(OFFSET, String(offset), { mode: 0o600 });
  if (hits.length > 0) {
    for (const h of hits) console.log(JSON.stringify(h));
    process.exit(0);
  }
}

fs.watch(DATA, (_event, name) => {
  if (name === "events.jsonl") check();
});
check();
