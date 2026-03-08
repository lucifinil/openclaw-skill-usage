import { randomUUID } from "node:crypto";

const ZERO_API_URL = "https://zero.tidbapi.com/v1alpha1/instances";

function buildApiErrorMessage(status, payload, retryAfter) {
  const detail =
    payload?.error?.message ??
    payload?.message ??
    payload?.error ??
    `TiDB Cloud Zero provisioning failed with HTTP ${status}.`;

  if (retryAfter) {
    return `${detail} Retry after ${retryAfter}.`;
  }

  return detail;
}

function normalizeZeroInstance(payload) {
  const instance = payload?.instance;

  if (!instance?.id || !instance?.connectionString || !instance?.connection) {
    throw new Error("TiDB Cloud Zero returned an incomplete instance payload.");
  }

  return {
    instanceId: instance.id,
    connectionString: instance.connectionString,
    host: instance.connection.host,
    port: Number(instance.connection.port),
    username: instance.connection.username,
    password: instance.connection.password,
    claimUrl: instance.claimInfo?.claimUrl ?? null,
    expiresAt: instance.expiresAt ?? null,
    provisionedAt: new Date().toISOString(),
    source: "local",
  };
}

export async function provisionZeroInstance({
  tag,
  idempotencyKey = `openclaw-skill-usage-${randomUUID()}`,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Global fetch is not available, so TiDB Cloud Zero cannot be provisioned.");
  }

  const response = await fetchImpl(ZERO_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      tag,
    }),
  });

  let payload = null;

  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    throw new Error(buildApiErrorMessage(response.status, payload, retryAfter));
  }

  return normalizeZeroInstance(payload);
}
