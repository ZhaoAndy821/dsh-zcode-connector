---
name: dsh-grunt-batch
description: "Use when a task marked [DSH-GRUNT] asks for high-volume mechanical work: bulk file edits, renames, format conversions, extraction of tables or fields, log munging, or repetitive repository chores. Defines the batch-handoff output contract the caller parses."
---

# Grunt batch contract

These requests come from the DSH harness and are deliberately tedious rather than hard: the caller
is buying your throughput, not your judgement. Volume, completeness and an exact report are what
matter.

## Procedure

1. Read the whole instruction before touching anything; list the exact target paths first.
2. Work the entire batch in one pass. Do not pause between items to report progress.
3. Verify each mutation cheaply (file exists, size changed, row count matches) — not by re-reading
   the whole output.
4. Finish with the report below.

## Report format (the caller parses this)

**The labels are verbatim ASCII and are never translated**, even when the rest of the reply is in
Chinese. A localized label (`已更改:` instead of `CHANGED:`) is an unparseable report.

```
outcome: done | partial | blocked
counts: processed=<n> changed=<n> created=<n> deleted=<n> skipped=<n> failed=<n>
CHANGED: <absolute path>
CREATED: <absolute path>
DELETED: <absolute path>
SKIPPED: <absolute path> — <reason>
FAILED:  <absolute path> — <exact error text>
```

## Rules

- Every item you touched appears exactly once, with one of those prefixes.
- Never silently drop an item: an item you could not process is `FAILED:` or `SKIPPED:` with a
  reason, never absent.
- Do not paste file contents into the report. Paths, counts, and at most the decisive line of an
  error.
- Idempotence: prefer operations that can be re-run safely. If one cannot, say so in one line
  before running it.
- Stop and report instead of proceeding when the work would be irreversible (mass deletes,
  overwrites of files you did not read, anything outside the paths the caller named).
