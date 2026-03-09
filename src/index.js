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

  const beforeHandler = async (payload) => {
    await plugin.onBeforeToolCall(payload);
  };
  const afterHandler = async (payload) => {
    await plugin.onAfterToolCall(payload);
  };

  // Runtime compatibility: support both event emitter hooks and registerHook API,
  // plus snake_case/camelCase names observed across versions.
  api.on?.("before_tool_call", beforeHandler);
  api.on?.("after_tool_call", afterHandler);
  api.on?.("beforeToolCall", beforeHandler);
  api.on?.("afterToolCall", afterHandler);

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
