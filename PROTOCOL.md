# Working through the desk: instructions for a Claude session

These are the rules a Claude Code session follows when the owner works with it through a desk. `<desk>` is the
desk's folder, for example `~/desks/myproject`. The owner is the `owner.id` in its `config.json`.

## Waiting for the owner

- **At the start of every session**, run `node <desk>/bin/wait.js` in the background (`run_in_background`), then end
  the turn. It sleeps on a file watch and exits when the owner writes a message, opens a ticket, or hands a ticket to
  Claude. Its exit wakes the session.
- **Its output is one JSON line per event**, for example
  `{"kind":"message","q":"Q12","from":"kuba",...}` or `{"kind":"ticket","q":"Q13","title":"..."}`.
- **Start it again right after every wake**, before doing the work. While it runs, the page shows "Claude is listening".
  It resumes where the last one stopped, so nothing written in between is lost.
- **Never poll the desk:** no cron, no loops, no `sleep`, no repeated `list`. The waiter is the only way to wait.
- **Run one waiter at a time.** If the harness says one is still running, don't start a second.
- **The owner may also write in the terminal.** Answer there what was asked there.

## Reading and answering

```
node <desk>/bin/desk.js list [--waiting claude] [--all]        open tickets: key, waiting on, status, title, last message
node <desk>/bin/desk.js show Q12 [--last 3]                    a ticket's fields and messages
node <desk>/bin/desk.js since 2026-11-04T07:00:00Z             everyone else's messages since then
node <desk>/bin/desk.js new --title "..." --file msg.md [--waiting <owner>] [--steps A1,A2]
node <desk>/bin/desk.js post Q12 --file msg.md [--waiting <owner>|nobody] [--status done] [--decision "..."]
node <desk>/bin/desk.js set Q12 [--waiting ..] [--status discussing|resolved|done|deferred] [--decision ".."]
                                [--title ..] [--blocks Q3,Q4] [--blocked-by Q5] [--steps ..] [--archive|--unarchive]
```

- **Write each message to a file** in the scratchpad first, then post it with `--file`. Never put the text on the
  command line.
- **Posting hands the ticket to the owner** unless `--waiting` says otherwise. Use `--waiting nobody` for news that
  needs no answer.
- **Timestamps are the server's.** Never type a time into a message as the time it was sent.
- **Formatting:** messages are Markdown, with headings, lists, bold, inline code, code fences and links. A ` ```svg `
  fence is drawn as a diagram. `Q12` links to that ticket.

## How the owner and Claude work

1. **One ticket per open item.** Every question, proposal or piece of work that is not finished, tested and accepted
   has a ticket, in the lane that is true now:
   - With Claude: in progress or queued, in order;
   - Your turn: needs the owner's decision or review;
   - Waiting on another person;
   - Deferred, only when the owner deferred it.

   An empty "Your turn" with nothing in progress means everything is done and accepted. Keep it true.
2. **News becomes a ticket.** A root cause, an incident, a test result, or a decision the owner must make goes into a
   new ticket, even if it was first said in the terminal. The owner reads the desk away from the computer. Replies to
   an existing ticket stay on it.
3. **Write for a phone.** Each message stands on its own:
   - the answer first, then the evidence;
   - short sentences, and what was measured, with numbers;
   - end with the question the owner must answer, such as "OK to build?".
4. **Build only what is decided and unblocked.** Propose concretely: what changes, what it costs, what it touches.
   Then wait for the owner's yes on the ticket. Silence, an earlier "probably", or an automated notification is not a
   yes. Once the work is done, say so on the ticket with what was checked. Mark it `done` when the owner accepts it.
5. **What needs the owner stays visible.** Any new message, from anyone, reopens its ticket: it goes back to
   `discussing` and out of the archive. To answer and close, pass the status with the message
   (`post Q12 --file msg.md --status done`). Record decisions with `--decision`.
6. **Correct yourself in the open.** When an earlier message was wrong, or claimed something without evidence, post
   the correction on the same ticket and say what changed.
7. **No secrets on the desk.** Messages are stored as plain text and shown on the page: no passwords, keys or tokens.

## Snippet for the project's CLAUDE.md

```markdown
## Desk

I work with the owner through the desk at <desk> (page: <https url>). Follow <desk>/PROTOCOL.md:
- at session start and after every wake, run `node <desk>/bin/wait.js` in the background, then end the turn;
- never poll the desk;
- answer on tickets with `node <desk>/bin/desk.js`;
- anything interesting for the owner becomes a ticket;
- build only what is decided and unblocked.
```
