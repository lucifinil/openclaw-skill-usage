import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readJson, writeJsonAtomic } from "./plugin-config.js";
import { TiDBUsageRepository } from "./tidb-usage-repository.js";
import { encodeUsageSpaceToken, decodeUsageSpaceToken } from "./usage-space-token.js";
import { provisionZeroInstance } from "./zero-client.js";
import { LocalUsageAnalytics } from "./local-usage-analytics.js";
import { enrichEventsWithResolver } from "./event-enricher.js";

function noop() {}

function sortInstallations(left, right) {
  return (
    right.triggerCount - left.triggerCount ||
    right.attemptCount - left.attemptCount ||
    left.installationLabel.localeCompare(right.installationLabel)
  );
}

function mergeInstallationsForDisplay(baseInstallations = [], localInstallations = []) {
  const localById = new Map(localInstallations.map((item) => [item.installationId, item]));
  return baseInstallations.map((installation) => {
    const local = localById.get(installation.installationId);
    if (!local) {
      return installation;
    }
    const needsAgents = !Array.isArray(installation.agents) || installation.agents.length === 0;
    const needsAccounts = !Array.isArray(installation.accounts) || installation.accounts.length === 0;
    return {
      ...installation,
      agents: needsAgents ? (local.agents ?? installation.agents ?? []) : installation.agents,
      accounts: needsAccounts ? (local.accounts ?? installation.accounts ?? []) : installation.accounts,
    };
  });
}

function mergeTopResultForDisplay(baseResult, localResult) {
  const localRows = localResult?.rows ?? [];
  const baseRows = baseResult?.rows ?? [];
  const localBySkillId = new Map(localRows.map((row) => [row.skillId, row]));
  const mergedRows = baseRows.map((row) => {
    const local = localBySkillId.get(row.skillId);
    if (!local) {
      return row;
    }
    const hasCloudBreakdown =
      (row.agentCount ?? 0) > 0 ||
      (row.accountCount ?? 0) > 0 ||
      (row.installations ?? []).some((item) => (item.agents ?? []).length > 0 || (item.accounts ?? []).length > 0);
    const divergentTotals =
      row.triggerCount !== local.triggerCount ||
      row.attemptCount !== local.attemptCount ||
      row.installationCount !== local.installationCount;

    if (!hasCloudBreakdown && divergentTotals) {
      return {
        ...local,
        source: row.source ?? local.source,
      };
    }

    const needsAgents = !row.agentCount || !(row.installations ?? []).some((item) => (item.agents ?? []).length > 0);
    const needsAccounts = !row.accountCount || !(row.installations ?? []).some((item) => (item.accounts ?? []).length > 0);
    return {
      ...row,
      agentCount: needsAgents ? local.agentCount : row.agentCount,
      accountCount: needsAccounts ? local.accountCount : row.accountCount,
      installations: mergeInstallationsForDisplay(row.installations ?? [], local.installations ?? []),
    };
  });

  const mergedIds = new Set(mergedRows.map((row) => row.skillId));
  const localOnlyRows = localRows.filter((row) => !mergedIds.has(row.skillId));

  return {
    ...baseResult,
    rows: [...mergedRows, ...localOnlyRows]
      .sort(
        (left, right) =>
          right.triggerCount - left.triggerCount ||
          right.attemptCount - left.attemptCount ||
          left.skillName.localeCompare(right.skillName),
      )
      .slice(0, baseRows.length > 0 ? Math.max(baseRows.length, localRows.length) : localRows.length),
  };
}

function hashRecordKey(eventKey, attempts) {
  return createHash("sha256").update(`${eventKey}:${attempts}`).digest("hex");
}

