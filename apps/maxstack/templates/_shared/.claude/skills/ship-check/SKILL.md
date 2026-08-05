---
name: ship-check
description: Pre-"done" gate over the maxstack MCP tools. Runs the validate gate via run_checks, then walks the relevant requirement's acceptanceCriteria (list_acceptance_criteria / explain_feature) and reports pass/fail per criterion. Use before calling a feature or the project "done" or ready to ship.
---

# ship-check

A read-and-verify gate run before declaring work done. You **report** status; you do not silently fix things, apply spec-ops, or check off boxes to make it pass.

Everything goes through the **maxstack MCP platform tools** (`mcp__maxstack__*` in Claude Code; the same names for any connected agent).

**If the tools are absent:** `mcp__maxstack__*` comes from a stdio server the client spawns itself (`.mcp.json` → `maxstack mcp`), so it should be present in every session; absence means the registration failed. In a `maxstack.json` project run the gate with the CLI instead: `maxstack validate` plus the project's own typecheck/lint/test scripts, and read acceptance criteria from the layer files under `spec/` (read-only). State in the report that MCP was unavailable and which checks that replaced.

## Procedure

1. **Mechanical checks.** `run_checks` with no `checks` argument — this runs the full gate: `spec-validate` (spec referential integrity) plus the project's registered typecheck/lint/test checks. Capture each result's `ok` + `output`. If the runner exposes fewer checks than expected, say so; don't fake a pass.
2. **Acceptance-criteria walk.** Determine which requirement(s) the work claims to satisfy (from the task, branch, or prompt → the `r-xxx` id). For each:
   - `list_acceptance_criteria {requirementId:"r-xxx"}` — the criteria.
   - `explain_feature {requirementId:"r-xxx"}` — user story, edge cases, cross-layer links.
   Assess each criterion against the actual code/tests:
   - ✅ met (point to the test or code that demonstrates it)
   - ❌ not met (say what's missing)
   - ❓ unverifiable (say why — e.g. needs manual/QA or a missing test)
3. **Edge cases.** Check the requirement's `edgeCasesAndErrorStates` (from `explain_feature`) are handled or explicitly deferred.
4. **Report** a concise verdict:
   - `run_checks` results (pass/fail with key output on failure)
   - per-criterion table for each requirement
   - a clear **SHIP / DON'T SHIP** call with the blocking items listed

## Rules
- Be honest: if any check is red or a criterion isn't met, say DON'T SHIP and list why.
- Don't change the spec (`apply_spec_change`) or code to make checks pass — that's `/run-next-task`'s job. Report only.
- Don't check boxes in `TASKS.md` (if the project has one); surface status for the human to act on.
