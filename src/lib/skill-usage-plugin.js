import path from "node:path";
import { JsonlSkillUsageStore } from "./local-event-store.js";
import {
  ensureInstallationIdentity,
  resolvePluginOptions,
} from "./plugin-config.js";
import { createPendingSkillRead, finalizeSkillObservation } from "./skill-usage-detector.js";
import { normalizeToolCallId, normalizeToolName } from "./hook-context.js";
import { SkillUsageCloud } from "./skill-usage-cloud.js";
import { runSkillUsageCommand } from "./skill-usage-command.js";
import { executeSkillUsageTool } from "./skill-usage-tool.js";
import { SubagentRunIndex } from "./subagent-run-index.js";

function noop() {}

const SUBAGENT_SPAWN_TOOLS = new Set(["sessions_spawn", "functions.sessions_spawn"]);

function tryCaptureSubagentRunId(payload) {
  const toolName = normalizeToolName(payload);
  const result = payload?.result ?? {};
  const runtime = payload?.params?.runtime ?? payload?.input?.runtime ?? payload?.args?.runtime;
  const childKey = result?.childSessionKey ?? payload?.childSessionKey ?? null;
  const isNamedSpawnTool = Boolean(toolName && SUBAGENT_SPAWN_TOOLS.has(toolName));
  const runId = isNamedSpawnTool
    ? (result?.runId ?? null)
    : (result?.runId ?? payload?.runId ?? null);
  const isSubagentFromPayload =
    runtime === "subagent" ||
    (typeof childKey === "string" && childKey.includes(":subagent:"));

  if (!isSubagentFromPayload) return null;
  if (!isNamedSpawnTool && !(typeof childKey === "string" && childKey.includes(":subagent:"))) {
    return null;
  }

  return typeof runId === "string" && runId.length > 0 ? runId : null;
}

export class SkillUsagePlugin {
  constructor({ api, cloudFactory }) {
    this.api = api;
    this.logger = api?.logger ?? {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    };
    this.pendingReads = new Map();
    this.subagentRunIds = new Set();
    this.subagentRunIndex = null;
    this.initialized = false;
    this.initializing = null;
    this.installationIdentity = null;
    this.store = null;
    this.options = resolvePluginOptions(api);
    this.cloudFactory =
      cloudFactory ??
      ((args) =>
        new SkillUsageCloud({
          ...args,
          options: this.options,
        }));
    this.cloud = null;
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    if (!this.initializing) {
      this.initializing = (async () => {
        const stateDir = this.options.stateDir;
        this.installationIdentity = await ensureInstallationIdentity(stateDir, {
          installationLabel: this.options.installationLabel,
        });
        this.store = new JsonlSkillUsageStore({
          rootDir: path.join(stateDir, "events"),
        });
        await this.store.initialize();
        this.subagentRunIndex = new SubagentRunIndex({
          stateDir,
          logger: this.logger,
        });
        await this.subagentRunIndex.initialize();
        this.cloud = this.cloudFactory({
          stateDir,
          installationIdentity: this.installationIdentity,
          store: this.store,
          logger: this.logger,
        });
        await this.cloud.initialize();
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
    const maybeSubagentRunId = tryCaptureSubagentRunId(payload);
    if (maybeSubagentRunId) {
      this.subagentRunIds.add(maybeSubagentRunId);
      await this.initialize();
      await this.subagentRunIndex?.mark(maybeSubagentRunId);
      this.logger.debug?.("Captured subagent run id", { runId: maybeSubagentRunId });
    }

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

    if (
      event.runId &&
      (this.subagentRunIds.has(event.runId) || this.subagentRunIndex?.has(event.runId))
    ) {
      event.sessionScope = "subagent";
    }

    const record = await this.store.record({
      ...event,
      installationLabel: this.installationIdentity.installationLabel,
    });

    this.logger.debug?.("Recorded skill usage event", {
      skillId: record.skillId,
      skillName: record.skillName,
      firstTrigger: record.firstTrigger,
      eventKey: record.eventKey,
    });

    if (this.options.autoSync) {
      this.cloud.enqueueSync("observed skill usage");
    }

    return record;
  }

  async runCommand(args) {
    await this.initialize();

    try {
      return await runSkillUsageCommand({
        cloud: this.cloud,
        args,
      });
    } catch (error) {
      return {
        text: `Skill usage command failed: ${error.message}`,
      };
    }
  }

  async executeTool(params) {
    await this.initialize();

    try {
      return await executeSkillUsageTool({
        cloud: this.cloud,
        params,
      });
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Skill usage tool failed: ${error.message}`,
          },
        ],
      };
    }
  }

  async stop() {
    if (this.cloud) {
      await this.cloud.stop();
    }

    if (this.store) {
      await this.store.flush();
    }

    this.pendingReads.clear();
    this.subagentRunIds.clear();
  }
}

export function createSkillUsagePlugin({ api, cloudFactory }) {
  return new SkillUsagePlugin({ api, cloudFactory });
}
