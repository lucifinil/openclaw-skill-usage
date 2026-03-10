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

  api.on?.("before_tool_call", async (payload) => {
    api.logger?.info?.(
      `[skill-usage-debug] before_tool_call tool=${payload?.toolName ?? "unknown"} runId=${payload?.runId ?? ""}`,
    );
    await plugin.onBeforeToolCall(payload);
  });

  api.on?.("after_tool_call", async (payload) => {
    api.logger?.info?.(
      `[skill-usage-debug] after_tool_call tool=${payload?.toolName ?? "unknown"} runId=${payload?.runId ?? ""}`,
    );
    await plugin.onAfterToolCall(payload);
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
