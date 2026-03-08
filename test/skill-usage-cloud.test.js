import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonlSkillUsageStore } from "../src/lib/local-event-store.js";
import { SkillUsageCloud } from "../src/lib/skill-usage-cloud.js";
import { encodeUsageSpaceToken, decodeUsageSpaceToken } from "../src/lib/usage-space-token.js";
import { runSkillUsageCommand } from "../src/lib/skill-usage-command.js";

class FakeRepository {
  constructor() {
    this.events = new Map();
    this.spaceMeta = new Map();
  }

  async ensureUsageSpace({ usageSpaceId, installationId, zeroConfig, source }) {
    this.spaceMeta.set(usageSpaceId, {
      installationId,
      zeroConfig,
      source,
    });
  }

  async upsertEvents(events) {
    events.forEach((event) => {
      this.events.set(event.recordKey, event);
    });
    return {
      uploaded: events.length,
    };
  }

  async queryTopSkills({ usageSpaceId, periodKey }) {
    const rows = Array.from(this.events.values()).filter((event) => event.usageSpaceId === usageSpaceId);
    const grouped = new Map();

    rows.forEach((event) => {
      const current =
        grouped.get(event.skillId) ?? {
          skillId: event.skillId,
          skillName: event.skillName,
          triggerCount: 0,
          attemptCount: 0,
          installationIds: new Set(),
          agentIds: new Set(),
          subagentRunIds: new Set(),
        };

      current.attemptCount += 1;
      if (event.firstTrigger) {
        current.triggerCount += 1;
      }
      current.installationIds.add(event.installationId);
      if (event.agentId) {
        current.agentIds.add(event.agentId);
      }
      if (event.sessionScope === "subagent" && event.runId) {
        current.subagentRunIds.add(event.runId);
      }

      grouped.set(event.skillId, current);
    });

    return {
      period: {
        label:
          periodKey === "1d"
            ? "1 day"
            : periodKey === "7d"
              ? "7 days"
              : periodKey === "30d"
                ? "30 days"
                : "all time",
      },
      rows: Array.from(grouped.values())
        .map((row) => ({
          skillId: row.skillId,
          skillName: row.skillName,
          triggerCount: row.triggerCount,
          attemptCount: row.attemptCount,
          installationCount: row.installationIds.size,
          agentCount: row.agentIds.size,
          subagentRunCount: row.subagentRunIds.size,
        }))
        .sort(
          (left, right) =>
            right.triggerCount - left.triggerCount ||
            right.attemptCount - left.attemptCount ||
            left.skillName.localeCompare(right.skillName),
        ),
    };
  }

  async queryUsageSpaceSummary({ usageSpaceId }) {
    const rows = Array.from(this.events.values()).filter((event) => event.usageSpaceId === usageSpaceId);
    const installations = new Set();
    const agents = new Set();
    const subagentRuns = new Set();

    rows.forEach((event) => {
      installations.add(event.installationId);
      if (event.agentId) {
        agents.add(event.agentId);
      }
      if (event.sessionScope === "subagent" && event.runId) {
        subagentRuns.add(event.runId);
      }
    });

    return {
      totalAttempts: rows.length,
      totalTriggers: rows.filter((event) => event.firstTrigger).length,
      installationCount: installations.size,
      agentCount: agents.size,
      subagentRunCount: subagentRuns.size,
      lastObservedAt: rows.at(-1)?.observedAt ?? null,
    };
  }

  async deleteInstallationData({ usageSpaceId, installationId }) {
    Array.from(this.events.entries()).forEach(([key, event]) => {
      if (event.usageSpaceId === usageSpaceId && event.installationId === installationId) {
        this.events.delete(key);
      }
    });
  }

  async deleteUsageSpaceData({ usageSpaceId }) {
    Array.from(this.events.entries()).forEach(([key, event]) => {
      if (event.usageSpaceId === usageSpaceId) {
        this.events.delete(key);
      }
    });
  }

  async close() {}
}

function createCloud(tempDir, repository) {
  const store = new JsonlSkillUsageStore({
    rootDir: path.join(tempDir, "events"),
  });

  return new SkillUsageCloud({
    stateDir: tempDir,
    installationIdentity: {
      installationId: "install-1",
      createdAt: "2026-03-07T10:00:00.000Z",
    },
    store,
    options: {
      databaseName: "openclaw_skill_usage",
      provisionTag: "openclaw-skill-usage",
    },
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        instance: {
          id: "zero-1",
          connection: {
            host: "zero.example.com",
            port: 4000,
            username: "demo",
            password: "secret",
          },
          connectionString: "mysql://demo:secret@zero.example.com:4000",
          claimInfo: {
            claimUrl: "https://tidbcloud.com/claim/demo",
          },
          expiresAt: "2026-04-06T10:00:00.000Z",
        },
      }),
      headers: new Headers(),
    }),
    repositoryFactory: () => repository,
  });
}

