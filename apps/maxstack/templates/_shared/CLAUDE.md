# {{PROJECT_NAME}}

{{DESCRIPTION}}

This project was scaffolded by [maxstack](https://github.com/your-org/maxstack). It is TypeScript-only, strict mode, built on the Vite+ toolchain (`vp`).

## Source of truth

- **The spec** — scope, requirements (each with `acceptanceCriteria`), goals/metrics, data entities, pages, and decisions. It is read and changed **through the maxstack MCP platform tools**, never by hand-editing a file: `query_spec` reads it; `propose_spec_change` / `apply_spec_change` / `record_decision` are the only write path (typed, validated, logged spec-ops). This replaces the old `SCOPE.md` + `SUCCESS_CRITERIA.md` markdown pair.
- **`TASKS.md`** — the living backlog. Each task references the requirement id (`r-xxx`) it implements. Current priorities are pinned at the top.

**Never hand-maintain success criteria in a separate file** — they live as `acceptanceCriteria` on each requirement in the spec, read with `list_acceptance_criteria`.

## MCP surface

The three skills below drive the **maxstack MCP server**, configured in `.mcp.json` (point `MAXSTACK_MCP_URL` at your running maxstack app's `/mcp`). In Claude Code the tools appear as `mcp__maxstack__*`; any MCP-capable agent uses the same tool names. The vocabulary is self-describing — `query_spec {section:"ops"}` lists every spec-op — so an agent needs no special skill to drive it.

**Call `init` first, once per session.** It returns the whole picture in one call — this project's entities, pages, requirements, slots and API, every spec-op you could reach for, the generators and checks available, the installable bundles, and what is already pending review. It exists because the alternative is eight separate `query_spec` / `browse_catalog` / `review_queue` calls, and in practice that means hand-building something a bundle already provides. It also takes a whole **batch** of ops (`init {ops:[…]}`) validated as one all-or-nothing unit, so an entity and its eight fields is one call rather than nine — pass `{apply: true}` once the merged `effect` is what you meant.

Tools: `init` · `query_spec` · `propose_spec_change` · `apply_spec_change` · `record_decision` · `run_generator` · `run_checks` · `explain_feature` · `list_acceptance_criteria`.

**Cold start:** MCP connections are established at agent-session start. If `mcp__maxstack__*` is absent from the tool list, the server wasn't running when the session began — starting it now will **not** surface the tools this session. In a project with `maxstack.json`, the `maxstack` CLI (`add-entity` · `add-field` · `add-page` · `op` · `gen` · `validate`) is a first-class authoring path through the same validated spec-ops — use it (each skill's Cold start section maps the tools). Otherwise, start `maxstack dev` and restart the agent session; never hand-edit the spec to route around a missing server.

## Workflow

1. `/plan-and-scope` — read the spec (`query_spec`), propose + apply typed spec-ops, record decisions, and keep the `TASKS.md` gate honest.
2. `/run-next-task` — pick the top unblocked task, implement it against its requirement's acceptance criteria, drive generators (`run_generator`) and the validate gate (`run_checks`) through MCP, commit.
3. `/ship-check` — before calling anything "done": `run_checks` (spec-validate + typecheck + lint + tests) + walk the acceptance criteria.

## Commands

```bash
vp dev      # local dev
vp check    # typecheck + lint
vp test     # run tests
vp build    # production build (web-app)
vp pack     # library/cli/api build
tsx prd/validate.ts   # validate prd.ts referential integrity
```

## Conventions

- Strict TypeScript everywhere; no `any` without a written reason.
- Don't start building a requirement until it exists in `prd.ts` and `tsx prd/validate.ts` passes.
- Match the style of surrounding code.
