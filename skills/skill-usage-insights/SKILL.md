---
name: skill-usage-insights
description: Use when the user wants to know which OpenClaw skills are used most, compare usage across periods, or understand how counts are shared across installations, agents, and subagent runs.
---

# Skill Usage Insights

Use the `skill_usage_stats` tool when the user asks about:

- most-used or least-used skills
- rankings for `1d`, `7d`, `30d`, or `all`
- how usage is shared across installations, agents, or subagent runs
- which installations contributed to a skill's total and by how much
- which bot accounts inside an installation contributed to a skill's total
- whether counts are local-only or joined into a shared usage space

Defaults:

- If the user asks for "most used skills" without a period, use `all`.
- If they ask for "recent" usage, use `7d` unless they specify a different window.
- Use the tool's `status` action before explaining share/join behavior or cloud metadata.

Counting model:

- A skill counts as triggered when OpenClaw reads that skill's `SKILL.md`.
- Repeated reads of the same skill inside one run count as extra attempts, not extra triggers.
- Rankings default to trigger count, high to low.

Response expectations:

- Name the period explicitly.
- Surface the top skills first.
- When the result is shared, include the installation breakdown if it helps answer the question.
- Mention the usage-space scope if it matters to the answer.
- If the user asks about privacy, state that only non-sensitive metadata is synced: skill ids/names, installation/agent identifiers, session scope, timestamps, status, and latency.
