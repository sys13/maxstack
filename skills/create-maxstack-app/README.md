# maxstack skill

An [Agent Skill](https://docs.claude.com/en/docs/claude-code/skills) that is the
entrypoint for working with maxstack — creating a new app and driving it through
its whole lifecycle: typed spec-ops, feature bundles, owned views, run, build, and
deploy.

## Install

```sh
npx skills add create-maxstack-app        # from the published skills registry
# or point at this repo directly:
npx skills add github:sys13/maxstack/skills/create-maxstack-app
```

This installs the skill into `~/.claude/skills/create-maxstack-app/` (or your
project's `.claude/skills/`). Once installed, ask Claude to "create a new maxstack
app" — or anything about a maxstack verb — and the skill activates.

## Layout

```
create-maxstack-app/
  SKILL.md                 the entrypoint — golden path, command reference, guardrails
  references/
    spec-ops.md            the typed op vocabulary (data / page / prd / pricing)
    bundles.md             the feature-bundle catalog + prerequisites
```

## Requires

The `maxstack` CLI — `npm install -g maxstack` (or `npx maxstack`).
