"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  HEALTH_CHECK_TIMEOUT_MS,
  databaseIsHealthy
} = require("../dist/health/database-check.js");
const { createHealthHandler } = require("../dist/health/handler.js");
const { parsePostgresPort } = require("../dist/database/knex.js");

function makeContext() {
  const messages = [];
  return {
    messages,
    context: {
      invocationId: "test-invocation",
      log(message) {
        messages.push(String(message));
      }
    }
  };
}

test("health handler returns 200 and its endpoint-specific success body", async () => {
  const { context, messages } = makeContext();
  const handler = createHealthHandler(async () => true);

  const response = await handler({}, context);

  assert.equal(response.status, 200);
  assert.deepEqual(response.jsonBody, { status: "ok" });
  assert.equal(messages.length, 1);
  const successLog = JSON.parse(messages[0]);
  assert.deepEqual(Object.keys(successLog).sort(), ["durationMs", "event", "invocationId", "outcome"]);
  assert.equal(successLog.event, "health_check");
  assert.equal(successLog.invocationId, "test-invocation");
  assert.equal(successLog.outcome, "ok");
  assert.equal(Number.isFinite(successLog.durationMs), true);
});

test("database failure returns a sanitized RFC 9457 problem response", async () => {
  const { context, messages } = makeContext();
  const handler = createHealthHandler(async () => {
    throw new Error("password=do-not-leak postgres://private/db");
  });

  const response = await handler({}, context);

  assert.equal(response.status, 503);
  assert.equal(response.headers["content-type"], "application/problem+json");
  assert.deepEqual(response.jsonBody, {
    type: "about:blank",
    title: "Service Unavailable",
    status: 503,
    code: "HEALTH_CHECK_UNAVAILABLE"
  });
  assert.equal(JSON.stringify(response).includes("do-not-leak"), false);
  assert.equal(messages.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(messages[0])).sort(), [
    "durationMs",
    "event",
    "invocationId",
    "outcome"
  ]);
  assert.equal(messages[0].includes("do-not-leak"), false);
  assert.equal(messages[0].includes("postgres://"), false);
});

test("database failure maps to a generic 503 even when the probe returns false", async () => {
  const { context } = makeContext();
  const handler = createHealthHandler(async () => false);

  const response = await handler({}, context);

  assert.equal(response.status, 503);
  assert.equal(response.jsonBody.code, "HEALTH_CHECK_UNAVAILABLE");
});

test("database check enforces the configured three-second total deadline", async () => {
  assert.equal(HEALTH_CHECK_TIMEOUT_MS, 3000);
  const startedAt = Date.now();

  const result = await databaseIsHealthy(() => new Promise(() => {}));

  const elapsedMs = Date.now() - startedAt;
  assert.equal(result, false);
  assert.ok(elapsedMs >= 2800, `deadline returned too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 4000, `deadline exceeded tolerance: ${elapsedMs}ms`);
});

test("database check sanitizes query rejection into an unavailable result", async () => {
  const result = await databaseIsHealthy(async () => {
    throw new Error("raw postgres error with sensitive details");
  });

  assert.equal(result, false);
});

test("PostgreSQL port configuration accepts only valid TCP ports", () => {
  assert.equal(parsePostgresPort(undefined), 5432);
  assert.equal(parsePostgresPort("5433"), 5433);
  for (const invalidPort of ["", "0", "65536", "54ab"]) {
    assert.throws(
      () => parsePostgresPort(invalidPort),
      { message: "Database configuration is incomplete." }
    );
  }
});
