export function formatExpiry(expiresAt) {
  if (!expiresAt) {
    return "unknown";
  }

  return new Date(expiresAt).toISOString();
}

function formatTimestamp(value) {
  if (!value) {
    return "none yet";
  }

  return new Date(value).toISOString();
}

function sumTriggers(items) {
  return (items ?? []).reduce((sum, item) => sum + Number(item?.triggerCount ?? 0), 0);
}

function sumAttempts(items) {
  return (items ?? []).reduce((sum, item) => sum + Number(item?.attemptCount ?? item?.triggerCount ?? 0), 0);
}

function appendUnknownBucket(lines, { label, missingTriggers, missingAttempts, note }) {
  if (missingTriggers <= 0 && missingAttempts <= 0) {
    return;
  }

  lines.push(
    `      ${label} - ${missingTriggers} total triggers, ${missingAttempts} attempts (${note})`,
  );
}

function formatAccountBreakdownLines(accounts, installation) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return [];
  }

  const lines = ["      by channel account:"];

  accounts.forEach((account) => {
    lines.push(
      `      ${normalizeAccountLabel(account.accountLabel)} - ${account.triggerCount} total triggers, ${account.attemptCount} attempts`,
    );
  });

  const missingTriggers = Number(installation?.triggerCount ?? 0) - sumTriggers(accounts);
  const missingAttempts = Number(installation?.attemptCount ?? installation?.triggerCount ?? 0) - sumAttempts(accounts);
  appendUnknownBucket(lines, {
    label: 'Unknown channel account',
    missingTriggers,
    missingAttempts,
    note: 'routing metadata incomplete',
  });

  return lines;
}

