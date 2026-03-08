import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureInstallationIdentity } from "../src/lib/plugin-config.js";

test("installation identity persists an override label", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "skill-usage-config-"));

  try {
    const identity = await ensureInstallationIdentity(tempDir, {
      installationLabel: "Mac-mini",
    });

    assert.equal(identity.installationLabel, "Mac-mini");

    const sameIdentity = await ensureInstallationIdentity(tempDir, {
      installationLabel: "MBP",
    });

    assert.equal(sameIdentity.installationId, identity.installationId);
    assert.equal(sameIdentity.installationLabel, "MBP");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
