"use strict";

const assert = require("node:assert/strict");
const { createHash, randomBytes } = require("node:crypto");
const path = require("node:path");
const { test } = require("node:test");
const argon2 = require("argon2");
const knexFactory = require("knex");
const { Client } = require("pg");
const { assertLoopbackHost } = require("../src/database/local-only.cjs");
const { createInitialAdmin } = require("../seed/admin.cjs");
const { createAuthHandlers, requireAdminSession } = require("../dist/auth/handler.js");

const AUTH_ORIGIN = "http://localhost:5173";
const AUTH_PASSWORD = "synthetic-valid-admin-password";

const EXPECTED_DOMAIN_TABLES = [
  "aluno",
  "foto_perfil",
  "materia",
  "matricula",
  "professor",
  "resultado",
  "sessao",
  "simulado",
  "simulado_aluno",
  "simulado_disciplina",
  "token_ativacao",
  "token_redefinicao_senha",
  "turma",
  "turma_disciplina",
  "turma_disciplina_professor",
  "usuario"
];

function connectionFromEnvironment(database) {
  const host = process.env.PGHOST || "127.0.0.1";
  assertLoopbackHost(host);
  return {
    host,
    port: Number(process.env.PGPORT || 5432),
    database,
    user: process.env.PGUSER || "notasmax",
    password: process.env.PGPASSWORD,
    application_name: "notasmax-v1-integration-test"
  };
}

function makeKnex(connection) {
  return knexFactory({
    client: "pg",
    connection,
    pool: { min: 0, max: 2, acquireTimeoutMillis: 5000 },
    migrations: { tableName: "knex_migrations", extension: "js" }
  });
}

let identityCounter = 0;
function newIdentity(prefix) {
  identityCounter += 1;
  return `${prefix}-${process.pid}-${identityCounter}@example.test`;
}

async function insertUser(transaction, { profile = "administrador", email, pendingEmail = null, name = "Synthetic User" }) {
  const [row] = await transaction("usuario")
    .insert({
      tipo_perfil: profile,
      nome_completo: name,
      email_institucional: email,
      email_pendente: pendingEmail,
      ativado_em: transaction.raw("CURRENT_TIMESTAMP")
    })
    .returning("id_usuario");
  return row.id_usuario;
}

async function insertStudent(database, email = newIdentity("student")) {
  return database.transaction(async (transaction) => {
    const id = await insertUser(transaction, { profile: "aluno", email });
    await transaction("aluno").insert({ id_usuario: id, telefone_responsavel: "+5511999990000" });
    return id;
  });
}

async function insertProfessor(database, email = newIdentity("professor")) {
  return database.transaction(async (transaction) => {
    const id = await insertUser(transaction, { profile: "professor", email });
    await transaction("professor").insert({ id_usuario: id });
    return id;
  });
}

function authRequest(method, { origin = AUTH_ORIGIN, requestedWith = "XMLHttpRequest", cookie, body, forwardedFor } = {}) {
  const headers = new Headers();
  if (origin !== undefined) headers.set("origin", origin);
  if (requestedWith !== undefined) headers.set("x-requested-with", requestedWith);
  if (cookie !== undefined) headers.set("cookie", `notasmax_session=${cookie}`);
  if (forwardedFor !== undefined) headers.set("x-forwarded-for", forwardedFor);
  return { method, headers, json: async () => body };
}

function authHandlers(database) {
  return createAuthHandlers({
    getDatabase: () => database,
    allowedOrigins: [AUTH_ORIGIN]
  });
}

function sessionCookie(response) {
  return response.cookies && response.cookies.find((cookie) => cookie.name === "notasmax_session");
}

async function insertAuthAdministrator(database, { email = newIdentity("auth-admin"), password = AUTH_PASSWORD, name = "Synthetic Auth Administrator" } = {}) {
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19 * 1024,
    timeCost: 2,
    parallelism: 1
  });
  const id = await database.transaction(async (transaction) => {
    const userId = await insertUser(transaction, { profile: "administrador", email, name });
    await transaction("usuario").where({ id_usuario: userId }).update({ hash_senha: passwordHash });
    return userId;
  });
  return { id, email, password, passwordHash };
}

async function insertAuthSession(database, idUsuario) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest();
  const { rows } = await database.raw("SELECT clock_timestamp() AS database_now");
  const now = new Date(rows[0].database_now);
  await database("sessao").insert({
    id_usuario: idUsuario,
    hash_token_sha256: tokenHash,
    criada_em: now,
    ultima_atividade_em: now,
    expira_em: new Date(now.getTime() + 15 * 60 * 1000),
    expira_absoluta_em: new Date(now.getTime() + 8 * 60 * 60 * 1000)
  });
  return token;
}

function expectPgCode(promise, code) {
  return assert.rejects(promise, (error) => {
    if (!error) return false;
    return typeof code === "function" ? code(error) : error.code === code;
  });
}

