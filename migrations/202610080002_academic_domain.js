"use strict";

const { assertLoopbackHost } = require("../src/database/local-only.cjs");

exports.up = async function up(knex) {
  assertLoopbackHost(knex.client.config.connection.host);

  await knex.raw(`
    CREATE TABLE materia (
      id_materia BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      nome TEXT NOT NULL,
      descricao TEXT,
      excluido_em TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX materia_nome_ativa_uk
      ON materia (lower(btrim(nome)))
      WHERE excluido_em IS NULL;

    CREATE TABLE turma (
      id_turma BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      serie INTEGER NOT NULL,
      ano_letivo INTEGER NOT NULL,
      CONSTRAINT turma_serie_ck CHECK (serie IN (1, 2, 3)),
      CONSTRAINT turma_serie_ano_uk UNIQUE (serie, ano_letivo)
    );

    CREATE TABLE matricula (
      id_matricula BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_usuario_aluno BIGINT NOT NULL REFERENCES aluno (id_usuario) ON DELETE RESTRICT,
      id_turma BIGINT NOT NULL REFERENCES turma (id_turma) ON DELETE RESTRICT,
      inicio_vigencia DATE NOT NULL,
      fim_vigencia DATE,
      cancelada_em TIMESTAMPTZ,
      CONSTRAINT matricula_vigencia_ck CHECK (fim_vigencia IS NULL OR fim_vigencia > inicio_vigencia)
    );
    CREATE INDEX matricula_aluno_turma_idx
      ON matricula (id_usuario_aluno, id_turma);
    CREATE UNIQUE INDEX matricula_aluno_aberta_uk
      ON matricula (id_usuario_aluno)
      WHERE fim_vigencia IS NULL;

    CREATE TABLE turma_disciplina (
      id_turma_disciplina BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_turma BIGINT NOT NULL REFERENCES turma (id_turma) ON DELETE RESTRICT,
      id_materia BIGINT NOT NULL REFERENCES materia (id_materia) ON DELETE RESTRICT,
      CONSTRAINT turma_disciplina_turma_materia_uk UNIQUE (id_turma, id_materia)
    );

    CREATE TABLE turma_disciplina_professor (
      id_turma_disciplina BIGINT NOT NULL REFERENCES turma_disciplina (id_turma_disciplina) ON DELETE RESTRICT,
      id_usuario_professor BIGINT NOT NULL REFERENCES professor (id_usuario) ON DELETE RESTRICT,
      CONSTRAINT turma_disciplina_professor_pk PRIMARY KEY (id_turma_disciplina, id_usuario_professor)
    );
  `);
};

exports.down = async function down() {
  throw new Error("This phase is forward-only; migrations cannot be rolled back.");
};
