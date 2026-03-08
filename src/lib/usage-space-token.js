const TOKEN_PREFIX = "ocsu1_";

export function encodeUsageSpaceToken(payload) {
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      ...payload,
    }),
    "utf8",
  ).toString("base64url");

  return `${TOKEN_PREFIX}${body}`;
}

export function decodeUsageSpaceToken(token) {
  if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) {
    throw new Error("Expected an OpenClaw skill usage token that starts with ocsu1_.");
  }

  const body = token.slice(TOKEN_PREFIX.length);
  let parsed;

  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("The usage space token is not valid base64url JSON.");
  }

  if (parsed?.version !== 1) {
    throw new Error(`Unsupported usage space token version: ${parsed?.version ?? "unknown"}.`);
  }

  if (!parsed?.usageSpaceId || !parsed?.databaseName || !parsed?.zero) {
    throw new Error("The usage space token is missing required connection details.");
  }

  return parsed;
}
