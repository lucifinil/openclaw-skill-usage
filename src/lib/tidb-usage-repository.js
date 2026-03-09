function escapeIdentifier(identifier) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(
      `Invalid database identifier "${identifier}". Use letters, numbers, and underscores only.`,
    );
  }

  return `\`${identifier}\``;
}

const RETRYABLE_CONNECTION_ERROR_CODES = new Set([
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "PROTOCOL_ENQUEUE_AFTER_QUIT",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
]);

function isRetryableConnectionError(error) {
  if (!error) {
    return false;
  }

  if (typeof error.code === "string" && RETRYABLE_CONNECTION_ERROR_CODES.has(error.code)) {
    return true;
  }

  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";

  return (
    message.includes("closed state") ||
    message.includes("connection is closed") ||
    message.includes("connection closed") ||
    message.includes("connection lost") ||
    message.includes("server has gone away") ||
    message.includes("broken pipe") ||
    message.includes("cannot enqueue")
  );
}

function buildMysqlConfig(zeroConfig) {
  return {
    host: zeroConfig.host,
    port: zeroConfig.port,
    user: zeroConfig.username,
    password: zeroConfig.password,
    ssl: {
      minVersion: "TLSv1.2",
    },
    enableKeepAlive: true,
    connectTimeout: 10_000,
  };
}

