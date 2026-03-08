import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readJson, writeJsonAtomic } from "./plugin-config.js";
import { TiDBUsageRepository } from "./tidb-usage-repository.js";
import { encodeUsageSpaceToken, decodeUsageSpaceToken } from "./usage-space-token.js";
import { provisionZeroInstance } from "./zero-client.js";
import { LocalUsageAnalytics } from "./local-usage-analytics.js";

function noop() {}

function hashRecordKey(eventKey, attempts) {
  return createHash("sha256").update(`${eventKey}:${attempts}`).digest("hex");
}

function defaultCloudState({ installationId, databaseName }) {
  return {
    version: 1,
    databaseName,
    usageSpace: {
      id: installationId,
      source: "local",
    },
    zero: null,
    provisioning: null,
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

  async buildCloudEvents() {
    const events = await this.store.readAllEvents();
    return events.map((event) => ({
      ...event,
      usageSpaceId: this.cloudState.usageSpace.id,
      recordKey: hashRecordKey(event.eventKey, event.attempts),
    }));
  }

  async syncAll() {
    await this.initialize();
    const repository = await this.getRepository();
    const events = await this.buildCloudEvents();

    await repository.ensureUsageSpace({
      usageSpaceId: this.cloudState.usageSpace.id,
      installationId: this.installationIdentity.installationId,
      zeroConfig: this.cloudState.zero,
      source: this.cloudState.usageSpace.source,
    });

    const syncResult = await repository.upsertEvents(events);
    const summary = await repository.queryUsageSpaceSummary({
      usageSpaceId: this.cloudState.usageSpace.id,
    });

    return {
      ...syncResult,
      summary,
      usageSpaceId: this.cloudState.usageSpace.id,
      zero: this.cloudState.zero,
    };
  }

  async queryTopSkillsWithFallback({ periodKey = "all", limit = 10 } = {}) {
    try {
      const result = await this.queryTopSkills({
        periodKey,
        limit,
      });

      return {
        ...result,
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
    return repository.queryTopSkills({
      usageSpaceId: this.cloudState.usageSpace.id,
      periodKey,
      limit,
    });
  }

  async getStatus() {
    await this.initialize();
    const sync = await this.syncAll();

    return {
      usageSpaceId: this.cloudState.usageSpace.id,
      usageSpaceSource: this.cloudState.usageSpace.source,
      databaseName: this.cloudState.databaseName,
      zero: this.cloudState.zero,
      summary: sync.summary,
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

      return this.localAnalytics.querySummary({
        usageSpaceId: this.cloudState.usageSpace.id,
        usageSpaceSource: this.cloudState.usageSpace.source,
        databaseName: this.cloudState.databaseName,
        zero: this.cloudState.zero,
        degradedReason: error.message,
        cloudState: this.cloudState.zero ? "degraded" : "local-only",
      });
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
    await this.persist();
    await this.syncAll();

    return {
      usageSpaceId: this.cloudState.usageSpace.id,
      zero: this.cloudState.zero,
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
    await this.persist();
    return this.syncAll();
  }

  async deleteInstallationData() {
    await this.initialize();
    const repository = await this.getRepository();
    await repository.deleteInstallationData({
      usageSpaceId: this.cloudState.usageSpace.id,
      installationId: this.installationIdentity.installationId,
    });
    await this.store.clear();
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
