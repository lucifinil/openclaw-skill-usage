import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
              memory: "mem9",
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

    assert.equal(record.skillName, "mem9 (includes plugin)");
    assert.equal(record.skillId, "mem9-includes-plugin");
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
