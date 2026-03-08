# OpenClaw Skill Usage

See which skills actually earn their slot.

OpenClaw Skill Usage is a zero-config plugin that counts real skill invocations, ranks them from high to low, and lets multiple OpenClaw installations join the same shared leaderboard.

The product idea is simple:

- OpenClaw skills are apps.
- You need an app chart.
- The chart should work locally by default and become shareable with one command when you want it to.

## What it does

- counts every installed skill by actual use
- ranks skills for `1d`, `7d`, `30d`, and `all`
- auto-provisions TiDB Cloud Zero on first sync
- shares counts across multiple OpenClaw installations with a join token
- keeps local-first defaults: one installation starts in its own usage space automatically
- exposes both a slash command and an agent tool

## What counts as one skill use

A skill counts as triggered when OpenClaw reads that skill's `SKILL.md`.

Why this boundary:

- it matches OpenClaw's on-demand skill loading model
- it reflects the moment a skill is actually pulled into execution
- it avoids counting skills that were merely installed but never used

Deduping rule:

- one skill, one run, one trigger
- repeated reads in the same run are tracked as attempts, not extra triggers

That gives you two useful numbers:

- `triggers`: how many times a skill was really invoked
- `attempts`: how many times OpenClaw re-read or retried the skill within those invocations

## Zero-config install

Install the plugin, restart the Gateway, and use it.

Local development install:

```bash
openclaw plugins install .
npm install
```

Then restart the OpenClaw Gateway.

After that, the plugin starts counting immediately. The first cloud-backed query or sync auto-provisions a TiDB Cloud Zero instance with no manual database setup.

## Native OpenClaw surface

This plugin ships both:

- `/skillusage` slash commands for fast user actions
- a bundled `skill-usage-insights` skill plus a `skill_usage_stats` agent tool so the agent can answer usage questions naturally

Example user prompts:

- "What are my most used skills?"
- "Show my top skills in the last 7 days."
- "Are subagents driving most of the skill traffic?"

Example agent flow:

```text
User: What are my most used skills this month?
Agent: calls skill_usage_stats with { action: "top", period: "30d" }
Agent: returns ranked skills from highest to lowest trigger count
```

## Slash commands

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

Typical flow:

```text
/skillusage top 7d
/skillusage join-token
```

On another installation:

```text
/skillusage join <token>
```

## Sharing model

Professional terms used in this repo:

- `installation`: one OpenClaw Gateway deployment
- `agent`: one configured OpenClaw agent
- `subagent run`: one spawned subagent execution
- `usage space`: the aggregation namespace that multiple installations can share

Default behavior:

- one installation starts in one private usage space
- agents and subagent runs inside that installation count together automatically

When you want a shared chart:

1. Run `/skillusage join-token` on the installation that already has the leaderboard you want.
2. Run `/skillusage join <token>` on another installation.
3. Both installations now write into the same usage space and see the same aggregated rankings.

## Privacy model

Only non-sensitive metadata is synced:

- skill id and skill name
- installation id
- agent id
- session scope (`main` or `subagent`)
- turn, message, request, and channel ids when available
- timestamps, status, latency, trigger counts, and attempt numbers

Not synced:

- prompts
- user messages
- arbitrary tool outputs
- skill file contents beyond metadata used to identify the skill

## TiDB Cloud Zero notes

This plugin provisions TiDB Cloud Zero through `https://zero.tidbcloud.com/`.

Important behavior:

- Zero instances are easy to create and great for instant onboarding
- Zero is ephemeral until claimed
- each provisioned instance includes a claim URL and expiration timestamp

If you want durable long-term history, claim the instance before it expires.

## Example output

```text
Top skills for 7 days:
1. gh-issue-pr-iterations - 18 triggers, 22 attempts, 2 installations, 3 agents, 5 subagent runs
2. git-pr - 11 triggers, 12 attempts, 2 installations, 2 agents, 1 subagent runs
3. prepare-svp-weekly-report - 4 triggers, 4 attempts, 1 installations, 1 agents, 0 subagent runs
```

```text
Skill usage status:
usage space: 7f2c... (joined)
database: openclaw_skill_usage
cloud instance: zero_abc123
expires at: 2026-04-06T10:00:00.000Z
claim URL: https://...
synced totals: 38 triggers, 45 attempts
members: 2 installations, 3 agents, 6 subagent runs
metadata sent: skill id/name, installation id, agent id, session scope, timestamps, status, latency
```

## Why this can become a default plugin

- zero setup for the common case
- useful on day one
- obvious value for every OpenClaw user with more than a few installed skills
- turns skills from a pile of folders into something measurable

## Follow-up ideas

- trend charts and skill growth deltas
- per-agent leaderboards
- Control UI cards for top skills
- export/import for durable backups beyond Zero
- publish aggregate discovery signals into ClawHub

## Development

```bash
npm install
npm test
```
