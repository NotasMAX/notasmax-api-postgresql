import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import type { Knex } from "knex";

const DUMMY_PASSWORD_HASH = "$argon2id$v=19$m=19456,p=1,t=2$E5lArmfMnm3PLlR9RW99vA$/PvdykPSvRk69SAli+gXX3DaVYIqOY1DvOGVCReZLXA";
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

type AccountRow = {
  id_usuario: string | number;
  tipo_perfil: string;
  nome_completo: string;
  hash_senha: string | null;
  ativado_em: Date | string | null;
  excluido_em: Date | string | null;
  falhas_login_na_janela: number;
  inicio_janela_falhas_login: Date | string | null;
  bloqueado_ate: Date | string | null;
};

type SessionRow = {
  id_sessao: string | number;
  id_usuario: string | number;
  expira_em: Date | string;
  expira_absoluta_em: Date | string;
};

type IdentityRow = Pick<AccountRow, "id_usuario" | "tipo_perfil" | "nome_completo">;

export type SessionIdentity = {
  id: string;
  displayName: string;
  profile: string;
};

export type LoginResult =
  | { success: true; token: string; user: SessionIdentity }
  | { success: false };

export type CurrentSessionResult =
  | { authenticated: false }
  | { authenticated: true; user: SessionIdentity };

function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

async function databaseNow(transaction: Knex.Transaction): Promise<Date> {
  const result = await transaction.raw("SELECT clock_timestamp() AS database_now") as {
    rows: Array<{ database_now: Date | string }>;
  };
  return asDate(result.rows[0].database_now);
}

function identity(account: IdentityRow): SessionIdentity {
  return {
    id: String(account.id_usuario),
    displayName: account.nome_completo,
    profile: account.tipo_perfil
  };
}

export async function createLoginSession(
  knex: Knex,
  credentials: { email: string; password: string },
  previousToken?: string
): Promise<LoginResult> {
  return knex.transaction(async (transaction) => {
    let previousSession: Pick<SessionRow, "id_sessao"> | undefined;
    if (previousToken) {
      previousSession = await transaction("sessao")
        .select("id_sessao")
        .where({ hash_token_sha256: tokenHash(previousToken) })
        .whereNull("revogada_em")
        .forUpdate()
        .first() as Pick<SessionRow, "id_sessao"> | undefined;
    }

    const account = await transaction("usuario")
      .select(
        "id_usuario",
        "tipo_perfil",
        "nome_completo",
        "hash_senha",
        "ativado_em",
        "excluido_em",
        "falhas_login_na_janela",
        "inicio_janela_falhas_login",
        "bloqueado_ate"
      )
      .where({ email_institucional: credentials.email })
      .forUpdate()
      .first() as AccountRow | undefined;

    const passwordHash = account?.hash_senha || DUMMY_PASSWORD_HASH;
    let passwordMatches = false;
    try {
      passwordMatches = await argon2.verify(passwordHash, credentials.password);
    } catch (error) {
      if (!account?.hash_senha) throw error;
      await argon2.verify(DUMMY_PASSWORD_HASH, credentials.password);
    }
    if (!account) return { success: false };

    const now = await databaseNow(transaction);
    const blockedUntil = account.bloqueado_ate ? asDate(account.bloqueado_ate) : undefined;
    if (blockedUntil && blockedUntil.getTime() > now.getTime()) {
      return { success: false };
    }

    const eligibleAdministrator = account.tipo_perfil === "administrador"
      && account.ativado_em !== null
      && account.excluido_em === null
      && account.hash_senha !== null;

    if (!passwordMatches || !eligibleAdministrator) {
      const windowStartedAt = account.inicio_janela_falhas_login
        ? asDate(account.inicio_janela_falhas_login)
        : undefined;
      const windowIsCurrent = windowStartedAt !== undefined
        && windowStartedAt.getTime() > now.getTime() - FAILURE_WINDOW_MS;
      const failures = windowIsCurrent ? account.falhas_login_na_janela + 1 : 1;
      await transaction("usuario")
        .where({ id_usuario: account.id_usuario })
        .update({
          falhas_login_na_janela: failures,
          inicio_janela_falhas_login: windowIsCurrent ? windowStartedAt : now,
          bloqueado_ate: failures >= 5 ? new Date(now.getTime() + LOCKOUT_MS) : null
        });
      return { success: false };
    }

    const token = randomBytes(32).toString("base64url");
    const absoluteExpiry = new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS);
    if (previousSession) {
      await transaction("sessao")
        .where({ id_sessao: previousSession.id_sessao })
        .whereNull("revogada_em")
        .update({ revogada_em: now });
    }

    await transaction("usuario")
      .where({ id_usuario: account.id_usuario })
      .update({
        falhas_login_na_janela: 0,
        inicio_janela_falhas_login: null,
        bloqueado_ate: null
      });
    await transaction("sessao").insert({
      id_usuario: account.id_usuario,
      hash_token_sha256: tokenHash(token),
      criada_em: now,
      ultima_atividade_em: now,
      expira_em: new Date(now.getTime() + IDLE_TIMEOUT_MS),
      expira_absoluta_em: absoluteExpiry
    });

    return { success: true, token, user: identity(account) };
  });
}

