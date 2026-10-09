"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const argon2 = require("argon2");
const { createAuthHandlers, requireAdminSession } = require("../dist/auth/handler.js");
const { createLoginSession } = require("../dist/auth/session-service.js");

const allowedOrigin = "http://localhost:5173";
const password = "synthetic-unit-password-123";
const loginBody = { email: "admin@example.test", password };

function request(method, headers = {}, body, bodyStream) {
  let jsonCalls = 0;
  return {
    method,
    headers: new Headers(headers),
    body: bodyStream,
    async json() {
      jsonCalls += 1;
      if (body instanceof Error) throw body;
      return body;
    },
    get jsonCalls() { return jsonCalls; }
  };
}

function assertProblem(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers["content-type"], "application/problem+json");
  assert.equal(response.jsonBody.type, "about:blank");
  assert.equal(response.jsonBody.status, status);
  if (code) assert.equal(response.jsonBody.code, code);
  return response.jsonBody;
}

const noContext = { log() { throw new Error("Auth handler must not log request data."); } };

test("login and logout reject absent, null, and disallowed Origin before body or database access", async () => {
  let databaseCalls = 0;
  const handlers = createAuthHandlers({
    getDatabase() { databaseCalls += 1; throw new Error("must not access database"); },
    allowedOrigins: [allowedOrigin]
  });

  for (const origin of [undefined, "null", "https://attacker.example.test"]) {
    const headers = { "x-requested-with": "XMLHttpRequest" };
    if (origin !== undefined) headers.origin = origin;
    const loginRequest = request("POST", headers, loginBody);
    const login = await handlers.createSession(loginRequest, noContext);
    assertProblem(login, 403, "ORIGIN_NOT_ALLOWED");
    assert.equal(loginRequest.jsonCalls, 0);

    const logout = await handlers.deleteCurrentSession(request("DELETE", headers), noContext);
    assertProblem(logout, 403, "ORIGIN_NOT_ALLOWED");
    assert.equal(JSON.stringify([login, logout]).includes(origin || "missing-origin"), false);
  }

  assert.equal(databaseCalls, 0);
});

test("login and logout require the exact custom header before database access", async () => {
  let databaseCalls = 0;
  const handlers = createAuthHandlers({
    getDatabase() { databaseCalls += 1; throw new Error("must not access database"); },
    allowedOrigins: [allowedOrigin]
  });

  for (const value of [undefined, "not-xml-http-request"]) {
    const headers = { origin: allowedOrigin };
    if (value !== undefined) headers["x-requested-with"] = value;
    const loginRequest = request("POST", headers, loginBody);
    assertProblem(await handlers.createSession(loginRequest, noContext), 403, "REQUEST_HEADER_REQUIRED");
    assert.equal(loginRequest.jsonCalls, 0);
    assertProblem(await handlers.deleteCurrentSession(request("DELETE", headers), noContext), 403,
      "REQUEST_HEADER_REQUIRED");
  }

  assert.equal(databaseCalls, 0);
});

test("login reuses shared JSON validation for malformed and invalid input without accessing the database", async () => {
  let databaseCalls = 0;
  const handlers = createAuthHandlers({
    getDatabase() { databaseCalls += 1; throw new Error("must not access database"); },
    allowedOrigins: [allowedOrigin]
  });
  const headers = { origin: allowedOrigin, "x-requested-with": "XMLHttpRequest" };

  const malformed = request("POST", headers, new SyntaxError("private-parser-error"));
  const malformedResponse = await handlers.createSession(malformed, noContext);
  assertProblem(malformedResponse, 400, "VALIDATION_ERROR");
  assert.equal(JSON.stringify(malformedResponse).includes("private-parser-error"), false);

  const invalid = request("POST", headers, {
    email: "private-invalid-email",
    password: "short-secret"
  });
  const invalidResponse = await handlers.createSession(invalid, noContext);
  const body = assertProblem(invalidResponse, 422, "VALIDATION_ERROR");
  assert.deepEqual(body.errors.map((entry) => entry.code), ["INVALID_FORMAT", "VALUE_OUT_OF_RANGE"]);
  assert.equal(JSON.stringify(invalidResponse).includes("private-invalid-email"), false);
  assert.equal(JSON.stringify(invalidResponse).includes("short-secret"), false);
  assert.equal(databaseCalls, 0);
});

