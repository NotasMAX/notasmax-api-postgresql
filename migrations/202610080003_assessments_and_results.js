"use strict";

const { assertLoopbackHost } = require("../src/database/local-only.cjs");

exports.up = async function up(knex) {
  assertLoopbackHost(knex.client.config.connection.host);

  await knex.raw(`
    CREATE TABLE simulado (
      id_simulado BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_turma BIGINT NOT NULL REFERENCES turma (id_turma) ON DELETE RESTRICT,
      numero INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      bimestre SMALLINT NOT NULL,
      data_realizacao DATE NOT NULL,
      instante_confirmacao_realizacao TIMESTAMPTZ,
      excluido_em TIMESTAMPTZ,
      CONSTRAINT simulado_numero_ck CHECK (numero > 0),
      CONSTRAINT simulado_tipo_ck CHECK (tipo IN ('objetivo', 'dissertativo')),
      CONSTRAINT simulado_bimestre_ck CHECK (bimestre BETWEEN 1 AND 4),
      CONSTRAINT simulado_id_turma_uk UNIQUE (id_simulado, id_turma)
    );
    CREATE UNIQUE INDEX simulado_numero_ativo_uk
      ON simulado (id_turma, numero)
      WHERE excluido_em IS NULL;
    CREATE INDEX simulado_turma_bimestre_data_idx
      ON simulado (id_turma, bimestre, data_realizacao);

    CREATE TABLE simulado_disciplina (
      id_simulado BIGINT NOT NULL,
      id_turma BIGINT NOT NULL,
      id_materia BIGINT NOT NULL,
      total_questoes INTEGER NOT NULL,
      peso NUMERIC(5, 4) NOT NULL,
      CONSTRAINT simulado_disciplina_pk PRIMARY KEY (id_simulado, id_turma, id_materia),
      CONSTRAINT simulado_disciplina_total_questoes_ck CHECK (total_questoes > 0),
      CONSTRAINT simulado_disciplina_peso_ck CHECK (peso > 0 AND peso <= 1),
      CONSTRAINT simulado_disciplina_simulado_fk FOREIGN KEY (id_simulado, id_turma)
        REFERENCES simulado (id_simulado, id_turma) ON DELETE RESTRICT,
      CONSTRAINT simulado_disciplina_oferta_fk FOREIGN KEY (id_turma, id_materia)
        REFERENCES turma_disciplina (id_turma, id_materia) ON DELETE RESTRICT
    );

    CREATE TABLE simulado_aluno (
      id_simulado BIGINT NOT NULL REFERENCES simulado (id_simulado) ON DELETE RESTRICT,
      id_usuario_aluno BIGINT NOT NULL REFERENCES aluno (id_usuario) ON DELETE RESTRICT,
      CONSTRAINT simulado_aluno_pk PRIMARY KEY (id_simulado, id_usuario_aluno)
    );

    CREATE TABLE resultado (
      id_simulado BIGINT NOT NULL,
      id_usuario_aluno BIGINT NOT NULL,
      id_turma BIGINT NOT NULL,
      id_materia BIGINT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendente',
      acertos INTEGER,
      CONSTRAINT resultado_pk PRIMARY KEY (id_simulado, id_usuario_aluno, id_turma, id_materia),
      CONSTRAINT resultado_estado_ck CHECK (estado IN ('pendente', 'avaliado', 'ausente')),
      CONSTRAINT resultado_acertos_ck CHECK (acertos IS NULL OR acertos >= 0),
      CONSTRAINT resultado_estado_acertos_ck CHECK (
        (estado = 'avaliado' AND acertos IS NOT NULL)
        OR (estado IN ('pendente', 'ausente') AND acertos IS NULL)
      ),
      CONSTRAINT resultado_participante_fk FOREIGN KEY (id_simulado, id_usuario_aluno)
        REFERENCES simulado_aluno (id_simulado, id_usuario_aluno) ON DELETE RESTRICT,
      CONSTRAINT resultado_disciplina_fk FOREIGN KEY (id_simulado, id_turma, id_materia)
        REFERENCES simulado_disciplina (id_simulado, id_turma, id_materia) ON DELETE RESTRICT
    );
  `);
};

exports.down = async function down() {
  throw new Error("This phase is forward-only; migrations cannot be rolled back.");
};
