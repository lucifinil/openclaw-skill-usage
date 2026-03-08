export function formatExpiry(expiresAt) {
  if (!expiresAt) {
    return "unknown";
  }

  return new Date(expiresAt).toISOString();
}

export function formatTopResult(result) {
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

export function formatStatus(status) {
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

export function formatHelp() {
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
