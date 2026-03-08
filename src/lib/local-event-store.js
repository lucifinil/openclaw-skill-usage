import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

async function readJson(filePath, fallback) {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tempPath, body, "utf8");
  await rename(tempPath, filePath);
}

export class JsonlSkillUsageStore {
  constructor({ rootDir }) {
    this.rootDir = rootDir;
    this.eventsPath = path.join(rootDir, "skill-usage-events.jsonl");
    this.indexPath = path.join(rootDir, "skill-usage-index.json");
    this.queue = Promise.resolve();
    this.index = null;
    this.ready = false;
  }

  async initialize() {
    if (this.ready) {
      return;
    }

    await mkdir(this.rootDir, { recursive: true });
    this.index = await readJson(this.indexPath, {});
    this.ready = true;
  }

  async record(event) {
    this.queue = this.queue.then(async () => {
      await this.initialize();

      const current = this.index[event.eventKey] ?? {
        attempts: 0,
        firstObservedAt: event.observedAt,
      };

      const attempts = current.attempts + 1;
      const firstTrigger = current.attempts === 0;
      const record = {
        ...event,
        attempts,
        firstTrigger,
        firstObservedAt: current.firstObservedAt,
      };

      await appendFile(this.eventsPath, `${JSON.stringify(record)}\n`, "utf8");

      this.index[event.eventKey] = {
        attempts,
        skillId: event.skillId,
        skillName: event.skillName,
        lastObservedAt: event.observedAt,
        firstObservedAt: current.firstObservedAt,
        lastStatus: event.status,
      };

      await writeJsonAtomic(this.indexPath, this.index);

      return record;
    });

    return this.queue;
  }

  async readAllEvents() {
    await this.initialize();

    try {
      const text = await readFile(this.eventsPath, "utf8");
      return text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  async flush() {
    await this.queue;
  }
}