test("usage space tokens round-trip join details", () => {
  const token = encodeUsageSpaceToken({
    usageSpaceId: "space-1",
    installationId: "install-a",
    databaseName: "openclaw_skill_usage",
    zero: {
      instanceId: "zero-1",
      connectionString: "mysql://demo:secret@zero.example.com:4000",
    },
  });

  const decoded = decodeUsageSpaceToken(token);
  assert.equal(decoded.usageSpaceId, "space-1");
  assert.equal(decoded.installationId, "install-a");
});

test("cloud sync provisions once and aggregates top skills", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-cloud-"));

  try {
    const repository = new FakeRepository();
    const cloud = createCloud(tempDir, repository);
    await cloud.store.initialize();
    await cloud.store.record({
      eventKey: "event-1",
      attempts: 1,
      firstTrigger: true,
      firstObservedAt: "2026-03-07T10:00:00.000Z",
      installationId: "install-1",
      agentId: "main",
      runId: "run-1",
      sessionScope: "main",
      skillId: "git-pr",
      skillName: "git-pr",
      skillSource: "user",
      status: "ok",
      observedAt: "2026-03-07T10:00:00.000Z",
      triggerAnchor: "turn-1",
    });
    await cloud.store.record({
      eventKey: "event-1",
      attempts: 2,
      firstTrigger: false,
      firstObservedAt: "2026-03-07T10:00:00.000Z",
      installationId: "install-1",
      agentId: "main",
      runId: "run-1",
      sessionScope: "main",
      skillId: "git-pr",
      skillName: "git-pr",
      skillSource: "user",
      status: "ok",
      observedAt: "2026-03-07T10:00:01.000Z",
      triggerAnchor: "turn-1",
    });
    await cloud.store.record({
      eventKey: "event-2",
      attempts: 1,
      firstTrigger: true,
      firstObservedAt: "2026-03-07T10:05:00.000Z",
      installationId: "install-1",
      agentId: "summarizer",
      runId: "sub-run-1",
      sessionScope: "subagent",
      skillId: "gh-issue-pr-iterations",
      skillName: "gh-issue-pr-iterations",
      skillSource: "user",
      status: "ok",
      observedAt: "2026-03-07T10:05:00.000Z",
      triggerAnchor: "turn-2",
    });

    const status = await cloud.getStatus();
    assert.equal(status.summary.totalAttempts, 3);
    assert.equal(status.summary.totalTriggers, 2);
    assert.equal(status.zero.instanceId, "zero-1");

    const top = await cloud.queryTopSkills({
      periodKey: "all",
    });
    assert.equal(top.rows[0].skillName, "git-pr");
    assert.equal(top.rows[0].triggerCount, 1);
    assert.equal(top.rows[0].attemptCount, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("join, leave, and delete flows update usage spaces", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-cloud-"));

  try {
    const repository = new FakeRepository();
    const cloud = createCloud(tempDir, repository);
    await cloud.initialize();

    const token = encodeUsageSpaceToken({
      usageSpaceId: "shared-space",
      installationId: "install-a",
      databaseName: "shared_usage",
      zero: {
        instanceId: "zero-shared",
        host: "zero.example.com",
        port: 4000,
        username: "demo",
        password: "secret",
        connectionString: "mysql://demo:secret@zero.example.com:4000",
        claimUrl: "https://tidbcloud.com/claim/shared",
        expiresAt: "2026-04-06T10:00:00.000Z",
      },
    });

    const joined = await cloud.joinUsageSpace(token);
    assert.equal(joined.usageSpaceId, "shared-space");

    const status = await cloud.getStatus();
    assert.equal(status.usageSpaceSource, "joined");

    const left = await cloud.leaveUsageSpace();
    assert.equal(left.usageSpaceId, "install-1");

    const deleted = await cloud.deleteUsageSpaceData();
    assert.equal(deleted.nextStatus.usageSpaceId, "install-1");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("command handler returns top rankings and join tokens", async () => {
  const cloud = {
    async queryTopSkills() {
      return {
        period: { label: "7 days" },
        rows: [
          {
            skillName: "git-pr",
            triggerCount: 3,
            attemptCount: 4,
            installationCount: 2,
            agentCount: 2,
            subagentRunCount: 1,
          },
        ],
      };
    },
    async createJoinToken() {
      return "ocsu1_token";
    },
    async getStatus() {
      return {
        usageSpaceId: "space-1",
        usageSpaceSource: "local",
        databaseName: "openclaw_skill_usage",
        zero: {
          instanceId: "zero-1",
          expiresAt: "2026-04-06T10:00:00.000Z",
          claimUrl: "https://tidbcloud.com/claim/demo",
        },
        summary: {
          totalTriggers: 3,
          totalAttempts: 4,
          installationCount: 2,
          agentCount: 2,
          subagentRunCount: 1,
        },
      };
    },
  };

  const top = await runSkillUsageCommand({
    cloud,
    args: "top 7d",
  });
  assert.match(top.text, /Top skills for 7 days/);

  const token = await runSkillUsageCommand({
    cloud,
    args: "join-token",
  });
  assert.match(token.text, /ocsu1_token/);
});
