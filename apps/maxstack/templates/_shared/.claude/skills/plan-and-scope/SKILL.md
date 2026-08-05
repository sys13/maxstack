---
name: plan-and-scope
description: Scope work by driving the maxstack MCP platform tools — read the spec (query_spec), propose typed spec-ops (propose_spec_change), and apply the accepted ones (apply_spec_change / record_decision). The spec is the single source of truth; you change it only through validated ops, never by hand-editing files. Use when scoping, when requirements change, or before unlocking build tasks.
---

# plan-and-scope

You maintain this project's **spec** — scope, requirements (each with `acceptanceCriteria`), goals/metrics, data entities, pages, and decisions — through the **maxstack MCP platform tools**, not by editing files. Every change is a *typed spec-op* that the server validates, diffs, and logs, so the spec can never land in a broken state.

Tools are named plainly below (`query_spec`, …). In Claude Code they appear as `mcp__maxstack__query_spec`; other agents use the same names over the connected server.

The tools come from a **stdio** server your client spawns itself (`.mcp.json` → `maxstack mcp`), so they are available in every session — nothing has to be started first, and `maxstack dev` is for *watching* the app, not for reaching these tools.

## If the tools are absent

Rare now, and it means the server didn't start: the `.mcp.json` server prompt was declined, `maxstack` isn't on `PATH`, or this isn't a `maxstack init` project. It is never permission to hand-edit spec files, and it isn't a dead end:

- **Project has `maxstack.json`**: use the `maxstack` CLI — it lands ops through the *same* validated pipeline as `apply_spec_change`.
  - `query_spec` → read the layer files under `spec/` (read-only; never write them).
  - `apply_spec_change` → `maxstack op --file change.json` with `{"op":"…","args":{…}}` (e.g. `data.addEntity`, `page.addPage`); add `--accept --gen` to land + accept + regenerate. Sugar for the common ops: `maxstack add-entity` / `maxstack add-field` / `maxstack add-page`.
  - `record_decision` → `maxstack op` with `{"op":"prd.recordDecision","args":{"entry":{…}}}`.
  - `run_generator` → `maxstack gen` · `run_checks` → `maxstack validate` (plus the project's own check/test scripts).
  - `propose_spec_change` has no CLI twin: `maxstack op` validates before landing and fails without writing, so a rejected op is safe to fix and retry.
- **No `maxstack.json`**: there is no CLI path. Report that, and do not improvise writes.

Either way, say in your report that the MCP server didn't load and why, so the human can fix the registration rather than discover it next session.

## The vocabulary is self-describing

You do not need this skill to know the ops. Ask the server:
- `query_spec {section:"ops"}` — the full spec-op vocabulary (name, layer, one-line summary).
- `query_spec {section:"summary"}` — counts + title + status.
- `query_spec {section:"requirements"}` — ids, user stories, acceptance criteria.

## Procedure

1. **Read the current spec.** `query_spec {section:"summary"}`, then the sections you'll touch (`requirements`, `data`, `pages`, `ledger`).
2. **Discover the ops** you'll need: `query_spec {section:"ops"}`.
3. **Propose before you apply.** For each intended change, call `propose_spec_change {op, args}`. It returns `{valid, errors, diff}` **without writing**. If `valid` is false, fix `args` against the reported errors (unknown ids, duplicate ids, out-of-range fields) and propose again.
4. **Apply the accepted op.** `apply_spec_change {op, args}` — this validates server-side again and logs the op with provenance. A requirement needs a testable, `r-`prefixed op payload: `userStory`, concrete `acceptanceCriteria`, `priority`, `edgeCasesAndErrorStates`, and correct cross-references (scope → `realizedByRequirementId`; metric → `measuredByEventIds`; requirement → `servesMetricIds`; roadmap phase via `intoPhaseId`).
5. **Record decisions** you make while scoping with `record_decision {id, question, options, recommendedOptionId?, chosenOptionId?, rationale}` — omit `chosenOptionId` to log a still-open decision. This is the durable "why", append-only.
6. **Verify the whole spec.** `run_checks {checks:["spec-validate"]}` until it passes (referential integrity across all layers).
7. **Report**: what ops you applied (from their diffs), the check result, and any coverage gaps you noticed (a requirement with no metric, a scope item with no `realizedByRequirementId`). Do not resolve approval decisions on the human's behalf.

## Rules
- Change the spec **only** through `apply_spec_change` / `record_decision`. The ops are the single write path; there is no separate success-criteria file.
- Never invent acceptance criteria you can't justify from the scope — record the uncertainty as a pending decision (`record_decision` with no `chosenOptionId`) instead.
- Leave the spec passing `run_checks {checks:["spec-validate"]}`.
- v1 ops are additive. If you need a remove/rename that has no op, record a decision noting the gap rather than editing around it.
