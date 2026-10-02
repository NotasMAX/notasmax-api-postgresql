import { app } from "@azure/functions";
import { getKnex } from "../database/knex";
import { databaseIsHealthy } from "../health/database-check";
import { createHealthHandler } from "../health/handler";

const healthHandler = createHealthHandler(() =>
  databaseIsHealthy(() => Promise.resolve(getKnex().raw("SELECT 1")))
);

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "v1/health",
  handler: healthHandler
});
