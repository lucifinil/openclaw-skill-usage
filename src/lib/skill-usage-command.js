const PERIOD_ALIASES = new Map([
  ["1d", "1d"],
  ["day", "1d"],
  ["today", "1d"],
  ["7d", "7d"],
  ["week", "7d"],
  ["30d", "30d"],
  ["month", "30d"],
  ["all", "all"],
  ["all-time", "all"],
]);

function resolvePeriod(token) {
  if (!token) {
    return "all";
  }

  return PERIOD_ALIASES.get(token.toLowerCase()) ?? null;
}

function formatExpiry(expiresAt) {
  if (!expiresAt) {
    return "unknown";
  }

  return new Date(expiresAt).toISOString();
}

function formatTopResult(result) {
  if (result.rows.length === 0) {
    return `No skill usage has been synced yet for ${result.period.label}.`;
  }

  const lines = [`Top skills for ${result.period.label}:`];

  result.rows.forEach((row, index) => {
    lines.push(
      `${index + 1}. ${row.skillName} - ${row.triggerCount} triggers, ${row.attemptCount} attempts, ${row.installationCount} installations, ${row.agentCount} agents, ${row.subagentRunCount} subagent runs`,
    );
  });

  return lines.join("\n");
}

function formatStatus(status) {
  return [
    "Skill usage status:",
    `usage space: ${status.usageSpaceId} (${status.usageSpaceSource})`,
    `database: ${status.databaseName}`,
    `cloud instance: ${status.zero?.instanceId ?? "not provisioned"}`,
    `expires at: ${formatExpiry(status.zero?.expiresAt)}`,
    `claim URL: ${status.zero?.claimUrl ?? "not available"}`,
    `synced totals: ${status.summary.totalTriggers} triggers, ${status.summary.totalAttempts} attempts`,
    `members: ${status.summary.installationCount} installations, ${status.summary.agentCount} agents, ${status.summary.subagentRunCount} subagent runs`,
    "metadata sent: skill id/name, installation id, agent id, session scope, timestamps, status, latency",
  ].join("\n");
}

function formatHelp() {
  return [
    "Usage:",
    "/skillusage status",
    "/skillusage top [1d|7d|30d|all]",
    "/skillusage sync",
    "/skillusage join-token",
    "/skillusage join <token>",
    "/skillusage leave",
    "/skillusage delete installation",
    "/skillusage delete space",
  ].join("\n");
}

export async function runSkillUsageCommand({ cloud, args }) {
  const trimmed = args?.trim() ?? "";

  if (trimmed.length === 0 || trimmed === "help") {
    return {
      text: formatHelp(),
    };
  }

  const [command, ...rest] = trimmed.split(/\s+/);

  switch (command.toLowerCase()) {
    case "status": {
      const status = await cloud.getStatus();
      return {
        text: formatStatus(status),
      };
    }
    case "sync": {
      const sync = await cloud.syncAll();
      return {
        text: `Synced ${sync.uploaded} local records into usage space ${sync.usageSpaceId}. Totals: ${sync.summary.totalTriggers} triggers, ${sync.summary.totalAttempts} attempts.`,
      };
    }
    case "top": {
      const periodKey = resolvePeriod(rest[0]);

      if (!periodKey) {
        throw new Error(`Unknown period "${rest[0]}". Use 1d, 7d, 30d, or all.`);
      }

      const result = await cloud.queryTopSkills({
        periodKey,
      });
      return {
        text: formatTopResult(result),
      };
    }
    case "join-token": {
      const token = await cloud.createJoinToken();
      return {
        text: `Share this token with another OpenClaw installation:\n${token}`,
      };
    }
    case "join": {
      const token = rest.join(" ").trim();

      if (!token) {
        throw new Error("Provide a usage space token after /skillusage join.");
      }

      const joined = await cloud.joinUsageSpace(token);
      return {
        text: `Joined usage space ${joined.usageSpaceId}. Cloud instance ${joined.zero.instanceId} will now aggregate this installation's skill counts with the shared space.`,
      };
    }
    case "leave": {
      const status = await cloud.leaveUsageSpace();
      return {
        text: `Left the shared usage space. This installation is back on its local default space ${status.usageSpaceId}.`,
      };
    }
    case "delete": {
      const target = rest[0]?.toLowerCase();

      if (target === "installation") {
        const status = await cloud.deleteInstallationData();
        return {
          text: `Deleted this installation's cloud rows and cleared the local event buffer. Current totals in usage space ${status.usageSpaceId}: ${status.summary.totalTriggers} triggers, ${status.summary.totalAttempts} attempts.`,
        };
      }

      if (target === "space") {
        const result = await cloud.deleteUsageSpaceData();
        return {
          text: `Deleted cloud rows for usage space ${result.deletedUsageSpaceId}. This installation now uses ${result.nextStatus.usageSpaceId} (${result.nextStatus.usageSpaceSource}).`,
        };
      }

      throw new Error('Use "/skillusage delete installation" or "/skillusage delete space".');
    }
    default:
      throw new Error(`Unknown /skillusage command "${command}". Use /skillusage help.`);
  }
}