test("bounded login streams preserve malformed JSON and ordinary validation responses", async () => {
  let databaseCalls = 0;
  const handlers = createAuthHandlers({
    getDatabase() { databaseCalls += 1; throw new Error("must not access database"); },
    allowedOrigins: [allowedOrigin]
  });
  const headers = {
    origin: allowedOrigin,
    "x-requested-with": "XMLHttpRequest"
  };
  const streamFor = (text) => {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      }
    }, { highWaterMark: 0 });
  };
  const malformedRequest = request("POST", headers, undefined, streamFor('{"email":'));
  const malformed = await handlers.createSession(malformedRequest, noContext);
  assertProblem(malformed, 400, "VALIDATION_ERROR");
  assert.equal(malformed.jsonBody.detail, "O corpo da requisição não contém um JSON válido.");
  assert.equal(malformedRequest.jsonCalls, 0);

  const invalidRequest = request("POST", headers, undefined, streamFor(JSON.stringify({
    email: "private-invalid-email",
    password: "short-secret"
  })));
  const invalid = await handlers.createSession(invalidRequest, noContext);
  const invalidBody = assertProblem(invalid, 422, "VALIDATION_ERROR");
  assert.deepEqual(invalidBody.errors.map((entry) => entry.code), ["INVALID_FORMAT", "VALUE_OUT_OF_RANGE"]);
  assert.equal(invalidRequest.jsonCalls, 0);
  assert.equal(JSON.stringify([malformed, invalid]).includes("private-invalid-email"), false);
  assert.equal(JSON.stringify([malformed, invalid]).includes("short-secret"), false);
  assert.equal(databaseCalls, 0);
});

test("login rejects a declared oversized body before reading it or accessing the database", async () => {
  let bodyReadCount = 0;
  let databaseCalls = 0;
  const bodyStream = new ReadableStream({
    pull() {
      bodyReadCount += 1;
      throw new Error("oversized request body should not be read");
    }
  }, { highWaterMark: 0 });
  const handlers = createAuthHandlers({
    getDatabase() { databaseCalls += 1; throw new Error("must not access database"); },
    allowedOrigins: [allowedOrigin]
  });
  const loginRequest = request("POST", {
    origin: allowedOrigin,
    "x-requested-with": "XMLHttpRequest",
    "content-length": String(8 * 1024 + 1)
  }, undefined, bodyStream);

  const response = await handlers.createSession(loginRequest, noContext);

  assert.equal(response.status, 413);
  assert.equal(response.headers["content-type"], "application/problem+json");
  assert.deepEqual(response.jsonBody, {
    type: "about:blank",
    title: "Conteúdo muito grande",
    status: 413,
    detail: "O corpo da requisição excede o tamanho máximo permitido."
  });
  assert.equal(bodyReadCount, 0);
  assert.equal(loginRequest.jsonCalls, 0);
  assert.equal(databaseCalls, 0);
});

test("login enforces the byte limit when Content-Length is absent or underreported", async () => {
  const rejectedMarker = "synthetic-oversized-credential";
  const encodeLoginPayload = (unexpected) => new TextEncoder().encode(JSON.stringify({
    email: `${rejectedMarker}@example.test`,
    password: `short-${rejectedMarker}`,
    unexpected
  }));
  const utf8Payload = JSON.stringify({ email: "a@example.test", password: "synthetic-password", unexpected: "é".repeat(4200) });
  const escapedPayload = JSON.stringify({ email: "a@example.test", password: "synthetic-password", unexpected: String.fromCharCode(0).repeat(1500) });
  assert.ok(utf8Payload.length < 8 * 1024);
  assert.ok(new TextEncoder().encode(utf8Payload).byteLength > 8 * 1024);
  assert.ok(escapedPayload.length > 8 * 1024);
  const oversizedBodies = [
    encodeLoginPayload("x".repeat(9 * 1024)),
    encodeLoginPayload("é".repeat(4200)),
    encodeLoginPayload(String.fromCharCode(0).repeat(1500))
  ];
  assert.ok(oversizedBodies.every((body) => body.byteLength > 8 * 1024));

  for (const bodyBytes of oversizedBodies) {
    for (const contentLength of [undefined, "1"]) {
      let cancelled = false;
      let pullCount = 0;
      let databaseCalls = 0;
      const splitAt = Math.floor(8 * 1024 / 2);
      const chunks = [bodyBytes.subarray(0, splitAt), bodyBytes.subarray(splitAt)];
      let chunkIndex = 0;
      const headers = {
        origin: allowedOrigin,
        "x-requested-with": "XMLHttpRequest"
      };
      if (contentLength !== undefined) headers["content-length"] = contentLength;
      const bodyStream = new ReadableStream({
        pull(controller) {
          pullCount += 1;
          if (chunkIndex < chunks.length) controller.enqueue(chunks[chunkIndex++]);
          else controller.close();
        },
        cancel() { cancelled = true; }
      }, { highWaterMark: 0 });
      const handlers = createAuthHandlers({
        getDatabase() { databaseCalls += 1; throw new Error("must not access database"); },
        allowedOrigins: [allowedOrigin]
      });
      const loginRequest = request("POST", headers, undefined, bodyStream);

      const response = await handlers.createSession(loginRequest, noContext);

      assert.equal(response.status, 413);
      assert.equal(response.headers["content-type"], "application/problem+json");
      assert.equal(response.jsonBody.code, undefined);
      assert.equal(loginRequest.jsonCalls, 0);
      assert.equal(pullCount, 2);
      assert.equal(cancelled, true);
      assert.equal(databaseCalls, 0);
      assert.equal(JSON.stringify(response).includes(rejectedMarker), false);
    }
  }
});

