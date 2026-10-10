"use strict";

const { assertLoopbackHost } = require("../src/database/local-only.cjs");

exports.up = async function up(knex) {
  assertLoopbackHost(knex.client.config.connection.host);

  await knex.raw(`
    ALTER TABLE usuario
      ADD COLUMN contador_pedidos_redefinicao INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN inicio_janela_redefinicao TIMESTAMPTZ,
      ADD CONSTRAINT usuario_contador_pedidos_redefinicao_ck
        CHECK (contador_pedidos_redefinicao >= 0)
  `);
};

exports.down = async function down() {
  throw new Error("This phase is forward-only; migrations cannot be rolled back.");
};
