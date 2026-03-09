import path from "node:path";
import { JsonlSkillUsageStore } from "./local-event-store.js";
import {
  ensureInstallationIdentity,
  normalizeBotLabel,
  resolvePluginOptions,
  resolvePluginSlots,
} from "./plugin-config.js";
import {
  createPendingSkillRead,
  createPseudoSkillObservation,
  finalizeSkillObservation,
} from "./skill-usage-detector.js";
import { normalizeToolCallId, normalizeToolName } from "./hook-context.js";
import { SkillUsageCloud } from "./skill-usage-cloud.js";
import { runSkillUsageCommand } from "./skill-usage-command.js";
import { executeSkillUsageTool } from "./skill-usage-tool.js";
import { SubagentRunIndex } from "./subagent-run-index.js";
import { RoutingSampleRecorder } from "./routing-sample-recorder.js";
import { normalizeRunContext } from "./hook-context.js";

function noop() {}

const SUBAGENT_SPAWN_TOOLS = new Set(["sessions_spawn", "functions.sessions_spawn"]);
const MEMORY_TOOL_NAMES = new Set([
  "memory_search",
  "memory_store",
  "memory_get",
  "memory_update",
  "memory_delete",
]);

function formatPlatformLabel(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function normalizeBotPlatform(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  return value.trim().toLowerCase();
}

function resolveAccountIdentity({ event, accountAliases }) {
  const botPlatform = normalizeBotPlatform(event.botPlatform);
  const botId = normalizeBotLabel(event.botId);
  const botName = normalizeBotLabel(event.botName);
  const channelId = normalizeBotLabel(event.channelId);
  let botKey = null;
  let defaultLabel = null;

  if (botId) {
    botKey = [botPlatform, botId].filter(Boolean).join(":");
    defaultLabel = botName ?? botId;
  } else if (botName) {
    botKey = [botPlatform, `name:${botName.toLowerCase()}`].filter(Boolean).join(":");
    defaultLabel = botName;
  } else if (channelId) {
    botKey = [botPlatform, `channel:${channelId}`].filter(Boolean).join(":");
    defaultLabel = `channel:${channelId}`;
  }

  if (!botKey) {
    return {
      botKey: null,
      botLabel: null,
      botPlatform,
    };
  }

  const aliasedLabel = accountAliases?.[botKey] ?? null;
  const label = aliasedLabel ?? defaultLabel ?? botKey;
  const platformLabel = formatPlatformLabel(botPlatform);

  return {
    botKey,
    botLabel: aliasedLabel ?? (platformLabel ? `${platformLabel} / ${label}` : label),
    botPlatform,
  };
}

function tryCaptureSubagentRunId(payload) {
  const toolName = normalizeToolName(payload);
  const result = payload?.result ?? {};
  const runtime = payload?.params?.runtime ?? payload?.input?.runtime ?? payload?.args?.runtime;
  const childKey = result?.childSessionKey ?? payload?.childSessionKey ?? null;
  const runId = result?.runId ?? payload?.runId ?? null;

  const isNamedSpawnTool = Boolean(toolName && SUBAGENT_SPAWN_TOOLS.has(toolName));
  const isSubagentFromPayload =
    runtime === "subagent" ||
    (typeof childKey === "string" && childKey.includes(":subagent:"));

  if (!isSubagentFromPayload) return null;
  if (!isNamedSpawnTool && !(typeof childKey === "string" && childKey.includes(":subagent:"))) {
    return null;
  }

  return typeof runId === "string" && runId.length > 0 ? runId : null;
}

function resolvePseudoSkillDescriptor(payload, pluginSlots) {
  const toolName = normalizeToolName(payload);

  if (toolName && MEMORY_TOOL_NAMES.has(toolName)) {
    const slotName =
      typeof pluginSlots?.memory === "string" && pluginSlots.memory.trim().length > 0
        ? pluginSlots.memory.trim()
        : "memory";

    return {
      pseudoSkillId: `${slotName}-includes-plugin`,
      pseudoSkillName: `${slotName} (includes plugin)`,
    };
  }

  return null;
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
    this.routingSampleRecorder = null;
    this.initialized = false;
    this.initializing = null;
    this.installationIdentity = null;
    this.store = null;
    this.options = resolvePluginOptions(api);
    this.pluginSlots = resolvePluginSlots(api);
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
        if (this.options.captureRoutingSamples) {
          this.routingSampleRecorder = new RoutingSampleRecorder({
            stateDir,
          });
          await this.routingSampleRecorder.initialize();
        }
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

  async captureRoutingSample({ phase, payload, resolvedContext = null }) {
    if (!this.routingSampleRecorder) {
      return;
    }

    try {
      await this.routingSampleRecorder.record({
        phase,
        payload,
        normalizedContext: normalizeRunContext(payload),
        resolvedContext,
        installationId: this.installationIdentity?.installationId ?? null,
      });
    } catch (error) {
      this.logger.warn?.(`Failed to record routing sample: ${error.message}`);
    }
  }

  async onBeforeToolCall(payload) {
    const pending = createPendingSkillRead(payload);

    if (!pending && !this.options.captureRoutingSamples) {
      return null;
    }

    await this.initialize();
    await this.captureRoutingSample({
      phase: "before_tool_call",
      payload,
    });

    if (!pending) {
      return null;
    }
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
    const pseudoSkill = pending ? null : resolvePseudoSkillDescriptor(payload, this.pluginSlots);

    if (!pending && !pseudoSkill && !maybeSubagentRunId && !this.options.captureRoutingSamples) {
      return null;
    }

    await this.initialize();

    let event = null;
    let record = null;

    if (pending) {
      if (pendingKey) {
        this.pendingReads.delete(pendingKey);
      }

      event = finalizeSkillObservation({
        pending,
        payload,
        installationId: this.installationIdentity.installationId,
      });
    } else {
      if (!pseudoSkill) {
        await this.captureRoutingSample({
          phase: "after_tool_call",
          payload,
        });
        return null;
      }

      event = createPseudoSkillObservation({
        payload,
        installationId: this.installationIdentity.installationId,
        pseudoSkillId: pseudoSkill.pseudoSkillId,
        pseudoSkillName: pseudoSkill.pseudoSkillName,
      });
    }

    if (
      event.runId &&
      (this.subagentRunIds.has(event.runId) || this.subagentRunIndex?.has(event.runId))
    ) {
      event.sessionScope = "subagent";
    }
    const botIdentity = resolveAccountIdentity({
      event,
      accountAliases: this.options.accountAliases,
    });

    record = await this.store.record({
      ...event,
      installationLabel: this.installationIdentity.installationLabel,
      botKey: botIdentity.botKey,
      botLabel: botIdentity.botLabel,
      botPlatform: botIdentity.botPlatform,
    });
    await this.captureRoutingSample({
      phase: "after_tool_call",
      payload,
      resolvedContext: {
        agentId: record.agentId,
        accountKey: record.botKey,
        accountLabel: record.botLabel,
        accountPlatform: record.botPlatform,
        channelId: record.channelId,
        sessionScope: record.sessionScope,
        runId: record.runId,
      },
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

    if (this.routingSampleRecorder) {
      await this.routingSampleRecorder.flush();
    }

    this.pendingReads.clear();
    this.subagentRunIds.clear();
  }
}

export function createSkillUsagePlugin({ api, cloudFactory }) {
  return new SkillUsagePlugin({ api, cloudFactory });
}
