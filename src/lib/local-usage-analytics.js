import { enrichEventsWithResolver } from "./event-enricher.js";

function dedupeEvents(events) {
  const seen = new Set();
  const deduped = [];
  for (const event of events) {
    const key = event?.eventKey ?? `${event?.skillId}|${event?.toolCallId}|${event?.observedAt}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

function periodToThreshold(periodKey, now = new Date()) {
  const threshold = new Date(now);

  switch (periodKey) {
    case "1d":
      threshold.setUTCDate(threshold.getUTCDate() - 1);
      return threshold.getTime();
    case "7d":
      threshold.setUTCDate(threshold.getUTCDate() - 7);
      return threshold.getTime();
    case "30d":
      threshold.setUTCDate(threshold.getUTCDate() - 30);
      return threshold.getTime();
    case "all":
      return Number.NEGATIVE_INFINITY;
    default:
      throw new Error(`Unsupported period "${periodKey}". Use 1d, 7d, 30d, or all.`);
  }
}

function periodLabel(periodKey) {
  switch (periodKey) {
    case "1d":
      return "1 day";
    case "7d":
      return "7 days";
    case "30d":
      return "30 days";
    case "all":
      return "all time";
    default:
      throw new Error(`Unsupported period "${periodKey}". Use 1d, 7d, 30d, or all.`);
  }
}

function toTimestamp(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function sortInstallations(left, right) {
  return (
    right.triggerCount - left.triggerCount ||
    right.attemptCount - left.attemptCount ||
    left.installationLabel.localeCompare(right.installationLabel)
  );
}

function resolveSubagentIdentityKey(event) {
  if (event?.sessionScope !== "subagent") {
    return null;
  }

  const candidates = [
    event.runId,
    event.sessionKey,
    event.sessionId,
    event.triggerAnchor,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
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

function summarizeRows(events) {
  const installations = new Set();
  const agents = new Set();
  const accounts = new Set();
  const subagentRuns = new Set();
  let totalAttempts = 0;
  let totalTriggers = 0;
  let lastObservedAt = null;

  events.forEach((event) => {
    totalAttempts += 1;
    if (event.firstTrigger) {
      totalTriggers += 1;
    }
    if (event.installationId) {
      installations.add(event.installationId);
    }
    if (event.agentId) {
      agents.add(event.agentId);
    }
    if (event.botKey) {
      accounts.add(event.botKey);
    }
    const subagentIdentity = resolveSubagentIdentityKey(event);
    if (subagentIdentity) {
      subagentRuns.add(subagentIdentity);
    }
    if (!lastObservedAt || new Date(event.observedAt) > new Date(lastObservedAt)) {
      lastObservedAt = event.observedAt;
    }
  });

  return {
    totalAttempts,
    totalTriggers,
    installationCount: installations.size,
    agentCount: agents.size,
    accountCount: accounts.size,
    subagentRunCount: subagentRuns.size,
    lastObservedAt,
  };
}

export class LocalUsageAnalytics {
  constructor({ store, eventResolver = null, transcriptScanner = null }) {
    this.store = store;
    this.eventResolver = eventResolver;
    this.transcriptScanner = transcriptScanner;
  }

  async listBaseEvents() {
    return await this.store.readAllEvents();
  }

  async listTranscriptEvents() {
    if (!this.transcriptScanner) {
      return [];
    }
    return await this.transcriptScanner.scanSkillReadEvents();
  }

  async listEventsForPeriod(periodKey) {
    const baseEvents = await this.listBaseEvents();
    const transcriptEvents = await this.listTranscriptEvents();
    const events = await enrichEventsWithResolver(dedupeEvents([...baseEvents, ...transcriptEvents]), this.eventResolver);
    const threshold = periodToThreshold(periodKey);

    return events.filter((event) => {
      const observedAt = toTimestamp(event.observedAt);
      return observedAt != null && observedAt >= threshold;
    });
  }

  async queryTopSkills({
    periodKey = "all",
    limit = 10,
    usageSpaceId,
    usageSpaceSource,
    degradedReason = null,
    cloudState = "local-only",
  } = {}) {
    const events = await this.listEventsForPeriod(periodKey);
    const grouped = new Map();

    events.forEach((event) => {
      const current =
        grouped.get(event.skillId) ?? {
          skillId: event.skillId,
          skillName: event.skillName,
          triggerCount: 0,
          attemptCount: 0,
          installationIds: new Set(),
          agentIds: new Set(),
          accountKeys: new Set(),
          subagentRunIds: new Set(),
          installations: new Map(),
        };
      const installationId = event.installationId ?? "unknown-installation";
      const installationLabel = event.installationLabel ?? installationId;

      current.attemptCount += 1;
      if (event.firstTrigger) {
        current.triggerCount += 1;
      }
      if (event.installationId) {
        current.installationIds.add(event.installationId);
      }
      if (event.agentId) {
        current.agentIds.add(event.agentId);
      }
      if (event.botKey) {
        current.accountKeys.add(event.botKey);
      }
      const subagentIdentity = resolveSubagentIdentityKey(event);
      if (subagentIdentity) {
        current.subagentRunIds.add(subagentIdentity);
      }
      const installationCurrent =
        current.installations.get(installationId) ?? {
          installationId,
          installationLabel,
          triggerCount: 0,
          attemptCount: 0,
          mainTriggerCount: 0,
          subagentTriggerCount: 0,
          agents: new Map(),
          accounts: new Map(),
        };
      installationCurrent.attemptCount += 1;
      if (event.firstTrigger) {
        installationCurrent.triggerCount += 1;
        if (event.sessionScope === "subagent") {
          installationCurrent.subagentTriggerCount += 1;
        } else {
          installationCurrent.mainTriggerCount += 1;
        }
      }
      if (event.agentId) {
        const agentCurrent =
          installationCurrent.agents.get(event.agentId) ?? {
            agentId: event.agentId,
            agentLabel: event.agentId,
            triggerCount: 0,
            attemptCount: 0,
          };
        agentCurrent.attemptCount += 1;
        if (event.firstTrigger) {
          agentCurrent.triggerCount += 1;
        }
        installationCurrent.agents.set(event.agentId, agentCurrent);
      }
      if (event.botKey) {
        const accountCurrent =
          installationCurrent.accounts.get(event.botKey) ?? {
            accountKey: event.botKey,
            accountLabel: event.botLabel ?? event.botKey,
            accountPlatform: event.botPlatform ?? null,
            triggerCount: 0,
            attemptCount: 0,
            mainTriggerCount: 0,
            subagentTriggerCount: 0,
          };
        accountCurrent.attemptCount += 1;
        if (event.firstTrigger) {
          accountCurrent.triggerCount += 1;
          if (event.sessionScope === "subagent") {
            accountCurrent.subagentTriggerCount += 1;
          } else {
            accountCurrent.mainTriggerCount += 1;
          }
        }
        installationCurrent.accounts.set(event.botKey, accountCurrent);
      }
      current.installations.set(installationId, installationCurrent);

      grouped.set(event.skillId, current);
    });

    return {
      source: "local",
      cloudState,
      degradedReason,
      aggregationScope: "local-installation",
      usageSpaceId,
      usageSpaceSource,
      period: {
        key: periodKey,
        label: periodLabel(periodKey),
      },
      rows: Array.from(grouped.values())
        .map((row) => ({
          skillId: row.skillId,
          skillName: row.skillName,
          triggerCount: row.triggerCount,
          attemptCount: row.attemptCount,
          installationCount: row.installationIds.size,
          agentCount: row.agentIds.size,
          accountCount: row.accountKeys.size,
          subagentRunCount: row.subagentRunIds.size,
          installations: Array.from(row.installations.values())
            .map((installation) => ({
              ...installation,
              agents: Array.from(installation.agents.values()).sort(sortAgents),
              accounts: Array.from(installation.accounts.values()).sort(sortBots),
            }))
            .sort(sortInstallations),
        }))
        .sort(
          (left, right) =>
            right.triggerCount - left.triggerCount ||
            right.attemptCount - left.attemptCount ||
            left.skillName.localeCompare(right.skillName),
        )
        .slice(0, limit),
    };
  }

  async querySummary({
    usageSpaceId,
    usageSpaceSource,
    installationLabel = null,
    databaseName = null,
    zero = null,
    degradedReason = null,
    cloudState = "local-only",
  } = {}) {
    const events = await enrichEventsWithResolver(await this.store.readAllEvents(), this.eventResolver);

    return {
      source: "local",
      cloudState,
      degradedReason,
      aggregationScope: "local-installation",
      usageSpaceId,
      usageSpaceSource,
      installationLabel,
      databaseName,
      zero,
      summary: summarizeRows(events),
    };
  }
}
