// A ticket desk between one person (the owner) and a Claude Code session: one conversation per ticket.
// No dependencies. Settings in config.json next to this file (see config.example.json).
// The owner signs in with the one password whose scrypt hash is in data/auth.json
// (bin/set-password.js); Claude's tool on this machine (bin/desk.js) sends data/token.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA = path.join(__dirname, "data");
const STORE = path.join(DATA, "chat.json");
const EVENTS = path.join(DATA, "events.jsonl");
const AUTH = path.join(DATA, "auth.json");
const TOKEN = path.join(DATA, "token");
const SESSIONS = path.join(DATA, "sessions.json");
// bin/wait.js writes its pid here while Claude's session waits for the owner
const LISTENER = path.join(DATA, "listener.json");
const SESSION_DAYS = 30;
const BODY_MAX = 2 * 1024 * 1024;
const TEXT_MAX = 400 * 1024;
const STATUS = new Set(["discussing", "resolved", "done", "deferred"]);

const config = loadConfig();
const port = Number(process.env.PORT || config.port);
const OWNER = config.owner.id;
const WHO = new Set([OWNER, "claude", ...config.others.map((o) => o.id), "nobody"]);
const WHO_TEXT = [...WHO].join(", ");
// Two desks on one host share its cookies: each port has its own
const COOKIE = "desk_" + port;

function loadConfig() {
  const c = readJson(path.join(__dirname, "config.json"), {});
  const person = (p, id, name) => ({ id: String(p?.id || id).toLowerCase(), name: String(p?.name || name) });
  const owner = person(c.owner, "owner", "Owner");
  const others = (Array.isArray(c.others) ? c.others : [])
    .map((o) => person(o, "", ""))
    .filter((o) => /^[a-z][a-z0-9_-]{0,19}$/.test(o.id) && !["claude", "nobody", owner.id].includes(o.id));
  const plan = c.plan?.url && /^https:\/\//.test(c.plan.url) ? { label: String(c.plan.label || "The plan"), url: c.plan.url } : null;
  return { title: String(c.title || "Desk"), port: Number(c.port) || 3002, owner, others, plan };
}

fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

let store = readJson(STORE, { version: 1, tickets: {}, messages: [] });
let sessions = readJson(SESSIONS, {});
if (!fs.existsSync(TOKEN))
  fs.writeFileSync(TOKEN, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
const claudeToken = fs.readFileSync(TOKEN, "utf8").trim();

function save(event) {
  store.version++;
  writeJson(STORE, store);
  if (event) fs.appendFileSync(EVENTS, JSON.stringify({ ...event, version: store.version }) + "\n", { mode: 0o600 });
}

// ---- auth

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function passwordOk(password) {
  const auth = readJson(AUTH, null);
  if (auth == null || typeof password !== "string") return false;
  const hash = crypto.scryptSync(password, Buffer.from(auth.salt, "hex"), 64).toString("hex");
  return safeEqual(hash, auth.hash);
}
function cookieOf(req) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}
function whoIs(req) {
  if (safeEqual(req.headers["x-desk-token"] || "", claudeToken)) return "claude";
  const sid = cookieOf(req);
  const s = sid == null ? null : sessions[sid];
  if (s != null && s.until > Date.now()) return OWNER;
  return null;
}
// A few tries a minute, from anywhere: one password, one person
let tries = [];
function tooManyTries() {
  const now = Date.now();
  tries = tries.filter((t) => now - t < 60_000);
  return tries.length >= 5;
}

