# OpenClaw Skill Usage

OpenClaw Skill Usage is an OpenClaw plugin that counts when installed skills are actually invoked. It treats a skill as used when the agent reads that skill's `SKILL.md`, which matches OpenClaw's on-demand skill loading model.

This repository is being delivered issue-first:

- `#1` captures and dedupes local skill usage events
- `#2` will add TiDB Cloud Zero sync, join, and delete flows
- `#3` will add the agent-facing skill, commands, and polished README

## Current status

The current slice ships:

- a plugin scaffold that registers OpenClaw tool-call hooks
- resilient detection for `read` calls targeting `SKILL.md`
- stable installation identity and event dedupe keys
- local JSONL buffering for skill usage attempts
- tests proving repeated reads in the same run only count once

## Development

```bash
npm test
```

## Planned terminology

- `installation`: one OpenClaw gateway deployment
- `agent`: one configured OpenClaw agent
- `subagent run`: a spawned subagent execution
- `usage space`: the shared aggregation namespace that will arrive in issue `#2`
