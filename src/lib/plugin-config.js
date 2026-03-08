import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PLUGIN_ID = "skill-usage";

function getPluginEntryConfig(api) {
  return api?.config?.plugins?.entries?.[PLUGIN_ID]?.config ?? {};
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

async function readJson(filePath) {
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

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function ensureInstallationIdentity(stateDir) {
  await mkdir(stateDir, { recursive: true });
  const identityPath = path.join(stateDir, "installation.json");
  const existing = await readJson(identityPath);

  if (existing?.installationId) {
    return existing;
  }

  const created = {
    installationId: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  await writeJsonAtomic(identityPath, created);
  return created;
}
