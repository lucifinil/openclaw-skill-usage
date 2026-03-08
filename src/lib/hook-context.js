import path from "node:path";

const DEFAULT_OBSERVED_AT = "1970-01-01T00:00:00.000Z";

function isString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values) {
  for (const value of values) {
    if (isString(value)) {
      return value.trim();
    }
  }

  return null;
}

function getNestedString(source, keys) {
  let current = source;

  for (const key of keys) {
    if (!isObject(current) && typeof current !== "function") {
      return null;
    }

    current = current?.[key];
  }

  return isString(current) ? current.trim() : null;
}

function getNestedValue(source, keys) {
  let current = source;

  for (const key of keys) {
    if (!isObject(current) && typeof current !== "function") {
      return null;
    }

    current = current?.[key];
  }

  return current ?? null;
}

export function coerceIsoTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  if (isString(value)) {
    const parsed = new Date(value);

    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return DEFAULT_OBSERVED_AT;
}

export function normalizeToolName(payload) {
  return firstString(
    payload?.toolName,
    payload?.name,
    getNestedString(payload, ["tool", "name"]),
    getNestedString(payload, ["toolCall", "name"]),
    getNestedString(payload, ["call", "toolName"]),
    getNestedString(payload, ["context", "toolName"]),
  );
}

export function normalizeToolParams(payload) {
  const candidates = [
    payload?.params,
    payload?.input,
    payload?.args,
    getNestedValue(payload, ["tool", "params"]),
    getNestedValue(payload, ["toolCall", "params"]),
    getNestedValue(payload, ["call", "params"]),
  ];

  for (const candidate of candidates) {
    if (isObject(candidate)) {
      return candidate;
    }
  }

  return {};
}

export function normalizeToolCallId(payload) {
  return firstString(
    payload?.toolCallId,
    payload?.callId,
    payload?.id,
    getNestedString(payload, ["toolCall", "id"]),
    getNestedString(payload, ["call", "id"]),
    getNestedString(payload, ["context", "toolCallId"]),
  );
}

export function extractPotentialPath(params) {
  if (!isObject(params)) {
    return null;
  }

  return firstString(
    params.path,
    params.file_path,
    params.filePath,
    params.filename,
    params.targetPath,
    params.uri,
    getNestedString(params, ["target", "path"]),
  );
}

export function normalizeResultText(payload) {
  const candidates = [
    payload?.result?.text,
    payload?.result?.content,
    payload?.content,
    payload?.output,
    getNestedValue(payload, ["result", "data"]),
    getNestedValue(payload, ["response", "content"]),
  ];

  for (const candidate of candidates) {
    if (isString(candidate)) {
      return candidate;
    }

    if (Array.isArray(candidate)) {
      const text = candidate
        .map((part) => {
          if (isString(part)) {
            return part;
          }

          if (isObject(part) && isString(part.text)) {
            return part.text;
          }

          return "";
        })
        .filter(Boolean)
        .join("\n");

      if (text.length > 0) {
        return text;
      }
    }
  }

  return "";
}

export function normalizeToolStatus(payload) {
  if (typeof payload?.ok === "boolean") {
    return payload.ok ? "ok" : "error";
  }

  if (typeof payload?.success === "boolean") {
    return payload.success ? "ok" : "error";
  }

  if (payload?.error || payload?.result?.error || payload?.result?.ok === false) {
    return "error";
  }

  return "ok";
}

export function normalizeLatencyMs(payload, startedAt) {
  const direct = payload?.latencyMs ?? payload?.durationMs ?? payload?.elapsedMs;

  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }

  const finishedAt = coerceIsoTimestamp(
    payload?.finishedAt ??
      payload?.timestamp ??
      getNestedValue(payload, ["context", "timestamp"]) ??
      Date.now(),
  );

  const startDate = new Date(startedAt);
  const finishDate = new Date(finishedAt);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(finishDate.getTime())) {
    return null;
  }

  const diff = finishDate.getTime() - startDate.getTime();
  return diff >= 0 ? diff : null;
}

export function normalizeRunContext(payload) {
  const sessionKey = firstString(
    payload?.sessionKey,
    getNestedString(payload, ["context", "sessionKey"]),
    getNestedString(payload, ["session", "key"]),
  );

  const sessionScopeHint = firstString(
    payload?.sessionScope,
    getNestedString(payload, ["context", "sessionScope"]),
  );

  return {
    agentId: firstString(
      payload?.agentId,
      getNestedString(payload, ["context", "agentId"]),
      getNestedString(payload, ["agent", "id"]),
      getNestedString(payload, ["run", "agentId"]),
    ),
    runId: firstString(
      payload?.runId,
      getNestedString(payload, ["context", "runId"]),
      getNestedString(payload, ["run", "id"]),
      payload?.traceId,
    ),
    sessionId: firstString(
      payload?.sessionId,
      getNestedString(payload, ["context", "sessionId"]),
      getNestedString(payload, ["session", "id"]),
    ),
    sessionKey,
    sessionScope:
      sessionScopeHint ??
      (payload?.isSubagent === true || sessionKey?.toLowerCase().includes("subagent")
        ? "subagent"
        : "main"),
    turnId: firstString(
      payload?.turnId,
      getNestedString(payload, ["context", "turnId"]),
      getNestedString(payload, ["turn", "id"]),
    ),
    messageId: firstString(
      payload?.messageId,
      getNestedString(payload, ["context", "messageId"]),
      getNestedString(payload, ["message", "id"]),
    ),
    requestId: firstString(
      payload?.requestId,
      getNestedString(payload, ["context", "requestId"]),
      getNestedString(payload, ["request", "id"]),
    ),
    channelId: firstString(
      payload?.channelId,
      getNestedString(payload, ["context", "channelId"]),
      getNestedString(payload, ["channel", "id"]),
    ),
    observedAt: coerceIsoTimestamp(
      payload?.timestamp ??
        payload?.observedAt ??
        getNestedValue(payload, ["context", "timestamp"]) ??
        Date.now(),
    ),
  };
}

export function mergeRunContexts(primary, secondary) {
  return {
    agentId: primary.agentId ?? secondary.agentId,
    runId: primary.runId ?? secondary.runId,
    sessionId: primary.sessionId ?? secondary.sessionId,
    sessionKey: primary.sessionKey ?? secondary.sessionKey,
    sessionScope: primary.sessionScope ?? secondary.sessionScope ?? "main",
    turnId: primary.turnId ?? secondary.turnId,
    messageId: primary.messageId ?? secondary.messageId,
    requestId: primary.requestId ?? secondary.requestId,
    channelId: primary.channelId ?? secondary.channelId,
    observedAt: primary.observedAt ?? secondary.observedAt ?? DEFAULT_OBSERVED_AT,
  };
}

export function basenameWithoutExt(filePath) {
  return path.basename(filePath, path.extname(filePath));
}
