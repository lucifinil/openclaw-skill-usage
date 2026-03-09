function formatPlatformLabel(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function deriveBotIdentity(event) {
  const botPlatform = event.botPlatform ?? null;
  const botId = event.botId ?? null;
  const botName = event.botName ?? null;
  const channelId = event.channelId ?? null;

  if (event.botKey) {
    return {
      botKey: event.botKey,
      botLabel: event.botLabel ?? event.botKey,
    };
  }

  if (botId) {
    const botKey = [botPlatform, botId].filter(Boolean).join(":");
    const platformLabel = formatPlatformLabel(botPlatform);
    const label = botName ?? botId;
    return {
      botKey,
      botLabel: platformLabel ? `${platformLabel} / ${label}` : label,
    };
  }

  if (channelId) {
    const botKey = [botPlatform, `channel:${channelId}`].filter(Boolean).join(":");
    const platformLabel = formatPlatformLabel(botPlatform);
    const label = `channel:${channelId}`;
    return {
      botKey,
      botLabel: platformLabel ? `${platformLabel} / ${label}` : label,
    };
  }

  return {
    botKey: null,
    botLabel: null,
  };
}

function mergeMissingIdentity(event, resolved) {
  if (!resolved) {
    return event;
  }

  const merged = {
    ...event,
    agentId: event.agentId ?? resolved.agentId ?? null,
    sessionKey: event.sessionKey ?? resolved.sessionKey ?? null,
    channelId: event.channelId ?? resolved.channelId ?? null,
    botId: event.botId ?? resolved.accountId ?? null,
    botName: event.botName ?? resolved.accountName ?? null,
    botPlatform: event.botPlatform ?? resolved.botPlatform ?? null,
  };

  const derived = deriveBotIdentity(merged);
  return {
    ...merged,
    botKey: merged.botKey ?? derived.botKey,
    botLabel: merged.botLabel ?? derived.botLabel,
  };
}

export async function enrichEventsWithResolver(events, resolver) {
  if (!resolver || !Array.isArray(events) || events.length === 0) {
    return events;
  }

  const cache = new Map();

  async function resolve(runId) {
    if (!runId || typeof runId !== "string") {
      return null;
    }
    if (cache.has(runId)) {
      return cache.get(runId);
    }
    const result = await resolver.resolve(runId);
    cache.set(runId, result ?? null);
    return result ?? null;
  }

  const enriched = [];
  for (const event of events) {
    const needsIdentity =
      event &&
      typeof event === "object" &&
      typeof event.runId === "string" &&
      (!event.agentId || !event.sessionKey || (!event.botId && !event.botKey && !event.channelId));

    if (!needsIdentity) {
      enriched.push(event);
      continue;
    }

    const resolved = await resolve(event.runId);
    enriched.push(mergeMissingIdentity(event, resolved));
  }

  return enriched;
}
