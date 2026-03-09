import test from "node:test";
import assert from "node:assert/strict";
import { TiDBUsageRepository } from "../src/lib/tidb-usage-repository.js";

function createClosedStateError() {
  const error = new Error("Can't add new command when connection is in closed state");
  error.code = "PROTOCOL_ENQUEUE_AFTER_QUIT";
  return error;
}

function createMockConnection({ onQuery, onExecute, onBeginTransaction } = {}) {
  const state = {
    queryCalls: [],
    executeCalls: [],
    beginTransactionCalls: 0,
    commitCalls: 0,
    rollbackCalls: 0,
    endCalls: 0,
  };

  return {
    state,
    async query(sql, params = []) {
      state.queryCalls.push({ sql, params });
      if (onQuery) {
        return onQuery(sql, params, state);
      }
      return [[]];
    },
    async execute(sql, params = []) {
      state.executeCalls.push({ sql, params });
      if (onExecute) {
        return onExecute(sql, params, state);
      }
      return [{ affectedRows: 1 }];
    },
    async beginTransaction() {
      state.beginTransactionCalls += 1;
      if (onBeginTransaction) {
        return onBeginTransaction(state);
      }
    },
    async commit() {
      state.commitCalls += 1;
    },
    async rollback() {
      state.rollbackCalls += 1;
    },
    async end() {
      state.endCalls += 1;
    },
  };
}

function createRepositoryWithConnections(connections) {
  let index = 0;

  return {
    repository: new TiDBUsageRepository({
      zeroConfig: {
        host: "zero.example.com",
        port: 4000,
        username: "demo",
        password: "secret",
      },
      databaseName: "openclaw_skill_usage",
      connectionFactory: async () => {
        const connection = connections[index];
        index += 1;

        if (!connection) {
          throw new Error("No connection available for test.");
        }

        return connection;
      },
    }),
    getFactoryCalls() {
      return index;
    },
  };
}

test("repository reconnects and retries summary queries after a closed connection", async () => {
  let failed = false;
  const firstConnection = createMockConnection({
    onQuery(sql) {
      if (!failed && sql.includes("COUNT(*) AS totalAttempts")) {
        failed = true;
        throw createClosedStateError();
      }

      if (sql.includes("COUNT(*) AS totalAttempts")) {
        return [[{ totalAttempts: 1, totalTriggers: 1, installationCount: 1, agentCount: 1 }]];
      }

      return [[]];
    },
  });
  const secondConnection = createMockConnection({
    onQuery(sql) {
      if (sql.includes("COUNT(*) AS totalAttempts")) {
        return [
          [
            {
              totalAttempts: 4,
              totalTriggers: 3,
              installationCount: 2,
              agentCount: 2,
              accountCount: 1,
              lastObservedAt: "2026-03-09T07:00:00.000Z",
            },
          ],
        ];
      }

      return [[]];
    },
  });
  const { repository, getFactoryCalls } = createRepositoryWithConnections([
    firstConnection,
    secondConnection,
  ]);

  const summary = await repository.queryUsageSpaceSummary({
    usageSpaceId: "space-1",
  });

  assert.equal(summary.totalAttempts, 4);
  assert.equal(summary.totalTriggers, 3);
  assert.equal(summary.installationCount, 2);
  assert.equal(summary.agentCount, 2);
  assert.equal(summary.accountCount, 1);
  assert.equal(getFactoryCalls(), 2);
  assert.equal(firstConnection.state.endCalls, 1);
});

test("repository reconnects and retries writes after a closed connection", async () => {
  let failed = false;
  const firstConnection = createMockConnection({
    onBeginTransaction() {
      if (!failed) {
        failed = true;
        throw createClosedStateError();
      }
    },
  });
  const secondConnection = createMockConnection();
  const { repository, getFactoryCalls } = createRepositoryWithConnections([
    firstConnection,
    secondConnection,
  ]);

  const result = await repository.upsertEvents([
    {
      recordKey: "record-1",
      eventKey: "event-1",
      attempts: 1,
      firstTrigger: true,
      usageSpaceId: "space-1",
      installationId: "install-1",
      agentId: "odin",
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "session-key-1",
      sessionScope: "main",
      turnId: "turn-1",
      messageId: "message-1",
      requestId: "request-1",
      channelId: "channel-1",
      botKey: "discord:123",
      botLabel: "Discord / @team-bot",
      botPlatform: "discord",
      skillId: "git-pr",
      skillName: "git-pr",
      skillSource: "user",
      status: "ok",
      latencyMs: 5,
      observedAt: "2026-03-09T07:00:00.000Z",
      firstObservedAt: "2026-03-09T07:00:00.000Z",
      triggerAnchor: "turn-1",
    },
  ]);

  assert.equal(result.uploaded, 1);
  assert.equal(getFactoryCalls(), 2);
  assert.equal(firstConnection.state.endCalls, 1);
  assert.equal(secondConnection.state.beginTransactionCalls, 1);
  assert.equal(secondConnection.state.commitCalls, 1);
});
