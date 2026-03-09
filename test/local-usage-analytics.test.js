import test from "node:test";
import assert from "node:assert/strict";
import { LocalUsageAnalytics } from "../src/lib/local-usage-analytics.js";

function createStore(events) {
  return {
    async readAllEvents() {
      return events;
    },
  };
}

test("local analytics ranks skills across all time", async () => {
  const analytics = new LocalUsageAnalytics({
    store: createStore([
      {
        observedAt: "2026-03-07T10:00:00.000Z",
        firstTrigger: true,
        installationId: "install-1",
        installationLabel: "Mac-mini",
        agentId: "main",
        botKey: "discord:123",
        botLabel: "Discord / @sales-bot",
        botPlatform: "discord",
        sessionScope: "main",
        runId: "run-1",
        skillId: "git-pr",
        skillName: "git-pr",
      },
      {
        observedAt: "2026-03-07T10:01:00.000Z",
        firstTrigger: false,
        installationId: "install-1",
        installationLabel: "Mac-mini",
        agentId: "main",
        botKey: "discord:123",
        botLabel: "Discord / @sales-bot",
        botPlatform: "discord",
        sessionScope: "main",
        runId: "run-1",
        skillId: "git-pr",
        skillName: "git-pr",
      },
      {
        observedAt: "2026-03-06T10:00:00.000Z",
        firstTrigger: true,
        installationId: "install-1",
        installationLabel: "Mac-mini",
        agentId: "worker",
        sessionScope: "subagent",
        runId: "sub-1",
        skillId: "gh-issue-pr-iterations",
        skillName: "gh-issue-pr-iterations",
      },
    ]),
  });

  const result = await analytics.queryTopSkills({
    periodKey: "all",
    limit: 10,
    usageSpaceId: "install-1",
    usageSpaceSource: "local",
  });

  assert.equal(result.source, "local");
  assert.equal(result.rows[0].skillName, "git-pr");
  assert.equal(result.rows[0].triggerCount, 1);
  assert.equal(result.rows[0].attemptCount, 2);
  assert.deepEqual(result.rows[0].installations, [
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
  ]);
});

test("local analytics treats subagent events without runId as one subagent run when session identity exists", async () => {
  const analytics = new LocalUsageAnalytics({
    store: createStore([
      {
        observedAt: "2026-03-07T10:00:00.000Z",
        firstTrigger: true,
        installationId: "install-1",
        installationLabel: "Mac-mini",
        agentId: "worker",
        sessionScope: "subagent",
        runId: null,
        sessionKey: "agent:main:subagent:abc",
        triggerAnchor: "anchor-1",
        skillId: "weather",
        skillName: "weather",
      },
      {
        observedAt: "2026-03-07T10:01:00.000Z",
        firstTrigger: false,
        installationId: "install-1",
        installationLabel: "Mac-mini",
        agentId: "worker",
        sessionScope: "subagent",
        runId: null,
        sessionKey: "agent:main:subagent:abc",
        triggerAnchor: "anchor-2",
        skillId: "weather",
        skillName: "weather",
      },
    ]),
  });

  const top = await analytics.queryTopSkills({
    periodKey: "all",
    usageSpaceId: "install-1",
    usageSpaceSource: "local",
  });

  assert.equal(top.rows[0].subagentRunCount, 1);

  const status = await analytics.querySummary({
    usageSpaceId: "install-1",
    usageSpaceSource: "local",
    installationLabel: "Mac-mini",
  });

  assert.equal(status.summary.subagentRunCount, 1);
});

test("local analytics status summarizes the installation scope", async () => {
  const analytics = new LocalUsageAnalytics({
    store: createStore([
      {
        observedAt: "2026-03-07T10:00:00.000Z",
        firstTrigger: true,
        installationId: "install-1",
        installationLabel: "Mac-mini",
        agentId: "main",
        sessionScope: "main",
        runId: "run-1",
        skillId: "git-pr",
        skillName: "git-pr",
      },
      {
        observedAt: "2026-03-07T11:00:00.000Z",
        firstTrigger: true,
        installationId: "install-1",
        installationLabel: "Mac-mini",
        agentId: "worker",
        sessionScope: "subagent",
        runId: "sub-2",
        skillId: "prepare-svp-weekly-report",
        skillName: "prepare-svp-weekly-report",
      },
    ]),
  });

  const status = await analytics.querySummary({
    usageSpaceId: "install-1",
    usageSpaceSource: "local",
    installationLabel: "Mac-mini",
    databaseName: "openclaw_skill_usage",
  });

  assert.equal(status.source, "local");
  assert.equal(status.installationLabel, "Mac-mini");
  assert.equal(status.summary.totalTriggers, 2);
  assert.equal(status.summary.agentCount, 2);
  assert.equal(status.summary.accountCount, 0);
  assert.equal(status.summary.subagentRunCount, 1);
});

test("local analytics keeps one channel account across multiple routed agents", async () => {
  const analytics = new LocalUsageAnalytics({
    store: createStore([
      {
        observedAt: "2026-03-07T10:00:00.000Z",
        firstTrigger: true,
        installationId: "install-1",
        installationLabel: "Mac-mini",
        agentId: "odin",
        botKey: "discord:acct:team-bot",
        botLabel: "Discord / @team-bot",
        botPlatform: "discord",
        sessionScope: "main",
        runId: "run-odin-1",
        skillId: "git-pr",
        skillName: "git-pr",
      },
      {
        observedAt: "2026-03-07T10:05:00.000Z",
        firstTrigger: true,
        installationId: "install-1",
        installationLabel: "Mac-mini",
        agentId: "loki",
        botKey: "discord:acct:team-bot",
        botLabel: "Discord / @team-bot",
        botPlatform: "discord",
        sessionScope: "main",
        runId: "run-loki-1",
        skillId: "git-pr",
        skillName: "git-pr",
      },
    ]),
  });

  const result = await analytics.queryTopSkills({
    periodKey: "all",
    usageSpaceId: "install-1",
    usageSpaceSource: "local",
  });

  assert.equal(result.rows[0].agentCount, 2);
  assert.equal(result.rows[0].accountCount, 1);
  assert.deepEqual(result.rows[0].installations[0].agents, [
    {
      agentId: "loki",
      agentLabel: "loki",
      triggerCount: 1,
      attemptCount: 1,
    },
    {
      agentId: "odin",
      agentLabel: "odin",
      triggerCount: 1,
      attemptCount: 1,
    },
  ]);
  assert.deepEqual(result.rows[0].installations[0].accounts, [
    {
      accountKey: "discord:acct:team-bot",
      accountLabel: "Discord / @team-bot",
      accountPlatform: "discord",
      triggerCount: 2,
      attemptCount: 2,
      mainTriggerCount: 2,
      subagentTriggerCount: 0,
    },
  ]);
});
