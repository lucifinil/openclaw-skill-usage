import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

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

function normalizePath(value) {
  return typeof value === "string" ? value.replace(/\\/g, "/") : null;
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hash(parts) {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function classifySkillSource(normalizedPath) {
  if (!normalizedPath) return "other";
  if (normalizedPath.includes("/.openclaw/workspace/") || normalizedPath.includes("/workspace/.openclaw/")) {
    return "workspace";
  }
  if (normalizedPath.includes("/.openclaw/skills/") || normalizedPath.includes("/.codex/skills/")) {
    return "user";
  }
  if (normalizedPath.includes("/node_modules/") || normalizedPath.includes("/extensions/")) {
    return "plugin";
  }
  return "other";
}

function parseFrontmatter(text) {
  const trimmed = (text ?? "").trimStart();
  if (!trimmed.startsWith("---")) {
    return {};
  }
  const lines = trimmed.split("\n");
  const boundaryIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (boundaryIndex < 0) {
    return {};
  }
  const fields = {};
  for (const line of lines.slice(1, boundaryIndex)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key.length > 0 && value.length > 0) {
      fields[key] = value.replace(/^['"]|['"]$/g, "");
    }
  }
  return fields;
}

function extractTextContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (isObject(item) && typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractToolCalls(entry) {
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((item) => isObject(item) && item.type === "toolCall");
}

function extractToolResult(entry) {
  if (entry?.message?.role !== "toolResult") {
    return null;
  }
  return {
    toolCallId: firstString(entry?.message?.toolCallId),
    toolName: firstString(entry?.message?.toolName),
    text: extractTextContent(entry?.message?.content),
    timestamp: firstString(entry?.timestamp),
  };
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

async function listAgentSessionDirs(openclawRoot) {
  const agentsDir = path.join(openclawRoot, "agents");
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

async function listSessionFiles(openclawRoot) {
  const sessionDirs = await listAgentSessionDirs(openclawRoot);
  const files = [];
  for (const sessionsDir of sessionDirs) {
    try {
      const entries = await readdir(sessionsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(path.join(sessionsDir, entry.name));
        }
      }
    } catch {
      continue;
    }
  }
  return files;
}

async function loadSessionIndex(openclawRoot) {
  const sessionDirs = await listAgentSessionDirs(openclawRoot);
  const bySessionId = new Map();
  const bySessionKey = new Map();

  for (const sessionsDir of sessionDirs) {
    const sessionsPath = path.join(sessionsDir, "sessions.json");
    try {
      const text = await readFile(sessionsPath, "utf8");
      const data = JSON.parse(text);
      if (!isObject(data)) continue;

      for (const [sessionKey, value] of Object.entries(data)) {
        if (!isObject(value)) continue;
        const record = {
          sessionKey,
          sessionId: firstString(value.sessionId),
          accountId: firstString(value.deliveryContext?.accountId, value.lastAccountId, value.origin?.accountId),
          accountName: firstString(value.accountName, value.origin?.label),
          botPlatform: firstString(value.deliveryContext?.channel, value.channel, value.origin?.provider),
          channelId: firstString(
            deriveChannelIdFromTo(value.deliveryContext?.to),
            deriveChannelIdFromTo(value.lastTo),
            deriveChannelIdFromSessionKey(sessionKey),
            value.groupId,
          ),
        };
        bySessionKey.set(sessionKey, record);
        if (record.sessionId) {
          bySessionId.set(record.sessionId, record);
        }
      }
    } catch {
      continue;
    }
  }

  return { bySessionId, bySessionKey };
}

function formatPlatformLabel(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function deriveBotIdentity({ accountId, channelId, botPlatform }) {
  if (accountId) {
    const key = [botPlatform, accountId].filter(Boolean).join(":");
    const label = formatPlatformLabel(botPlatform)
      ? `${formatPlatformLabel(botPlatform)} / ${accountId}`
      : accountId;
    return { botKey: key, botLabel: label };
  }

  if (channelId) {
    const key = [botPlatform, `channel:${channelId}`].filter(Boolean).join(":");
    const label = formatPlatformLabel(botPlatform)
      ? `${formatPlatformLabel(botPlatform)} / channel:${channelId}`
      : `channel:${channelId}`;
    return { botKey: key, botLabel: label };
  }

  return { botKey: null, botLabel: null };
}

function buildEvent({ entry, toolCall, toolResult, installationId, installationLabel, sessionMeta, sessionIndex, fileAgentId }) {
  const args = isObject(toolCall.arguments) ? toolCall.arguments : {};
  const skillPath = normalizePath(firstString(args.path, args.file_path, args.filePath));
  if (!skillPath || path.basename(skillPath) !== "SKILL.md") {
    return null;
  }

  const declaredName = parseFrontmatter(toolResult?.text ?? "").name ?? null;
  const fallbackSkillName = path.basename(path.dirname(skillPath));
  const skillName = declaredName ?? fallbackSkillName;
  const skillId = slugify(skillName) || slugify(fallbackSkillName) || "unknown-skill";
  const observedAt = firstString(toolResult?.timestamp, entry?.timestamp) ?? new Date().toISOString();
  const sessionId = firstString(entry?.sessionId, sessionMeta?.sessionId);
  const directSessionKey = firstString(entry?.sessionKey, sessionMeta?.sessionKey);
  const indexedSession =
    (sessionId && sessionIndex.bySessionId.get(sessionId)) ||
    (directSessionKey && sessionIndex.bySessionKey.get(directSessionKey)) ||
    null;
  const sessionKey = firstString(directSessionKey, indexedSession?.sessionKey);
  const agentId = firstString(entry?.agentId, sessionMeta?.agentId, fileAgentId);
  const channelId = firstString(
    entry?.channelId,
    sessionMeta?.channelId,
    indexedSession?.channelId,
    deriveChannelIdFromSessionKey(sessionKey),
  );
  const accountId = firstString(entry?.accountId, sessionMeta?.accountId, indexedSession?.accountId);
  const botPlatform = firstString(entry?.platform, sessionMeta?.botPlatform, indexedSession?.botPlatform);
  const botIdentity = deriveBotIdentity({ accountId, channelId, botPlatform });
  const triggerAnchor = firstString(toolCall.id, entry?.id, sessionId, sessionKey, skillPath, observedAt);

  return {
    schemaVersion: 1,
    eventType: "skill_usage",
    eventKey: hash([installationId, triggerAnchor, skillId, "transcript"]),
    installationId,
    installationLabel,
    usageSpaceId: installationId,
    triggerAnchor,
    toolCallId: firstString(toolCall.id),
    observedAt,
    status: "ok",
    latencyMs: null,
    agentId,
    botId: accountId,
    botName: null,
    botKey: botIdentity.botKey,
    botLabel: botIdentity.botLabel,
    botPlatform,
    runId: firstString(toolCall.runId, toolResult?.runId),
    sessionId,
    sessionKey,
    sessionScope: sessionKey?.includes(":subagent:") ? "subagent" : "main",
    turnId: null,
    messageId: null,
    requestId: null,
    channelId,
    skillId,
    skillName,
    skillDeclaredName: declaredName,
    skillPath,
    skillSource: classifySkillSource(skillPath),
    attempts: 1,
    firstTrigger: true,
    firstObservedAt: observedAt,
    derivedFromTranscript: true,
  };
}

export class TranscriptSkillScanner {
  constructor({ openclawRoot, installationIdentity }) {
    this.openclawRoot = openclawRoot;
    this.installationIdentity = installationIdentity;
  }

  async scanSkillReadEvents() {
    const files = await listSessionFiles(this.openclawRoot);
    const sessionIndex = await loadSessionIndex(this.openclawRoot);
    const results = [];

    for (const filePath of files) {
      const fileAgentId = filePath.split(`${path.sep}agents${path.sep}`)[1]?.split(path.sep)[0] ?? null;
      let text;
      try {
        text = await readFile(filePath, "utf8");
      } catch {
        continue;
      }

      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      const toolResults = new Map();
      const sessionMeta = {
        sessionId: null,
        sessionKey: null,
        agentId: null,
        channelId: null,
        accountId: null,
        botPlatform: null,
      };

      const parsed = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          parsed.push(entry);
          sessionMeta.sessionId ??= firstString(entry?.sessionId, entry?.id && entry.type === "session" ? entry.id : null);
          sessionMeta.sessionKey ??= firstString(entry?.sessionKey);
          sessionMeta.agentId ??= firstString(entry?.agentId);
          sessionMeta.channelId ??= firstString(entry?.channelId);
          sessionMeta.accountId ??= firstString(entry?.accountId);
          sessionMeta.botPlatform ??= firstString(entry?.platform);
          const toolResult = extractToolResult(entry);
          if (toolResult?.toolCallId) {
            toolResults.set(toolResult.toolCallId, toolResult);
          }
        } catch {
          continue;
        }
      }

      for (const entry of parsed) {
        for (const toolCall of extractToolCalls(entry)) {
          if (firstString(toolCall.name) !== "read") continue;
          const event = buildEvent({
            entry,
            toolCall,
            toolResult: toolResults.get(firstString(toolCall.id)) ?? null,
            installationId: this.installationIdentity.installationId,
            installationLabel: this.installationIdentity.installationLabel,
            sessionMeta,
            sessionIndex,
            fileAgentId,
          });
          if (event) {
            results.push(event);
          }
        }
      }
    }

    return results;
  }
}
