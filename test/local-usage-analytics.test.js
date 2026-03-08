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
    },
  ]);
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
  assert.equal(status.summary.subagentRunCount, 1);
});
