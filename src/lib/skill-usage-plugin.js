import path from "node:path";
import { JsonlSkillUsageStore } from "./local-event-store.js";
import { ensureInstallationIdentity, resolveStateDir } from "./plugin-config.js";
import { createPendingSkillRead, finalizeSkillObservation } from "./skill-usage-detector.js";
import { normalizeToolCallId } from "./hook-context.js";

function noop() {}

export class SkillUsagePlugin {
  constructor({ api }) {
    this.api = api;
    this.logger = api?.logger ?? {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    };
    this.pendingReads = new Map();
    this.initialized = false;
    this.initializing = null;
    this.installationIdentity = null;
    this.store = null;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    if (!this.initializing) {
      this.initializing = (async () => {
        const stateDir = resolveStateDir(this.api);
        this.installationIdentity = await ensureInstallationIdentity(stateDir);
        this.store = new JsonlSkillUsageStore({
          rootDir: path.join(stateDir, "events"),
        });
        await this.store.initialize();
        this.initialized = true;
      })();
    }

    await this.initializing;
  }

  async onBeforeToolCall(payload) {
    const pending = createPendingSkillRead(payload);

    if (!pending) {
      return null;
    }

    await this.initialize();
    this.pendingReads.set(pending.pendingKey, pending);
    return pending;
  }

  async onAfterToolCall(payload) {
    const fallbackPending = createPendingSkillRead(payload);
    const toolCallId = normalizeToolCallId(payload);
    const pendingKey = fallbackPending?.pendingKey ?? toolCallId;
    const pending = (pendingKey && this.pendingReads.get(pendingKey)) ?? fallbackPending;

    if (!pending) {
      return null;
    }

    if (pendingKey) {
      this.pendingReads.delete(pendingKey);
    }

    await this.initialize();

    const event = finalizeSkillObservation({
      pending,
      payload,
      installationId: this.installationIdentity.installationId,
    });

    const record = await this.store.record(event);

    this.logger.debug?.("Recorded skill usage event", {
      skillId: record.skillId,
      skillName: record.skillName,
      firstTrigger: record.firstTrigger,
      eventKey: record.eventKey,
    });

    return record;
  }

  async stop() {
    if (this.store) {
      await this.store.flush();
    }

    this.pendingReads.clear();
  }
}

export function createSkillUsagePlugin({ api }) {
  return new SkillUsagePlugin({ api });
}