test("V1 schema, admin auth/session lifecycle, concurrency, and seed use a disposable PostgreSQL database", {
  skip: process.env.RUN_POSTGRES_INTEGRATION !== "1"
}, async (t) => {
  const configuredDatabase = process.env.PGDATABASE || "notasmax";
  const maintenance = connectionFromEnvironment("postgres");
  let maintenanceClient;
  let database;
  let secondConnection;
  let generatedDatabase;
  let databaseCreated = false;

  try {
    maintenanceClient = new Client(maintenance);
    await maintenanceClient.connect();
    const serverVersion = await maintenanceClient.query("SHOW server_version");
    assert.match(serverVersion.rows[0].server_version, /^18\.6(?:[ .]|$)/);

    generatedDatabase = `notasmax_it_${process.pid}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
    if (generatedDatabase === configuredDatabase || !/^notasmax_it_[a-z0-9_]+$/.test(generatedDatabase)) {
      throw new Error("Disposable database name did not pass the safety check.");
    }
    await maintenanceClient.query(`CREATE DATABASE "${generatedDatabase}"`);
    databaseCreated = true;

    const targetConnection = connectionFromEnvironment(generatedDatabase);
    database = makeKnex(targetConnection);
    secondConnection = makeKnex(targetConnection);

    const [batch, migrations] = await database.migrate.latest({
      directory: path.resolve(__dirname, "../migrations"),
      extension: "js"
    });
    assert.equal(batch, 1);
    assert.equal(migrations.length, 3);

    await t.test("admin login creates hash-only session, rotates it on login, and logout revokes it", async () => {
      const account = await insertAuthAdministrator(database);
      await database("usuario").where({ id_usuario: account.id }).update({
        falhas_login_na_janela: 2,
        inicio_janela_falhas_login: database.raw("clock_timestamp() - INTERVAL '1 minute'")
      });
      const handlers = authHandlers(database);
      const login = await handlers.createSession(authRequest("POST", {
        body: { email: account.email, password: account.password },
        forwardedFor: "203.0.113.55"
      }), {});

      assert.equal(login.status, 200);
      assert.deepEqual(login.jsonBody, {
        user: {
          id: String(account.id),
          displayName: "Synthetic Auth Administrator",
          profile: "administrador"
        }
      });
      assert.deepEqual(Object.keys(login.jsonBody.user).sort(), ["displayName", "id", "profile"]);
      assert.equal(login.headers["cache-control"], "no-store");
      const firstCookie = sessionCookie(login);
      assert.ok(firstCookie);
      assert.equal(firstCookie.httpOnly, true);
      assert.equal(firstCookie.secure, true);
      assert.equal(firstCookie.sameSite, "None");
      assert.equal(firstCookie.path, "/api/v1/auth");
      assert.equal(firstCookie.maxAge, 8 * 60 * 60);
      assert.equal(firstCookie.domain, undefined);

      const firstSession = await database("sessao").where({ id_usuario: account.id }).first();
      const expectedHash = createHash("sha256").update(firstCookie.value).digest();
      assert.equal(Buffer.isBuffer(firstSession.hash_token_sha256), true);
      assert.equal(firstSession.hash_token_sha256.equals(expectedHash), true);
      assert.notEqual(firstSession.hash_token_sha256.toString("utf8"), firstCookie.value);
      assert.equal(new Date(firstSession.expira_em).getTime() - new Date(firstSession.criada_em).getTime(),
        15 * 60 * 1000);
      assert.equal(new Date(firstSession.expira_absoluta_em).getTime() - new Date(firstSession.criada_em).getTime(),
        8 * 60 * 60 * 1000);
      const resetAccount = await database("usuario").where({ id_usuario: account.id }).first(
        "falhas_login_na_janela", "inicio_janela_falhas_login", "bloqueado_ate"
      );
      assert.equal(resetAccount.falhas_login_na_janela, 0);
      assert.equal(resetAccount.inicio_janela_falhas_login, null);
      assert.equal(resetAccount.bloqueado_ate, null);
      const loginPublic = JSON.stringify({ headers: login.headers, jsonBody: login.jsonBody });
      for (const secret of [account.email, account.password, account.passwordHash, firstCookie.value, "203.0.113.55"]) {
        assert.equal(loginPublic.includes(secret), false);
      }

      const me = await handlers.currentSession(authRequest("GET", { cookie: firstCookie.value }), {});
      assert.equal(me.status, 200);
      assert.deepEqual(me.jsonBody, login.jsonBody);
      assert.equal(me.headers["cache-control"], "no-store");
      const guard = await requireAdminSession({
        headers: new Headers({ cookie: `notasmax_session=${firstCookie.value}` })
      }, () => database);
      assert.equal(guard.authorized, true);
      assert.deepEqual(guard.user, login.jsonBody.user);
      const rotated = await handlers.createSession(authRequest("POST", {
        cookie: firstCookie.value,
        body: { email: account.email, password: account.password }
      }), {});
      assert.equal(rotated.status, 200);
      const secondCookie = sessionCookie(rotated);
      assert.ok(secondCookie);
      assert.notEqual(secondCookie.value, firstCookie.value);
      const firstAfterRotation = await database("sessao").where({ id_sessao: firstSession.id_sessao }).first();
      assert.notEqual(firstAfterRotation.revogada_em, null);

      const logout = await handlers.deleteCurrentSession(authRequest("DELETE", {
        cookie: secondCookie.value
      }), {});
      assert.equal(logout.status, 204);
      assert.equal(logout.headers["cache-control"], "no-store");
      assert.deepEqual(sessionCookie(logout), {
        name: "notasmax_session",
        value: "",
        path: "/api/v1/auth",
        httpOnly: true,
        secure: true,
        sameSite: "None",
        maxAge: 0
      });
      const secondHash = createHash("sha256").update(secondCookie.value).digest();
      const secondSession = await database("sessao").where({ hash_token_sha256: secondHash }).first();
      assert.notEqual(secondSession.revogada_em, null);
      const afterLogout = await handlers.currentSession(authRequest("GET", { cookie: secondCookie.value }), {});
      assert.equal(afterLogout.status, 401);
      assert.equal(afterLogout.headers["www-authenticate"], "NotasMAX-Session");
      assert.equal(afterLogout.headers["cache-control"], "no-store");
    });

    await t.test("login failures are generic for unknown, invalid, inactive, deleted, and locked accounts", async () => {
      const handlers = authHandlers(database);
      const wrongPassword = "synthetic-wrong-admin-password";
      const active = await insertAuthAdministrator(database, { email: newIdentity("auth-wrong") });
      const inactive = await insertAuthAdministrator(database, { email: newIdentity("auth-inactive") });
      const deleted = await insertAuthAdministrator(database, { email: newIdentity("auth-deleted") });
      const locked = await insertAuthAdministrator(database, { email: newIdentity("auth-locked") });
      const malformedHash = await insertAuthAdministrator(database, { email: newIdentity("auth-malformed-hash") });
      await database("usuario").where({ id_usuario: inactive.id }).update({ ativado_em: null });
      await database("usuario").where({ id_usuario: deleted.id }).update({ excluido_em: database.raw("clock_timestamp()") });
      await database("usuario").where({ id_usuario: locked.id }).update({
        bloqueado_ate: database.raw("clock_timestamp() + INTERVAL '15 minutes'")
      });
      await database("usuario").where({ id_usuario: malformedHash.id }).update({
        hash_senha: "synthetic-malformed-password-hash"
      });

      const publicFailures = [];
      publicFailures.push(await handlers.createSession(authRequest("POST", {
        body: { email: active.email, password: wrongPassword }
      }), {}));

      const originalVerify = argon2.verify;
      const dummyVerifications = [];
      argon2.verify = async (hash, password, ...rest) => {
        dummyVerifications.push(String(hash));
        return originalVerify(hash, password, ...rest);
      };
      try {
        publicFailures.push(await handlers.createSession(authRequest("POST", {
          body: { email: newIdentity("auth-unknown"), password: AUTH_PASSWORD }
        }), {}));
      } finally {
        argon2.verify = originalVerify;
      }
      assert.equal(dummyVerifications.length, 1);
      assert.match(dummyVerifications[0], /^\$argon2id\$v=19\$m=19456,(?:p=1,t=2|t=2,p=1)\$/);
      assert.notEqual(dummyVerifications[0], active.passwordHash);

      for (const account of [inactive, deleted, locked, malformedHash]) {
        publicFailures.push(await handlers.createSession(authRequest("POST", {
          body: { email: account.email, password: account.password }
        }), {}));
      }
      assert.equal(publicFailures.length, 6);
      for (const response of publicFailures) {
        assert.equal(response.status, 401);
        assert.equal(response.headers["content-type"], "application/problem+json");
        assert.equal(response.headers["www-authenticate"], "NotasMAX-Session");
        assert.equal(response.headers["cache-control"], "no-store");
        assert.deepEqual(response.jsonBody, publicFailures[0].jsonBody);
        assert.equal(response.cookies, undefined);
      }
      const serialized = JSON.stringify(publicFailures);
      for (const privateValue of [
        active.email, inactive.email, deleted.email, locked.email,
        active.password, wrongPassword, active.passwordHash, "203.0.113.55", "synthetic-malformed-password-hash"
      ]) assert.equal(serialized.includes(privateValue), false);
    });

    await t.test("account lockout enforces the fifth failure, window boundary, expiry, and success reset", async () => {
      const account = await insertAuthAdministrator(database, { email: newIdentity("auth-lockout") });
      const handlers = authHandlers(database);
      const invalidLogin = () => handlers.createSession(authRequest("POST", {
        body: { email: account.email, password: "synthetic-wrong-admin-password" }
      }), {});

      for (let attempt = 0; attempt < 4; attempt += 1) {
        assert.equal((await invalidLogin()).status, 401);
      }
      let stored = await database("usuario").where({ id_usuario: account.id }).first(
        "falhas_login_na_janela", "inicio_janela_falhas_login", "bloqueado_ate"
      );
      assert.equal(stored.falhas_login_na_janela, 4);
      assert.equal(stored.bloqueado_ate, null);

      assert.equal((await invalidLogin()).status, 401);
      stored = await database("usuario").where({ id_usuario: account.id }).first(
        "falhas_login_na_janela", "inicio_janela_falhas_login", "bloqueado_ate"
      );
      assert.equal(stored.falhas_login_na_janela, 5);
      const lockCheck = await database.raw(
        "SELECT bloqueado_ate > clock_timestamp() AS active FROM usuario WHERE id_usuario = ?",
        [account.id]
      );
      assert.equal(lockCheck.rows[0].active, true);
      assert.equal((await handlers.createSession(authRequest("POST", {
        body: { email: account.email, password: account.password }
      }), {})).status, 401);
      stored = await database("usuario").where({ id_usuario: account.id }).first("falhas_login_na_janela");
      assert.equal(stored.falhas_login_na_janela, 5);

      await database.raw(`
        UPDATE usuario
        SET bloqueado_ate = clock_timestamp() - INTERVAL '1 second',
            inicio_janela_falhas_login = clock_timestamp() - INTERVAL '15 minutes'
        WHERE id_usuario = ?
      `, [account.id]);
      assert.equal((await invalidLogin()).status, 401);
      stored = await database("usuario").where({ id_usuario: account.id }).first(
        "falhas_login_na_janela", "inicio_janela_falhas_login", "bloqueado_ate"
      );
      assert.equal(stored.falhas_login_na_janela, 1);
      assert.equal(stored.bloqueado_ate, null);

      await database("usuario").where({ id_usuario: account.id }).update({
        falhas_login_na_janela: 3,
        inicio_janela_falhas_login: database.raw("clock_timestamp() - INTERVAL '1 minute'"),
        bloqueado_ate: null
      });
      const success = await handlers.createSession(authRequest("POST", {
        body: { email: account.email, password: account.password }
      }), {});
      assert.equal(success.status, 200);
      stored = await database("usuario").where({ id_usuario: account.id }).first(
        "falhas_login_na_janela", "inicio_janela_falhas_login", "bloqueado_ate"
      );
      assert.equal(stored.falhas_login_na_janela, 0);
      assert.equal(stored.inicio_janela_falhas_login, null);
      assert.equal(stored.bloqueado_ate, null);
    });

    await t.test("shared administrator guard distinguishes active non-admin sessions and avoids cache", async () => {
      const studentId = await insertStudent(database, newIdentity("auth-student"));
      const studentToken = await insertAuthSession(database, studentId);
      const result = await requireAdminSession({
        headers: new Headers({ cookie: `notasmax_session=${studentToken}` })
      }, () => database);
      assert.equal(result.authorized, false);
      assert.equal(result.response.status, 404);
      assert.equal(result.response.jsonBody.code, "RESOURCE_NOT_FOUND");
      assert.equal(result.response.headers["cache-control"], "no-store");
      assert.equal(JSON.stringify(result.response).includes(studentToken), false);

      const handlers = authHandlers(database);
      const response = await handlers.currentSession(authRequest("GET", { cookie: studentToken }), {});
      assert.equal(response.status, 404);
      assert.equal(response.jsonBody.code, "RESOURCE_NOT_FOUND");
      assert.equal(response.headers["cache-control"], "no-store");
    });

    await t.test("idle and absolute expiry invalidate sessions and sliding activity never exceeds the absolute limit", async () => {
      const account = await insertAuthAdministrator(database, { email: newIdentity("auth-expiry") });
      const handlers = authHandlers(database);
      const firstLogin = await handlers.createSession(authRequest("POST", {
        body: { email: account.email, password: account.password }
      }), {});
      const firstToken = sessionCookie(firstLogin).value;
      const firstHash = createHash("sha256").update(firstToken).digest();
      let firstSession = await database("sessao").where({ hash_token_sha256: firstHash }).first();
      await database.raw(`
        UPDATE sessao
        SET expira_em = clock_timestamp() - INTERVAL '1 second',
            expira_absoluta_em = clock_timestamp() + INTERVAL '1 hour'
        WHERE id_sessao = ?
      `, [firstSession.id_sessao]);
      const idleExpired = await handlers.currentSession(authRequest("GET", { cookie: firstToken }), {});
      assert.equal(idleExpired.status, 401);
      firstSession = await database("sessao").where({ id_sessao: firstSession.id_sessao }).first();
      assert.notEqual(firstSession.revogada_em, null);

      const secondLogin = await handlers.createSession(authRequest("POST", {
        body: { email: account.email, password: account.password }
      }), {});
      const secondToken = sessionCookie(secondLogin).value;
      const secondHash = createHash("sha256").update(secondToken).digest();
      const secondSession = await database("sessao").where({ hash_token_sha256: secondHash }).first();
      await database.raw(`
        UPDATE sessao
        SET ultima_atividade_em = clock_timestamp() - INTERVAL '5 minutes',
            expira_em = clock_timestamp() + INTERVAL '4 minutes',
            expira_absoluta_em = clock_timestamp() + INTERVAL '5 minutes'
        WHERE id_sessao = ?
      `, [secondSession.id_sessao]);
      const active = await handlers.currentSession(authRequest("GET", { cookie: secondToken }), {});
      assert.equal(active.status, 200);
      const cappedSession = await database("sessao").where({ id_sessao: secondSession.id_sessao }).first();
      assert.equal(new Date(cappedSession.expira_em).getTime(), new Date(cappedSession.expira_absoluta_em).getTime());
      assert.ok(new Date(cappedSession.ultima_atividade_em).getTime() > new Date(secondSession.ultima_atividade_em).getTime());

      await database.raw(`
        UPDATE sessao
        SET expira_em = clock_timestamp() - INTERVAL '2 seconds',
            expira_absoluta_em = clock_timestamp() - INTERVAL '1 second'
        WHERE id_sessao = ?
      `, [secondSession.id_sessao]);
      const absoluteExpired = await handlers.currentSession(authRequest("GET", { cookie: secondToken }), {});
      assert.equal(absoluteExpired.status, 401);
      const expiredRow = await database("sessao").where({ id_sessao: secondSession.id_sessao }).first();
      assert.notEqual(expiredRow.revogada_em, null);
    });

    await t.test("separate PostgreSQL connections serialize concurrent lockout, session activity, and revocation", async () => {
      const backendPids = await Promise.all([
        database.raw("SELECT pg_backend_pid() AS pid"),
        secondConnection.raw("SELECT pg_backend_pid() AS pid")
      ]);
      assert.notEqual(backendPids[0].rows[0].pid, backendPids[1].rows[0].pid);

      const lockoutAccount = await insertAuthAdministrator(database, { email: newIdentity("auth-concurrent-lockout") });
      const firstHandlers = authHandlers(database);
      const secondHandlers = authHandlers(secondConnection);
      const concurrentFailures = await Promise.all([
        firstHandlers.createSession(authRequest("POST", {
          body: { email: lockoutAccount.email, password: "synthetic-wrong-admin-password" }
        }), {}),
        secondHandlers.createSession(authRequest("POST", {
          body: { email: lockoutAccount.email, password: "synthetic-wrong-admin-password" }
        }), {}),
        firstHandlers.createSession(authRequest("POST", {
          body: { email: lockoutAccount.email, password: "synthetic-wrong-admin-password" }
        }), {}),
        secondHandlers.createSession(authRequest("POST", {
          body: { email: lockoutAccount.email, password: "synthetic-wrong-admin-password" }
        }), {}),
        firstHandlers.createSession(authRequest("POST", {
          body: { email: lockoutAccount.email, password: "synthetic-wrong-admin-password" }
        }), {})
      ]);
      assert.ok(concurrentFailures.every((response) => response.status === 401));
      const lockoutState = await database("usuario").where({ id_usuario: lockoutAccount.id }).first(
        "falhas_login_na_janela", "bloqueado_ate"
      );
      assert.equal(lockoutState.falhas_login_na_janela, 5);
      const lockCheck = await database.raw(
        "SELECT bloqueado_ate > clock_timestamp() AS active FROM usuario WHERE id_usuario = ?",
        [lockoutAccount.id]
      );
      assert.equal(lockCheck.rows[0].active, true);

      const sessionAccount = await insertAuthAdministrator(database, { email: newIdentity("auth-concurrent-session") });
      const login = await firstHandlers.createSession(authRequest("POST", {
        body: { email: sessionAccount.email, password: sessionAccount.password }
      }), {});
      const token = sessionCookie(login).value;
      const rotated = await Promise.all([
        firstHandlers.createSession(authRequest("POST", {
          cookie: token,
          body: { email: sessionAccount.email, password: sessionAccount.password }
        }), {}),
        secondHandlers.createSession(authRequest("POST", {
          cookie: token,
          body: { email: sessionAccount.email, password: sessionAccount.password }
        }), {})
      ]);
      assert.ok(rotated.every((response) => response.status === 200));
      const rotatedTokens = rotated.map((response) => sessionCookie(response).value);
      assert.notEqual(rotatedTokens[0], token);
      assert.notEqual(rotatedTokens[1], token);
      assert.notEqual(rotatedTokens[0], rotatedTokens[1]);
      const originalHash = createHash("sha256").update(token).digest();
      const originalSession = await database("sessao").where({ hash_token_sha256: originalHash }).first();
      assert.notEqual(originalSession.revogada_em, null);

      const activity = await Promise.all([
        firstHandlers.currentSession(authRequest("GET", { cookie: rotatedTokens[0] }), {}),
        secondHandlers.currentSession(authRequest("GET", { cookie: rotatedTokens[0] }), {})
      ]);
      assert.ok(activity.every((response) => response.status === 200));

      const transition = await Promise.all([
        firstHandlers.currentSession(authRequest("GET", { cookie: rotatedTokens[0] }), {}),
        secondHandlers.deleteCurrentSession(authRequest("DELETE", { cookie: rotatedTokens[0] }), {})
      ]);
      assert.ok([200, 401].includes(transition[0].status));
      assert.equal(transition[1].status, 204);
      const tokenHash = createHash("sha256").update(rotatedTokens[0]).digest();
      const revoked = await database("sessao").where({ hash_token_sha256: tokenHash }).first();
      assert.notEqual(revoked.revogada_em, null);
      assert.equal((await secondHandlers.currentSession(authRequest("GET", { cookie: rotatedTokens[0] }), {})).status, 401);
      assert.equal((await secondHandlers.deleteCurrentSession(authRequest("DELETE", {
        cookie: rotatedTokens[1]
      }), {})).status, 204);
    });

    await t.test("creates precisely the 16 approved domain tables", async () => {
      const result = await database.raw(`
        SELECT tablename
        FROM pg_catalog.pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN ('knex_migrations', 'knex_migrations_lock')
        ORDER BY tablename
      `);
      assert.deepEqual(result.rows.map((row) => row.tablename), EXPECTED_DOMAIN_TABLES);
    });

    await t.test("serializes concurrent initial-admin seed attempts and stores only a password hash", async () => {
      const firstPassword = "synthetic-first-password";
      const secondPassword = "synthetic-second-password";
      const raceEmails = [newIdentity("initial-admin-one"), newIdentity("initial-admin-two")];
      const previousActiveAdmins = await database("usuario")
        .select("id_usuario", "ativado_em")
        .where({ tipo_perfil: "administrador" })
        .whereNotNull("ativado_em")
        .whereNull("excluido_em");

      try {
        if (previousActiveAdmins.length > 0) {
          await database("usuario")
            .whereIn("id_usuario", previousActiveAdmins.map((administrator) => administrator.id_usuario))
            .update({ ativado_em: null });
        }
        const activeAdminsBeforeRace = await database("usuario")
          .select("id_usuario")
          .where({ tipo_perfil: "administrador" })
          .whereNotNull("ativado_em")
          .whereNull("excluido_em");
        assert.equal(activeAdminsBeforeRace.length, 0);

        const pids = await Promise.all([
          database.raw("SELECT pg_backend_pid() AS pid"),
          secondConnection.raw("SELECT pg_backend_pid() AS pid")
        ]);
        assert.notEqual(pids[0].rows[0].pid, pids[1].rows[0].pid);

        const outcomes = await Promise.allSettled([
          createInitialAdmin({
            knex: database,
            name: "Synthetic Administrator One",
            email: raceEmails[0],
            password: firstPassword
          }),
          createInitialAdmin({
            knex: secondConnection,
            name: "Synthetic Administrator Two",
            email: raceEmails[1],
            password: secondPassword
          })
        ]);

        assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
        const rejected = outcomes.find((result) => result.status === "rejected");
        assert.equal(rejected.reason.code, "ACTIVE_ADMIN_EXISTS");
        assert.equal(outcomes.find((result) => result.status === "fulfilled").value, undefined);
        const administrators = await database("usuario")
          .select("email_institucional", "hash_senha")
          .where({ tipo_perfil: "administrador" })
          .whereNotNull("ativado_em")
          .whereNull("excluido_em");
        assert.equal(administrators.length, 1);
        assert.ok(raceEmails.includes(administrators[0].email_institucional));
        const persistedRaceAttempts = await database("usuario")
          .select("email_institucional", "hash_senha")
          .whereIn("email_institucional", raceEmails);
        assert.equal(persistedRaceAttempts.length, 1);
        assert.deepEqual(persistedRaceAttempts[0], administrators[0]);
        assert.notEqual(administrators[0].hash_senha, firstPassword);
        assert.notEqual(administrators[0].hash_senha, secondPassword);
        assert.equal(
          await argon2.verify(administrators[0].hash_senha, firstPassword)
          || await argon2.verify(administrators[0].hash_senha, secondPassword),
          true
        );

        await assert.rejects(
          createInitialAdmin({
            knex: database,
            name: "Synthetic Duplicate Administrator",
            email: newIdentity("duplicate-admin"),
            password: "synthetic-not-persisted"
          }),
          (error) => error && error.code === "ACTIVE_ADMIN_EXISTS"
        );
        await assert.rejects(
          createInitialAdmin({ knex: database, name: " ", email: "invalid", password: "x" }),
          /name is invalid/
        );
      } finally {
        await database("usuario").whereIn("email_institucional", raceEmails).del();
        for (const administrator of previousActiveAdmins) {
          await database("usuario").where({ id_usuario: administrator.id_usuario }).update({
            ativado_em: administrator.ativado_em
          });
        }
      }
    });

    await t.test("enforces deferred profile consistency and physical constraints", async () => {
      const studentId = await insertStudent(database);
      const professorId = await insertProfessor(database);
      const classId = (await database("turma").insert({ serie: 1, ano_letivo: 2026 }).returning("id_turma"))[0].id_turma;
      const subjectId = (await database("materia").insert({ nome: "Matemática" }).returning("id_materia"))[0].id_materia;
      const offerId = (await database("turma_disciplina").insert({ id_turma: classId, id_materia: subjectId }).returning("id_turma_disciplina"))[0].id_turma_disciplina;

      await database("turma_disciplina_professor").insert({
        id_turma_disciplina: offerId,
        id_usuario_professor: professorId
      });
      await database("matricula").insert({
        id_usuario_aluno: studentId,
        id_turma: classId,
        inicio_vigencia: "2026-01-01"
      });

      await expectPgCode(database("turma").insert({ serie: 4, ano_letivo: 2026 }), "23514");
      await expectPgCode(database("turma").insert({ serie: 1, ano_letivo: 2026 }), "23505");
      await expectPgCode(database("materia").insert({ nome: "  matemática " }), "23505");
      await expectPgCode(database("matricula").insert({
        id_usuario_aluno: studentId,
        id_turma: classId,
        inicio_vigencia: "2026-02-01"
      }), "23505");
      await expectPgCode(database("matricula").insert({
        id_usuario_aluno: studentId,
        id_turma: classId,
        inicio_vigencia: "2026-03-01",
        fim_vigencia: "2026-03-01"
      }), "23514");

      await expectPgCode(database("usuario").insert({
        tipo_perfil: "aluno",
        nome_completo: "Synthetic Missing Profile",
        email_institucional: newIdentity("missing-profile")
      }), "23514");
      await expectPgCode(database.transaction(async (transaction) => {
        const id = await insertUser(transaction, {
          profile: "professor",
          email: newIdentity("mismatched-profile")
        });
        await transaction("aluno").insert({ id_usuario: id, telefone_responsavel: "+5511999990000" });
      }), (error) => ["23503", "23514"].includes(error.code));

      const transferSourceId = await insertStudent(database, newIdentity("transfer-source"));
      const transferTargetId = await database.transaction((transaction) => insertUser(transaction, {
        profile: "administrador",
        email: newIdentity("transfer-target")
      }));
      await expectPgCode(database.transaction(async (transaction) => {
        await transaction("usuario").where({ id_usuario: transferTargetId }).update({ tipo_perfil: "aluno" });
        await transaction("aluno").where({ id_usuario: transferSourceId }).update({ id_usuario: transferTargetId });
      }), (error) => error.code === "23514" && error.constraint === "usuario_profile_integrity_ck");
      const sourceProfile = await database("usuario")
        .where({ id_usuario: transferSourceId })
        .first("tipo_perfil");
      const sourceExtension = await database("aluno")
        .where({ id_usuario: transferSourceId })
        .first("id_usuario");
      assert.equal(sourceProfile.tipo_perfil, "aluno");
      assert.equal(sourceExtension.id_usuario, transferSourceId);

      await expectPgCode(database("aluno").insert({
        id_usuario: studentId,
        telefone_responsavel: "   "
      }), "23514");
      await expectPgCode(database("turma_disciplina_professor").insert({
        id_turma_disciplina: offerId,
        id_usuario_professor: professorId
      }), "23505");

      await expectPgCode(database("sessao").insert({
        id_usuario: studentId,
        hash_token_sha256: Buffer.alloc(31),
        expira_em: "2026-01-01T00:00:00Z",
        expira_absoluta_em: "2026-02-01T00:00:00Z"
      }), "23514");
      await expectPgCode(database("foto_perfil").insert({
        id_usuario: studentId,
        chave_objeto: "synthetic-key",
        tipo_midia: "image/gif",
        tamanho_bytes: 10
      }), "23514");
      await expectPgCode(database("foto_perfil").insert({
        id_usuario: studentId,
        chave_objeto: "synthetic-key-too-large",
        tipo_midia: "image/png",
        tamanho_bytes: 5242881
      }), "23514");
      await database("foto_perfil").insert({
        id_usuario: studentId,
        chave_objeto: "synthetic-photo-key",
        tipo_midia: "image/jpeg",
        tamanho_bytes: 2048
      });
      await database("foto_perfil").where({ id_usuario: studentId }).update({
        chave_objeto: "synthetic-photo-key-replaced",
        atualizada_em: "2000-01-01T00:00:00Z"
      });
      const updatedPhoto = await database("foto_perfil").where({ id_usuario: studentId }).first("atualizada_em");
      assert.notEqual(new Date(updatedPhoto.atualizada_em).toISOString(), "2000-01-01T00:00:00.000Z");

      const activationHash = Buffer.alloc(32, 1);
      await database("token_ativacao").insert({
        id_usuario: studentId,
        hash_token_sha256: activationHash,
        expira_em: "2026-12-01T00:00:00Z"
      });
      await expectPgCode(database("token_ativacao").insert({
        id_usuario: studentId,
        hash_token_sha256: Buffer.alloc(32, 2),
        expira_em: "2026-12-02T00:00:00Z"
      }), "23505");
      await expectPgCode(database("token_redefinicao_senha").insert({
        id_usuario: studentId,
        hash_token_sha256: Buffer.alloc(31, 3),
        expira_em: "2026-12-01T00:00:00Z"
      }), "23514");

      await expectPgCode(database("sessao").insert({
        id_usuario: studentId,
        hash_token_sha256: Buffer.alloc(32, 4),
        expira_em: "2026-03-01T00:00:00Z",
        expira_absoluta_em: "2026-02-01T00:00:00Z"
      }), "23514");
    });

    await t.test("enforces email uniqueness across all current and pending write paths", async () => {
      const currentEmail = newIdentity("email-current");
      const pendingEmail = newIdentity("email-pending");
      const existingId = await database.transaction((transaction) => insertUser(transaction, {
        email: currentEmail,
        pendingEmail
      }));

      await expectPgCode(database("usuario").insert({
        tipo_perfil: "administrador",
        nome_completo: "Duplicate Current",
        email_institucional: currentEmail
      }), "23505");
      await expectPgCode(database("usuario").insert({
        tipo_perfil: "administrador",
        nome_completo: "Current Matches Pending",
        email_institucional: pendingEmail
      }), "23505");
      await expectPgCode(database("usuario").insert({
        tipo_perfil: "administrador",
        nome_completo: "Pending Matches Current",
        email_institucional: newIdentity("other-current-a"),
        email_pendente: currentEmail
      }), "23505");
      await expectPgCode(database("usuario").insert({
        tipo_perfil: "administrador",
        nome_completo: "Pending Matches Pending",
        email_institucional: newIdentity("other-current-b"),
        email_pendente: pendingEmail
      }), "23505");
      const sameRowEmail = newIdentity("same-row");
      await expectPgCode(database("usuario").insert({
        tipo_perfil: "administrador",
        nome_completo: "Same Row Address Conflict",
        email_institucional: sameRowEmail,
        email_pendente: sameRowEmail
      }), "23505");

      const currentUpdateId = await database.transaction((transaction) => insertUser(transaction, {
        email: newIdentity("current-update")
      }));
      await expectPgCode(database("usuario").where({ id_usuario: currentUpdateId }).update({
        email_institucional: pendingEmail
      }), "23505");

      const pendingUpdateId = await database.transaction((transaction) => insertUser(transaction, {
        email: newIdentity("pending-update-current"),
        pendingEmail: newIdentity("pending-update")
      }));
      await expectPgCode(database("usuario").where({ id_usuario: pendingUpdateId }).update({
        email_pendente: currentEmail
      }), "23505");

      await expectPgCode(database("usuario").where({ id_usuario: existingId }).update({
        email_pendente: currentEmail
      }), "23505");
    });

    await t.test("rejects racing current-versus-pending email writes on separate connections", async () => {
      let readyCount = 0;
      let releaseGate;
      const gate = new Promise((resolve) => { releaseGate = resolve; });
      const backendPids = [];
      const raceEmail = newIdentity("concurrent-email");

      const runInsert = (connection, values) => connection.transaction(async (transaction) => {
        const backend = await transaction.raw("SELECT pg_backend_pid() AS pid");
        backendPids.push(backend.rows[0].pid);
        readyCount += 1;
        if (readyCount === 2) releaseGate();
        await gate;
        await transaction("usuario").insert({
          tipo_perfil: "administrador",
          nome_completo: "Synthetic Concurrent Writer",
          ...values
        });
      });

      const outcomes = await Promise.allSettled([
        runInsert(database, { email_institucional: raceEmail }),
        runInsert(secondConnection, {
          email_institucional: newIdentity("concurrent-other"),
          email_pendente: raceEmail
        })
      ]);
      assert.equal(new Set(backendPids).size, 2);
      assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
      assert.equal(outcomes.find((result) => result.status === "rejected").reason.code, "23505");
    });

    await t.test("enforces simulation and result constraints and composite references", async () => {
      const studentId = await insertStudent(database);
      const classId = (await database("turma").insert({ serie: 2, ano_letivo: 2027 }).returning("id_turma"))[0].id_turma;
      const subjectId = (await database("materia").insert({ nome: "Ciências" }).returning("id_materia"))[0].id_materia;
      await database("turma_disciplina").insert({ id_turma: classId, id_materia: subjectId });
      const simulationId = (await database("simulado").insert({
        id_turma: classId,
        numero: 1,
        tipo: "objetivo",
        bimestre: 1,
        data_realizacao: "2026-04-15"
      }).returning("id_simulado"))[0].id_simulado;
      await database("simulado_disciplina").insert({
        id_simulado: simulationId,
        id_turma: classId,
        id_materia: subjectId,
        total_questoes: 10,
        peso: "0.5000"
      });
      await expectPgCode(database("simulado").insert({
        id_turma: classId,
        numero: 1,
        tipo: "objetivo",
        bimestre: 1,
        data_realizacao: "2026-04-20"
      }), "23505");
      await expectPgCode(database("simulado").insert({
        id_turma: classId,
        numero: 2,
        tipo: "invalido",
        bimestre: 1,
        data_realizacao: "2026-04-20"
      }), "23514");
      await database("simulado_aluno").insert({
        id_simulado: simulationId,
        id_usuario_aluno: studentId
      });
      await expectPgCode(database("simulado_aluno").insert({
        id_simulado: simulationId,
        id_usuario_aluno: studentId
      }), "23505");

      await expectPgCode(database("simulado_disciplina").insert({
        id_simulado: simulationId,
        id_turma: classId,
        id_materia: subjectId,
        total_questoes: 0,
        peso: "0.5000"
      }), "23514");
      await expectPgCode(database("simulado_disciplina").insert({
        id_simulado: simulationId,
        id_turma: classId,
        id_materia: subjectId,
        total_questoes: 10,
        peso: "1.0001"
      }), "23514");
      await expectPgCode(database("simulado_aluno").insert({
        id_simulado: simulationId,
        id_usuario_aluno: "9223372036854775807"
      }), "23503");

      await expectPgCode(database("resultado").insert({
        id_simulado: simulationId,
        id_usuario_aluno: studentId,
        id_turma: classId,
        id_materia: subjectId,
        estado: "avaliado"
      }), "23514");
      await expectPgCode(database("resultado").insert({
        id_simulado: simulationId,
        id_usuario_aluno: studentId,
        id_turma: classId,
        id_materia: subjectId,
        estado: "ausente",
        acertos: 0
      }), "23514");
      await expectPgCode(database("resultado").insert({
        id_simulado: simulationId,
        id_usuario_aluno: studentId,
        id_turma: classId,
        id_materia: subjectId,
        estado: "avaliado",
        acertos: -1
      }), "23514");
      await database("resultado").insert({
        id_simulado: simulationId,
        id_usuario_aluno: studentId,
        id_turma: classId,
        id_materia: subjectId,
        estado: "avaliado",
        acertos: 0
      });
      await expectPgCode(database("resultado").insert({
        id_simulado: simulationId,
        id_usuario_aluno: studentId,
        id_turma: classId,
        id_materia: "9223372036854775807"
      }), "23503");
    });
  } finally {
    if (secondConnection) {
      await secondConnection.destroy().catch(() => {});
    }
    if (database) {
      await database.destroy().catch(() => {});
    }
    if (maintenanceClient && databaseCreated && generatedDatabase) {
      await maintenanceClient.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [generatedDatabase]
      ).catch(() => {});
      await maintenanceClient.query(`DROP DATABASE "${generatedDatabase}"`).catch(() => {});
    }
    if (maintenanceClient) {
      await maintenanceClient.end().catch(() => {});
    }
  }
});
