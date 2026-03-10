# Compact Output Spec

## Goal

Provide a `top` output format that is:

- shorter
- stable
- easy to read
- easier to parse downstream

`format=compact` uses this spec by default.
`format=detail` preserves the legacy verbose output.

## 1. Top-level structure

Each skill renders as a block beginning with:

```text
skill: <skillName> (<triggerCount>)
```

Example:

```text
skill: git-pr (5)
```

## 2. Single-installation format

When a skill has only one installation:

- do not render `installation: ...`
- render agent and channel summaries directly

Format:

```text
skill: <skillName> (<triggerCount>)
- agent: <agentSummary>
- channel: <channelSummary>
```

Example:

```text
skill: weather (37)
- agent: elon 24 | main 10 | tim 1 | unknown 2
- channel: disc/el 18 | wa 6 | tim 2 | unknown 11
```

## 3. Multi-installation format

When a skill has multiple installations:

- render one installation block per installation
- separate installation blocks with a fixed divider

Format:

```text
skill: <skillName> (<triggerCount>)
installation: <installationLabel> (<triggerCount>)
- agent: <agentSummary>
- channel: <channelSummary>
-------------------------------------
installation: <installationLabel> (<triggerCount>)
- agent: <agentSummary>
- channel: <channelSummary>
```

Example:

```text
skill: git-pr (5)
installation: Mac-mini (3)
- agent: odin 3
- channel: Discord / @sales-bot 3
-------------------------------------
installation: MBP (2)
- agent: loki 2
- channel: none
```

## 4. Skill separator

When multiple skills are rendered, separate skill blocks with:

```text
=====================================
```

Example:

```text
skill: git-pr (5)
- agent: odin 3 | loki 2
- channel: Discord / @sales-bot 3 | unknown 2
=====================================
skill: weather (4)
- agent: elon 4
- channel: wa 4
```

## 5. Stable line prefixes

Prefixes are fixed:

- `skill:`
- `installation:`
- `- agent:`
- `- channel:`

Do not substitute synonyms.

## 6. Summary formatting

### Agent summary

Join multiple agents with ` | `:

```text
- agent: elon 24 | main 10 | tim 1
```

### Channel summary

Join multiple channel accounts with ` | `:

```text
- channel: disc/el 18 | wa 6 | tim 2
```

## 7. Empty and unknown buckets

### No channel data

```text
- channel: none
```

### No agent data

```text
- agent: none
```

### Incomplete attribution

Missing attribution is rendered via `unknown` buckets:

```text
- agent: elon 24 | unknown 2
- channel: disc/el 18 | unknown 11
```

## 8. Label normalization

Compact mode may shorten long labels, but mappings must stay stable.

Examples:

- `Unknown channel account` → `unknown`
- `Unknown agent` → `unknown`
- `Whatsapp / default` → `wa`
- `Discord / elon` → `disc/el`
- verbose Discord channel labels such as `Discord / Guild #allhands channel id:...` should be normalized to a stable actor/account label like `Discord / elon` before compact shortening

Rules:

- prefer short labels
- avoid ambiguity
- keep the same source label mapped to the same compact label

## 9. Non-goals

Compact output does not try to show:

- attempts
- verbose metadata
- data source headers
- scope headers
- explanatory prose

Those belong to `detail` mode.

## 10. Compatibility rule

- `compact` is the default display format
- `detail` is the complete legacy format
- compact changes should preserve:
  - stable prefixes
  - stable separators
  - stable single-installation vs multi-installation rules

Avoid frequent format churn so downstream parsing stays reliable.