function formatAgentBreakdownLines(agents, installation) {
  if (!Array.isArray(agents) || agents.length === 0) {
    return [];
  }

  const lines = ["      by agent:"];

  agents.forEach((agent) => {
    lines.push(`      ${agent.agentLabel} - ${agent.triggerCount} total triggers, ${agent.attemptCount} attempts`);
  });

  const missingTriggers = Number(installation?.triggerCount ?? 0) - sumTriggers(agents);
  const missingAttempts = Number(installation?.attemptCount ?? installation?.triggerCount ?? 0) - sumAttempts(agents);
  appendUnknownBucket(lines, {
    label: 'Unknown agent',
    missingTriggers,
    missingAttempts,
    note: 'agent attribution incomplete',
  });

  return lines;
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
    lines.push(...formatAgentBreakdownLines(installation.agents, installation));
    lines.push(...formatAccountBreakdownLines(installation.accounts, installation));
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

function formatTopResultDetail(result) {
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
  lines.push(
    `scope: ${result.aggregationScope === "usage-space" ? "current usage space" : "this installation only"}`,
  );
  if (result.degradedReason) {
    lines.push(`cloud status: ${result.degradedReason}`);
  }

  result.rows.forEach((row, index) => {
    lines.push(`${index + 1}. ${row.skillName} - total ${row.triggerCount} triggers, ${row.attemptCount} attempts`);
    lines.push(...formatInstallationBreakdownLines(row.installations));
  });

  return lines.join("\n");
}


function normalizeAccountLabel(label) {
  const raw = String(label ?? '').trim();
  const normalized = raw.toLowerCase();
  if (normalized.includes('guild #allhands channel id:1480303286182608897')) {
    return 'Discord / elon';
  }
  return raw;
}

function shortAccountLabel(label) {
  const normalizedLabel = normalizeAccountLabel(label);
  const normalized = String(normalizedLabel ?? '').toLowerCase();
  if (normalized.includes('unknown')) return 'unknown';
  if (normalized.includes('whatsapp')) return 'wa';
  if (normalized.includes('discord / elon')) return 'disc/el';
  if (normalized.includes('discord / tim')) return 'tim';
  return normalizedLabel;
}

function shortAgentLabel(label) {
  const normalized = String(label ?? '').toLowerCase();
  if (normalized.includes('unknown')) return 'unknown';
  return label;
}

function compactSegment(items, kind) {
  if (!Array.isArray(items) || items.length === 0) {
    return `- ${kind === 'account' ? 'channel' : 'agent'}: none`;
  }
  const parts = items.map((item) => {
    const label = kind === 'account'
      ? shortAccountLabel(item.accountLabel ?? item.accountKey ?? 'unknown')
      : shortAgentLabel(item.agentLabel ?? item.agentId ?? 'unknown');
    return `${label} ${item.triggerCount}`;
  });
  return `- ${kind === 'account' ? 'channel' : 'agent'}: ${parts.join(' | ')}`;
}

function mergeInstallationBreakdownForCompact(installation) {
  const agents = Array.isArray(installation?.agents) ? installation.agents : [];
  const accounts = Array.isArray(installation?.accounts) ? installation.accounts : [];
  const agentMissing = Number(installation?.triggerCount ?? 0) - sumTriggers(agents);
  const accountMissing = Number(installation?.triggerCount ?? 0) - sumTriggers(accounts);
  const fullAgents = agentMissing > 0
    ? [...agents, { agentLabel: 'unknown', triggerCount: agentMissing }]
    : agents;
  const fullAccounts = accountMissing > 0
    ? [...accounts, { accountLabel: 'unknown', triggerCount: accountMissing }]
    : accounts;
  return { agents: fullAgents, accounts: fullAccounts };
}

function formatTopResultCompact(result) {
  if (result.rows.length === 0) {
    return formatTopResultDetail(result);
  }

  const lines = [];
  result.rows.forEach((row, index) => {
    const installations = Array.isArray(row.installations) ? row.installations : [];
    if (index > 0) {
      lines.push('=====================================');
    }
    lines.push(`skill: ${row.skillName} (${row.triggerCount})`);

    if (installations.length <= 1) {
      const breakdown = mergeInstallationBreakdownForCompact(installations[0] ?? row ?? {});
      lines.push(compactSegment(breakdown.agents, 'agent'));
      lines.push(compactSegment(breakdown.accounts, 'account'));
      return;
    }

    installations.forEach((installation, installationIndex) => {
      const breakdown = mergeInstallationBreakdownForCompact(installation ?? {});
      if (installationIndex > 0) {
        lines.push('-------------------------------------');
      }
      lines.push(`installation: ${installation.installationLabel} (${installation.triggerCount})`);
      lines.push(compactSegment(breakdown.agents, 'agent'));
      lines.push(compactSegment(breakdown.accounts, 'account'));
    });
  });
  return lines.join("\n");
}

export function formatTopResult(result, { format = 'compact' } = {}) {
  if (format === 'detail') {
    return formatTopResultDetail(result);
  }
  return formatTopResultCompact(result);
}

export function formatStatus(status) {
  const totalsLabel = status.source === "cloud" ? "synced totals" : "local totals";
  const sync = status.sync ?? {};

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
    `last observed at: ${status.summary.lastObservedAt ?? "none yet"}`,
    `last cloud sync: ${formatTimestamp(sync.lastSuccessfulSyncAt)}`,
    `pending local records: ${sync.pendingLocalRecordCount ?? 0}`,
    `last sync error: ${sync.lastError ?? "none"}`,
    ...(status.degradedReason ? [`cloud status: ${status.degradedReason}`] : []),
    "metadata sent: skill id/name, installation id/label, channel account key/label/platform, agent id, routing/session identifiers, timestamps, status, latency",
  ].join("\n");
}

export function formatHelp() {
  return [
    "Usage:",
    "/skillusage status",
    "/skillusage doctor",
    "/skillusage top [1d|7d|30d|all]",
    "/skillusage sync [full]",
    "/skillusage join-token",
    "/skillusage join <token>",
    "/skillusage leave",
    "/skillusage delete installation",
    "/skillusage delete space",
  ].join("\n");
}
