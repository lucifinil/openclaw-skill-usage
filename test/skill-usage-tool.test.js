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
            accountCount: 1,
            subagentRunCount: 1,
            installations: [
              {
                installationId: "install-1",
                installationLabel: "Mac-mini",
                triggerCount: 3,
                attemptCount: 4,
                mainTriggerCount: 2,
                subagentTriggerCount: 1,
                agents: [
                  {
                    agentId: "odin",
                    agentLabel: "odin",
                    triggerCount: 3,
                    attemptCount: 4,
                  },
                ],
                accounts: [
                  {
                    accountKey: "discord:123",
                    accountLabel: "Discord / @sales-bot",
                    accountPlatform: "discord",
                    triggerCount: 3,
                    attemptCount: 4,
                    mainTriggerCount: 2,
                    subagentTriggerCount: 1,
                  },
                ],
              },
              {
                installationId: "install-2",
                installationLabel: "MBP",
                triggerCount: 2,
                attemptCount: 2,
                mainTriggerCount: 2,
                subagentTriggerCount: 0,
                agents: [
                  {
                    agentId: "loki",
                    agentLabel: "loki",
                    triggerCount: 2,
                    attemptCount: 2,
                  },
                ],
                accounts: [],
              },
            ],
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
  assert.match(result.content[0].text, /git-pr \(5\)/);
  assert.match(result.content[0].text, /Mac-mini \(3\)/);
  assert.match(result.content[0].text, /agent:\s+odin 3/);
  assert.match(result.content[0].text, /channel:\s+Discord \/ @sales-bot 3/);
  assert.match(result.content[0].text, /MBP \(2\)/);
  assert.match(result.content[0].text, /agent:\s+loki 2/);
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
          installationLabel: "Mac-mini",
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
          accountCount: 2,
          subagentRunCount: 4,
        },
        sync: {
          lastSuccessfulSyncAt: "2026-03-07T10:10:00.000Z",
          pendingLocalRecordCount: 0,
          lastError: null,
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
  assert.match(result.content[0].text, /this installation: Mac-mini/);
  assert.match(result.content[0].text, /last cloud sync:/);
  assert.match(result.content[0].text, /pending local records: 0/);
  assert.match(result.content[0].text, /last sync error: none/);
});


test("skill usage tool renders unknown channel-account bucket when breakdown is below parent total", async () => {
  const result = await executeSkillUsageTool({
    cloud: {
      async queryTopSkillsWithFallback() {
        return {
          source: "cloud",
          cloudState: "healthy",
          aggregationScope: "usage-space",
          period: { key: "7d", label: "7 days" },
          rows: [
            {
              skillId: "weather",
              skillName: "weather",
              triggerCount: 29,
              attemptCount: 29,
              installationCount: 1,
              agentCount: 3,
              accountCount: 3,
              installations: [
                {
                  installationId: "install-1",
                  installationLabel: "Fans-MacBook-Air.local",
                  triggerCount: 29,
                  attemptCount: 29,
                  agents: [
                    { agentId: "elon", agentLabel: "elon", triggerCount: 18, attemptCount: 18 },
                    { agentId: "main", agentLabel: "main", triggerCount: 10, attemptCount: 10 },
                    { agentId: "tim", agentLabel: "tim", triggerCount: 1, attemptCount: 1 },
                  ],
                  accounts: [
                    { accountKey: "discord:elon", accountLabel: "Discord / elon", triggerCount: 18, attemptCount: 18 },
                    { accountKey: "whatsapp:default", accountLabel: "Whatsapp / default", triggerCount: 6, attemptCount: 6 },
                    { accountKey: "discord:tim", accountLabel: "Discord / tim", triggerCount: 2, attemptCount: 2 },
                  ],
                },
              ],
            },
          ],
        };
      },
    },
    params: { action: "top", period: "7d", limit: 5 },
  });

  assert.match(result.content[0].text, /weather \(29\)/);
  assert.match(result.content[0].text, /agent:\s+elon 18 \| main 10 \| tim 1/i);
  assert.match(result.content[0].text, /channel:\s+disc\/el 18 \| wa 6 \| tim 2 \| unknown 3/i);
  assert.doesNotMatch(result.content[0].text, /channel id:1480303286182608897/i);
});


