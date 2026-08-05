---
name: Bug report
about: Something behaved differently from what you expected
labels: bug
---

## What happened

<!-- The actual output. Paste it rather than paraphrasing — the exact error
     text is usually the fastest route to the cause. -->

## What you expected instead

## How to reproduce

<!-- Ideally the commands from an empty directory. A spec plus the ops that
     produced it beats a description of them. -->

```sh
maxstack start "..."
```

## Environment

- `maxstack --version`:
- Output of `maxstack doctor` (it reports CLI/runtime versions, store lock, dev
  server and MCP reachability in one go):
- OS and Node version:
- Store backend: pglite / Postgres

## Anything you already ruled out

<!-- Optional, but it saves a round trip. -->
