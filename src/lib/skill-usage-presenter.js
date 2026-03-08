export function formatExpiry(expiresAt) {
  if (!expiresAt) {
    return "unknown";
  }

  return new Date(expiresAt).toISOString();
}

function formatInstallationBreakdownLines(installations) {
  if (!Array.isArray(installations) || installations.length === 0) {
    return ["   by installation: none yet"];
  }

  const lines = ["   by installation:"];

  installations.forEach((installation) => {
    lines.push(
      `   ${installation.installationLabel} - ${installation.triggerCount} total triggers, ${installation.attemptCount} attempts`,
    );
    lines.push(
      `      scope split: main ${installation.mainTriggerCount ?? 0}, subagent ${installation.subagentTriggerCount ?? 0}`,
    );
  });

  return lines;
}

function formatDataSource(result) {
  if (result.source === "cloud") {
    return "cloud-synced usage space";
  }

  if (result.cloudState === "degraded") {
    return "local fallback (cloud currently unavailable)";
  }

  return "local installation only";
}

export function formatTopResult(result) {
  if (result.rows.length === 0) {
    const lines = [`No skill usage has been recorded for ${result.period.label}.`];
    lines.push(`data source: ${formatDataSource(result)}`);
    if (result.degradedReason) {
      lines.push(`cloud status: ${result.degradedReason}`);
    }
    return lines.join("\n");
  }

  const lines = [`Top skills for ${result.period.label}:`];
  lines.push(`data source: ${formatDataSource(result)}`);
  if (result.aggregationScope === "local-installation") {
    lines.push("scope: this installation only");
  }
  if (result.degradedReason) {
    lines.push(`cloud status: ${result.degradedReason}`);
  }

  result.rows.forEach((row, index) => {
    lines.push(`${index + 1}. ${row.skillName} - total ${row.triggerCount} triggers, ${row.attemptCount} attempts`);
    lines.push(...formatInstallationBreakdownLines(row.installations));
  });

  return lines.join("\n");
}

export function formatStatus(status) {
  const totalsLabel = status.source === "cloud" ? "synced totals" : "local totals";

  return [
    "Skill usage status:",
    `data source: ${formatDataSource(status)}`,
    `scope: ${status.aggregationScope === "usage-space" ? "current usage space" : "this installation only"}`,
    `usage space: ${status.usageSpaceId} (${status.usageSpaceSource})`,
    `this installation: ${status.installationLabel ?? "unknown"}`,
    `database: ${status.databaseName}`,
    `cloud instance: ${status.zero?.instanceId ?? "not provisioned"}`,
    `expires at: ${formatExpiry(status.zero?.expiresAt)}`,
    `claim URL: ${status.zero?.claimUrl ?? "not available"}`,
    `${totalsLabel}: ${status.summary.totalTriggers} triggers, ${status.summary.totalAttempts} attempts`,
    `members: ${status.summary.installationCount} installations, ${status.summary.agentCount} agents, ${status.summary.subagentRunCount} subagent runs`,
    `last observed at: ${status.summary.lastObservedAt ?? "none yet"}`,
    ...(status.degradedReason ? [`cloud status: ${status.degradedReason}`] : []),
    "metadata sent: skill id/name, installation id/label, agent id, session scope, timestamps, status, latency",
  ].join("\n");
}

export function formatHelp() {
  return [
    "Usage:",
    "/skillusage status",
    "/skillusage doctor",
    "/skillusage top [1d|7d|30d|all]",
    "/skillusage sync",
    "/skillusage join-token",
    "/skillusage join <token>",
    "/skillusage leave",
    "/skillusage delete installation",
    "/skillusage delete space",
  ].join("\n");
}