test("skill usage tool can render compact top output", async () => {
  const result = await executeSkillUsageTool({
    cloud: {
      async queryTopSkillsWithFallback() {
        return {
          source: "cloud",
          cloudState: "healthy",
          aggregationScope: "usage-space",
          period: { key: "7d", label: "7 days" },
          rows: [
            {
              skillId: "weather",
              skillName: "weather",
              triggerCount: 37,
              attemptCount: 37,
              installationCount: 1,
              agentCount: 4,
              accountCount: 4,
              installations: [
                {
                  installationId: "install-1",
                  installationLabel: "Fans-MacBook-Air.local",
                  triggerCount: 37,
                  attemptCount: 37,
                  agents: [
                    { agentId: "elon", agentLabel: "elon", triggerCount: 24, attemptCount: 24 },
                    { agentId: "main", agentLabel: "main", triggerCount: 10, attemptCount: 10 },
                    { agentId: "tim", agentLabel: "tim", triggerCount: 1, attemptCount: 1 },
                    { agentId: "unknown", agentLabel: "Unknown agent", triggerCount: 2, attemptCount: 2 },
                  ],
                  accounts: [
                    { accountKey: "discord:elon", accountLabel: "Discord / elon", triggerCount: 18, attemptCount: 18 },
                    { accountKey: "whatsapp:default", accountLabel: "Whatsapp / default", triggerCount: 6, attemptCount: 6 },
                    { accountKey: "discord:tim", accountLabel: "Discord / tim", triggerCount: 2, attemptCount: 2 },
                    { accountKey: "unknown", accountLabel: "Unknown channel account", triggerCount: 11, attemptCount: 11 },
                  ],
                },
              ],
            },
          ],
        };
      },
    },
    params: { action: "top", period: "7d", limit: 5 },
  });

  assert.match(result.content[0].text, /weather \(37\)/);
  assert.match(result.content[0].text, /agent:\s+elon 24 \| main 10 \| tim 1 \| unknown 2/i);
  assert.match(result.content[0].text, /channel:\s+disc\/el 18 \| wa 6 \| tim 2 \| unknown 11/i);
});


test("skill usage tool normalizes verbose Discord channel labels in compact output", async () => {
  const result = await executeSkillUsageTool({
    cloud: {
      async queryTopSkillsWithFallback() {
        return {
          source: "cloud",
          cloudState: "healthy",
          aggregationScope: "usage-space",
          period: { key: "7d", label: "7 days" },
          rows: [
            {
              skillId: "github",
              skillName: "github",
              triggerCount: 5,
              attemptCount: 5,
              installationCount: 1,
              agentCount: 1,
              accountCount: 1,
              installations: [
                {
                  installationId: "install-1",
                  installationLabel: "Fans-MacBook-Air.local",
                  triggerCount: 5,
                  attemptCount: 5,
                  agents: [
                    { agentId: "elon", agentLabel: "elon", triggerCount: 5, attemptCount: 5 },
                  ],
                  accounts: [
                    { accountKey: "discord:elon", accountLabel: "Discord / Guild #allhands channel id:1480303286182608897", triggerCount: 5, attemptCount: 5 },
                  ],
                },
              ],
            },
          ],
        };
      },
    },
    params: { action: "top", period: "7d", limit: 5 },
  });

  assert.match(result.content[0].text, /channel:\s+disc\/el 5/i);
  assert.doesNotMatch(result.content[0].text, /channel id:1480303286182608897/i);
});

test("skill usage tool still supports detail top output", async () => {
  const result = await executeSkillUsageTool({
    cloud: {
      async queryTopSkillsWithFallback() {
        return {
          source: "cloud",
          cloudState: "healthy",
          aggregationScope: "usage-space",
          period: { key: "7d", label: "7 days" },
          rows: [
            {
              skillId: "weather",
              skillName: "weather",
              triggerCount: 37,
              attemptCount: 37,
              installationCount: 1,
              agentCount: 4,
              accountCount: 4,
              installations: [
                {
                  installationId: "install-1",
                  installationLabel: "Fans-MacBook-Air.local",
                  triggerCount: 37,
                  attemptCount: 37,
                  agents: [
                    { agentId: "elon", agentLabel: "elon", triggerCount: 24, attemptCount: 24 },
                    { agentId: "main", agentLabel: "main", triggerCount: 10, attemptCount: 10 },
                  ],
                  accounts: [
                    { accountKey: "discord:elon", accountLabel: "Discord / elon", triggerCount: 18, attemptCount: 18 },
                    { accountKey: "whatsapp:default", accountLabel: "Whatsapp / default", triggerCount: 6, attemptCount: 6 },
                  ],
                },
              ],
            },
          ],
        };
      },
    },
    params: { action: "top", period: "7d", limit: 5, format: "detail" },
  });

  assert.match(result.content[0].text, /1\. weather - total 37 triggers, 37 attempts/);
  assert.match(result.content[0].text, /by installation:/);
  assert.match(result.content[0].text, /by agent:/);
  assert.match(result.content[0].text, /by channel account:/);
});
