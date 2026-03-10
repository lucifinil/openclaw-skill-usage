import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { JsonlSkillUsageStore } from "../src/lib/local-event-store.js";
import {
  createPendingSkillRead,
  finalizeSkillObservation,
} from "../src/lib/skill-usage-detector.js";
import { createSkillUsagePlugin } from "../src/lib/skill-usage-plugin.js";

function createApi(stateDir, overrides = {}) {
  const pluginConfig = {
    stateDir,
    autoSync: overrides.autoSync ?? false,
    ...(overrides.config ?? {}),
  };
  const base = {
    config: {
      plugins: {
        entries: {
          "skill-usage": {
            config: pluginConfig,
          },
        },
      },
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  };

  if (overrides.configOverride) {
    base.config = {
      ...base.config,
      ...overrides.configOverride,
      plugins: {
        ...base.config.plugins,
        ...overrides.configOverride.plugins,
      },
    };
  }

  return base;
}

test("createPendingSkillRead detects SKILL.md reads", () => {
  const pending = createPendingSkillRead({
    toolName: "read",
    toolCallId: "call-1",
    params: {
      path: "/Users/demo/.codex/skills/git-pr/SKILL.md",
    },
    context: {
      agentId: "main",
      runId: "run-1",
      sessionId: "session-1",
      timestamp: "2026-03-07T10:00:00.000Z",
    },
  });

  assert.ok(pending);
  assert.equal(pending.skillSource, "user");
  assert.equal(pending.fallbackSkillName, "git-pr");
  assert.equal(pending.pendingKey, "call-1");
});

test("finalizeSkillObservation prefers declared skill names from frontmatter", () => {
  const pending = createPendingSkillRead({
    toolName: "read",
    toolCallId: "call-2",
    params: {
      path: "/Users/demo/.openclaw/skills/gh-issue-pr-iterations/SKILL.md",
    },
    context: {
      agentId: "main",
      botId: "12345",
      botName: "@sales-bot",
      platform: "discord",
      runId: "run-9",
      turnId: "turn-3",
      timestamp: "2026-03-07T10:00:00.000Z",
    },
  });

  const event = finalizeSkillObservation({
    pending,
    installationId: "install-1",
    payload: {
      toolName: "read",
      toolCallId: "call-2",
      ok: true,
      result: {
        content: "---\nname: gh-issue-pr-iterations\n---\n# GitHub Issue PR Iterations\n",
      },
      context: {
        agentId: "main",
        botId: "12345",
        botName: "@sales-bot",
        platform: "discord",
        runId: "run-9",
        turnId: "turn-3",
        timestamp: "2026-03-07T10:00:01.000Z",
      },
    },
  });

  assert.equal(event.skillName, "gh-issue-pr-iterations");
  assert.equal(event.skillId, "gh-issue-pr-iterations");
  assert.equal(event.triggerAnchor, "turn-3");
  assert.equal(event.usageSpaceId, "install-1");
  assert.equal(event.botId, "12345");
  assert.equal(event.botName, "@sales-bot");
  assert.equal(event.botPlatform, "discord");
});

test("JsonlSkillUsageStore records attempts while deduping first triggers", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-store-"));

  try {
    const store = new JsonlSkillUsageStore({ rootDir: tempDir });
    const baseEvent = {
      schemaVersion: 1,
      eventType: "skill_usage",
      eventKey: "event-1",
      installationId: "install-1",
      usageSpaceId: "install-1",
      triggerAnchor: "run-1",
      observedAt: "2026-03-07T10:00:00.000Z",
      status: "ok",
      latencyMs: 3,
      skillId: "git-pr",
      skillName: "git-pr",
    };

    const first = await store.record(baseEvent);
    const second = await store.record({
      ...baseEvent,
      observedAt: "2026-03-07T10:00:02.000Z",
    });

    assert.equal(first.firstTrigger, true);
    assert.equal(second.firstTrigger, false);
    assert.equal(second.attempts, 2);

    const events = await store.readAllEvents();
    assert.equal(events.length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("plugin records one trigger for repeated skill reads in the same run", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-plugin-"));

  try {
    const plugin = createSkillUsagePlugin({
      api: createApi(tempDir),
    });

    const baseBefore = {
      toolName: "read",
      params: {
        path: "/Users/demo/.codex/skills/git-pr/SKILL.md",
      },
      context: {
        agentId: "main",
        runId: "run-1",
        sessionId: "session-1",
        timestamp: "2026-03-07T10:00:00.000Z",
      },
    };

    const baseAfter = {
      toolName: "read",
      ok: true,
      result: {
        content: "---\nname: git-pr\n---\n# Git PR\n",
      },
      context: {
        agentId: "main",
        runId: "run-1",
        sessionId: "session-1",
        timestamp: "2026-03-07T10:00:01.000Z",
      },
    };

    await plugin.onBeforeToolCall({
      ...baseBefore,
      toolCallId: "call-1",
    });
    const first = await plugin.onAfterToolCall({
      ...baseAfter,
      toolCallId: "call-1",
    });

    await plugin.onBeforeToolCall({
      ...baseBefore,
      toolCallId: "call-2",
      context: {
        ...baseBefore.context,
        timestamp: "2026-03-07T10:00:02.000Z",
      },
    });
    const second = await plugin.onAfterToolCall({
      ...baseAfter,
      toolCallId: "call-2",
      context: {
        ...baseAfter.context,
        timestamp: "2026-03-07T10:00:03.000Z",
      },
    });

    assert.equal(first.firstTrigger, true);
    assert.equal(second.firstTrigger, false);

    const events = await plugin.store.readAllEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].eventKey, events[1].eventKey);
    assert.equal(typeof plugin.installationIdentity.installationLabel, "string");
    assert.ok(plugin.installationIdentity.installationLabel.length > 0);
    assert.equal(events[0].installationLabel, plugin.installationIdentity.installationLabel);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("plugin records memory tools as pseudo skill using configured memory slot", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-pseudo-skill-"));

  try {
    const plugin = createSkillUsagePlugin({
      api: createApi(tempDir, {
        configOverride: {
          plugins: {
            slots: {
              memory: "memory-slot",
            },
          },
        },
      }),
    });

    const record = await plugin.onAfterToolCall({
      toolName: "memory_search",
      toolCallId: "call-memory-1",
      ok: true,
      result: { items: [] },
      context: {
        agentId: "main",
        runId: "run-memory-1",
        turnId: "turn-memory-1",
        timestamp: "2026-03-07T09:00:01.000Z",
      },
    });

    assert.equal(record.skillName, "memory-slot (includes plugin)");
    assert.equal(record.skillId, "memory-slot-includes-plugin");
    assert.equal(record.firstTrigger, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("plugin marks read events as subagent when runId was spawned via sessions_spawn", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-subagent-"));

  try {
    const plugin = createSkillUsagePlugin({ api: createApi(tempDir) });

    await plugin.onAfterToolCall({
      toolName: "sessions_spawn",
      params: { runtime: "subagent" },
      result: {
        runId: "sub-run-123",
        childSessionKey: "agent:main:subagent:abc",
      },
      context: { timestamp: "2026-03-07T10:00:00.000Z" },
    });

    await plugin.onBeforeToolCall({
      toolName: "read",
      toolCallId: "call-sub-1",
      params: { path: "/usr/local/lib/node_modules/openclaw/skills/weather/SKILL.md" },
      context: {
        runId: "sub-run-123",
        timestamp: "2026-03-07T10:00:01.000Z",
      },
    });

    const record = await plugin.onAfterToolCall({
      toolName: "read",
      toolCallId: "call-sub-1",
      ok: true,
      result: { content: "---\nname: weather\n---\n# Weather\n" },
      context: {
        runId: "sub-run-123",
        timestamp: "2026-03-07T10:00:02.000Z",
      },
    });

    assert.equal(record.sessionScope, "subagent");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("plugin captures subagent run id from childSessionKey even when tool name is not normalized", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-subagent-"));

  try {
    const plugin = createSkillUsagePlugin({ api: createApi(tempDir) });

    await plugin.onAfterToolCall({
      toolName: null,
      result: {
        runId: "sub-run-456",
        childSessionKey: "agent:main:subagent:def",
      },
      context: { timestamp: "2026-03-07T11:00:00.000Z" },
    });

    await plugin.onBeforeToolCall({
      toolName: "read",
      toolCallId: "call-sub-2",
      params: { path: "/usr/local/lib/node_modules/openclaw/skills/weather/SKILL.md" },
      context: {
        runId: "sub-run-456",
        timestamp: "2026-03-07T11:00:01.000Z",
      },
    });

    const record = await plugin.onAfterToolCall({
      toolName: "read",
      toolCallId: "call-sub-2",
      ok: true,
      result: { content: "---\nname: weather\n---\n# Weather\n" },
      context: {
        runId: "sub-run-456",
        timestamp: "2026-03-07T11:00:02.000Z",
      },
    });

    assert.equal(record.sessionScope, "subagent");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("plugin keeps subagent run mapping across plugin instances", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-subagent-persist-"));

  try {
    const pluginA = createSkillUsagePlugin({ api: createApi(tempDir) });
    await pluginA.onAfterToolCall({
      toolName: "sessions_spawn",
      params: { runtime: "subagent" },
      result: {
        runId: "sub-run-persist-1",
        childSessionKey: "agent:main:subagent:xyz",
      },
      context: { timestamp: "2026-03-07T12:00:00.000Z" },
    });

    const pluginB = createSkillUsagePlugin({ api: createApi(tempDir) });
    await pluginB.onBeforeToolCall({
      toolName: "read",
      toolCallId: "call-sub-persist",
      params: { path: "/usr/local/lib/node_modules/openclaw/skills/weather/SKILL.md" },
      context: {
        runId: "sub-run-persist-1",
        timestamp: "2026-03-07T12:00:01.000Z",
      },
    });

    const record = await pluginB.onAfterToolCall({
      toolName: "read",
      toolCallId: "call-sub-persist",
      ok: true,
      result: { content: "---\nname: weather\n---\n# Weather\n" },
      context: {
        runId: "sub-run-persist-1",
        timestamp: "2026-03-07T12:00:02.000Z",
      },
    });

    assert.equal(record.sessionScope, "subagent");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("plugin attributes channel bot usage with friendly aliases", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-bot-"));

  try {
    const plugin = createSkillUsagePlugin({
      api: createApi(tempDir, {
        config: {
          botAliases: {
            "discord:channel:discord-room-1": "Discord / @sales-bot",
          },
        },
      }),
    });

    await plugin.onBeforeToolCall({
      toolName: "read",
      toolCallId: "call-bot-1",
      params: { path: "/Users/demo/.codex/skills/git-pr/SKILL.md" },
      context: {
        agentId: "main",
        channelId: "discord-room-1",
        platform: "discord",
        runId: "run-bot-1",
        timestamp: "2026-03-07T10:00:00.000Z",
      },
    });

    const record = await plugin.onAfterToolCall({
      toolName: "read",
      toolCallId: "call-bot-1",
      ok: true,
      result: { content: "---\nname: git-pr\n---\n# Git PR\n" },
      context: {
        agentId: "main",
        channelId: "discord-room-1",
        platform: "discord",
        runId: "run-bot-1",
        timestamp: "2026-03-07T10:00:01.000Z",
      },
    });

    assert.equal(record.botKey, "discord:channel:discord-room-1");
    assert.equal(record.botLabel, "Discord / @sales-bot");
    assert.equal(record.botPlatform, "discord");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("plugin resolves snake_case routing fields for agent and channel account breakdowns", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-snake-case-"));

  try {
    const plugin = createSkillUsagePlugin({
      api: createApi(tempDir, {
        config: {
          botAliases: {
            "discord:elon": "Discord / @team-bot",
          },
        },
      }),
    });

    await plugin.onBeforeToolCall({
      toolName: "read",
      toolCallId: "call-snake-case-1",
      params: { path: "/Users/demo/.codex/skills/git-pr/SKILL.md" },
      context: {
        agent_id: "odin",
        account_id: "elon",
        account_name: "team-bot",
        channel_id: "1480303286182608897",
        platform: "discord",
        run_id: "run-snake-case-1",
        session_key: "agent:main:subagent:snake-case",
        message_id: "msg-snake-case-1",
        timestamp: "2026-03-07T10:00:00.000Z",
      },
    });

    const record = await plugin.onAfterToolCall({
      toolName: "read",
      toolCallId: "call-snake-case-1",
      ok: true,
      result: { content: "---\nname: git-pr\n---\n# Git PR\n" },
      context: {
        agent_id: "odin",
        account_id: "elon",
        account_name: "team-bot",
        channel_id: "1480303286182608897",
        platform: "discord",
        run_id: "run-snake-case-1",
        session_key: "agent:main:subagent:snake-case",
        message_id: "msg-snake-case-1",
        timestamp: "2026-03-07T10:00:01.000Z",
      },
    });

    assert.equal(record.agentId, "odin");
    assert.equal(record.botKey, "discord:elon");
    assert.equal(record.botLabel, "Discord / @team-bot");
    assert.equal(record.botPlatform, "discord");
    assert.equal(record.sessionKey, "agent:main:subagent:snake-case");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("plugin does not synthesize a channel account from agent id alone", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-account-"));

  try {
    const plugin = createSkillUsagePlugin({
      api: createApi(tempDir),
    });

    await plugin.onBeforeToolCall({
      toolName: "read",
      toolCallId: "call-agent-only",
      params: { path: "/Users/demo/.codex/skills/git-pr/SKILL.md" },
      context: {
        agentId: "odin",
        runId: "run-agent-only",
        timestamp: "2026-03-07T10:00:00.000Z",
      },
    });

    const record = await plugin.onAfterToolCall({
      toolName: "read",
      toolCallId: "call-agent-only",
      ok: true,
      result: { content: "---\nname: git-pr\n---\n# Git PR\n" },
      context: {
        agentId: "odin",
        runId: "run-agent-only",
        timestamp: "2026-03-07T10:00:01.000Z",
      },
    });

    assert.equal(record.agentId, "odin");
    assert.equal(record.botKey, null);
    assert.equal(record.botLabel, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("plugin backfills identity from session transcripts using runId", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "skill-usage-attribution-root-"));
  const tempDir = path.join(tempRoot, "state", "plugins", "skill-usage");

  try {
    await mkdir(tempDir, { recursive: true });
    const sessionDir = path.join(tempRoot, "agents", "main", "sessions");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "sessions.json"),
      JSON.stringify({
        "agent:main:discord:channel:1480303286182608897": {
          sessionId: "session-1",
          deliveryContext: {
            channel: "discord",
            to: "channel:1480303286182608897",
            accountId: "elon",
          },
          lastAccountId: "elon",
        },
      }, null, 2) + "\n",
      "utf8",
    );

    await writeFile(
      path.join(sessionDir, "session-1.jsonl"),
      [
        JSON.stringify({
          type: "message",
          sessionId: "session-1",
          sessionKey: "agent:main:discord:channel:1480303286182608897",
          agentId: "odin",
          channelId: null,
          accountId: null,
          platform: "discord",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/Users/demo/.codex/skills/git-pr/SKILL.md" } }],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "read", runId: "run-backfill-1" }],
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const plugin = createSkillUsagePlugin({
      api: createApi(tempDir, {
        config: {
          botAliases: {
            "discord:elon": "Discord / @team-bot",
          },
        },
      }),
    });

    await plugin.onBeforeToolCall({
      toolName: "read",
      toolCallId: "call-backfill-1",
      params: { path: "/Users/demo/.codex/skills/git-pr/SKILL.md" },
      context: {
        runId: "run-backfill-1",
        timestamp: "2026-03-07T10:00:00.000Z",
      },
    });

    const record = await plugin.onAfterToolCall({
      toolName: "read",
      toolCallId: "call-backfill-1",
      ok: true,
      result: { content: "---\nname: git-pr\n---\n# Git PR\n" },
      context: {
        runId: "run-backfill-1",
        timestamp: "2026-03-07T10:00:01.000Z",
      },
    });

    assert.equal(record.agentId, "odin");
    assert.equal(record.sessionKey, "agent:main:discord:channel:1480303286182608897");
    assert.equal(record.channelId, "1480303286182608897");
    assert.equal(record.botKey, "discord:elon");
    assert.equal(record.botLabel, "Discord / @team-bot");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("plugin can capture sanitized routing samples for remote fixture collection", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-routing-samples-"));

  try {
    const plugin = createSkillUsagePlugin({
      api: createApi(tempDir, {
        config: {
          captureRoutingSamples: true,
        },
      }),
    });

    await plugin.onBeforeToolCall({
      toolName: "read",
      toolCallId: "call-routing-1",
      params: {
        path: "/Users/demo/.codex/skills/git-pr/SKILL.md",
      },
      context: {
        agentId: "odin",
        accountId: "acct-1",
        accountName: "@team-bot",
        channelId: "discord-room-1",
        platform: "discord",
        runId: "run-routing-1",
        timestamp: "2026-03-07T10:00:00.000Z",
      },
    });

    await plugin.onAfterToolCall({
      toolName: "read",
      toolCallId: "call-routing-1",
      ok: true,
      result: {
        content: "---\nname: git-pr\n---\n# Git PR\n",
      },
      context: {
        agentId: "odin",
        accountId: "acct-1",
        accountName: "@team-bot",
        channelId: "discord-room-1",
        platform: "discord",
        runId: "run-routing-1",
        timestamp: "2026-03-07T10:00:01.000Z",
      },
    });
    await plugin.stop();

    const filePath = path.join(tempDir, "debug", "routing-samples.jsonl");
    const lines = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(lines.length, 2);
    assert.equal(lines[0].payload.toolName, "read");
    assert.equal(lines[0].payload.context.agentId, "odin");
    assert.equal(lines[0].payload.context.accountId, "acct-1");
    assert.equal(lines[0].payload.context.channelId, "discord-room-1");
    assert.equal(lines[0].payload.context.platform, "discord");
    assert.equal(lines[0].payload.result, undefined);
    assert.equal(lines[0].payload.params, undefined);
    assert.equal(lines[1].resolvedContext.accountPlatform, "discord");
    assert.equal(lines[1].resolvedContext.accountLabel, "Discord / @team-bot");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
