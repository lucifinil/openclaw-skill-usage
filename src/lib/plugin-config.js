import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";

const PLUGIN_ID = "skill-usage";
const DEFAULT_DATABASE_NAME = "openclaw_skill_usage";
const DEFAULT_PROVISION_TAG = "openclaw-skill-usage";
const DEFAULT_INSTALLATION_LABEL_PREFIX = "installation";
const MAX_INSTALLATION_LABEL_LENGTH = 80;

function getPluginEntryConfig(api) {
  return api?.config?.plugins?.entries?.[PLUGIN_ID]?.config ?? {};
}

export function resolvePluginSlots(api) {
  return api?.config?.plugins?.slots ?? {};
}

export function resolvePluginOptions(api) {
  const entryConfig = getPluginEntryConfig(api);

  return {
    stateDir: resolveStateDir(api),
    autoSync: entryConfig.autoSync !== false,
    provisionTag:
      typeof entryConfig.provisionTag === "string" && entryConfig.provisionTag.trim().length > 0
        ? entryConfig.provisionTag.trim()
        : DEFAULT_PROVISION_TAG,
    databaseName:
      typeof entryConfig.databaseName === "string" && entryConfig.databaseName.trim().length > 0
        ? entryConfig.databaseName.trim()
        : DEFAULT_DATABASE_NAME,
    installationLabel:
      typeof entryConfig.installationLabel === "string" && entryConfig.installationLabel.trim().length > 0
        ? normalizeInstallationLabel(entryConfig.installationLabel)
        : null,
  };
}

export function resolveStateDir(api) {
  const pluginConfig = getPluginEntryConfig(api);

  if (typeof pluginConfig.stateDir === "string" && pluginConfig.stateDir.trim().length > 0) {
    return path.resolve(pluginConfig.stateDir);
  }

  if (typeof process.env.OPENCLAW_STATE_DIR === "string" && process.env.OPENCLAW_STATE_DIR.length > 0) {
    return path.join(process.env.OPENCLAW_STATE_DIR, "plugins", PLUGIN_ID);
  }

  if (typeof process.env.HOME === "string" && process.env.HOME.length > 0) {
    return path.join(process.env.HOME, ".openclaw", "state", "plugins", PLUGIN_ID);
  }

  return path.join(process.cwd(), ".openclaw-state", PLUGIN_ID);
}

export async function readJson(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export function normalizeInstallationLabel(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized.slice(0, MAX_INSTALLATION_LABEL_LENGTH) : null;
}

function defaultInstallationLabel(installationId) {
  const hostLabel = normalizeInstallationLabel(osHostname());

  if (hostLabel) {
    return hostLabel;
  }

  return `${DEFAULT_INSTALLATION_LABEL_PREFIX}-${installationId.slice(0, 8)}`;
}

export async function ensureInstallationIdentity(stateDir, { installationLabel } = {}) {
  await mkdir(stateDir, { recursive: true });
  const identityPath = path.join(stateDir, "installation.json");
  const existing = await readJson(identityPath);
  const installationId = existing?.installationId ?? randomUUID();
  const nextInstallationLabel =
    normalizeInstallationLabel(installationLabel) ??
    normalizeInstallationLabel(existing?.installationLabel) ??
    defaultInstallationLabel(installationId);

  if (existing?.installationId && existing?.installationLabel === nextInstallationLabel) {
    return existing;
  }

  const created = {
    ...existing,
    installationId,
    installationLabel: nextInstallationLabel,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };

  await writeJsonAtomic(identityPath, created);
  return created;
}
