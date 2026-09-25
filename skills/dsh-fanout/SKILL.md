---
name: dsh-fanout
description: "Use when a task arrives from the DSH harness with [DSH-FANOUT] or when a batch exceeds roughly 20 items or spans several independent modules. Explains how to split the work across subagents launched through the Agent tool, how many to run, and how to merge their reports. Prevents one oversized instruction from being attempted in a single pass."
---

# Fan-out: split a batch across subagents

A single pass over a large batch fails quietly on a small model: items get skipped, counts drift,
and the report stops matching reality. Split first, then merge.

## When to fan out

- The batch has more than ~20 items, **or**
- it covers 3+ independent modules, directories, or file families, **or**
- the caller marks the prompt `[DSH-FANOUT]`.

Otherwise do it in one pass — fan-out costs more than it saves on small work.

## How to split

1. **Enumerate first.** List every item (paths, ids, rows) and write the count down.
2. **Partition by independence, not by size.** Two items belong to the same chunk only when they
   touch no shared file. Never let two subagents write the same file.
3. **Chunk size 5–15 items.** Small enough that one chunk cannot be abandoned halfway.
4. **One subagent per chunk, launched in a single message** so they run in parallel rather than
   one after another. Prefer the `dsh-batch-worker` role when it is available; otherwise use
   `general-purpose`.
5. **Give each subagent only its chunk**: the exact item list, the exact operation, and the
   report format. It has no access to this conversation, so nothing may be implied.

## Merging

- Collect one report per chunk. Do not re-read the files to double-check — trust `CHANGED:`
  lines unless the counts disagree.
- **Sum the counts** and emit one merged report in the same `outcome/counts/CHANGED/FAILED`
  format as a single-pass job.
- If a chunk failed or came back partial, **re-run only that chunk** (with a fresh subagent),
  never the whole batch.
- If the item count you enumerated does not equal processed + skipped + failed, say so explicitly
  in the final report — do not paper over the difference.

## Hard rules

- No nested fan-out: a subagent must not spawn further subagents. Depth is you → worker.
- Never hand a subagent an open-ended instruction ("clean up this directory"). Every chunk is an
  explicit list plus an explicit operation.
- Irreversible work (mass deletes, overwrites of files nobody read) is reported, not executed.
