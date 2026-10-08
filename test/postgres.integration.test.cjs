"use strict";

const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const path = require("node:path");
const { test } = require("node:test");
const argon2 = require("argon2");
const knexFactory = require("knex");
const { Client } = require("pg");
const { assertLoopbackHost } = require("../src/database/local-only.cjs");
const { createInitialAdmin } = require("../seed/admin.cjs");

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

function expectPgCode(promise, code) {
  return assert.rejects(promise, (error) => {
    if (!error) return false;
    return typeof code === "function" ? code(error) : error.code === code;
  });
}

test("V1 migrations, constraints, concurrent rules, and seed use a disposable PostgreSQL database", {
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
      const pids = await Promise.all([
        database.raw("SELECT pg_backend_pid() AS pid"),
        secondConnection.raw("SELECT pg_backend_pid() AS pid")
      ]);
      assert.notEqual(pids[0].rows[0].pid, pids[1].rows[0].pid);

      const firstPassword = "synthetic-first-password";
      const secondPassword = "synthetic-second-password";
      const outcomes = await Promise.allSettled([
        createInitialAdmin({
          knex: database,
          name: "Synthetic Administrator One",
          email: newIdentity("initial-admin-one"),
          password: firstPassword
        }),
        createInitialAdmin({
          knex: secondConnection,
          name: "Synthetic Administrator Two",
          email: newIdentity("initial-admin-two"),
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
