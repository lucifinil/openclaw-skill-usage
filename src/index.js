import { createSkillUsagePlugin } from "./lib/skill-usage-plugin.js";
import { skillUsageToolDefinition } from "./lib/skill-usage-tool.js";

export default function register(api) {
  const plugin = createSkillUsagePlugin({ api });

  api.registerService?.({
    id: "skill-usage",
    start: async () => {
      await plugin.initialize();
    },
    stop: async () => {
      await plugin.stop();
    },
  });

  const mergeToolHookPayload = (event, ctx) => ({
    ...(event ?? {}),
    ...(ctx ?? {}),
    context: {
      ...(event?.context ?? {}),
      ...(ctx ?? {}),
    },
  });

  const beforeHandler = async (event, ctx) => {
    api.logger?.info?.(
      `[skill-usage-debug] before_tool_call tool=${event?.toolName ?? "unknown"} runId=${event?.runId ?? ctx?.runId ?? ""}`,
    );
    await plugin.onBeforeToolCall(mergeToolHookPayload(event, ctx));
  };
  const afterHandler = async (event, ctx) => {
    api.logger?.info?.(
      `[skill-usage-debug] after_tool_call tool=${event?.toolName ?? "unknown"} runId=${event?.runId ?? ctx?.runId ?? ""}`,
    );
    await plugin.onAfterToolCall(mergeToolHookPayload(event, ctx));
  };

  // Prefer typed registerHook API here so tool hook context (agentId/sessionKey/sessionId)
  // is delivered reliably via the second ctx parameter.
  api.registerHook?.("before_tool_call", beforeHandler, {
    name: "skill-usage.before-tool-call",
    description: "Observes skill file reads before the tool executes.",
  });
  api.registerHook?.("after_tool_call", afterHandler, {
    name: "skill-usage.after-tool-call",
    description: "Finalizes and records skill usage observations after the tool executes.",
  });

  api.registerCommand?.({
    name: "skillusage",
    description: "Show skill usage rankings, sync cloud state, and manage shared usage spaces.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => plugin.runCommand(ctx.args),
  });

  api.registerTool?.({
    ...skillUsageToolDefinition,
    execute: async (_id, params) => plugin.executeTool(params),
  });
}
