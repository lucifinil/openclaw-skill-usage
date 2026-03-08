import { createSkillUsagePlugin } from "./lib/skill-usage-plugin.js";

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

  api.registerHook(
    "before_tool_call",
    async (payload) => {
      await plugin.onBeforeToolCall(payload);
    },
    {
      name: "skill-usage.before-tool-call",
      description: "Observes skill file reads before the tool executes.",
    },
  );

  api.registerHook(
    "after_tool_call",
    async (payload) => {
      await plugin.onAfterToolCall(payload);
    },
    {
      name: "skill-usage.after-tool-call",
      description: "Finalizes and records skill usage observations after the tool executes.",
    },
  );
}
