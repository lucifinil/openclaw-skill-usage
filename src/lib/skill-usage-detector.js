import path from "node:path";
import { createHash } from "node:crypto";
import {
  extractPotentialPath,
  mergeRunContexts,
  normalizeLatencyMs,
  normalizeResultText,
  normalizeRunContext,
  normalizeToolCallId,
  normalizeToolName,
  normalizeToolParams,
  normalizeToolStatus,
} from "./hook-context.js";

const READ_TOOL_NAMES = new Set([
  "read",
  "functions.read",
  "read_file",
  "filesystem.read",
  "fs.read",
]);

function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

function hash(parts) {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function classifySkillSource(normalizedPath) {
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
  const trimmed = text.trimStart();

  if (!trimmed.startsWith("---")) {
    return {};
  }

  const lines = trimmed.split("\n");

  if (lines.length < 3) {
    return {};
  }

  const boundaryIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");

  if (boundaryIndex < 0) {
    return {};
  }

  const headerLines = lines.slice(1, boundaryIndex);
  const fields = {};

  for (const line of headerLines) {
    const separator = line.indexOf(":");

    if (separator < 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (key.length > 0 && value.length > 0) {
      fields[key] = value.replace(/^['"]|['"]$/g, "");
    }
  }

  return fields;
}

function buildPendingKey({ toolCallId, pathValue, runContext }) {
  if (toolCallId) {
    return toolCallId;
  }

  return hash([
    pathValue,
    runContext.runId ?? "",
    runContext.turnId ?? "",
    runContext.messageId ?? "",
    runContext.sessionId ?? "",
  ]);
}

function buildTriggerAnchor(runContext) {
  return (
    runContext.turnId ??
    runContext.messageId ??
    runContext.runId ??
    runContext.requestId ??
    runContext.sessionId ??
    "unknown"
  );
}

function buildBaseObservation({ payload, installationId, triggerAnchor, skillId, skillName }) {
  const runContext = normalizeRunContext(payload);
  const eventKey = hash([installationId, triggerAnchor, skillId]);

  return {
    schemaVersion: 1,
    eventType: "skill_usage",
    eventKey,
    installationId,
    usageSpaceId: installationId,
    triggerAnchor,
    toolCallId: normalizeToolCallId(payload) ?? null,
    observedAt: runContext.observedAt,
    status: normalizeToolStatus(payload),
    latencyMs: normalizeLatencyMs(payload),
    agentId: runContext.agentId,
    runId: runContext.runId,
    sessionId: runContext.sessionId,
    sessionKey: runContext.sessionKey,
    sessionScope: runContext.sessionScope,
    turnId: runContext.turnId,
    messageId: runContext.messageId,
    requestId: runContext.requestId,
    channelId: runContext.channelId,
    skillId,
    skillName,
  };
}

export function createPendingSkillRead(payload) {
  const toolName = normalizeToolName(payload);

  if (!toolName || !READ_TOOL_NAMES.has(toolName)) {
    return null;
  }

  const params = normalizeToolParams(payload);
  const pathValue = extractPotentialPath(params);

  if (!pathValue) {
    return null;
  }

  const normalizedPath = normalizePath(pathValue);

  if (path.basename(normalizedPath) !== "SKILL.md") {
    return null;
  }

  const runContext = normalizeRunContext(payload);
  const toolCallId = normalizeToolCallId(payload);

  return {
    pendingKey: buildPendingKey({ toolCallId, pathValue: normalizedPath, runContext }),
    toolCallId,
    startedAt: runContext.observedAt,
    runContext,
    skillPath: normalizedPath,
    skillDirectory: path.dirname(normalizedPath),
    fallbackSkillName: path.basename(path.dirname(normalizedPath)),
    skillSource: classifySkillSource(normalizedPath),
  };
}

export function finalizeSkillObservation({ pending, payload, installationId }) {
  const afterContext = normalizeRunContext(payload);
  const runContext = mergeRunContexts(afterContext, pending.runContext);
  const body = normalizeResultText(payload);
  const frontmatter = parseFrontmatter(body);
  const declaredName = frontmatter.name ?? null;
  const skillName = declaredName ?? pending.fallbackSkillName;
  const skillId = slugify(skillName) || slugify(pending.fallbackSkillName) || "unknown-skill";
  const triggerAnchor = buildTriggerAnchor(runContext);

  return {
    ...buildBaseObservation({
      payload: {
        ...payload,
        context: runContext,
      },
      installationId,
      triggerAnchor,
      skillId,
      skillName,
    }),
    toolCallId: normalizeToolCallId(payload) ?? pending.toolCallId ?? null,
    latencyMs: normalizeLatencyMs(payload, pending.startedAt),
    skillDeclaredName: declaredName,
    skillPath: pending.skillPath,
    skillSource: pending.skillSource,
  };
}

export function createPseudoSkillObservation({ payload, installationId, pseudoSkillName, pseudoSkillId }) {
  if (typeof pseudoSkillName !== "string" || pseudoSkillName.trim().length === 0) {
    return null;
  }

  const runContext = normalizeRunContext(payload);
  const triggerAnchor = buildTriggerAnchor(runContext);
  const skillName = pseudoSkillName.trim();
  const skillId = pseudoSkillId ?? (slugify(skillName) || "unknown-pseudo-skill");

  return {
    ...buildBaseObservation({
      payload,
      installationId,
      triggerAnchor,
      skillId,
      skillName,
    }),
    skillDeclaredName: null,
    skillPath: null,
    skillSource: "plugin",
  };
}
