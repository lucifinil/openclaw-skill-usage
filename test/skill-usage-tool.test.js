import test from "node:test";
import assert from "node:assert/strict";
import { executeSkillUsageTool } from "../src/lib/skill-usage-tool.js";

test("skill usage tool renders top rankings", async () => {
  const result = await executeSkillUsageTool({
    cloud: {
      async queryTopSkillsWithFallback() {
        return {
          source: "cloud",
          cloudState: "healthy",
          aggregationScope: "usage-space",
          period: { label: "30 days" },
          rows: [
            {
              skillName: "git-pr",
              triggerCount: 5,
              attemptCount: 6,
              installationCount: 2,
              agentCount: 2,
              subagentRunCount: 1,
            },
          ],
        };
      },
    },
    params: {
      action: "top",
      period: "30d",
      limit: 5,
    },
  });

  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /Top skills for 30 days/);
  assert.match(result.content[0].text, /git-pr/);
});

test("skill usage tool renders status output", async () => {
  const result = await executeSkillUsageTool({
    cloud: {
      async getStatusWithFallback() {
        return {
          source: "cloud",
          cloudState: "healthy",
          aggregationScope: "usage-space",
          usageSpaceId: "space-1",
          usageSpaceSource: "joined",
          databaseName: "openclaw_skill_usage",
          zero: {
            instanceId: "zero-1",
            expiresAt: "2026-04-06T10:00:00.000Z",
            claimUrl: "https://tidbcloud.com/claim/demo",
          },
          summary: {
            totalTriggers: 8,
            totalAttempts: 9,
            installationCount: 2,
            agentCount: 3,
            subagentRunCount: 4,
          },
        };
      },
    },
    params: {
      action: "status",
    },
  });

  assert.match(result.content[0].text, /space-1/);
  assert.match(result.content[0].text, /joined/);
});