export async function inspectSession(knex: Knex, token: string): Promise<CurrentSessionResult> {
  return knex.transaction(async (transaction) => {
    const session = await transaction("sessao")
      .select("id_sessao", "id_usuario", "expira_em", "expira_absoluta_em")
      .where({ hash_token_sha256: tokenHash(token) })
      .whereNull("revogada_em")
      .forUpdate()
      .first() as SessionRow | undefined;
    if (!session) return { authenticated: false };

    const now = await databaseNow(transaction);
    const absoluteExpiry = asDate(session.expira_absoluta_em);
    if (asDate(session.expira_em).getTime() <= now.getTime()
      || absoluteExpiry.getTime() <= now.getTime()) {
      await transaction("sessao")
        .where({ id_sessao: session.id_sessao })
        .whereNull("revogada_em")
        .update({ revogada_em: now });
      return { authenticated: false };
    }

    const account = await transaction("usuario")
      .select("id_usuario", "tipo_perfil", "nome_completo", "ativado_em", "excluido_em")
      .where({ id_usuario: session.id_usuario })
      .forShare()
      .first() as Pick<AccountRow, "id_usuario" | "tipo_perfil" | "nome_completo" | "ativado_em" | "excluido_em"> | undefined;
    if (!account || account.ativado_em === null || account.excluido_em !== null) {
      await transaction("sessao")
        .where({ id_sessao: session.id_sessao })
        .whereNull("revogada_em")
        .update({ revogada_em: now });
      return { authenticated: false };
    }

    await transaction("sessao")
      .where({ id_sessao: session.id_sessao })
      .whereNull("revogada_em")
      .update({
        ultima_atividade_em: now,
        expira_em: new Date(Math.min(now.getTime() + IDLE_TIMEOUT_MS, absoluteExpiry.getTime()))
      });

    return { authenticated: true, user: identity(account) };
  });
}

export async function revokeSession(knex: Knex, token: string): Promise<boolean> {
  return knex.transaction(async (transaction) => {
    const session = await transaction("sessao")
      .select("id_sessao", "expira_em", "expira_absoluta_em")
      .where({ hash_token_sha256: tokenHash(token) })
      .whereNull("revogada_em")
      .forUpdate()
      .first() as Pick<SessionRow, "id_sessao" | "expira_em" | "expira_absoluta_em"> | undefined;
    if (!session) return false;

    const now = await databaseNow(transaction);
    const expired = asDate(session.expira_em).getTime() <= now.getTime()
      || asDate(session.expira_absoluta_em).getTime() <= now.getTime();
    await transaction("sessao")
      .where({ id_sessao: session.id_sessao })
      .whereNull("revogada_em")
      .update({ revogada_em: now });
    return !expired;
  });
}