function aggregateTopRows(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const current = grouped.get(row.skillId) ?? {
      skillId: row.skillId,
      skillName: row.skillName,
      triggerCount: 0,
      attemptCount: 0,
      installationCount: 0,
      agentCount: 0,
      accountCount: 0,
      subagentRunCount: 0,
      installations: [],
    };
    current.triggerCount += Number(row.triggerCount ?? 0);
    current.attemptCount += Number(row.attemptCount ?? 0);
    current.installations.push(...(row.installations ?? []));
    grouped.set(row.skillId, current);
  }

  return Array.from(grouped.values()).map((row) => {
    const installationIds = new Set();
    const agentIds = new Set();
    const accountKeys = new Set();
    let subagentRunCount = 0;
    for (const installation of row.installations) {
      if (installation?.installationId) installationIds.add(installation.installationId);
      for (const agent of installation?.agents ?? []) {
        if (agent?.agentId) agentIds.add(agent.agentId);
      }
      for (const account of installation?.accounts ?? []) {
        if (account?.accountKey) accountKeys.add(account.accountKey);
      }
      subagentRunCount += Number(installation?.subagentTriggerCount ?? 0) > 0 ? 1 : 0;
    }
    return {
      ...row,
      installationCount: installationIds.size,
      agentCount: agentIds.size,
      accountCount: accountKeys.size,
      subagentRunCount,
      installations: row.installations.sort(sortInstallations),
    };
  }).sort((left, right) =>
    right.triggerCount - left.triggerCount ||
    right.attemptCount - left.attemptCount ||
    left.skillName.localeCompare(right.skillName),
  );
}

function defaultCloudState({ installationId, databaseName }) {
  return {
    version: 2,
    databaseName,
    usageSpace: {
      id: installationId,
      source: "local",
    },
    zero: null,
    provisioning: null,
    sync: defaultSyncState({
      usageSpaceId: installationId,
    }),
  };
}

function defaultSyncState({ usageSpaceId }) {
  return {
    usageSpaceId,
    checkpointOffset: 0,
    lastSuccessfulSyncAt: null,
    lastUploadedCount: 0,
    lastError: null,
    lastErrorAt: null,
  };
}

function isActiveZeroInstance(zeroConfig) {
  if (!zeroConfig?.expiresAt) {
    return Boolean(zeroConfig);
  }

  const expiresAt = new Date(zeroConfig.expiresAt);

  if (Number.isNaN(expiresAt.getTime())) {
    return Boolean(zeroConfig);
  }

  return expiresAt.getTime() > Date.now();
}

export class SkillUsageCloud {
  constructor({
    stateDir,
    installationIdentity,
    store,
    options,
    logger,
    fetchImpl = globalThis.fetch,
    repositoryFactory,
    eventResolver = null,
    transcriptScanner = null,
  }) {
    this.stateDir = stateDir;
    this.installationIdentity = installationIdentity;
    this.store = store;
    this.options = options;
    this.logger = logger ?? {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    };
    this.fetchImpl = fetchImpl;
    this.repositoryFactory =
      repositoryFactory ??
      ((config) =>
        new TiDBUsageRepository({
          zeroConfig: config.zero,
          databaseName: config.databaseName,
        }));
    this.cloudStatePath = path.join(stateDir, "cloud.json");
    this.cloudState = null;
    this.repository = null;
    this.repositoryKey = null;
    this.syncQueue = Promise.resolve();
    this.localAnalytics = new LocalUsageAnalytics({
      store: this.store,
      eventResolver,
      transcriptScanner,
    });
  }

  async initialize() {
    if (this.cloudState) {
      return;
    }

    await mkdir(this.stateDir, { recursive: true });

    const existing =
      (await readJson(this.cloudStatePath)) ??
      defaultCloudState({
        installationId: this.installationIdentity.installationId,
        databaseName: this.options.databaseName,
      });

    if (!existing.databaseName) {
      existing.databaseName = this.options.databaseName;
    }

    if (!existing.usageSpace?.id) {
      existing.usageSpace = {
        id: this.installationIdentity.installationId,
        source: "local",
      };
    }

    if (!existing.sync || typeof existing.sync !== "object") {
      existing.sync = defaultSyncState({
        usageSpaceId: existing.usageSpace.id,
      });
    }

    if (existing.sync.usageSpaceId !== existing.usageSpace.id) {
      existing.sync = defaultSyncState({
        usageSpaceId: existing.usageSpace.id,
      });
    }

    this.cloudState = existing;
    await this.persist();
  }

  async persist() {
    await writeJsonAtomic(this.cloudStatePath, this.cloudState);
  }

