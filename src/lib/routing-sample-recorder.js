import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const TOP_LEVEL_KEYS = [
  "toolName",
  "toolCallId",
  "agentId",
  "accountId",
  "accountName",
  "accountUsername",
  "accountPlatform",
  "botId",
  "botName",
  "botPlatform",
  "channelId",
  "platform",
  "provider",
  "service",
  "sessionScope",
  "sessionKey",
  "sessionId",
  "runId",
  "turnId",
  "messageId",
  "requestId",
  "timestamp",
  "observedAt",
  "childSessionKey",
];

const NESTED_KEYS = {
  context: TOP_LEVEL_KEYS,
  account: ["id", "name", "username", "platform", "provider"],
  bot: ["id", "name", "username", "platform"],
  channel: ["id", "accountId", "accountName", "botId", "botName", "platform", "provider"],
  connector: ["type", "platform", "accountId", "accountName", "botId", "botName"],
  integration: ["provider", "platform", "accountId", "accountName", "botId", "botName"],
  transport: ["platform", "provider"],
  session: ["id", "key", "scope", "type", "isSubagent"],
  run: ["id", "agentId"],
};

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizePrimitive(value) {
  if (value == null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  return undefined;
}

function pickKeys(source, keys) {
  if (!isObject(source) && typeof source !== "function") {
    return undefined;
  }

  const result = {};

  keys.forEach((key) => {
    const value = sanitizePrimitive(source?.[key]);
    if (value !== undefined) {
      result[key] = value;
    }
  });

  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizePayload(payload) {
  const topLevel = pickKeys(payload, TOP_LEVEL_KEYS) ?? {};

  Object.entries(NESTED_KEYS).forEach(([section, keys]) => {
    const nested = pickKeys(payload?.[section], keys);
    if (nested) {
      topLevel[section] = nested;
    }
  });

  return topLevel;
}

function hasRoutingSignal(payload, normalizedContext) {
  const fields = [
    normalizedContext?.agentId,
    normalizedContext?.botId,
    normalizedContext?.botName,
    normalizedContext?.botPlatform,
    normalizedContext?.channelId,
    normalizedContext?.sessionKey,
    payload?.agentId,
    payload?.accountId,
    payload?.botId,
    payload?.channelId,
    payload?.platform,
    payload?.provider,
  ];

  return fields.some((value) => typeof value === "string" && value.trim().length > 0);
}

export class RoutingSampleRecorder {
  constructor({ stateDir }) {
    this.rootDir = path.join(stateDir, "debug");
    this.filePath = path.join(this.rootDir, "routing-samples.jsonl");
    this.ready = false;
    this.queue = Promise.resolve();
  }

  async initialize() {
    if (this.ready) {
      return;
    }

    await mkdir(this.rootDir, { recursive: true });
    this.ready = true;
  }

  async record({ phase, payload, normalizedContext, resolvedContext = null, installationId = null }) {
    if (!hasRoutingSignal(payload, normalizedContext)) {
      return;
    }

    this.queue = this.queue.then(async () => {
      await this.initialize();

      const sample = {
        recordedAt: new Date().toISOString(),
        phase,
        installationId,
        payload: sanitizePayload(payload),
        normalizedContext,
        ...(resolvedContext ? { resolvedContext } : {}),
      };

      await appendFile(this.filePath, `${JSON.stringify(sample)}\n`, "utf8");
    });

    return this.queue;
  }

  async flush() {
    await this.queue;
  }
}