function listening() {
  const l = readJson(LISTENER, null);
  if (l == null || !Number.isInteger(l.pid)) return false;
  try {
    process.kill(l.pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---- tickets

const nowIso = () => new Date().toISOString();
const qid = (n) => "Q" + String(n).padStart(2, "0");
const otherOf = (from) => (from === "claude" ? OWNER : "claude");
const list = (v) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.length <= 40).slice(0, 30) : undefined;

function addMessage(q, from, text) {
  const message = { id: crypto.randomBytes(9).toString("base64url"), q, from, text, at: nowIso() };
  store.messages.push(message);
  return message;
}

function newTicket(from, body) {
  const title = String(body.title || "").trim().slice(0, 120);
  const text = String(body.text || "").trim();
  if (!title || !text) return { status: 400, body: { error: "A ticket needs a title and a first message" } };
  if (text.length > TEXT_MAX) return { status: 413, body: { error: "The message is too long" } };
  const num = Math.max(0, ...Object.values(store.tickets).map((t) => t.num || 0)) + 1;
  const id = qid(num);
  const at = nowIso();
  store.tickets[id] = {
    num,
    title,
    waitingOn: WHO.has(body.waitingOn) ? body.waitingOn : otherOf(from),
    status: "discussing",
    steps: list(body.steps) || [],
    blocks: [],
    blockedBy: [],
    decision: "",
    startedBy: from,
    createdAt: at,
    updatedAt: at
  };
  const message = addMessage(id, from, text);
  save({ kind: "ticket", q: id, from, at, title });
  return { status: 200, body: { id, message } };
}

function patchTicket(id, body) {
  const t = store.tickets[id];
  if (t == null) return { status: 404, body: { error: "No such ticket" } };
  if (body.waitingOn !== undefined) {
    if (!WHO.has(body.waitingOn)) return { status: 400, body: { error: "waitingOn: " + WHO_TEXT } };
    t.waitingOn = body.waitingOn;
  }
  if (body.status !== undefined) {
    if (!STATUS.has(body.status)) return { status: 400, body: { error: "status: discussing, resolved, done or deferred" } };
    t.status = body.status;
  }
  if (typeof body.title === "string" && body.title.trim()) t.title = body.title.trim().slice(0, 120);
  if (typeof body.decision === "string") t.decision = body.decision.slice(0, 4000);
  for (const key of ["steps", "blocks", "blockedBy"]) {
    const v = list(body[key]);
    if (v !== undefined) t[key] = v;
  }
  // Archived: out of every view but the archive, whatever its status
  if (typeof body.archived === "boolean") {
    t.archived = body.archived;
    t.archivedAt = body.archived ? nowIso() : null;
  }
  t.updatedAt = nowIso();
  return null;
}

function postMessage(id, from, body) {
  const t = store.tickets[id];
  if (t == null) return { status: 404, body: { error: "No such ticket" } };
  const text = String(body.text || "").trim();
  if (!text) return { status: 400, body: { error: "An empty message" } };
  if (text.length > TEXT_MAX) return { status: 413, body: { error: "The message is too long" } };
  if (body.waitingOn !== undefined && !WHO.has(body.waitingOn))
    return { status: 400, body: { error: "waitingOn: " + WHO_TEXT } };
  if (body.status !== undefined && !STATUS.has(body.status))
    return { status: 400, body: { error: "status: discussing, resolved, done or deferred" } };
  const message = addMessage(id, from, text);
  t.waitingOn = otherOf(from);
  // A new message reopens the ticket (out of resolved, done, deferred or the archive); a status sent with the message
  // still applies after it, so answering and closing is one post
  t.status = "discussing";
  if (t.archived) {
    t.archived = false;
    t.archivedAt = null;
  }
  patchTicket(id, body);
  save({ kind: "message", q: id, from, at: message.at, id: message.id });
  return { status: 200, body: { message } };
}

// ---- http

function send(res, status, body, headers = {}) {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    ...headers
  });
  res.end(json);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_MAX) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("not JSON"));
      }
    });
    req.on("error", reject);
  });
}
// Each desk has its own color: a hue from the hash of its token (random per desk, so stable across restarts),
// or "hue" (0-359) in config.json. It colors the page's brand, the sign-in page and the icon.
const HUE = Number.isInteger(config.hue)
  ? ((config.hue % 360) + 360) % 360
  : parseInt(crypto.createHash("sha256").update(claudeToken).digest("hex").slice(0, 8), 16) % 360;
function hslHex(h, s, l) {
  s /= 100;
  l /= 100;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return "#" + f(0) + f(8) + f(4);
}
const DARK_THEME = `--brand: hsl(${HUE} 80% 68%); --brand-ink: #1d2125; --brand-soft: hsl(${HUE} 40% 19%); --selected: hsl(${HUE} 40% 19%); --accent: hsl(${HUE} 60% 66%); --accent-ink: #0e151c;`;
const THEME_CSS =
  `:root { --brand: hsl(${HUE} 75% 40%); --brand-ink: #ffffff; --brand-soft: hsl(${HUE} 85% 95%); --selected: hsl(${HUE} 85% 95%); --accent: hsl(${HUE} 60% 38%); --accent-ink: #ffffff; }\n` +
  `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${DARK_THEME} } }\n` +
  `:root[data-theme="dark"] { ${DARK_THEME} }`;
const ICON_COLOR = encodeURIComponent(hslHex(HUE, 75, 40));
const escHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// The page asks /api/state for the people; the title and the owner's name are filled in here
const page = (name) =>
  fs
    .readFileSync(path.join(__dirname, "public", name), "utf8")
    .replace(/\{\{TITLE\}\}/g, escHtml(config.title))
    .replace(/\{\{THEME\}\}/g, THEME_CSS)
    .replace(/\{\{ICON_COLOR\}\}/g, ICON_COLOR)
    .replace(/\{\{INITIAL\}\}/g, escHtml(config.title.trim().charAt(0).toUpperCase() || "D"))
    .replace(/\{\{OWNER\}\}/g, escHtml(config.owner.name))
    .replace(/\{\{HINT\}\}/g, escHtml((readJson(AUTH, null) || {}).hint || ""));