  async ensureZeroInstance() {
    await this.initialize();

    if (this.cloudState.zero && isActiveZeroInstance(this.cloudState.zero)) {
      return this.cloudState.zero;
    }

    if (this.cloudState.zero?.source === "joined" && !isActiveZeroInstance(this.cloudState.zero)) {
      throw new Error(
        "The joined TiDB Cloud Zero instance has expired. Ask for a fresh join token or run /skillusage leave.",
      );
    }

    const idempotencyKey =
      this.cloudState.provisioning?.idempotencyKey ??
      `openclaw-skill-usage-${this.installationIdentity.installationId}-${randomUUID()}`;

    if (!this.cloudState.provisioning?.idempotencyKey) {
      this.cloudState.provisioning = {
        idempotencyKey,
      };
      await this.persist();
    }

    const zero = await provisionZeroInstance({
      tag: this.options.provisionTag,
      idempotencyKey,
      fetchImpl: this.fetchImpl,
    });

    this.cloudState.zero = zero;
    this.cloudState.provisioning = null;

    if (this.cloudState.usageSpace.source !== "joined") {
      this.cloudState.usageSpace = {
        id: this.installationIdentity.installationId,
        source: "local",
      };
    }

    await this.persist();
    return zero;
  }

  async getRepository() {
    const zero = await this.ensureZeroInstance();
    const repositoryKey = `${zero.instanceId}:${this.cloudState.databaseName}`;

    if (this.repository && this.repositoryKey === repositoryKey) {
      return this.repository;
    }

    if (this.repository) {
      await this.repository.close();
    }

    this.repository = this.repositoryFactory({
      zero,
      databaseName: this.cloudState.databaseName,
    });
    this.repositoryKey = repositoryKey;
    return this.repository;
  }

  resetSyncState({ usageSpaceId = this.cloudState?.usageSpace?.id ?? this.installationIdentity.installationId } = {}) {
    this.cloudState.sync = defaultSyncState({
      usageSpaceId,
    });
  }

  getSyncCheckpointOffset() {
    if (this.cloudState.sync?.usageSpaceId !== this.cloudState.usageSpace.id) {
      return 0;
    }

    return Math.max(0, Number(this.cloudState.sync?.checkpointOffset ?? 0));
  }

  async buildCloudEvents({ forceFull = false } = {}) {
    const checkpointOffset = forceFull ? 0 : this.getSyncCheckpointOffset();
    const { events, nextOffset } = await this.store.readEventsFromOffset(checkpointOffset);
    const enrichedEvents = await enrichEventsWithResolver(events, this.localAnalytics?.eventResolver ?? null);

    return {
      checkpointOffset,
      nextOffset,
      events: enrichedEvents.map((event) => ({
        ...event,
        usageSpaceId: this.cloudState.usageSpace.id,
        recordKey: hashRecordKey(event.eventKey, event.attempts),
        installationLabel: event.installationLabel ?? this.installationIdentity.installationLabel,
      })),
    };
  }

  async buildTopSnapshots() {
    const periods = ["1d", "7d", "30d", "all"];
    const snapshots = [];
    try {
      for (const periodKey of periods) {
        const result = await this.localAnalytics.queryTopSkills({
          periodKey,
          limit: 100,
          usageSpaceId: this.cloudState.usageSpace.id,
          usageSpaceSource: this.cloudState.usageSpace.source,
          cloudState: "healthy",
        });
        snapshots.push({
          usageSpaceId: this.cloudState.usageSpace.id,
          installationId: this.installationIdentity.installationId,
          installationLabel: this.installationIdentity.installationLabel,
          periodKey,
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          payload: {
            period: result.period,
            rows: result.rows,
          },
        });
      }
    } catch (error) {
      this.logger.warn?.(`Skill usage snapshot build skipped: ${error.message}`);
      return [];
    }
    return snapshots;
  }

  async getPendingLocalRecordCount() {
    await this.initialize();
    const checkpointOffset = this.getSyncCheckpointOffset();
    const { count } = await this.store.countEventsFromOffset(checkpointOffset);
    return count;
  }

  async markSyncSuccess({ nextOffset, uploaded }) {
    this.cloudState.sync = {
      usageSpaceId: this.cloudState.usageSpace.id,
      checkpointOffset: nextOffset,
      lastSuccessfulSyncAt: new Date().toISOString(),
      lastUploadedCount: uploaded,
      lastError: null,
      lastErrorAt: null,
    };
    await this.persist();
  }

  async markSyncError(error) {
    const message = error instanceof Error ? error.message : String(error);
    this.cloudState.sync = {
      ...(this.cloudState.sync ?? defaultSyncState({ usageSpaceId: this.cloudState.usageSpace.id })),
      usageSpaceId: this.cloudState.usageSpace.id,
      lastError: message,
      lastErrorAt: new Date().toISOString(),
    };
    await this.persist();
  }

