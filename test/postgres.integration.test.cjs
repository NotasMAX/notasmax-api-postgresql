"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { closeKnex, getKnex } = require("../dist/database/knex.js");

test("PostgreSQL integration executes SELECT 1", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "1"
}, async (t) => {
  const database = getKnex();
  t.after(async () => {
    await closeKnex();
  });

  let result;
  try {
    result = await database.raw("SELECT 1 AS value");
  } catch {
    assert.fail("PostgreSQL integration query failed; verify the test database is available.");
  }

  assert.equal(Number(result.rows[0].value), 1);
});
