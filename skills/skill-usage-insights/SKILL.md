---
name: skill-usage-insights
description: Use when the user wants to know which OpenClaw skills are used most, compare usage across periods, or understand how counts are shared across installations, agents, and channel accounts.
---

# Skill Usage Insights

Use the `skill_usage_stats` tool when the user asks about:

- most-used or least-used skills
- rankings for `1d`, `7d`, `30d`, or `all`
- how usage is shared across installations, agents, or channel accounts
- which installations contributed to a skill's total and by how much
- which Discord or Telegram accounts inside an installation contributed to a skill's total
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
- When the result is shared, include the installation, agent, and channel-account breakdowns if they help answer the question.
- Mention the usage-space scope if it matters to the answer.
- If the user asks about privacy, state that only non-sensitive metadata is synced: skill ids/names, installation/agent/account identifiers, routing/session metadata, timestamps, status, and latency.

Examples:

- "What are my most used skills?"
  - call `skill_usage_stats` with `{ action: "top", period: "all" }`
- "Show my top skills in the last 7 days."
  - call `skill_usage_stats` with `{ action: "top", period: "7d" }`
- "Is this local-only or shared across machines?"
  - call `skill_usage_stats` with `{ action: "status" }`
- "Which bot/account is using `git-pr` the most?"
  - call `skill_usage_stats` with `{ action: "top", period: "all" }` and explain the account breakdown

Formatting:

- The tool defaults to compact output.
- Use a more verbose explanation only when the user asks for the full detailed breakdown.

Boundaries:

- This skill is for reading and explaining skill-usage analytics.
- It does not install the plugin, enable config, or manage join/sync setup by itself.
- For setup or troubleshooting, hand off to the relevant install/config guidance instead of pretending the analytics skill can do provisioning work.
