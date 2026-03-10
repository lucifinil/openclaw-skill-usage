import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function collectStringsDeep(value, target = new Set()) {
  if (typeof value === "string") {
    target.add(value);
    return target;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringsDeep(item, target);
    }
    return target;
  }
  if (isObject(value)) {
    for (const nested of Object.values(value)) {
      collectStringsDeep(nested, target);
    }
  }
  return target;
}

function deriveChannelIdFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") {
    return null;
  }
  const match = sessionKey.match(/:channel:([^:]+)$/);
  return match?.[1] ?? null;
}

function deriveChannelIdFromTo(to) {
  if (typeof to !== "string") {
    return null;
  }
  const match = to.match(/^channel:(.+)$/);
  return match?.[1] ?? null;
}

function extractIdentityFromEntry(entry, fallback = {}) {
  const message = entry?.message;
  const details = message?.details;
  const contentStrings = collectStringsDeep(message?.content);
  return {
    sessionId: firstString(entry?.sessionId, message?.sessionId, details?.sessionId, fallback.sessionId),
    sessionKey: firstString(
      entry?.sessionKey,
      message?.sessionKey,
      details?.sessionKey,
      fallback.sessionKey,
    ),
    agentId: firstString(entry?.agentId, message?.agentId, details?.agentId, fallback.agentId),
    channelId: firstString(
      entry?.channelId,
      message?.channelId,
      details?.channelId,
      details?.metadata?.channelId,
      fallback.channelId,
    ),
    accountId: firstString(
      entry?.accountId,
      message?.accountId,
      details?.accountId,
      details?.metadata?.accountId,
      details?.metadata?.botId,
      fallback.accountId,
    ),
    accountName: firstString(
      entry?.accountName,
      message?.accountName,
      details?.accountName,
      details?.metadata?.accountName,
      fallback.accountName,
    ),
    botPlatform: firstString(
      entry?.platform,
      message?.platform,
      details?.platform,
      details?.metadata?.platform,
      details?.metadata?.provider,
      fallback.botPlatform,
    ),
    _contentStrings: contentStrings,
  };
}

async function listAgentSessionDirs(root) {
  const agentsDir = path.join(root, "agents");
  let agentDirs = [];
  try {
    agentDirs = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs = [];
  for (const dirent of agentDirs) {
    if (!dirent.isDirectory()) continue;
    dirs.push(path.join(agentsDir, dirent.name, "sessions"));
  }
  return dirs;
}

async function listSessionFiles(root) {
  const sessionDirs = await listAgentSessionDirs(root);
  const files = [];
  for (const sessionsDir of sessionDirs) {
    try {
      const sessionFiles = await readdir(sessionsDir, { withFileTypes: true });
      for (const file of sessionFiles) {
        if (!file.isFile()) continue;
        if (!file.name.endsWith(".jsonl")) continue;
        files.push(path.join(sessionsDir, file.name));
      }
    } catch {
      continue;
    }
  }
  return files;
}

function deriveTranscriptSessionIdentity(filePath) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    return { agentId: null, sessionId: null, sessionFile: null };
  }

  const normalized = filePath.split(path.sep);
  const agentIndex = normalized.lastIndexOf("agents");
  const sessionId = path.basename(filePath, ".jsonl");

  return {
    agentId:
      agentIndex >= 0 && normalized.length > agentIndex + 1
        ? normalized[agentIndex + 1]
        : null,
    sessionId: sessionId && sessionId !== "sessions" ? sessionId : null,
    sessionFile: filePath,
  };
}

async function loadSessionIndex(openclawRoot) {
  const sessionDirs = await listAgentSessionDirs(openclawRoot);
  const entries = [];

  for (const sessionsDir of sessionDirs) {
    const sessionsPath = path.join(sessionsDir, "sessions.json");
    try {
      const text = await readFile(sessionsPath, "utf8");
      const data = JSON.parse(text);
      if (!isObject(data)) continue;

      for (const [sessionKey, value] of Object.entries(data)) {
        if (!isObject(value)) continue;
        entries.push({
          sessionKey,
          sessionId: firstString(value.sessionId),
          sessionFile: firstString(value.sessionFile),
          accountId: firstString(value.deliveryContext?.accountId, value.lastAccountId, value.origin?.accountId),
          accountName: firstString(value.accountName, value.origin?.label),
          botPlatform: firstString(value.deliveryContext?.channel, value.channel, value.origin?.provider),
          channelId: firstString(
            deriveChannelIdFromTo(value.deliveryContext?.to),
            deriveChannelIdFromTo(value.lastTo),
            deriveChannelIdFromSessionKey(sessionKey),
            value.groupId,
          ),
          raw: value,
        });
      }
    } catch {
      continue;
    }
  }

  return entries;
}


function deriveAgentIdFromSessionKey(sessionKey) {
  if (typeof sessionKey !== "string") {
    return null;
  }
  const match = sessionKey.match(/^agent:([^:]+):/);
  return match?.[1] ?? null;
}

function looksLikeStableSessionId(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
}