test("the reusable administrator guard denies a missing or ambiguous cookie without database access", async () => {
  let databaseCalls = 0;
  for (const cookie of [undefined, "other=synthetic", "notasmax_session=bad", "notasmax_session=abc; notasmax_session=def"]) {
    const headers = new Headers();
    if (cookie !== undefined) headers.set("cookie", cookie);
    const result = await requireAdminSession({ headers }, () => {
      databaseCalls += 1;
      throw new Error("must not access database");
    });
    assert.equal(result.authorized, false);
    assertProblem(result.response, 401, "AUTHENTICATION_REQUIRED");
    assert.equal(result.response.headers["www-authenticate"], "NotasMAX-Session");
    assert.equal(result.response.headers["cache-control"], "no-store");
  }
  assert.equal(databaseCalls, 0);
});

test("unknown-email login invokes Argon2 verification with the approved dummy hash", async () => {
  const query = {
    select() { return this; },
    where() { return this; },
    whereNull() { return this; },
    forUpdate() { return this; },
    async first() { return undefined; }
  };
  const transaction = Object.assign(() => query, { raw: async () => undefined });
  const knex = { transaction: async (callback) => callback(transaction) };
  const originalVerify = argon2.verify;
  const hashes = [];
  argon2.verify = async (hash, candidate, ...rest) => {
    hashes.push(String(hash));
    return originalVerify(hash, candidate, ...rest);
  };

  try {
    assert.deepEqual(await createLoginSession(knex, {
      email: "unknown@example.test",
      password
    }), { success: false });
  } finally {
    argon2.verify = originalVerify;
  }

  assert.equal(hashes.length, 1);
  assert.match(hashes[0], /^\$argon2id\$v=19\$m=19456,(?:p=1,t=2|t=2,p=1)\$/);
});

test("administrator guard sanitizes unexpected database errors for future protected handlers", async () => {
  const rawError = "postgres://private-user:private-password@db.example.test/private-db";
  const result = await requireAdminSession({
    headers: new Headers({ cookie: `notasmax_session=${"A".repeat(43)}` })
  }, () => ({
    async transaction() { throw new Error(rawError); }
  }));

  assert.equal(result.authorized, false);
  assertProblem(result.response, 500);
  assert.equal(JSON.stringify(result.response).includes(rawError), false);
});

test("unexpected database errors become sanitized RFC 9457 responses without logs", async () => {
  const privateValues = [
    "synthetic-db-password",
    "synthetic-session-secret",
    "private@example.test",
    "203.0.113.42",
    "SELECT * FROM usuario",
    "raw-driver-stack"
  ];
  const handlers = createAuthHandlers({
    getDatabase() {
      return {
        async transaction() {
          throw new Error(privateValues.join(" "));
        }
      };
    },
    allowedOrigins: [allowedOrigin]
  });
  const response = await handlers.createSession(request("POST", {
    origin: allowedOrigin,
    "x-requested-with": "XMLHttpRequest"
  }, loginBody), noContext);

  const body = assertProblem(response, 500);
  assert.equal(body.code, undefined);
  assert.equal(body.detail, "Não foi possível concluir a solicitação.");
  const serialized = JSON.stringify(response);
  for (const value of privateValues) assert.equal(serialized.includes(value), false);
});
