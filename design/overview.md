# Skill Usage Data Model and Sync Design

## Short version

There are two different local data sources:

1. `skill-usage-events.jsonl`
   - plugin-owned local event log
   - records that a skill was observed during a run
   - may contain incomplete identity fields in some runtimes
2. OpenClaw transcripts + session metadata
   - `~/.openclaw/agents/*/sessions/*.jsonl`
   - `~/.openclaw/agents/*/sessions/sessions.json`
   - currently the more reliable source for routed identity such as agent, account, channel, and session linkage

The key design decision is:

> raw local JSONL is not the canonical source of routed identity.
> transcript-enriched local events are.

This means:

- local query paths may enrich missing identity at read time
- cloud sync should enrich local events before upload
- cloud is primarily the cross-installation sharing and aggregation layer, not the first place where routed identity is reconstructed

## Why this design exists

Originally it was tempting to require `skill-usage-events.jsonl` to be complete at write time.
In practice that is not reliable across all OpenClaw runtimes because:

- tool hook payloads are not always complete
- routing/session/account fields may be split across different transcript records
- some runtimes expose stable `runId` but do not provide full routed identity on the same tool-call event

Because of that, the system now treats transcript/session metadata as the stronger identity source.

## Data flow

```text
skill read observed
  -> plugin writes raw local event to skill-usage-events.jsonl
  -> local analytics / cloud sync enrich missing identity using transcript + sessions metadata
  -> enriched events are used for local rankings and uploaded to cloud
  -> cloud aggregates across installations
```

## Canonical rules

### Local raw JSONL

`skill-usage-events.jsonl` remains useful and should continue to exist because it provides:

- durable local observation history
- sync checkpoints
- retryable upload source
- simple local auditing

But it is **not required** to contain perfect identity at write time.

### Local enriched truth

For analytics and sync, the canonical local truth is:

- raw event
- plus transcript/session enrichment by `runId`

If raw and transcript disagree, use the single coherent session source that matches the transcript file/session metadata rather than mixing fields from multiple sessions.

### Cloud role

Cloud exists to provide:

- cross-installation sharing
- remote aggregation windows (`1d`, `7d`, `30d`, `all`)
- shared usage-space queries

Cloud should therefore consume the **enriched local event view**, not blindly trust incomplete raw local events.

## Important limitation

If raw event writes are incomplete, local query paths can still look correct because they enrich at read time.
That does **not** mean cloud sync is correct unless sync uses the same enrichment path.

This repo should avoid reintroducing the mistaken assumption that:

> if local display looks right, then raw events and cloud sync are automatically right.

That assumption is false.

## Current implementation intent

- raw events are still written immediately during plugin execution
- local analytics enriches missing identity with `SessionAttributionResolver`
- cloud sync enriches events from local JSONL before upload
- display merge remains a presentation safeguard, not the primary identity reconstruction layer

## Future guardrails

When changing this plugin, preserve these invariants:

1. Do not require raw hook payloads to be the only identity source.
2. Do not mix identity fields from different sessions.
3. Prefer a single transcript/session source for one event.
4. Keep cloud sync aligned with local enriched analytics.
5. Treat transcript/session metadata as canonical when raw events are incomplete.

## Current direction: enriched snapshot sync first

The current problem is no longer only identity reconstruction. We also need cloud/shared queries to reflect the same complete result set that local enriched analytics already knows how to produce.

In practice, local enriched analytics currently has the strongest installation-level truth because it combines:

- raw plugin-owned local JSONL events
- transcript-derived skill observations
- resolver-enriched routed identity
- final per-skill / per-agent / per-channel aggregation

That makes the current local top/status output the best available source of truth for one installation.

### Why snapshot sync is the current preferred direction

Instead of trying to upload every transcript-derived event immediately, the near-term preferred direction is:

> upload an installation-level enriched snapshot/baseline to cloud
> and use that as the shared source of truth for usage-space aggregation.

This is preferred because it:

- matches the strongest local truth we already trust
- avoids transcript-derived event dedupe/checkpoint complexity in the short term
- makes joined usage spaces easier to reason about
- lets installation 1 establish a correct enriched baseline before installation 2 joins

### Intended flow

```text
local raw events
  + transcript-derived observations
  + resolver-enriched identity
  -> local enriched aggregate truth for installation N
  -> sync enriched snapshot/baseline for installation N to cloud
  -> cloud aggregates installation-level snapshots across the usage space
  -> shared top/status queries read from cloud aggregate truth
```

### Join semantics under this direction

- Before join, installation 1 should sync its enriched baseline to cloud.
- After join, installation 2 should also sync its enriched baseline.
- Cloud should aggregate per-installation truths, not flatten incomplete local raw data.
- Query-time local merge may still exist as a safety net, but it should not be the long-term primary mechanism for correctness.

### Event sync is still valuable later

Event-level sync is still useful for:

- precise historical replay
- richer time-window recomputation
- auditing and backfills
- future correction/rebuild workflows

But the current recommendation is:

1. stabilize enriched snapshot sync first
2. keep event sync as a follow-up enhancement

This sequencing optimizes for correctness and simpler joins first, then richer history later.
