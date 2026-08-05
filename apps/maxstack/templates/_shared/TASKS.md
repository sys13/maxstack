# Tasks — {{PROJECT_NAME}}

> The living backlog. Each task references the `prd.ts` requirement id (`r-xxx`) it implements.
> Blocked tasks: `- [~] <task> — BLOCKED: <reason> (<date>)`.

## 📌 Current priorities

- [ ] Complete Phase 0 — Scoping (below) before anything else.

---

## 🔒 GATE: requirements must be locked in `prd.ts` (and pass `tsx prd/validate.ts`) before tasks below are started

### Phase 0 — Scoping (always first)
- [ ] Fill in `prd.ts`: problem, audience, scope, requirements (with `acceptanceCriteria`)
- [ ] Run `/plan-and-scope` to validate `prd.ts` and sanity-check coverage
- [ ] Review and approve `prd.ts`

### Phase 1 — Technical planning
_(unlocked after the gate)_
- [ ] Decide data model and key integrations (record in `prd.ts` → `technical`)
- [ ] ...

### Backlog
_(one task per requirement; reference the `r-xxx` id)_
- [ ] ...
