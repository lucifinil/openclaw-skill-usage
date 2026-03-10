# OpenClaw Skill Usage

See which skills actually earn their slot.

OpenClaw Skill Usage is a zero-config plugin that counts real skill invocations, ranks them from high to low, and lets multiple OpenClaw installations join the same shared leaderboard.

The product idea is simple:

- OpenClaw skills are apps.
- You need an app chart.
- The chart should work locally by default and become shareable with one command when you want it to.

## Example output

Default compact output:

```text
skill: weather (37)
- agent: elon 26 | main 10 | tim 1
- channel: disc/el 20 | wa 6 | tim 2 | unknown 9
=====================================
skill: skill-vetter (12)
- agent: main 9 | tim 2 | elon 1
- channel: wa 7 | disc/el 3 | tim 1 | unknown 1
=====================================
skill: github (8)
- agent: elon 6 | main 1 | unknown 1
- channel: disc/el 6 | wa 1 | unknown 1
```

Joined usage-space compact output keeps installation boundaries visible:

```text
skill: weather (34)
installation: Fans-MacBook-Air.local (30)
- agent: elon 19 | main 10 | tim 1
- channel: disc/el 13 | wa 6 | tim 2 | unknown 9
-------------------------------------
installation: Remote-Mac-mini (4)
- agent: tim 4
- channel: tim 4
=====================================
skill: github (7)
installation: Fans-MacBook-Air.local (5)
- agent: elon 4 | main 1
- channel: disc/el 4 | wa 1
-------------------------------------
installation: Remote-Mac-mini (2)
- agent: tim 2
- channel: tim 2
```

Verbose `detail` output is still available when you want the full breakdown:

```text
Top skills for 7 days:
data source: cloud-synced usage space
scope: current usage space
1. gh-issue-pr-iterations - total 18 triggers, 22 attempts
   by installation:
   Mac-mini - 10 total triggers, 12 attempts
      by agent:
      odin - 6 total triggers, 7 attempts
      loki - 4 total triggers, 5 attempts
      by channel account:
      Discord / @sales-bot - 7 total triggers, 8 attempts
      Telegram / @alerts-bot - 3 total triggers, 4 attempts
   MBP - 8 total triggers, 10 attempts
      by agent:
      freyja - 8 total triggers, 10 attempts
      by channel account:
      Discord / @community-bot - 8 total triggers, 10 attempts
```

Status output:

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
last observed at: 2026-03-08T07:40:00.000Z
last cloud sync: 2026-03-08T07:40:02.000Z
pending local records: 0
last sync error: none
metadata sent: skill id/name, installation id/label, channel account key/label/platform, agent id, routing/session identifiers, timestamps, status, latency
```

## What it does

- counts every installed skill by actual use
- ranks skills for `1d`, `7d`, `30d`, and `all`
- auto-provisions TiDB Cloud Zero on first sync
- shares counts across multiple OpenClaw installations with a join token
- shows each skill's total first, then a per-installation breakdown using installation labels
- splits each installation by routed agent and channel account when that metadata is available
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
- "Which Discord bot account is using `git-pr` the most?"
- "Compare skill usage by agent and Telegram account."

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
/skillusage sync [full]
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

Sync behavior:

- normal syncs upload only the unsynced tail of the local JSONL event log
- `/skillusage status` shows `last cloud sync`, `pending local records`, and `last sync error`
- `/skillusage sync full` forces a full resync of the local event history into the current usage space

## Identity and sync model

Important implementation detail:

- `skill-usage-events.jsonl` is the plugin-owned local event log
- OpenClaw transcripts and session metadata are currently the more reliable source of routed identity
- local analytics may enrich raw events at query time
- cloud sync should upload the enriched local event view, not rely on raw local events being complete

See `DESIGN.md` for the full rationale and guardrails.

## Remote routing capture

If you need to validate Discord or Telegram routing fields on a real OpenClaw server, enable sanitized routing capture temporarily:

```json
{
  "plugins": {
    "entries": {
      "skill-usage": {
        "enabled": true,
        "config": {
          "captureRoutingSamples": true
        }
      }
    }
  }
}
```

This writes sanitized routing samples to:

```text
~/.openclaw/state/plugins/skill-usage/debug/routing-samples.jsonl
```

What it includes:

- routing-related hook fields such as agent, account, channel, platform, run, and session ids
- selected nested `context`, `channel`, `account`, `bot`, `connector`, `integration`, `transport`, `session`, and `run` fields
- normalized and resolved routing context for the observed skill event

What it excludes:

- prompts
- user message content
- tool outputs such as `result.content`
- arbitrary tool params beyond the routing whitelist

Use it only while capturing samples for fixture work, then turn it back off.

## Sharing model

Professional terms used in this repo:

- `installation`: one OpenClaw Gateway deployment
- `agent`: one configured OpenClaw agent
- `channel account`: the Discord or Telegram account bound to a channel connector
- `usage space`: the aggregation namespace that multiple installations can share

Default behavior:

- one installation starts in one private usage space
- each installation gets a zero-config `installation label` from the machine hostname
- counts roll up under that installation automatically

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
          "installationLabel": "MBP",
          "accountAliases": {
            "discord:channel:discord-room-1": "Discord / @sales-bot",
            "telegram:channel:telegram-room-1": "Telegram / @alerts-bot"
          }
        }
      }
    }
  }
}
```

Channel-account attribution rules:

- if the runtime exposes a bot/account id, that becomes the stable channel-account key
- if the runtime only exposes a channel identity, the plugin falls back to a channel-bound account key
- `accountAliases` lets you turn those stable keys into the account names you actually want to see in rankings
- legacy `botAliases` is still accepted for backward compatibility

## Multi-agent routing

This plugin follows the same routing dimensions that OpenClaw documents for multi-agent channels:

- `agentId` tells you which OpenClaw agent handled the work
- `accountId` tells you which Discord or Telegram account the channel connector used

That means both of these common deployments are handled cleanly:

- Option A: one Discord bot account routing to multiple agents by channel or thread
- Option B: multiple Discord or Telegram bot accounts, each bound to its own agent

In Option A, you will see one channel-account row with multiple agent rows under the same installation.
In Option B, you will see separate channel-account rows and separate agent rows under the same installation.

## Privacy model

Only non-sensitive metadata is synced:

- skill id and skill name
- installation id and installation label
- channel account id/key, label, and platform when available
- agent id
- routing/session identifiers when available
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
