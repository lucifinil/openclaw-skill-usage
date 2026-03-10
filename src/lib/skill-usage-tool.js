import { formatStatus, formatTopResult } from "./skill-usage-presenter.js";

const PERIOD_VALUES = new Set(["1d", "7d", "30d", "all"]);
const ACTION_VALUES = new Set(["top", "status"]);
const FORMAT_VALUES = new Set(["compact", "detail"]);

function normalizePeriod(period) {
  if (!period) {
    return "all";
  }

  if (!PERIOD_VALUES.has(period)) {
    throw new Error(`Unsupported period "${period}". Use 1d, 7d, 30d, or all.`);
  }

  return period;
}

function normalizeFormat(format) {
  if (!format) return "compact";
  if (!FORMAT_VALUES.has(format)) {
    throw new Error(`Unsupported format "${format}". Use compact or detail.`);
  }
  return format;
}

function normalizeLimit(limit) {
  if (limit == null) {
    return 10;
  }

  const parsed = Number(limit);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 25) {
    throw new Error("Limit must be an integer between 1 and 25.");
  }

  return parsed;
}

export const skillUsageToolDefinition = {
  name: "skill_usage_stats",
  description:
    "Read OpenClaw skill usage analytics. Use this to answer which skills are used most, compare 1d/7d/30d/all-time rankings, or explain usage by installation, routed agent, and channel account.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["top", "status"],
        description: "top returns ranked skills; status returns usage-space and cloud-sync details.",
      },
      period: {
        type: "string",
        enum: ["1d", "7d", "30d", "all"],
        description: "Ranking window for action=top.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 25,
        description: "Maximum number of ranked skills to return for action=top.",
      },
      format: {
        type: "string",
        enum: ["compact", "detail"],
        description: "Output style for top results. Defaults to compact.",
      },
    },
    required: ["action"],
  },
};

export async function executeSkillUsageTool({ cloud, params }) {
  const action = params?.action;

  if (!ACTION_VALUES.has(action)) {
    throw new Error(`Unsupported action "${action}". Use top or status.`);
  }

  if (action === "status") {
    const status = await cloud.getStatusWithFallback();
    return {
      content: [
        {
          type: "text",
          text: formatStatus(status),
        },
      ],
    };
  }

  const result = await cloud.queryTopSkillsWithFallback({
    periodKey: normalizePeriod(params?.period),
    limit: normalizeLimit(params?.limit),
  });

  return {
    content: [
      {
        type: "text",
        text: formatTopResult(result, { format: normalizeFormat(params?.format) }),
      },
    ],
  };
}
