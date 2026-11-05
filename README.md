# jiraude

A small ticket desk for working with a Claude Code session. One person (the owner) and Claude talk in tickets, one
conversation per ticket. The owner reads and answers on a web page, from a desk or a phone. Claude reads and answers
with a command-line tool on the machine where its session runs. When the owner writes, a waiter process exits and
wakes the Claude session. Nothing polls.

- No dependencies: Node 18 or later, nothing to install.
- One folder per desk: the code, its `config.json` and its `data/`.
- The data is one JSON file plus an event log, on the same machine as the Claude session.

How Claude should use it: [PROTOCOL.md](PROTOCOL.md). Copy or link it into the project's `CLAUDE.md`.

## What a ticket has

- **Key:** `Q01`, `Q02`, …, numbered in order.
- **Title** and **messages:** messages are a Markdown subset (headings, lists, bold, inline code, code fences, links).
  A ` ```svg ` fence is drawn as a diagram, and `Q12` in text links to that ticket.
- **Waiting on:** the owner, `claude`, any other person from the config, or `nobody`. A message from one side hands the
  ticket to the other.
- **Status:** `discussing` (shown as Open), `resolved`, `done` or `deferred`.
- **Decision:** one line shown on top of the ticket.
- **Links:** `blocks` / `blockedBy` (other tickets), `steps` (plan step names, linked to the plan if one is set).
- **Archived:** hidden from every view but Archived.
- **Reopening:** a new message on a ticket sets it back to `discussing` and unarchives it, unless the message itself
  sets a status.

The page has views for whose turn it is (Your turn, With Claude, Waiting on <other>, Waiting on nobody), the statuses,
and All / Archived, as a list or a board. It marks replies the owner hasn't read; the read marks are kept on the
server, so the phone and the desktop agree. It shows whether a Claude session is listening right now.

## Set up a desk

1. **Get the code**, one clone per desk:
   ```
   git clone https://github.com/kuba97531/jiraude.git ~/desks/myproject
   cd ~/desks/myproject
   cp config.example.json config.json
   ```
2. **Edit `config.json`:**
   - `title`: the page's name;
   - `port`: a free local port, one per desk;
   - `owner`: the person who signs in (`id` is lower case and is stored on every ticket, so don't change it later);
   - `others`: people a ticket can wait on who don't sign in (or `[]`);
   - `plan`: an optional link shown on the page (or drop it);
   - `hue`: the desk's color, 0-359 (or drop it: each desk then gets its own color from the hash of its token, so
     several desks are told apart at a glance, icon included).
3. **Set the password.** The owner runs this in their own terminal, not through Claude:
   `node bin/set-password.js`. Only a scrypt hash is stored, in `data/auth.json`.
4. **Run it** with systemd: see [deploy/jiraude@.service](deploy/jiraude@.service), then
   `sudo systemctl enable --now jiraude@myproject`. The first start writes `data/token`, the key `bin/desk.js` uses.
5. **Put it behind HTTPS** with nginx: see [deploy/nginx-location.conf](deploy/nginx-location.conf). The cookie is
   `Secure`, so plain HTTP won't keep you signed in. Any path prefix works.
6. **Tell the Claude session**: add the snippet from PROTOCOL.md to the project's `CLAUDE.md`, with this desk's path.

Several desks on one machine: one clone, port and systemd instance each. Each desk has its own cookie, so they can share
a host name under different paths.

## One session per desk

The waiter keeps its place in the event log in `data/listener-offset`. If two sessions wait on one desk, only one of
them gets each message. For parallel sessions, give each its own desk.

## Security

- The owner signs in with one password, limited to 5 tries a minute. A session lasts 30 days, in an HttpOnly, Secure,
  SameSite=Strict cookie.
- Claude's tool sends `data/token` from the same machine. The server listens on 127.0.0.1 only.
- Writes from the page must carry the page's own header (a CSRF guard). The page has a strict Content Security Policy,
  and a diagram is shown as an image, so nothing in it runs.
- `data/` is mode 700 and its files 600. It holds the password hash, the token, the sessions and every message, and
  `.gitignore` keeps it out of git.

## Change the app

`server.js` exits when it is edited, and systemd starts it again. The pages are read on every request. Check a change
before it goes live: `node --check server.js`. For the page, check its script on its own, since one bad edit breaks
the live page.

## Files

- `server.js`: the HTTP server and the ticket store.
- `public/index.html`, `public/login.html`: the page (no build step) and the sign-in page.
- `bin/desk.js`: Claude's side.
- `bin/wait.js`: the waiter that wakes Claude's session.
- `bin/set-password.js`: sets the owner's password.
- `data/` (not in git):
  - `chat.json`: every ticket and message;
  - `events.jsonl`: one line per write, which the waiter watches;
  - `auth.json`, `token`, `sessions.json`;
  - `listener.json`: the waiting session's pid, for "Claude is listening";
  - `listener-offset`: the waiter's place in `events.jsonl`.
