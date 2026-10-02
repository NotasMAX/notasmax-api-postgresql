const { spawnSync } = require("node:child_process");

const result = spawnSync(
  process.execPath,
  [
    "--require",
    "./test/load-local-settings.cjs",
    "--test",
    "./test/postgres.integration.test.cjs"
  ],
  {
    stdio: "inherit",
    env: { ...process.env, RUN_POSTGRES_INTEGRATION: "1" }
  }
);

if (result.error) {
  process.stderr.write("Could not start the PostgreSQL integration test.\n");
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