  async getSyncStatus() {
    await this.initialize();
    return {
      lastSuccessfulSyncAt: this.cloudState.sync?.lastSuccessfulSyncAt ?? null,
      lastUploadedCount: Number(this.cloudState.sync?.lastUploadedCount ?? 0),
      lastError: this.cloudState.sync?.lastError ?? null,
      lastErrorAt: this.cloudState.sync?.lastErrorAt ?? null,
      pendingLocalRecordCount: await this.getPendingLocalRecordCount(),
    };
  }

  async syncAll({ forceFull = false } = {}) {
    await this.initialize();
    const repository = await this.getRepository();
    const batch = await this.buildCloudEvents({ forceFull });

    try {
      await repository.ensureUsageSpace({
        usageSpaceId: this.cloudState.usageSpace.id,
        installationId: this.installationIdentity.installationId,
        zeroConfig: this.cloudState.zero,
        source: this.cloudState.usageSpace.source,
      });
      await repository.ensureInstallationMember({
        usageSpaceId: this.cloudState.usageSpace.id,
        installationId: this.installationIdentity.installationId,
        installationLabel: this.installationIdentity.installationLabel,
      });

      const syncResult = await repository.upsertEvents(batch.events);
      const snapshots = await this.buildTopSnapshots();
      if (typeof repository.upsertTopSnapshots === "function") {
        await repository.upsertTopSnapshots(snapshots);
      }
      const summary = await repository.queryUsageSpaceSummary({
        usageSpaceId: this.cloudState.usageSpace.id,
      });
      await this.markSyncSuccess({
        nextOffset: batch.nextOffset,
        uploaded: syncResult.uploaded,
      });

      return {
        ...syncResult,
        summary,
        usageSpaceId: this.cloudState.usageSpace.id,
        zero: this.cloudState.zero,
        sync: await this.getSyncStatus(),
      };
    } catch (error) {
      await this.markSyncError(error);
      throw error;
    }
  }

  async queryTopSkillsWithFallback({ periodKey = "all", limit = 10 } = {}) {
    try {
      const result = await this.queryTopSkills({
        periodKey,
        limit,
      });
      const localResult = await this.localAnalytics.queryTopSkills({
        periodKey,
        limit,
        usageSpaceId: this.cloudState.usageSpace.id,
        usageSpaceSource: this.cloudState.usageSpace.source,
        cloudState: "healthy",
      });
      const merged = mergeTopResultForDisplay(result, localResult);

      return {
        ...merged,
        source: "cloud",
        cloudState: "healthy",
        aggregationScope: "usage-space",
        degradedReason: null,
        usageSpaceId: this.cloudState.usageSpace.id,
        usageSpaceSource: this.cloudState.usageSpace.source,
      };
    } catch (error) {
      await this.initialize();

      return this.localAnalytics.queryTopSkills({
        periodKey,
        limit,
        usageSpaceId: this.cloudState.usageSpace.id,
        usageSpaceSource: this.cloudState.usageSpace.source,
        degradedReason: error.message,
        cloudState: this.cloudState.zero ? "degraded" : "local-only",
      });
    }
  }

  enqueueSync(reason = "event") {
    this.syncQueue = this.syncQueue
      .then(async () => this.syncAll())
      .catch((error) => {
        this.logger.warn?.(`Skill usage cloud sync failed during ${reason}: ${error.message}`);
      });

    return this.syncQueue;
  }

  async flush() {
    await this.syncQueue;
  }

  async queryTopSkills({ periodKey = "all", limit = 10 } = {}) {
    await this.syncAll();
    const repository = await this.getRepository();

    if (
      this.cloudState?.usageSpace?.source === "joined" &&
      typeof repository.queryTopSnapshots === "function"
    ) {
      const snapshots = await repository.queryTopSnapshots({
        usageSpaceId: this.cloudState.usageSpace.id,
        periodKey,
      });
      if (Array.isArray(snapshots) && snapshots.length > 0) {
        const rows = aggregateTopRows(snapshots.flatMap((snapshot) => snapshot?.payload?.rows ?? [])).slice(0, limit);
        return {
          period: snapshots[0]?.payload?.period ?? { key: periodKey, label: periodKey },
          rows,
        };
      }
    }

    const eventResult = await repository.queryTopSkills({
      usageSpaceId: this.cloudState.usageSpace.id,
      periodKey,
      limit,
    });
    return eventResult;
  }

