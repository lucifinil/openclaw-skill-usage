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
    payload?.session_key,
    getNestedString(payload, ["context", "sessionKey"]),
    getNestedString(payload, ["context", "session_key"]),
    getNestedString(payload, ["session", "key"]),
    getNestedString(payload, ["session", "sessionKey"]),
    getNestedString(payload, ["session", "session_key"]),
  );

  const sessionScopeHint = firstString(
    payload?.sessionScope,
    payload?.session_scope,
    payload?.scope,
    payload?.sessionType,
    payload?.session_type,
    payload?.sessionKind,
    payload?.session_kind,
    getNestedString(payload, ["context", "sessionScope"]),
    getNestedString(payload, ["context", "session_scope"]),
    getNestedString(payload, ["context", "scope"]),
    getNestedString(payload, ["context", "sessionType"]),
    getNestedString(payload, ["context", "session_type"]),
    getNestedString(payload, ["context", "sessionKind"]),
    getNestedString(payload, ["context", "session_kind"]),
    getNestedString(payload, ["session", "scope"]),
    getNestedString(payload, ["session", "type"]),
    getNestedString(payload, ["session", "sessionScope"]),
    getNestedString(payload, ["session", "session_scope"]),
  );

  const agentId = firstString(
    payload?.agentId,
    payload?.agent_id,
    getNestedString(payload, ["context", "agentId"]),
    getNestedString(payload, ["context", "agent_id"]),
    getNestedString(payload, ["agent", "id"]),
    getNestedString(payload, ["run", "agentId"]),
    getNestedString(payload, ["run", "agent_id"]),
    getNestedString(payload, ["context", "agent", "id"]),
  );

  const isSubagentFlag =
    payload?.isSubagent === true ||
    payload?.is_subagent === true ||
    getNestedValue(payload, ["context", "isSubagent"]) === true ||
    getNestedValue(payload, ["context", "is_subagent"]) === true ||
    getNestedValue(payload, ["session", "isSubagent"]) === true ||
    getNestedValue(payload, ["session", "is_subagent"]) === true;
  const botPlatform = firstString(
    payload?.botPlatform,
    payload?.bot_platform,
    payload?.accountPlatform,
    payload?.account_platform,
    payload?.platform,
    payload?.provider,
    payload?.service,
    getNestedString(payload, ["context", "botPlatform"]),
    getNestedString(payload, ["context", "bot_platform"]),
    getNestedString(payload, ["context", "accountPlatform"]),
    getNestedString(payload, ["context", "account_platform"]),
    getNestedString(payload, ["context", "platform"]),
    getNestedString(payload, ["context", "provider"]),
    getNestedString(payload, ["context", "service"]),
    getNestedString(payload, ["channel", "platform"]),
    getNestedString(payload, ["channel", "provider"]),
    getNestedString(payload, ["bot", "platform"]),
    getNestedString(payload, ["bot", "bot_platform"]),
    getNestedString(payload, ["account", "platform"]),
    getNestedString(payload, ["account", "account_platform"]),
    getNestedString(payload, ["connector", "platform"]),
    getNestedString(payload, ["connector", "type"]),
    getNestedString(payload, ["integration", "platform"]),
    getNestedString(payload, ["integration", "provider"]),
    getNestedString(payload, ["transport", "platform"]),
  );
  const botId = firstString(
    payload?.botId,
    payload?.bot_id,
    payload?.accountId,
    payload?.account_id,
    getNestedString(payload, ["context", "botId"]),
    getNestedString(payload, ["context", "bot_id"]),
    getNestedString(payload, ["context", "accountId"]),
    getNestedString(payload, ["context", "account_id"]),
    getNestedString(payload, ["bot", "id"]),
    getNestedString(payload, ["bot", "bot_id"]),
    getNestedString(payload, ["account", "id"]),
    getNestedString(payload, ["account", "account_id"]),
    getNestedString(payload, ["context", "bot", "id"]),
    getNestedString(payload, ["context", "account", "id"]),
    getNestedString(payload, ["channel", "botId"]),
    getNestedString(payload, ["channel", "bot_id"]),
    getNestedString(payload, ["channel", "accountId"]),
    getNestedString(payload, ["channel", "account_id"]),
    getNestedString(payload, ["connector", "botId"]),
    getNestedString(payload, ["connector", "bot_id"]),
    getNestedString(payload, ["connector", "accountId"]),
    getNestedString(payload, ["connector", "account_id"]),
    getNestedString(payload, ["integration", "botId"]),
    getNestedString(payload, ["integration", "bot_id"]),
    getNestedString(payload, ["integration", "accountId"]),
    getNestedString(payload, ["integration", "account_id"]),
  );
  const botName = firstString(
    payload?.botName,
    payload?.bot_name,
    payload?.accountName,
    payload?.account_name,
    payload?.accountUsername,
    payload?.account_username,
    getNestedString(payload, ["context", "botName"]),
    getNestedString(payload, ["context", "bot_name"]),
    getNestedString(payload, ["context", "accountName"]),
    getNestedString(payload, ["context", "account_name"]),
    getNestedString(payload, ["context", "accountUsername"]),
    getNestedString(payload, ["context", "account_username"]),
    getNestedString(payload, ["bot", "name"]),
    getNestedString(payload, ["bot", "bot_name"]),
    getNestedString(payload, ["bot", "username"]),
    getNestedString(payload, ["account", "name"]),
    getNestedString(payload, ["account", "account_name"]),
    getNestedString(payload, ["account", "username"]),
    getNestedString(payload, ["account", "account_username"]),
    getNestedString(payload, ["context", "bot", "name"]),
    getNestedString(payload, ["context", "account", "name"]),
    getNestedString(payload, ["channel", "botName"]),
    getNestedString(payload, ["channel", "bot_name"]),
    getNestedString(payload, ["channel", "accountName"]),
    getNestedString(payload, ["channel", "account_name"]),
    getNestedString(payload, ["connector", "botName"]),
    getNestedString(payload, ["connector", "bot_name"]),
    getNestedString(payload, ["connector", "accountName"]),
    getNestedString(payload, ["connector", "account_name"]),
    getNestedString(payload, ["integration", "botName"]),
    getNestedString(payload, ["integration", "bot_name"]),
    getNestedString(payload, ["integration", "accountName"]),
    getNestedString(payload, ["integration", "account_name"]),
  );

  return {
    agentId,
    botId,
    botName,
    botPlatform,
    runId: firstString(
      payload?.runId,
      payload?.run_id,
      getNestedString(payload, ["context", "runId"]),
      getNestedString(payload, ["context", "run_id"]),
      getNestedString(payload, ["run", "id"]),
      payload?.traceId,
      payload?.trace_id,
    ),
    sessionId: firstString(
      payload?.sessionId,
      payload?.session_id,
      getNestedString(payload, ["context", "sessionId"]),
      getNestedString(payload, ["context", "session_id"]),
      getNestedString(payload, ["session", "id"]),
    ),
    sessionKey,
    sessionScope:
      sessionScopeHint ??
      (isSubagentFlag ||
      sessionKey?.toLowerCase().includes("subagent") ||
      agentId?.toLowerCase().includes("subagent")
        ? "subagent"
        : "main"),
    turnId: firstString(
      payload?.turnId,
      payload?.turn_id,
      getNestedString(payload, ["context", "turnId"]),
      getNestedString(payload, ["context", "turn_id"]),
      getNestedString(payload, ["turn", "id"]),
    ),
    messageId: firstString(
      payload?.messageId,
      payload?.message_id,
      getNestedString(payload, ["context", "messageId"]),
      getNestedString(payload, ["context", "message_id"]),
      getNestedString(payload, ["message", "id"]),
    ),
    requestId: firstString(
      payload?.requestId,
      payload?.request_id,
      getNestedString(payload, ["context", "requestId"]),
      getNestedString(payload, ["context", "request_id"]),
      getNestedString(payload, ["request", "id"]),
    ),
    channelId: firstString(
      payload?.channelId,
      payload?.channel_id,
      getNestedString(payload, ["context", "channelId"]),
      getNestedString(payload, ["context", "channel_id"]),
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
    botId: primary.botId ?? secondary.botId,
    botName: primary.botName ?? secondary.botName,
    botPlatform: primary.botPlatform ?? secondary.botPlatform,
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
