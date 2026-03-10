# Enriched Snapshot Sync Proposal

## Problem

Local enriched analytics already produces a stronger `top` truth than cloud in some cases because it combines:

- raw local JSONL events
- transcript-derived skill observations
- resolver-enriched routed identity
- local per-skill / per-agent / per-channel aggregation

Cloud still primarily reflects the raw-event sync path, which can cause:

- cloud result sets to be smaller than local enriched result sets
- joined usage-space queries to miss installation-level truth
- query-time merge logic to compensate for cloud incompleteness

## Goal

Make cloud the shared store for **per-installation enriched top truth**.

This proposal only targets:

- `/skillusage top`
- join-aware multi-installation aggregation
- correctness alignment between local enriched truth and cloud truth

## Non-goals

This proposal does **not** attempt to solve:

- status snapshots
- event replay / rebuild
- transcript-derived event upload
- SQL-native complex analytics aggregation
- full audit/history warehousing

Those are follow-up concerns and are better handled by a later event-sync design.

## Core Idea

Each installation syncs its current **enriched top snapshot** to cloud.

Cloud stores one snapshot per:

- usage space
- installation
- period

Then cloud queries aggregate installation snapshots in the application layer.

## Snapshot Scope

Snapshots are only used for `top` in the MVP.

They are stored per installation and per period:

- `1d`
- `7d`
- `30d`
- `all`

## Proposed Storage Shape

A logical table like:

- `usage_space_top_snapshots`

Suggested fields:

- `usage_space_id`
- `installation_id`
- `installation_label`
- `period_key`
- `schema_version`
- `generated_at`
- `payload_json`

Suggested primary key:

- `(usage_space_id, installation_id, period_key)`

This means each installation owns one latest snapshot per period.

## Snapshot Payload

The payload should stay close to the existing `localAnalytics.queryTopSkills(...)` result shape.

Example:

```json
{
  "period": { "key": "7d", "label": "7 days" },
  "rows": [
    {
      "skillId": "weather",
      "skillName": "weather",
      "triggerCount": 37,
      "attemptCount": 37,
      "agentCount": 3,
      "accountCount": 4,
      "installations": [
        {
          "installationId": "install-1",
          "installationLabel": "Fans-MacBook-Air.local",
          "triggerCount": 37,
          "attemptCount": 37,
          "agents": [
            { "agentId": "elon", "agentLabel": "elon", "triggerCount": 26, "attemptCount": 26 }
          ],
          "accounts": [
            { "accountKey": "discord:elon", "accountLabel": "Discord / elon", "triggerCount": 20, "attemptCount": 20 }
          ]
        }
      ]
    }
  ]
}
```

## Sync Flow

```text
local raw events
  + transcript-derived observations
  + resolver-enriched identity
  -> local enriched top result (per period)
  -> snapshot payload(s)
  -> upsert to cloud by installation + period
```

## Query Flow

For `/skillusage top <period>` in a **joined usage space**:

1. load all snapshots for the current usage space and period
2. aggregate rows across installations in the app layer
3. preserve per-installation truth while aggregating usage-space totals
4. render via existing compact/detail presenters

For **local-only usage spaces**, the system should continue to trust local enriched analytics first rather than forcing a cloud snapshot path.

## Join Semantics

Before join:

- installation 1 should sync its enriched baseline snapshot to cloud

After join:

- installation 2 should sync its enriched baseline snapshot to cloud
- cloud should aggregate installation 1 + installation 2 snapshots

This keeps installation boundaries intact and avoids flattening incomplete raw data too early.

## Why This Is Preferred Now

Compared with event-level sync, snapshot sync is the better near-term choice because it:

- directly reuses already-validated local enriched truth
- avoids transcript-event dedupe/checkpoint complexity
- makes join correctness easier to reason about
- improves user-visible `top` correctness faster

## Tradeoffs

### Pros

- simpler implementation
- easier correctness story
- natural fit for joined usage-space aggregation
- aligns cloud with current strongest local truth

### Cons

- weaker historical replay story
- less flexible than event-level sync for rebuild/audit work
- requires storing multiple periods explicitly
- likely needs later evolution if historical recomputation becomes important

## Relationship to Event Sync

This proposal does not replace event sync forever.

Recommended sequencing:

1. stabilize enriched snapshot sync first
2. add event-level sync later for replay, rebuild, and richer history

See follow-up issue #46 for the later event-sync direction.

## MVP Success Criteria

The MVP is successful when:

1. local enriched `top` and cloud-backed `top` return the same skill set
2. join results preserve installation 1 and installation 2 truths
3. cloud becomes the primary shared source of top truth
4. query-time local patching becomes a safety net, not the main correctness mechanism
