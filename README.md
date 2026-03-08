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
- shows each skill's total first, then a per-installation breakdown using installation labels
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
npm install
openclaw plugins install .
```

Then restart the OpenClaw Gateway.

After that, the plugin starts counting immediately. The first cloud-backed query or sync auto-provisions a TiDB Cloud Zero instance with no manual database setup. If TiDB Cloud Zero is unreachable, `top` and `status` still return local-only data so the plugin remains useful offline.

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

If TiDB Cloud Zero is unavailable, `/skillusage top ...` and `/skillusage status` fall back to this installation's local event buffer and tell you that the result is local-only or degraded. In that fallback mode, the installation breakdown only reflects the current installation because other installations live in the shared cloud view.

## Sharing model

Professional terms used in this repo:

- `installation`: one OpenClaw Gateway deployment
- `agent`: one configured OpenClaw agent
- `subagent run`: one spawned subagent execution
- `usage space`: the aggregation namespace that multiple installations can share

Default behavior:

- one installation starts in one private usage space
- each installation gets a zero-config `installation label` from the machine hostname
- agents and subagent runs inside that installation count together automatically

When you want a shared chart:

1. Run `/skillusage join-token` on the installation that already has the leaderboard you want.
2. Run `/skillusage join <token>` on another installation.
3. Both installations now write into the same usage space and see the same aggregated rankings.

If you want a custom installation label instead of the hostname-derived default, set it in plugin config:

```json
{
  "plugins": {
    "entries": {
      "skill-usage": {
        "enabled": true,
        "config": {
          "installationLabel": "MBP"
        }
      }
    }
  }
}
```

## Privacy model

Only non-sensitive metadata is synced:

- skill id and skill name
- installation id and installation label
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
data source: cloud-synced usage space
scope: current usage space
1. gh-issue-pr-iterations - total 18 triggers, 22 attempts
   by installation:
   Mac-mini - 10 total triggers, 12 attempts
      scope split: main 6, subagent 4
   MBP - 8 total triggers, 10 attempts
      scope split: main 5, subagent 3
2. git-pr - total 11 triggers, 12 attempts
   by installation:
   Mac-mini - 7 total triggers, 7 attempts
      scope split: main 5, subagent 2
   MBP - 4 total triggers, 5 attempts
      scope split: main 3, subagent 1
3. prepare-svp-weekly-report - total 4 triggers, 4 attempts
   by installation:
   Mac-mini - 4 total triggers, 4 attempts
      scope split: main 4, subagent 0
```

```text
Skill usage status:
data source: cloud-synced usage space
scope: current usage space
usage space: 7f2c... (joined)
this installation: Mac-mini
database: openclaw_skill_usage
cloud instance: zero_abc123
expires at: 2026-04-06T10:00:00.000Z
claim URL: https://...
synced totals: 38 triggers, 45 attempts
members: 2 installations, 3 agents, 6 subagent runs
last observed at: 2026-03-08T07:40:00.000Z
metadata sent: skill id/name, installation id/label, agent id, session scope, timestamps, status, latency
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
