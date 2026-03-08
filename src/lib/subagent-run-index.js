import path from "node:path";
import { mkdir } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "./plugin-config.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function nowMs() {
  return Date.now();
}

export class SubagentRunIndex {
  constructor({ stateDir, ttlMs = DEFAULT_TTL_MS, logger } = {}) {
    this.stateDir = stateDir;
    this.ttlMs = ttlMs;
    this.logger = logger ?? { debug() {}, warn() {} };
    this.filePath = path.join(stateDir, "subagent-runs.json");
    this.runMap = new Map();
    this.ready = false;
  }

  async initialize() {
    if (this.ready) return;
    await mkdir(this.stateDir, { recursive: true });
    const data = await readJson(this.filePath);
    const rows = Array.isArray(data?.runs) ? data.runs : [];
    const now = nowMs();

    for (const row of rows) {
      const runId = typeof row?.runId === "string" ? row.runId.trim() : "";
      const observedAtMs = Number(row?.observedAtMs ?? 0);
      if (!runId || !Number.isFinite(observedAtMs)) continue;
      if (now - observedAtMs > this.ttlMs) continue;
      this.runMap.set(runId, observedAtMs);
    }

    this.ready = true;
    if (rows.length !== this.runMap.size) {
      await this.persist();
    }
  }

  has(runId) {
    const key = typeof runId === "string" ? runId.trim() : "";
    if (!key) return false;
    const observedAtMs = this.runMap.get(key);
    if (!observedAtMs) return false;
    if (nowMs() - observedAtMs > this.ttlMs) {
      this.runMap.delete(key);
      return false;
    }
    return true;
  }

  async mark(runId) {
    const key = typeof runId === "string" ? runId.trim() : "";
    if (!key) return;
    this.runMap.set(key, nowMs());
    await this.persist();
  }

  async persist() {
    const now = nowMs();
    const runs = [];
    for (const [runId, observedAtMs] of this.runMap.entries()) {
      if (now - observedAtMs > this.ttlMs) {
        this.runMap.delete(runId);
        continue;
      }
      runs.push({ runId, observedAtMs });
    }

    await writeJsonAtomic(this.filePath, {
      schemaVersion: 1,
      ttlMs: this.ttlMs,
      updatedAt: new Date(now).toISOString(),
      runs,
    });
  }
}