async function defaultConnectionFactory(zeroConfig) {
  const mysql = await import("mysql2/promise");
  const createConnection = mysql.createConnection ?? mysql.default?.createConnection;

  if (typeof createConnection !== "function") {
    throw new Error("mysql2/promise did not expose createConnection.");
  }

  return createConnection(buildMysqlConfig(zeroConfig));
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function sqlValue(value) {
  return value === undefined ? null : value;
}

function periodToSql(periodKey) {
  switch (periodKey) {
    case "1d":
      return {
        label: "1 day",
        where: "AND observed_at >= (UTC_TIMESTAMP() - INTERVAL 1 DAY)",
      };
    case "7d":
      return {
        label: "7 days",
        where: "AND observed_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY)",
      };
    case "30d":
      return {
        label: "30 days",
        where: "AND observed_at >= (UTC_TIMESTAMP() - INTERVAL 30 DAY)",
      };
    case "all":
      return {
        label: "all time",
        where: "",
      };
    default:
      throw new Error(`Unsupported period "${periodKey}". Use 1d, 7d, 30d, or all.`);
  }
}

function sortInstallations(left, right) {
  return (
    right.triggerCount - left.triggerCount ||
    right.attemptCount - left.attemptCount ||
    left.installationLabel.localeCompare(right.installationLabel)
  );
}

function sortBots(left, right) {
  return (
    right.triggerCount - left.triggerCount ||
    right.attemptCount - left.attemptCount ||
    (left.accountLabel ?? left.botLabel).localeCompare(right.accountLabel ?? right.botLabel)
  );
}

function sortAgents(left, right) {
  return (
    right.triggerCount - left.triggerCount ||
    right.attemptCount - left.attemptCount ||
    left.agentLabel.localeCompare(right.agentLabel)
  );
}

export class TiDBUsageRepository {
  constructor({ zeroConfig, databaseName, connectionFactory = defaultConnectionFactory }) {
    this.zeroConfig = zeroConfig;
    this.databaseName = databaseName;
    this.connectionFactory = connectionFactory;
    this.connection = null;
    this.ready = false;
    this.initializing = null;
  }

  async initialize() {
    if (this.ready && this.connection) {
      return;
    }

    if (!this.initializing) {
      this.initializing = (async () => {
        this.connection = await this.connectionFactory(this.zeroConfig);
        const databaseIdentifier = escapeIdentifier(this.databaseName);

        await this.connection.query(`CREATE DATABASE IF NOT EXISTS ${databaseIdentifier}`);
        await this.connection.query(`USE ${databaseIdentifier}`);
        await this.connection.query(
          `CREATE TABLE IF NOT EXISTS usage_spaces (
            usage_space_id VARCHAR(64) PRIMARY KEY,
            created_by_installation_id VARCHAR(64) NOT NULL,
            instance_id VARCHAR(128) NOT NULL,
            claim_url TEXT NULL,
            expires_at DATETIME(6) NULL,
            source VARCHAR(16) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          )`,
        );
        await this.connection.query(
          `CREATE TABLE IF NOT EXISTS usage_space_installations (
            usage_space_id VARCHAR(64) NOT NULL,
            installation_id VARCHAR(64) NOT NULL,
            installation_label VARCHAR(191) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (usage_space_id, installation_id),
            KEY idx_usage_space_installation_label (usage_space_id, installation_label)
          )`,
        );
        await this.connection.query(
          `CREATE TABLE IF NOT EXISTS skill_usage_events (
            record_key VARCHAR(80) PRIMARY KEY,
            event_key VARCHAR(64) NOT NULL,
            attempts INT NOT NULL,
            first_trigger BOOLEAN NOT NULL,
            usage_space_id VARCHAR(64) NOT NULL,
            installation_id VARCHAR(64) NOT NULL,
            agent_id VARCHAR(191) NULL,
            run_id VARCHAR(191) NULL,
            session_id VARCHAR(191) NULL,
            session_key VARCHAR(191) NULL,
            session_scope VARCHAR(32) NOT NULL,
            turn_id VARCHAR(191) NULL,
            message_id VARCHAR(191) NULL,
            request_id VARCHAR(191) NULL,
            channel_id VARCHAR(191) NULL,
            bot_key VARCHAR(255) NULL,
            bot_label VARCHAR(255) NULL,
            bot_platform VARCHAR(64) NULL,
            skill_id VARCHAR(191) NOT NULL,
            skill_name VARCHAR(255) NOT NULL,
            skill_source VARCHAR(32) NOT NULL,
            status VARCHAR(16) NOT NULL,
            latency_ms BIGINT NULL,
            observed_at DATETIME(6) NOT NULL,
            first_observed_at DATETIME(6) NULL,
            trigger_anchor VARCHAR(191) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY ux_event_attempt (event_key, attempts),
            KEY idx_usage_space_period (usage_space_id, observed_at),
            KEY idx_usage_space_skill_period (usage_space_id, skill_id, observed_at),
            KEY idx_usage_space_bot_period (usage_space_id, bot_key, observed_at),
            KEY idx_installation_period (installation_id, observed_at),
            KEY idx_agent_period (agent_id, observed_at),
            KEY idx_session_scope_period (session_scope, observed_at)
          )`,
        );
        await this.connection.query(
          `ALTER TABLE skill_usage_events
            ADD COLUMN IF NOT EXISTS bot_key VARCHAR(255) NULL`,
        );
        await this.connection.query(
          `ALTER TABLE skill_usage_events
            ADD COLUMN IF NOT EXISTS bot_label VARCHAR(255) NULL`,
        );
        await this.connection.query(
          `ALTER TABLE skill_usage_events
            ADD COLUMN IF NOT EXISTS bot_platform VARCHAR(64) NULL`,
        );
        await this.connection.query(
          `ALTER TABLE skill_usage_events
            ADD INDEX IF NOT EXISTS idx_usage_space_bot_period (usage_space_id, bot_key, observed_at)`,
        );

        this.ready = true;
      })().finally(() => {
        this.initializing = null;
      });
    }

    await this.initializing;
  }

  async resetConnection() {
    const connection = this.connection;
    this.connection = null;
    this.ready = false;
    this.initializing = null;

    if (!connection) {
      return;
    }

    try {
      await connection.end();
    } catch {}
  }

  async withReconnect(operation) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.initialize();
        return await operation(this.connection);
      } catch (error) {
        if (!isRetryableConnectionError(error) || attempt === 1) {
          throw error;
        }

        await this.resetConnection();
      }
    }
  }

  async ensureUsageSpace({ usageSpaceId, installationId, zeroConfig, source }) {
    await this.withReconnect(async (connection) =>
      connection.execute(
        `INSERT INTO usage_spaces (
          usage_space_id,
          created_by_installation_id,
          instance_id,
          claim_url,
          expires_at,
          source
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          instance_id = VALUES(instance_id),
          claim_url = VALUES(claim_url),
          expires_at = VALUES(expires_at),
          source = VALUES(source)`,
        [
          sqlValue(usageSpaceId),
          sqlValue(installationId),
          sqlValue(zeroConfig.instanceId),
          sqlValue(zeroConfig.claimUrl),
          sqlValue(normalizeDate(zeroConfig.expiresAt)),
          sqlValue(source),
        ],
      ),
    );
  }

  async ensureInstallationMember({ usageSpaceId, installationId, installationLabel }) {
    await this.withReconnect(async (connection) =>
      connection.execute(
        `INSERT INTO usage_space_installations (
          usage_space_id,
          installation_id,
          installation_label
        ) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE
          installation_label = VALUES(installation_label)`,
        [sqlValue(usageSpaceId), sqlValue(installationId), sqlValue(installationLabel)],
      ),
    );
  }

  async upsertEvents(events) {
    if (events.length === 0) {
      return {
        uploaded: 0,
      };
    }

    return this.withReconnect(async (connection) => {
      await connection.beginTransaction();

      try {
        for (const event of events) {
          await connection.execute(
            `INSERT INTO skill_usage_events (
              record_key,
              event_key,
              attempts,
              first_trigger,
              usage_space_id,
              installation_id,
              agent_id,
              run_id,
              session_id,
              session_key,
              session_scope,
              turn_id,
              message_id,
              request_id,
              channel_id,
              bot_key,
              bot_label,
              bot_platform,
              skill_id,
              skill_name,
              skill_source,
              status,
              latency_ms,
              observed_at,
              first_observed_at,
              trigger_anchor
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              record_key = record_key`,
            [
              sqlValue(event.recordKey),
              sqlValue(event.eventKey),
              sqlValue(event.attempts),
              sqlValue(event.firstTrigger),
              sqlValue(event.usageSpaceId),
              sqlValue(event.installationId),
              sqlValue(event.agentId),
              sqlValue(event.runId),
              sqlValue(event.sessionId),
              sqlValue(event.sessionKey),
              sqlValue(event.sessionScope),
              sqlValue(event.turnId),
              sqlValue(event.messageId),
              sqlValue(event.requestId),
              sqlValue(event.channelId),
              sqlValue(event.botKey),
              sqlValue(event.botLabel),
              sqlValue(event.botPlatform),
              sqlValue(event.skillId),
              sqlValue(event.skillName),
              sqlValue(event.skillSource),
              sqlValue(event.status),
              sqlValue(event.latencyMs),
              sqlValue(normalizeDate(event.observedAt)),
              sqlValue(normalizeDate(event.firstObservedAt)),
              sqlValue(event.triggerAnchor),
            ],
          );
        }

        await connection.commit();
      } catch (error) {
        try {
          await connection.rollback();
        } catch {}
        throw error;
      }

      return {
        uploaded: events.length,
      };
    });
  }

  async queryTopSkills({ usageSpaceId, periodKey, limit = 20 }) {
    return this.withReconnect(async (connection) => {
      const period = periodToSql(periodKey);
      const [rows] = await connection.query(
        `SELECT
          skill_id AS skillId,
          MAX(skill_name) AS skillName,
          SUM(CASE WHEN first_trigger THEN 1 ELSE 0 END) AS triggerCount,
          COUNT(*) AS attemptCount,
          COUNT(DISTINCT installation_id) AS installationCount,
          COUNT(DISTINCT agent_id) AS agentCount,
          COUNT(DISTINCT bot_key) AS accountCount,
          COUNT(DISTINCT CASE WHEN session_scope = 'subagent' THEN COALESCE(NULLIF(run_id, ''), NULLIF(session_key, ''), NULLIF(session_id, ''), NULLIF(trigger_anchor, '')) END) AS subagentRunCount
        FROM skill_usage_events
        WHERE usage_space_id = ?
        ${period.where}
        GROUP BY skill_id
        ORDER BY triggerCount DESC, attemptCount DESC, skillName ASC
        LIMIT ?`,
        [usageSpaceId, limit],
      );

      if (rows.length === 0) {
        return {
          period,
          rows: [],
        };
      }

      const skillIds = rows.map((row) => row.skillId);
      const placeholders = skillIds.map(() => "?").join(", ");
      const [installationRows] = await connection.query(
        `SELECT
          skill_usage_events.skill_id AS skillId,
          skill_usage_events.installation_id AS installationId,
          COALESCE(usage_space_installations.installation_label, skill_usage_events.installation_id) AS installationLabel,
          SUM(CASE WHEN skill_usage_events.first_trigger THEN 1 ELSE 0 END) AS triggerCount,
          COUNT(*) AS attemptCount,
          SUM(CASE WHEN skill_usage_events.first_trigger AND skill_usage_events.session_scope = 'subagent' THEN 1 ELSE 0 END) AS subagentTriggerCount,
          SUM(CASE WHEN skill_usage_events.first_trigger AND skill_usage_events.session_scope <> 'subagent' THEN 1 ELSE 0 END) AS mainTriggerCount
        FROM skill_usage_events
        LEFT JOIN usage_space_installations
          ON usage_space_installations.usage_space_id = skill_usage_events.usage_space_id
          AND usage_space_installations.installation_id = skill_usage_events.installation_id
        WHERE skill_usage_events.usage_space_id = ?
        ${period.where}
        AND skill_usage_events.skill_id IN (${placeholders})
        GROUP BY
          skill_usage_events.skill_id,
          skill_usage_events.installation_id,
          COALESCE(usage_space_installations.installation_label, skill_usage_events.installation_id)
        ORDER BY triggerCount DESC, attemptCount DESC, installationLabel ASC`,
        [usageSpaceId, ...skillIds],
      );
      const installationsBySkill = new Map();
      const installationLookup = new Map();

      installationRows.forEach((row) => {
        const current = installationsBySkill.get(row.skillId) ?? [];
        const installation = {
          installationId: row.installationId,
          installationLabel: row.installationLabel,
          triggerCount: Number(row.triggerCount ?? 0),
          attemptCount: Number(row.attemptCount ?? 0),
          mainTriggerCount: Number(row.mainTriggerCount ?? 0),
          subagentTriggerCount: Number(row.subagentTriggerCount ?? 0),
          agents: [],
          accounts: [],
        };
        current.push(installation);
        installationsBySkill.set(row.skillId, current);
        installationLookup.set(`${row.skillId}:${row.installationId}`, installation);
      });
      const [agentRows] = await connection.query(
        `SELECT
          skill_id AS skillId,
          installation_id AS installationId,
          agent_id AS agentId,
          agent_id AS agentLabel,
          SUM(CASE WHEN first_trigger THEN 1 ELSE 0 END) AS triggerCount,
          COUNT(*) AS attemptCount
        FROM skill_usage_events
        WHERE usage_space_id = ?
        ${period.where}
        AND skill_id IN (${placeholders})
        AND agent_id IS NOT NULL
        GROUP BY skill_id, installation_id, agent_id
        ORDER BY triggerCount DESC, attemptCount DESC, agentLabel ASC`,
        [usageSpaceId, ...skillIds],
      );
      const [botRows] = await connection.query(
        `SELECT
          skill_id AS skillId,
          installation_id AS installationId,
          bot_key AS botKey,
          MAX(COALESCE(bot_label, bot_key)) AS botLabel,
          MAX(bot_platform) AS botPlatform,
          SUM(CASE WHEN first_trigger THEN 1 ELSE 0 END) AS triggerCount,
          COUNT(*) AS attemptCount,
          SUM(CASE WHEN first_trigger AND session_scope = 'subagent' THEN 1 ELSE 0 END) AS subagentTriggerCount,
          SUM(CASE WHEN first_trigger AND session_scope <> 'subagent' THEN 1 ELSE 0 END) AS mainTriggerCount
        FROM skill_usage_events
        WHERE usage_space_id = ?
        ${period.where}
        AND skill_id IN (${placeholders})
        AND bot_key IS NOT NULL
        GROUP BY skill_id, installation_id, bot_key
        ORDER BY triggerCount DESC, attemptCount DESC, botLabel ASC`,
        [usageSpaceId, ...skillIds],
      );

      agentRows.forEach((row) => {
        const installation = installationLookup.get(`${row.skillId}:${row.installationId}`);

        if (!installation) {
          return;
        }

        installation.agents.push({
          agentId: row.agentId,
          agentLabel: row.agentLabel,
          triggerCount: Number(row.triggerCount ?? 0),
          attemptCount: Number(row.attemptCount ?? 0),
        });
      });

      botRows.forEach((row) => {
        const installation = installationLookup.get(`${row.skillId}:${row.installationId}`);

        if (!installation) {
          return;
        }

        installation.accounts.push({
          accountKey: row.botKey,
          accountLabel: row.botLabel,
          accountPlatform: row.botPlatform,
          triggerCount: Number(row.triggerCount ?? 0),
          attemptCount: Number(row.attemptCount ?? 0),
          mainTriggerCount: Number(row.mainTriggerCount ?? 0),
          subagentTriggerCount: Number(row.subagentTriggerCount ?? 0),
        });
      });

      return {
        period,
        rows: rows.map((row) => ({
          skillId: row.skillId,
          skillName: row.skillName,
          triggerCount: Number(row.triggerCount ?? 0),
          attemptCount: Number(row.attemptCount ?? 0),
          installationCount: Number(row.installationCount ?? 0),
          agentCount: Number(row.agentCount ?? 0),
          accountCount: Number(row.accountCount ?? 0),
          subagentRunCount: Number(row.subagentRunCount ?? 0),
          installations: (installationsBySkill.get(row.skillId) ?? [])
            .map((installation) => ({
              ...installation,
              agents: installation.agents.sort(sortAgents),
              accounts: installation.accounts.sort(sortBots),
            }))
            .sort(sortInstallations),
        })),
      };
    });
  }

  async queryUsageSpaceSummary({ usageSpaceId }) {
    return this.withReconnect(async (connection) => {
      const [rows] = await connection.query(
        `SELECT
          COUNT(*) AS totalAttempts,
          SUM(CASE WHEN first_trigger THEN 1 ELSE 0 END) AS totalTriggers,
          COUNT(DISTINCT installation_id) AS installationCount,
          COUNT(DISTINCT agent_id) AS agentCount,
          COUNT(DISTINCT bot_key) AS accountCount,
          COUNT(DISTINCT CASE WHEN session_scope = 'subagent' THEN COALESCE(NULLIF(run_id, ''), NULLIF(session_key, ''), NULLIF(session_id, ''), NULLIF(trigger_anchor, '')) END) AS subagentRunCount,
          MAX(observed_at) AS lastObservedAt
        FROM skill_usage_events
        WHERE usage_space_id = ?`,
        [usageSpaceId],
      );
      const row = rows[0] ?? {};

      return {
        totalAttempts: Number(row.totalAttempts ?? 0),
        totalTriggers: Number(row.totalTriggers ?? 0),
        installationCount: Number(row.installationCount ?? 0),
        agentCount: Number(row.agentCount ?? 0),
        accountCount: Number(row.accountCount ?? 0),
        subagentRunCount: Number(row.subagentRunCount ?? 0),
        lastObservedAt: normalizeDate(row.lastObservedAt),
      };
    });
  }

  async deleteInstallationData({ usageSpaceId, installationId }) {
    await this.withReconnect(async (connection) =>
      connection.execute(`DELETE FROM skill_usage_events WHERE usage_space_id = ? AND installation_id = ?`, [
        usageSpaceId,
        installationId,
      ]),
    );
  }

  async deleteUsageSpaceData({ usageSpaceId }) {
    await this.withReconnect(async (connection) =>
      connection.execute(`DELETE FROM skill_usage_events WHERE usage_space_id = ?`, [usageSpaceId]),
    );
  }

  async close() {
    await this.resetConnection();
  }
}
