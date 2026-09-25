---
name: dsh-handoff
description: "Use when a request arrives from the DSH harness (the local DeepSeek Harness agent) rather than from the human user directly. Applies to bulk/mechanical work handed over to save the caller's context: mass file edits, renames, format conversions, log or document munging, table extraction, repetitive repository chores, and anything the caller describes as grunt work. Provides the handoff contract — what the caller guarantees, what to return, and how to report partial failure."
---

# DSH handoff contract

Requests that arrive with a `[DSH-HANDOFF]` marker come from the local DeepSeek Harness agent,
not from the human. That caller is delegating **mechanical volume** — work that is tedious rather
than hard — to spend this session's quota instead of its own context.

## What the caller guarantees

- The task is self-contained: every path, file and value needed is in the prompt.
- There is no conversation history to consult; this is a fresh task.
- Ambiguity is the caller's problem, not yours: if the prompt is genuinely ambiguous, say so in one
  line and name the exact missing input instead of guessing.

## What to return

1. **Outcome first**: done / partial / blocked, in one line.
2. **Exact counts**: how many items were processed, changed, skipped, failed.
3. **A machine-readable summary** when files changed — one path per line, prefixed `CHANGED:`,
   `CREATED:`, `DELETED:`, `SKIPPED:` so the caller can diff without re-reading everything.
4. **Failures with their error text**, quoted exactly, one per line, prefixed `FAILED:`.
   Never silently drop an item.
5. **No narration of your process.** The caller wants the result, not the story.

## Rules

- Do the whole batch before replying. Do not stop to ask permission for each item.
- Prefer idempotent operations; if a step cannot be made idempotent, say so before running it.
- Do not summarise large file contents back — report paths and counts, and quote only the lines
  that matter (a decisive error, a changed field, a surprising value).
- If the work turns out to be unsafe (delete-heavy, irreversible, or touching files outside the
  paths given), stop and report what you would have done instead of doing it.