  async getStatus() {
    await this.initialize();
    const sync = await this.syncAll();

    return {
      usageSpaceId: this.cloudState.usageSpace.id,
      usageSpaceSource: this.cloudState.usageSpace.source,
      installationLabel: this.installationIdentity.installationLabel,
      databaseName: this.cloudState.databaseName,
      zero: this.cloudState.zero,
      summary: sync.summary,
      sync: sync.sync,
    };
  }

  async getStatusWithFallback() {
    try {
      const status = await this.getStatus();

      return {
        ...status,
        source: "cloud",
        cloudState: "healthy",
        aggregationScope: "usage-space",
        degradedReason: null,
      };
    } catch (error) {
      await this.initialize();
      await this.markSyncError(error);

      const localStatus = await this.localAnalytics.querySummary({
        usageSpaceId: this.cloudState.usageSpace.id,
        usageSpaceSource: this.cloudState.usageSpace.source,
        installationLabel: this.installationIdentity.installationLabel,
        databaseName: this.cloudState.databaseName,
        zero: this.cloudState.zero,
        degradedReason: error.message,
        cloudState: this.cloudState.zero ? "degraded" : "local-only",
      });

      return {
        ...localStatus,
        sync: await this.getSyncStatus(),
      };
    }
  }

  async createJoinToken() {
    await this.initialize();
    await this.syncAll();

    return encodeUsageSpaceToken({
      issuedAt: new Date().toISOString(),
      installationId: this.installationIdentity.installationId,
      usageSpaceId: this.cloudState.usageSpace.id,
      databaseName: this.cloudState.databaseName,
      zero: this.cloudState.zero,
    });
  }

  async joinUsageSpace(token) {
    await this.initialize();
    const parsed = decodeUsageSpaceToken(token);

    this.cloudState.databaseName = parsed.databaseName;
    this.cloudState.usageSpace = {
      id: parsed.usageSpaceId,
      source: "joined",
      joinedFromInstallationId: parsed.installationId ?? null,
      joinedAt: new Date().toISOString(),
    };
    this.cloudState.zero = {
      ...parsed.zero,
      source: "joined",
    };
    this.cloudState.provisioning = null;
    this.resetSyncState({
      usageSpaceId: parsed.usageSpaceId,
    });
    await this.persist();
    const sync = await this.syncAll({
      forceFull: true,
    });

    return {
      usageSpaceId: this.cloudState.usageSpace.id,
      zero: this.cloudState.zero,
      sync: sync.sync,
    };
  }

  async leaveUsageSpace() {
    await this.initialize();
    this.cloudState.usageSpace = {
      id: this.installationIdentity.installationId,
      source: "local",
    };
    this.cloudState.zero = null;
    this.cloudState.provisioning = null;
    this.resetSyncState({
      usageSpaceId: this.installationIdentity.installationId,
    });
    await this.persist();
    return this.syncAll({
      forceFull: true,
    });
  }

  async deleteInstallationData() {
    await this.initialize();
    const repository = await this.getRepository();
    await repository.deleteInstallationData({
      usageSpaceId: this.cloudState.usageSpace.id,
      installationId: this.installationIdentity.installationId,
    });
    await this.store.clear();
    this.resetSyncState();
    await this.persist();
    return this.getStatus();
  }

  async deleteUsageSpaceData() {
    await this.initialize();
    const oldUsageSpaceId = this.cloudState.usageSpace.id;
    const repository = await this.getRepository();
    await repository.deleteUsageSpaceData({
      usageSpaceId: oldUsageSpaceId,
    });
    await this.store.clear();

    if (this.cloudState.usageSpace.source === "joined") {
      this.cloudState.usageSpace = {
        id: this.installationIdentity.installationId,
        source: "local",
      };
      this.cloudState.zero = null;
    }

    this.resetSyncState();
    await this.persist();

    return {
      deletedUsageSpaceId: oldUsageSpaceId,
      nextStatus: await this.getStatus(),
    };
  }

  async stop() {
    await this.flush();

    if (this.repository) {
      await this.repository.close();
    }
  }
}
