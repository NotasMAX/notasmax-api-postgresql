"use strict";

const { assertLoopbackHost } = require("../src/database/local-only.cjs");

exports.up = async function up(knex) {
  assertLoopbackHost(knex.client.config.connection.host);

  await knex.raw(`
    CREATE TABLE usuario (
      id_usuario BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      tipo_perfil TEXT NOT NULL,
      nome_completo TEXT NOT NULL,
      email_institucional TEXT NOT NULL,
      email_pendente TEXT,
      telefone_contato TEXT,
      hash_senha TEXT,
      ativado_em TIMESTAMPTZ,
      excluido_em TIMESTAMPTZ,
      falhas_login_na_janela INTEGER NOT NULL DEFAULT 0,
      inicio_janela_falhas_login TIMESTAMPTZ,
      bloqueado_ate TIMESTAMPTZ,
      CONSTRAINT usuario_tipo_perfil_ck CHECK (tipo_perfil IN ('aluno', 'professor', 'administrador')),
      CONSTRAINT usuario_nome_completo_ck CHECK (char_length(nome_completo) BETWEEN 1 AND 255 AND char_length(btrim(nome_completo)) > 0),
      CONSTRAINT usuario_email_institucional_lower_ck CHECK (email_institucional = lower(email_institucional)),
      CONSTRAINT usuario_email_pendente_lower_ck CHECK (email_pendente IS NULL OR email_pendente = lower(email_pendente)),
      CONSTRAINT usuario_falhas_login_ck CHECK (falhas_login_na_janela >= 0),
      CONSTRAINT usuario_id_tipo_uk UNIQUE (id_usuario, tipo_perfil),
      CONSTRAINT usuario_email_institucional_uk UNIQUE (email_institucional)
    );

    CREATE UNIQUE INDEX usuario_email_pendente_uk
      ON usuario (email_pendente)
      WHERE email_pendente IS NOT NULL;
    CREATE INDEX usuario_admin_listagem_idx
      ON usuario (tipo_perfil, nome_completo)
      WHERE excluido_em IS NULL;

    CREATE TABLE aluno (
      id_usuario BIGINT PRIMARY KEY,
      tipo_perfil TEXT NOT NULL DEFAULT 'aluno',
      telefone_responsavel TEXT NOT NULL,
      CONSTRAINT aluno_tipo_perfil_ck CHECK (tipo_perfil = 'aluno'),
      CONSTRAINT aluno_telefone_responsavel_ck CHECK (char_length(btrim(telefone_responsavel)) > 0),
      CONSTRAINT aluno_usuario_perfil_fk FOREIGN KEY (id_usuario, tipo_perfil)
        REFERENCES usuario (id_usuario, tipo_perfil) ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE TABLE professor (
      id_usuario BIGINT PRIMARY KEY,
      tipo_perfil TEXT NOT NULL DEFAULT 'professor',
      CONSTRAINT professor_tipo_perfil_ck CHECK (tipo_perfil = 'professor'),
      CONSTRAINT professor_usuario_perfil_fk FOREIGN KEY (id_usuario, tipo_perfil)
        REFERENCES usuario (id_usuario, tipo_perfil) ON DELETE RESTRICT
        DEFERRABLE INITIALLY DEFERRED
    );

    CREATE TABLE sessao (
      id_sessao BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_usuario BIGINT NOT NULL REFERENCES usuario (id_usuario) ON DELETE RESTRICT,
      hash_token_sha256 BYTEA NOT NULL UNIQUE,
      criada_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ultima_atividade_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expira_em TIMESTAMPTZ NOT NULL,
      expira_absoluta_em TIMESTAMPTZ NOT NULL,
      revogada_em TIMESTAMPTZ,
      CONSTRAINT sessao_hash_token_tamanho_ck CHECK (octet_length(hash_token_sha256) = 32),
      CONSTRAINT sessao_expiracao_ck CHECK (expira_em <= expira_absoluta_em)
    );
    CREATE INDEX sessao_usuario_expiracao_ativa_idx
      ON sessao (id_usuario, expira_em)
      WHERE revogada_em IS NULL;

    CREATE TABLE token_ativacao (
      id_token BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_usuario BIGINT NOT NULL UNIQUE REFERENCES usuario (id_usuario) ON DELETE RESTRICT,
      hash_token_sha256 BYTEA NOT NULL UNIQUE,
      expira_em TIMESTAMPTZ NOT NULL,
      CONSTRAINT token_ativacao_hash_tamanho_ck CHECK (octet_length(hash_token_sha256) = 32)
    );

    CREATE TABLE token_redefinicao_senha (
      id_token BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id_usuario BIGINT NOT NULL UNIQUE REFERENCES usuario (id_usuario) ON DELETE RESTRICT,
      hash_token_sha256 BYTEA NOT NULL UNIQUE,
      expira_em TIMESTAMPTZ NOT NULL,
      CONSTRAINT token_redefinicao_senha_hash_tamanho_ck CHECK (octet_length(hash_token_sha256) = 32)
    );

    CREATE TABLE foto_perfil (
      id_usuario BIGINT PRIMARY KEY REFERENCES usuario (id_usuario) ON DELETE RESTRICT,
      chave_objeto TEXT NOT NULL UNIQUE,
      tipo_midia TEXT NOT NULL,
      tamanho_bytes INTEGER NOT NULL,
      criada_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      atualizada_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT foto_perfil_tipo_midia_ck CHECK (tipo_midia IN ('image/jpeg', 'image/png')),
      CONSTRAINT foto_perfil_tamanho_ck CHECK (tamanho_bytes BETWEEN 1 AND 5242880)
    );

    CREATE FUNCTION update_foto_perfil_atualizada_em() RETURNS trigger
    LANGUAGE plpgsql VOLATILE AS $$
    BEGIN
      NEW.atualizada_em := CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER foto_perfil_atualizada_em_trg
      BEFORE UPDATE ON foto_perfil
      FOR EACH ROW EXECUTE FUNCTION update_foto_perfil_atualizada_em();

    CREATE FUNCTION enforce_usuario_email_uniqueness() RETURNS trigger
    LANGUAGE plpgsql VOLATILE AS $$
    DECLARE
      candidate_email TEXT;
      excluded_id BIGINT;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        FOR candidate_email IN
          SELECT DISTINCT lower(email)
          FROM unnest(ARRAY[OLD.email_institucional, OLD.email_pendente]) AS addresses(email)
          WHERE email IS NOT NULL
          ORDER BY lower(email)
        LOOP
          PERFORM pg_advisory_xact_lock(hashtextextended(candidate_email, 0));
        END LOOP;
        RETURN OLD;
      END IF;

      IF TG_OP = 'UPDATE' THEN
        excluded_id := OLD.id_usuario;
      END IF;

      FOR candidate_email IN
        SELECT DISTINCT lower(email)
        FROM unnest(ARRAY[
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.email_institucional END,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.email_pendente END,
          NEW.email_institucional,
          NEW.email_pendente
        ]) AS addresses(email)
        WHERE email IS NOT NULL
        ORDER BY lower(email)
      LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(candidate_email, 0));
      END LOOP;

      IF NEW.email_pendente IS NOT NULL AND NEW.email_pendente = NEW.email_institucional THEN
        RAISE EXCEPTION 'email addresses must be unique across current and pending values'
          USING ERRCODE = '23505', CONSTRAINT = 'usuario_email_cross_column_uk';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM usuario AS existing
        WHERE (excluded_id IS NULL OR existing.id_usuario <> excluded_id)
          AND (
            existing.email_institucional IN (NEW.email_institucional, NEW.email_pendente)
            OR existing.email_pendente IN (NEW.email_institucional, NEW.email_pendente)
          )
      ) THEN
        RAISE EXCEPTION 'email addresses must be unique across current and pending values'
          USING ERRCODE = '23505', CONSTRAINT = 'usuario_email_cross_column_uk';
      END IF;

      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER usuario_email_uniqueness_trg
      BEFORE INSERT OR UPDATE OF email_institucional, email_pendente OR DELETE ON usuario
      FOR EACH ROW EXECUTE FUNCTION enforce_usuario_email_uniqueness();

    CREATE FUNCTION enforce_usuario_profile_integrity() RETURNS trigger
    LANGUAGE plpgsql VOLATILE AS $$
    DECLARE
      affected_ids BIGINT[];
      affected_id BIGINT;
      expected_profile TEXT;
      has_aluno BOOLEAN;
      has_professor BOOLEAN;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        affected_ids := ARRAY[OLD.id_usuario];
      ELSIF TG_OP = 'UPDATE' THEN
        affected_ids := ARRAY[OLD.id_usuario, NEW.id_usuario];
      ELSE
        affected_ids := ARRAY[NEW.id_usuario];
      END IF;

      FOR affected_id IN
        SELECT DISTINCT id_usuario FROM unnest(affected_ids) AS ids(id_usuario)
      LOOP
        SELECT tipo_perfil INTO expected_profile
        FROM usuario
        WHERE id_usuario = affected_id;

        IF NOT FOUND THEN
          CONTINUE;
        END IF;

        SELECT EXISTS (SELECT 1 FROM aluno WHERE id_usuario = affected_id),
               EXISTS (SELECT 1 FROM professor WHERE id_usuario = affected_id)
          INTO has_aluno, has_professor;

        IF (expected_profile = 'aluno' AND (NOT has_aluno OR has_professor))
          OR (expected_profile = 'professor' AND (has_aluno OR NOT has_professor))
          OR (expected_profile = 'administrador' AND (has_aluno OR has_professor)) THEN
          RAISE EXCEPTION 'usuario profile extension does not match tipo_perfil'
            USING ERRCODE = '23514', CONSTRAINT = 'usuario_profile_integrity_ck';
        END IF;
      END LOOP;

      RETURN NULL;
    END;
    $$;

    CREATE CONSTRAINT TRIGGER usuario_profile_integrity_trg
      AFTER INSERT OR UPDATE OR DELETE ON usuario
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION enforce_usuario_profile_integrity();
    CREATE CONSTRAINT TRIGGER aluno_profile_integrity_trg
      AFTER INSERT OR UPDATE OR DELETE ON aluno
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION enforce_usuario_profile_integrity();
    CREATE CONSTRAINT TRIGGER professor_profile_integrity_trg
      AFTER INSERT OR UPDATE OR DELETE ON professor
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION enforce_usuario_profile_integrity();
  `);
};

exports.down = async function down() {
  throw new Error("This phase is forward-only; migrations cannot be rolled back.");
};
