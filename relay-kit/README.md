# Relay lanes — setup

Relay lanes are Claude Queue Relay's **optional** bridge to [Claude Cowork](https://claude.ai)
(Anthropic's desktop app that can drive a real browser). They let a Claude Code
session in VS Code hand off a task — "log into this site and pull these numbers,"
"fill out this form" — to Cowork, which does it and hands a result back. Nothing
else in the extension needs this: the tab queue, drag-to-reorder, and tab groups all
work with zero lanes configured. Set this up only if you actually want the handoff.

## Prerequisites

1. **Claude Cowork** — the Claude desktop app, with the **Claude in Chrome**
   connector turned on (Cowork's settings). This is what lets it drive a browser.
2. **Chrome**, normally already logged in to whatever sites your tasks will touch.
   Cowork clicks the field and lets Chrome's own password manager autofill —
   credentials never pass through the relay.
3. **macOS Accessibility permission** for VS Code, if you want the board's "Receive"
   button to type back into the right tab automatically (Settings → Privacy &
   Security → Accessibility). Not required for the relay itself to work, only for
   that one convenience.

## One-command setup

From this `relay-kit/` folder (or run the extension command below):

```bash
./setup.sh ~/Documents/claude-relay 3
```

This creates `~/Documents/claude-relay`, `~/Documents/claude-relay-2`, and
`~/Documents/claude-relay-3` — three independent lane folders, each with a
`relay/` subfolder (`inbound.md`, `outbound.md`, `queue/`, `archive/`, `outbox/`,
`data/`), the three scripts (`drain.sh`, `send.sh`, `receipts.sh`), and a
`CLAUDE.md` that Cowork reads automatically when you open that folder. Re-running
`setup.sh` is safe — it never overwrites an existing inbound/outbound/CLAUDE.md.

Only want one lane? `./setup.sh ~/Documents/claude-relay 1`.

**Or from inside VS Code:** Command Palette → **"Claude Queue Relay: Set Up Relay
Lanes"**. It asks how many lanes and where, runs the same script, and offers to set
`claudeQueueRelay.relayLanes` for you.

## Point the extension at your lanes

`setup.sh` prints the exact JSON to paste. It looks like:

```json
"claudeQueueRelay.relayLanes": [
  "/Users/you/Documents/claude-relay",
  "/Users/you/Documents/claude-relay-2",
  "/Users/you/Documents/claude-relay-3"
]
```

Paste that into VS Code settings.json (or the command above does it for you).

## Open Cowork

Open each lane folder as its own Cowork window (**one Cowork session per lane**).
Cowork reads that folder's `CLAUDE.md` and knows the contract from there.

## Day to day

- **Sending a task:** from a VS Code Claude Code session, just ask it to relay
  something — with the `relay` skill installed (see below) it picks the
  least-loaded lane and writes `inbound.md`. Or run `./relay/send.sh "goal text"`
  from a lane folder yourself.
- **Cowork's loop:** in that lane's Cowork window, run `./relay/drain.sh`. It
  prints the task (or `EMPTY`), Cowork does it, writes `relay/outbound.md`, and you
  run `drain.sh` again until `EMPTY`.
- **Checking results:** `./relay/receipts.sh` in a lane folder lists what's landed
  and not yet picked up; `receipts.sh all` lists every sibling lane. The Claude
  Queue Relay sidebar shows the same thing as colored lane numbers with a drawer.
- **Full contract:** each lane's own `CLAUDE.md` (generated from
  `CLAUDE.md.template`) has the complete task/result file format and the safety
  tiers — read that once, in either Cowork or VS Code.

## Optional: teach your VS Code Claude Code the relay protocol

`CLAUDE.md.template` is what *Cowork* reads. If you want your **VS Code** Claude
Code sessions to know how to pick a lane, write a well-formed task, and ingest a
result on their own (rather than you hand-writing `inbound.md` yourself), give them
a project skill describing that loop — lane-balancing, the handover file format
above, and "when you say 'check the relay', read `receipts.sh`." Claude Queue
Relay doesn't ship that skill (it's a Claude Code project convention, not an
extension feature) — write your own short one from the loop described above, or
adapt the version this project was built against (search the extension's own
GitHub history/README for "relay skill" if the maintainer has shared theirs).
