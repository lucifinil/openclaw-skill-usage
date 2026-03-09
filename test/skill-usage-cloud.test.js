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
    this.installations = new Map();
    this.upsertCalls = [];
  }

  async ensureUsageSpace({ usageSpaceId, installationId, zeroConfig, source }) {
    this.spaceMeta.set(usageSpaceId, {
      installationId,
      zeroConfig,
      source,
    });
  }

  async ensureInstallationMember({ usageSpaceId, installationId, installationLabel }) {
    this.installations.set(`${usageSpaceId}:${installationId}`, {
      usageSpaceId,
      installationId,
      installationLabel,
    });
  }

  async upsertEvents(events) {
    this.upsertCalls.push(events.map((event) => event.recordKey));
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
          accountKeys: new Set(),
          subagentRunIds: new Set(),
          installations: new Map(),
        };
      const installationKey = `${usageSpaceId}:${event.installationId}`;
      const installationLabel =
        this.installations.get(installationKey)?.installationLabel ??
        event.installationLabel ??
        event.installationId;

      current.attemptCount += 1;
      if (event.firstTrigger) {
        current.triggerCount += 1;
      }
      current.installationIds.add(event.installationId);
      if (event.agentId) {
        current.agentIds.add(event.agentId);
      }
      if (event.botKey) {
        current.accountKeys.add(event.botKey);
      }
      if (event.sessionScope === "subagent" && event.runId) {
        current.subagentRunIds.add(event.runId);
      }
      const installationCurrent =
        current.installations.get(event.installationId) ?? {
          installationId: event.installationId,
          installationLabel,
          triggerCount: 0,
          attemptCount: 0,
          mainTriggerCount: 0,
          subagentTriggerCount: 0,
          agents: new Map(),
          accounts: new Map(),
        };
      installationCurrent.attemptCount += 1;
      if (event.firstTrigger) {
        installationCurrent.triggerCount += 1;
        if (event.sessionScope === "subagent") {
          installationCurrent.subagentTriggerCount += 1;
        } else {
          installationCurrent.mainTriggerCount += 1;
        }
      }
      if (event.agentId) {
        const agentCurrent =
          installationCurrent.agents.get(event.agentId) ?? {
            agentId: event.agentId,
            agentLabel: event.agentId,
            triggerCount: 0,
            attemptCount: 0,
          };
        agentCurrent.attemptCount += 1;
        if (event.firstTrigger) {
          agentCurrent.triggerCount += 1;
        }
        installationCurrent.agents.set(event.agentId, agentCurrent);
      }
      if (event.botKey) {
        const accountCurrent =
          installationCurrent.accounts.get(event.botKey) ?? {
            accountKey: event.botKey,
            accountLabel: event.botLabel ?? event.botKey,
            accountPlatform: event.botPlatform ?? null,
            triggerCount: 0,
            attemptCount: 0,
            mainTriggerCount: 0,
            subagentTriggerCount: 0,
          };
        accountCurrent.attemptCount += 1;
        if (event.firstTrigger) {
          accountCurrent.triggerCount += 1;
          if (event.sessionScope === "subagent") {
            accountCurrent.subagentTriggerCount += 1;
          } else {
            accountCurrent.mainTriggerCount += 1;
          }
        }
        installationCurrent.accounts.set(event.botKey, accountCurrent);
      }
      current.installations.set(event.installationId, installationCurrent);

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
          accountCount: row.accountKeys.size,
          subagentRunCount: row.subagentRunIds.size,
          installations: Array.from(row.installations.values())
            .map((installation) => ({
              ...installation,
              agents: Array.from(installation.agents.values()).sort(
                (left, right) =>
                  right.triggerCount - left.triggerCount ||
                  right.attemptCount - left.attemptCount ||
                  left.agentLabel.localeCompare(right.agentLabel),
              ),
              accounts: Array.from(installation.accounts.values()).sort(
                (left, right) =>
                  right.triggerCount - left.triggerCount ||
                  right.attemptCount - left.attemptCount ||
                  left.accountLabel.localeCompare(right.accountLabel),
              ),
            }))
            .sort(
              (left, right) =>
                right.triggerCount - left.triggerCount ||
                right.attemptCount - left.attemptCount ||
                left.installationLabel.localeCompare(right.installationLabel),
            ),
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
    const accounts = new Set();
    const subagentRuns = new Set();

    rows.forEach((event) => {
      installations.add(event.installationId);
      if (event.agentId) {
        agents.add(event.agentId);
      }
      if (event.botKey) {
        accounts.add(event.botKey);
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
      accountCount: accounts.size,
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
      installationLabel: "Mac-mini",
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
    await cloud.initialize();
    await cloud.store.initialize();
    await cloud.store.record({
      eventKey: "event-1",
      attempts: 1,
      firstTrigger: true,
      firstObservedAt: "2026-03-07T10:00:00.000Z",
      installationId: "install-1",
      botKey: "discord:123",
      botLabel: "Discord / @sales-bot",
      botPlatform: "discord",
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
      botKey: "discord:123",
      botLabel: "Discord / @sales-bot",
      botPlatform: "discord",
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
    assert.equal(status.installationLabel, "Mac-mini");

    await repository.ensureInstallationMember({
      usageSpaceId: "install-1",
      installationId: "install-2",
      installationLabel: "MBP",
    });
    await repository.upsertEvents([
      {
        recordKey: "external-record-1",
        eventKey: "event-3",
        attempts: 1,
        firstTrigger: true,
        usageSpaceId: "install-1",
        installationId: "install-2",
        installationLabel: "MBP",
        agentId: "main",
        runId: "run-2",
        sessionScope: "main",
        skillId: "git-pr",
        skillName: "git-pr",
        skillSource: "user",
        status: "ok",
        observedAt: "2026-03-07T10:06:00.000Z",
        triggerAnchor: "turn-3",
      },
    ]);

    const top = await cloud.queryTopSkills({
      periodKey: "all",
    });
    assert.equal(top.rows[0].skillName, "git-pr");
    assert.equal(top.rows[0].triggerCount, 2);
    assert.equal(top.rows[0].attemptCount, 3);
    assert.deepEqual(top.rows[0].installations, [
      {
        installationId: "install-1",
        installationLabel: "Mac-mini",
        triggerCount: 1,
        attemptCount: 2,
        mainTriggerCount: 1,
        subagentTriggerCount: 0,
        agents: [
          {
            agentId: "main",
            agentLabel: "main",
            triggerCount: 1,
            attemptCount: 2,
          },
        ],
        accounts: [
          {
            accountKey: "discord:123",
            accountLabel: "Discord / @sales-bot",
            accountPlatform: "discord",
            triggerCount: 1,
            attemptCount: 2,
            mainTriggerCount: 1,
            subagentTriggerCount: 0,
          },
        ],
      },
      {
        installationId: "install-2",
        installationLabel: "MBP",
        triggerCount: 1,
        attemptCount: 1,
        mainTriggerCount: 1,
        subagentTriggerCount: 0,
        agents: [
          {
            agentId: "main",
            agentLabel: "main",
            triggerCount: 1,
            attemptCount: 1,
          },
        ],
        accounts: [],
      },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("cloud sync checkpoints upload only new local records and expose sync health", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-cloud-"));

  try {
    const repository = new FakeRepository();
    const cloud = createCloud(tempDir, repository);
    await cloud.initialize();
    await cloud.store.initialize();
    await cloud.store.record({
      eventKey: "event-1",
      attempts: 1,
      firstTrigger: true,
      firstObservedAt: "2026-03-07T10:00:00.000Z",
      installationId: "install-1",
      installationLabel: "Mac-mini",
      agentId: "odin",
      runId: "run-1",
      sessionScope: "main",
      skillId: "git-pr",
      skillName: "git-pr",
      skillSource: "user",
      status: "ok",
      observedAt: "2026-03-07T10:00:00.000Z",
      triggerAnchor: "turn-1",
    });

    const first = await cloud.syncAll();
    assert.equal(first.uploaded, 1);
    assert.equal(first.sync.pendingLocalRecordCount, 0);
    assert.ok(first.sync.lastSuccessfulSyncAt);
    assert.deepEqual(repository.upsertCalls.map((batch) => batch.length), [1]);

    const second = await cloud.syncAll();
    assert.equal(second.uploaded, 0);
    assert.deepEqual(repository.upsertCalls.map((batch) => batch.length), [1, 0]);

    await cloud.store.record({
      eventKey: "event-2",
      attempts: 1,
      firstTrigger: true,
      firstObservedAt: "2026-03-07T10:05:00.000Z",
      installationId: "install-1",
      installationLabel: "Mac-mini",
      agentId: "loki",
      runId: "run-2",
      sessionScope: "main",
      skillId: "weather",
      skillName: "weather",
      skillSource: "user",
      status: "ok",
      observedAt: "2026-03-07T10:05:00.000Z",
      triggerAnchor: "turn-2",
    });

    const pending = await cloud.getSyncStatus();
    assert.equal(pending.pendingLocalRecordCount, 1);

    const third = await cloud.syncAll();
    assert.equal(third.uploaded, 1);
    assert.equal(third.sync.pendingLocalRecordCount, 0);
    assert.deepEqual(repository.upsertCalls.map((batch) => batch.length), [1, 0, 1]);
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
    await cloud.store.initialize();
    await cloud.store.record({
      eventKey: "event-join-1",
      attempts: 1,
      firstTrigger: true,
      firstObservedAt: "2026-03-07T10:00:00.000Z",
      installationId: "install-1",
      installationLabel: "Mac-mini",
      agentId: "odin",
      runId: "run-1",
      sessionScope: "main",
      skillId: "git-pr",
      skillName: "git-pr",
      skillSource: "user",
      status: "ok",
      observedAt: "2026-03-07T10:00:00.000Z",
      triggerAnchor: "turn-1",
    });
    await cloud.syncAll();
    assert.ok(cloud.cloudState.sync.checkpointOffset > 0);

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
    assert.equal(joined.sync.pendingLocalRecordCount, 0);

    const status = await cloud.getStatus();
    assert.equal(status.usageSpaceSource, "joined");

    const left = await cloud.leaveUsageSpace();
    assert.equal(left.usageSpaceId, "install-1");
    assert.equal(left.sync.pendingLocalRecordCount, 0);

    const deleted = await cloud.deleteUsageSpaceData();
    assert.equal(deleted.nextStatus.usageSpaceId, "install-1");
    assert.equal(deleted.nextStatus.sync.pendingLocalRecordCount, 0);
    assert.equal(cloud.cloudState.sync.checkpointOffset, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("command handler returns top rankings and join tokens", async () => {
  const cloud = {
    async queryTopSkillsWithFallback() {
      return {
        source: "cloud",
        cloudState: "healthy",
        aggregationScope: "usage-space",
        period: { label: "7 days" },
        rows: [
          {
            skillName: "git-pr",
            triggerCount: 3,
            attemptCount: 4,
            installationCount: 2,
            agentCount: 2,
            accountCount: 1,
            subagentRunCount: 1,
            installations: [
              {
                installationId: "install-1",
                installationLabel: "Mac-mini",
                triggerCount: 2,
                attemptCount: 3,
                mainTriggerCount: 1,
                subagentTriggerCount: 1,
                agents: [
                  {
                    agentId: "main",
                    agentLabel: "main",
                    triggerCount: 2,
                    attemptCount: 3,
                  },
                ],
                accounts: [
                  {
                    accountKey: "discord:123",
                    accountLabel: "Discord / @sales-bot",
                    accountPlatform: "discord",
                    triggerCount: 2,
                    attemptCount: 3,
                    mainTriggerCount: 1,
                    subagentTriggerCount: 1,
                  },
                ],
              },
              {
                installationId: "install-2",
                installationLabel: "MBP",
                triggerCount: 1,
                attemptCount: 1,
                mainTriggerCount: 1,
                subagentTriggerCount: 0,
                agents: [
                  {
                    agentId: "main",
                    agentLabel: "main",
                    triggerCount: 1,
                    attemptCount: 1,
                  },
                ],
                accounts: [],
              },
            ],
          },
        ],
      };
    },
    async createJoinToken() {
      return "ocsu1_token";
    },
    async getStatusWithFallback() {
      return {
        source: "cloud",
        cloudState: "healthy",
        aggregationScope: "usage-space",
        usageSpaceId: "space-1",
        usageSpaceSource: "local",
        installationLabel: "Mac-mini",
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
          accountCount: 1,
          subagentRunCount: 1,
        },
        sync: {
          lastSuccessfulSyncAt: "2026-03-07T10:10:00.000Z",
          pendingLocalRecordCount: 0,
          lastError: null,
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

test("cloud falls back to local analytics when top queries fail", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-cloud-"));

  try {
    const repository = new FakeRepository();
    const cloud = createCloud(tempDir, repository);
    await cloud.initialize();
    await cloud.store.initialize();
    await cloud.store.record({
      eventKey: "event-1",
      attempts: 1,
      firstTrigger: true,
      firstObservedAt: "2026-03-07T10:00:00.000Z",
      installationId: "install-1",
      installationLabel: "Mac-mini",
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

    cloud.queryTopSkills = async () => {
      throw new Error("network down");
    };

    const result = await cloud.queryTopSkillsWithFallback({
      periodKey: "all",
      limit: 10,
    });

    assert.equal(result.source, "local");
    assert.equal(result.cloudState, "local-only");
    assert.equal(result.rows[0].skillName, "git-pr");
    assert.equal(result.rows[0].installations[0].installationLabel, "Mac-mini");
    assert.match(result.degradedReason, /network down/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("cloud falls back to local status when sync fails", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-cloud-"));

  try {
    const repository = new FakeRepository();
    const cloud = createCloud(tempDir, repository);
    await cloud.initialize();
    await cloud.store.initialize();
    await cloud.store.record({
      eventKey: "event-1",
      attempts: 1,
      firstTrigger: true,
      firstObservedAt: "2026-03-07T10:00:00.000Z",
      installationId: "install-1",
      installationLabel: "Mac-mini",
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

    cloud.getStatus = async () => {
      const error = new Error("zero unavailable");
      await cloud.markSyncError(error);
      throw error;
    };

    const status = await cloud.getStatusWithFallback();

    assert.equal(status.source, "local");
    assert.equal(status.summary.totalTriggers, 1);
    assert.equal(status.installationLabel, "Mac-mini");
    assert.equal(status.sync.pendingLocalRecordCount, 1);
    assert.match(status.sync.lastError, /zero unavailable/);
    assert.match(status.degradedReason, /zero unavailable/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