function mergeIndexIdentity(resolved, sessionEntries) {
  if (!resolved) {
    return null;
  }

  const matched = sessionEntries.find((entry) => {
    if (resolved.sessionId && entry.sessionId && resolved.sessionId === entry.sessionId) {
      return true;
    }
    if (resolved.sessionKey && entry.sessionKey && resolved.sessionKey === entry.sessionKey) {
      return true;
    }
    return false;
  });

  if (!matched) {
    return {
      ...resolved,
      channelId: resolved.channelId ?? deriveChannelIdFromSessionKey(resolved.sessionKey),
    };
  }

  return {
    ...resolved,
    sessionKey: resolved.sessionKey ?? matched.sessionKey ?? null,
    sessionId: resolved.sessionId ?? matched.sessionId ?? null,
    channelId:
      resolved.channelId ??
      matched.channelId ??
      deriveChannelIdFromSessionKey(resolved.sessionKey ?? matched.sessionKey) ??
      null,
    accountId: resolved.accountId ?? matched.accountId ?? null,
    accountName: resolved.accountName ?? matched.accountName ?? null,
    botPlatform: resolved.botPlatform ?? matched.botPlatform ?? null,
  };
}

export class SessionAttributionResolver {
  constructor({ openclawRoot }) {
    this.openclawRoot = openclawRoot;
    this.cache = new Map();
    this.sessionIndexPromise = null;
  }

  async getSessionIndex() {
    if (!this.sessionIndexPromise) {
      this.sessionIndexPromise = loadSessionIndex(this.openclawRoot);
    }
    return this.sessionIndexPromise;
  }

  async resolve(runId) {
    if (typeof runId !== "string" || runId.trim().length === 0) {
      return null;
    }

    if (this.cache.has(runId)) {
      return this.cache.get(runId);
    }

    const files = await listSessionFiles(this.openclawRoot);
    const sessionIndex = await this.getSessionIndex();

    for (const filePath of files) {
      let text;
      try {
        text = await readFile(filePath, "utf8");
      } catch {
        continue;
      }

      if (!text.includes(runId)) {
        continue;
      }

      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      const fileIdentity = deriveTranscriptSessionIdentity(filePath);
      const fallback = {
        sessionId: null,
        sessionKey: null,
        agentId: null,
        channelId: null,
        accountId: null,
        accountName: null,
        botPlatform: null,
      };

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const identity = extractIdentityFromEntry(entry, fallback);
          fallback.sessionId ??= identity.sessionId;
          fallback.sessionKey ??= identity.sessionKey;
          fallback.agentId ??= identity.agentId;
          fallback.channelId ??= identity.channelId;
          fallback.accountId ??= identity.accountId;
          fallback.accountName ??= identity.accountName;
          fallback.botPlatform ??= identity.botPlatform;

          const lineStrings = identity._contentStrings;
          if (line.includes(runId) || lineStrings.has(runId)) {
            const transcriptBound = sessionIndex.find((entry) => {
              if (fileIdentity.sessionFile && entry.sessionFile && entry.sessionFile === fileIdentity.sessionFile) {
                return true;
              }
              if (fileIdentity.sessionId && entry.sessionId && entry.sessionId === fileIdentity.sessionId) {
                return true;
              }
              return false;
            }) ?? null;

            const resolvedBase = transcriptBound
              ? {
                  runId,
                  sessionId: transcriptBound.sessionId ?? (looksLikeStableSessionId(identity.sessionId) ? identity.sessionId : null) ?? fileIdentity.sessionId,
                  sessionKey: transcriptBound.sessionKey ?? null,
                  agentId:
                    identity.agentId ??
                    fallback.agentId ??
                    deriveAgentIdFromSessionKey(transcriptBound.sessionKey) ??
                    fileIdentity.agentId,
                  channelId: transcriptBound.channelId ?? null,
                  accountId: transcriptBound.accountId ?? null,
                  accountName: transcriptBound.accountName ?? null,
                  botPlatform: transcriptBound.botPlatform ?? null,
                  sourceFile: filePath,
                }
              : {
                  runId,
                  sessionId: (looksLikeStableSessionId(identity.sessionId) ? identity.sessionId : null) ?? fallback.sessionId ?? fileIdentity.sessionId,
                  sessionKey: identity.sessionKey ?? fallback.sessionKey,
                  agentId: identity.agentId ?? fallback.agentId ?? fileIdentity.agentId,
                  channelId: identity.channelId ?? fallback.channelId,
                  accountId: identity.accountId ?? fallback.accountId,
                  accountName: identity.accountName ?? fallback.accountName,
                  botPlatform: identity.botPlatform ?? fallback.botPlatform,
                  sourceFile: filePath,
                };

            const resolved = mergeIndexIdentity(
              resolvedBase,
              transcriptBound ? [transcriptBound] : sessionIndex,
            );
            this.cache.set(runId, resolved);
            return resolved;
          }
        } catch {
          continue;
        }
      }
    }

    this.cache.set(runId, null);
    return null;
  }
}