const PAGE_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

async function handle(req, res) {
  const url = new URL(req.url, "http://desk");
  const p = url.pathname;
  const who = whoIs(req);

  if (req.method === "POST" && p === "/login") {
    if (tooManyTries()) return send(res, 429, { error: "Too many tries; wait a minute" });
    tries.push(Date.now());
    const body = await readBody(req).catch(() => ({}));
    if (!passwordOk(body.password)) return send(res, 401, { error: "Wrong password" });
    const sid = crypto.randomBytes(32).toString("base64url");
    sessions[sid] = { until: Date.now() + SESSION_DAYS * 86_400_000 };
    for (const [k, s] of Object.entries(sessions)) if (s.until < Date.now()) delete sessions[k];
    writeJson(SESSIONS, sessions);
    return send(res, 200, { ok: true }, {
      "Set-Cookie": `${COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`
    });
  }
  if (req.method === "POST" && p === "/logout") {
    const sid = cookieOf(req);
    if (sid != null && sessions[sid]) {
      delete sessions[sid];
      writeJson(SESSIONS, sessions);
    }
    return send(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
  }
  if (req.method === "GET" && (p === "/" || p === "/index.html"))
    return send(res, 200, page(who == null ? "login.html" : "index.html"), PAGE_HEADERS);

  if (!p.startsWith("/api/")) return send(res, 404, { error: "Not found" });
  if (who == null) return send(res, 401, { error: "Sign in first" });
  // A write from the page must come from the page
  if (req.method !== "GET" && who === OWNER && req.headers["x-desk"] !== "1")
    return send(res, 403, { error: "Missing the page's header" });

  if (req.method === "GET" && p === "/api/state") {
    const since = Number(url.searchParams.get("since") || 0);
    if (since === store.version) return send(res, 200, { version: store.version, unchanged: true, listening: listening() });
    const people = { owner: config.owner, others: config.others };
    return send(res, 200, { version: store.version, me: who, title: config.title, people, plan: config.plan, listening: listening(), tickets: store.tickets, messages: store.messages, seen: store.seen || {} });
  }
  const body = req.method === "GET" ? {} : await readBody(req).catch((e) => ({ __error: e.message }));
  if (body.__error) return send(res, 400, { error: body.__error });
  if (req.method === "POST" && p === "/api/tickets") {
    const r = newTicket(who, body);
    return send(res, r.status, r.body);
  }
  // The owner's newest message read per ticket, kept here so phone and desktop agree; no event, so it wakes nobody
  const s = /^\/api\/tickets\/(Q\d+)\/seen$/.exec(p);
  if (s && req.method === "POST") {
    if (who !== OWNER) return send(res, 403, { error: "Only the owner's reading counts" });
    if (store.tickets[s[1]] == null) return send(res, 404, { error: "No such ticket" });
    const at = typeof body.at === "string" && !isNaN(Date.parse(body.at)) ? body.at : null;
    if (at == null) return send(res, 400, { error: "at: the newest message's time" });
    store.seen = store.seen || {};
    if ((store.seen[s[1]] || "") < at) {
      store.seen[s[1]] = at;
      save(null);
    }
    return send(res, 200, { ok: true });
  }
  const m = /^\/api\/tickets\/(Q\d+)(\/messages)?$/.exec(p);
  if (m && req.method === "POST" && m[2]) {
    const r = postMessage(m[1], who, body);
    return send(res, r.status, r.body);
  }
  if (m && req.method === "PATCH" && !m[2]) {
    const refused = patchTicket(m[1], body);
    if (refused) return send(res, refused.status, refused.body);
    save({ kind: "update", q: m[1], from: who, at: nowIso(), fields: Object.keys(body) });
    return send(res, 200, { ticket: store.tickets[m[1]] });
  }
  return send(res, 404, { error: "Not found" });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) send(res, 500, { error: "Server error" });
    });
  })
  .listen(port, "127.0.0.1", () => console.log("desk listening on 127.0.0.1:" + port));

// A new server.js restarts the service (systemd's Restart=always); pages are read per request
fs.watchFile(__filename, { interval: 2000 }, () => {
  console.log("server.js changed, restarting");
  setTimeout(() => process.exit(0), 300);
});
