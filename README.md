# OpenClaw Skill Usage

OpenClaw Skill Usage is an OpenClaw plugin that counts when installed skills are actually invoked. It treats a skill as used when the agent reads that skill's `SKILL.md`, which matches OpenClaw's on-demand skill loading model.

This repository is being delivered issue-first:

- `#1` captures and dedupes local skill usage events
- `#2` adds TiDB Cloud Zero sync, join, and delete flows
- `#3` will add the agent-facing skill, commands, and polished README

## Current status

The current slice ships:

- a plugin scaffold that registers OpenClaw tool-call hooks
- resilient detection for `read` calls targeting `SKILL.md`
- stable installation identity and event dedupe keys
- local JSONL buffering for skill usage attempts
- automatic TiDB Cloud Zero provisioning on first sync
- cloud aggregation queries for `1d`, `7d`, `30d`, and `all`
- `/skillusage` commands for status, sync, join-token, join, leave, and delete
- tests proving repeated reads in the same run only count once

## Cloud model

The plugin sends only non-sensitive metadata to TiDB Cloud Zero:

- skill id and skill name
- installation id
- agent id
- session scope (`main` or `subagent`)
- turn, message, request, and channel ids when available
- timestamps, status, latency, trigger counts, and attempt numbers

It does not upload prompts, tool outputs beyond `SKILL.md` metadata, or user message content.

By default, one OpenClaw installation uses one local `usage space`. Generate a share token with:

```bash
/skillusage join-token
```

Join that space from another installation with:

```bash
/skillusage join <token>
```

TiDB Cloud Zero is ephemeral by default. Each instance includes a claim URL and expiration timestamp. Claim the instance before it expires if you want persistence beyond the default Zero session lifetime.

## Commands

```text
/skillusage status
/skillusage top [1d|7d|30d|all]
/skillusage sync
/skillusage join-token
/skillusage join <token>
/skillusage leave
/skillusage delete installation
/skillusage delete space
```

## Development

```bash
npm test
```

## Planned terminology

- `installation`: one OpenClaw gateway deployment
- `agent`: one configured OpenClaw agent
- `subagent run`: a spawned subagent execution
- `usage space`: the shared aggregation namespace that will arrive in issue `#2`
