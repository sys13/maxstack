---
name: run-next-task
description: Headless backlog automation over the maxstack MCP tools. Picks the top unblocked task, reads its requirement's acceptance criteria via list_acceptance_criteria, implements it, runs generators (run_generator) and the validate gate (run_checks) through MCP, commits if clean, and reports. Marks ambiguous/blocked tasks and moves on — no questions asked. Use via `claude -p "/run-next-task"`.
---

# run-next-task

Designed to run **unattended** (`claude -p`). Do not ask the user questions — if a task is ambiguous or blocked, mark it and move to the next one.

All spec reads, generation, and checks go through the **maxstack MCP platform tools** (`mcp__maxstack__*` in Claude Code; the same names for any connected agent). The MCP server is the single interface: you drive generators and the validate gate through it rather than invoking bespoke build scripts.

**If the tools are absent:** `mcp__maxstack__*` comes from a stdio server the client spawns itself (`.mcp.json` → `maxstack mcp`), so it should be present in every session; absence means the registration failed, not that something needs starting. In a `maxstack.json` project, drive the same validated ops through the CLI instead (see `/plan-and-scope` → If the tools are absent): spec writes via `maxstack op` / `add-entity` / `add-field` / `add-page`, generators via `maxstack gen`, the gate via `maxstack validate` plus the project's check/test scripts, and read acceptance criteria from the layer files under `spec/` (read-only). Without `maxstack.json`, mark the run blocked (`maxstack MCP server did not load`) and stop — do not improvise writes.

## Backlog source

`TASKS.md` is optional, and a maxstack project usually has none — the spec **is** the backlog there. Check once at the start of the run:

- **`TASKS.md` exists** → it drives the run: gate, task order, checkboxes, `[~] BLOCKED` marks, as written below.
- **No `TASKS.md`** → derive the backlog from the spec; do not create the file. A "task" is an unimplemented requirement: `query_spec {section:"requirements"}` for the list (ordered by `priority`, then spec order), minus requirements already landed — a requirement counts as done when a commit tagged with its id (`git log --oneline --grep "(r-xxx)"`, step 8's format) exists. The gate is the spec itself: if there are no requirements, or the ones present lack concrete `acceptanceCriteria`, stop and report that scoping must happen first (`/plan-and-scope`). Blocked/completed state lives in the report and the commit tags, not in a file.

## Procedure

1. **Check the gate.** With `TASKS.md`: if the Phase 0 scoping gate is not satisfied (requirements not locked / approved), stop and report that scoping must happen first (`/plan-and-scope`). Without it: apply the spec-side gate above. Do not start build tasks behind a closed gate.
2. **Pick a task.** With `TASKS.md`: the topmost unchecked, unblocked (`- [ ]`, not `- [~]`) task under an unlocked section, honoring the "Current priorities" pin. Without it: the first requirement from the derived backlog that the report of a previous run didn't mark blocked.
3. **Load the spec for that task.** Find the `r-xxx` requirement id the task references, then:
   - `list_acceptance_criteria {requirementId:"r-xxx"}` — the criteria you must satisfy.
   - `explain_feature {requirementId:"r-xxx"}` — user story, edge cases, and cross-layer links (entities/pages/metrics) in project-tailored form.
4. **Decide if it's actionable.** If ambiguous, underspecified, or blocked on something missing, mark it and skip. With `TASKS.md`:
   ```
   - [~] <task> — BLOCKED: <one-line reason> (<YYYY-MM-DD>)
   ```
   Without it: record the block (`r-xxx` + one-line reason) in the final report instead. Then go to the next task.
5. **Apply any spec change the task requires** as typed ops: `propose_spec_change` → fix until `valid` → `apply_spec_change`. (E.g. a new field is `data.addField`; a new page is `page.addPage`.) Never hand-edit the spec.
6. **Generate.** Run the relevant generators through MCP: `run_generator {generator:"docs"}` after spec changes, `run_generator {generator:"e2e-tests"}` when pages declare `e2eTests`. Use `query_spec` / the generator enum to see what's available. Write any hand-authored code the criteria still require, matching surrounding style; add/adjust tests to cover the criteria.
7. **Verify through MCP.** `run_checks` (omit `checks` to run the full gate: `spec-validate` plus the project's typecheck/lint/test checks). If anything fails and you can't fix it cleanly, revert this task's changes, mark it blocked with the failing check's output, and move on.
8. **Commit** only when every check passes:
   ```
   git add -A && git commit -m "<task summary> (<r-xxx>)"
   ```
9. **Update `TASKS.md`** if it exists: check off the completed task (`- [x]`). Without it, the `(r-xxx)` commit tag from step 8 is the done-marker — nothing else to write.
10. **Report**: task, requirement, ops applied (from their diffs), generators run, `run_checks` results, commit hash. If you blocked tasks, list them.

## Rules
- One task per run unless trivially chained; prefer small, verified, committed increments.
- Never commit while `run_checks` is red. Never check a box for work that didn't pass.
- Change the spec only through `apply_spec_change` / `record_decision`; drive generation + checks only through `run_generator` / `run_checks`.
- No questions to the user — encode uncertainty as a `[~] BLOCKED` line instead.
