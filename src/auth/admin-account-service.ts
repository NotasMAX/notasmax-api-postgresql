import type { Knex } from "knex";

export type AccountProfile = "aluno" | "professor" | "administrador";

export type AccountListQuery = {
  search?: string;
  activationStatus?: "pending" | "activated";
  enrollmentStatus?: "active" | "no_active_enrollment";
  classId?: string;
  subjectId?: string;
  page: number;
  pageSize: number;
};

export type NewAccount = {
  name: string;
  email: string;
  contactPhone?: string | null;
  guardianPhone?: string;
};

export type AccountPatch = Partial<NewAccount>;

const ADMIN_MEMBERSHIP_LOCK = "notasmax:admin-membership-change";

function activationStatus(value: Date | string | null): "pending" | "activated" {
  return value === null ? "pending" : "activated";
}

function filteredAccounts(knex: Knex, profile: AccountProfile, filters: AccountListQuery) {
  const query = knex("usuario as u")
    .where("u.tipo_perfil", profile)
    .whereNull("u.excluido_em");

  if (filters.search) {
    const search = `%${filters.search}%`;
    query.andWhere((searchQuery) => {
      searchQuery
        .whereILike("u.nome_completo", search)
        .orWhereILike("u.email_institucional", search);
    });
  }

  if (filters.activationStatus === "pending") query.whereNull("u.ativado_em");
  if (filters.activationStatus === "activated") query.whereNotNull("u.ativado_em");

  if (profile === "aluno") {
    if (filters.enrollmentStatus === "no_active_enrollment" && filters.classId) {
      query.whereRaw("FALSE");
    } else if (filters.enrollmentStatus === "active" || filters.classId) {
      query.whereExists(function activeEnrollment() {
        this.select(knex.raw("1"))
          .from("matricula as m")
          .whereRaw("m.id_usuario_aluno = u.id_usuario")
          .whereNull("m.fim_vigencia")
          .whereNull("m.cancelada_em");
        if (filters.classId) this.where("m.id_turma", filters.classId);
      });
    } else if (filters.enrollmentStatus === "no_active_enrollment") {
      query.whereNotExists(function activeEnrollment() {
        this.select(knex.raw("1"))
          .from("matricula as m")
          .whereRaw("m.id_usuario_aluno = u.id_usuario")
          .whereNull("m.fim_vigencia")
          .whereNull("m.cancelada_em");
      });
    }
  }

  if (profile === "professor" && (filters.classId || filters.subjectId)) {
    query.whereExists(function currentTeacherAssignment() {
      this.select(knex.raw("1"))
        .from("turma_disciplina_professor as tdp")
        .join("turma_disciplina as td", "td.id_turma_disciplina", "tdp.id_turma_disciplina")
        .whereRaw("tdp.id_usuario_professor = u.id_usuario");
      if (filters.classId) this.where("td.id_turma", filters.classId);
      if (filters.subjectId) this.where("td.id_materia", filters.subjectId);
    });
  }

  return query;
}

function listItem(profile: AccountProfile, row: Record<string, unknown>) {
  const common = {
    name: row.nome_completo,
    email: row.email_institucional,
    activationStatus: activationStatus(row.ativado_em as Date | string | null)
  };

  if (profile === "aluno") {
    const active = row.id_matricula !== null && row.id_matricula !== undefined;
    return {
      studentId: String(row.id_usuario),
      ...common,
      enrollmentStatus: active ? "active" : "no_active_enrollment",
      currentClass: active ? {
        series: Number(row.class_series),
        schoolYear: Number(row.school_year)
      } : null,
      ...(active ? { enrollmentId: String(row.id_matricula) } : {})
    };
  }

  if (profile === "professor") return { teacherId: String(row.id_usuario), ...common };
  return { administratorId: String(row.id_usuario), ...common };
}

export async function listAccounts(
  knex: Knex,
  profile: AccountProfile,
  filters: AccountListQuery
): Promise<{ items: Array<Record<string, unknown>>; pagination: {
  page: number; pageSize: number; totalItems: number; totalPages: number;
} }> {
  const countRow = await filteredAccounts(knex, profile, filters)
    .countDistinct({ total_items: "u.id_usuario" })
    .first() as { total_items: string | number };
  const totalItems = Number(countRow.total_items);

  const query = filteredAccounts(knex, profile, filters)
    .select("u.id_usuario", "u.nome_completo", "u.email_institucional", "u.ativado_em")
    .orderBy("u.nome_completo", "asc")
    .orderBy("u.id_usuario", "asc")
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize);

  if (profile === "aluno") {
    query
      .leftJoin("matricula as m", function activeEnrollment() {
        this.on("m.id_usuario_aluno", "u.id_usuario")
          .andOnNull("m.fim_vigencia")
          .andOnNull("m.cancelada_em");
      })
      .leftJoin("turma as t", "t.id_turma", "m.id_turma")
      .select("m.id_matricula", "t.serie as class_series", "t.ano_letivo as school_year");
  }

  const rows = await query as Array<Record<string, unknown>>;
  return {
    items: rows.map((row) => listItem(profile, row)),
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / filters.pageSize)
    }
  };
}

export async function accountForEdit(
  knex: Knex,
  profile: AccountProfile,
  userId: string
): Promise<{ id: string; email: string } | undefined> {
  const account = await knex("usuario")
    .select("id_usuario", "email_institucional")
    .where({ id_usuario: userId, tipo_perfil: profile })
    .whereNull("excluido_em")
    .first() as { id_usuario: string | number; email_institucional: string } | undefined;
  return account ? { id: String(account.id_usuario), email: account.email_institucional } : undefined;
}

export async function accountDetail(
  knex: Knex,
  profile: AccountProfile,
  userId: string
): Promise<Record<string, unknown> | undefined> {
  const query = knex("usuario as u")
    .select("u.id_usuario", "u.nome_completo", "u.email_institucional", "u.telefone_contato", "u.ativado_em")
    .where("u.id_usuario", userId)
    .where("u.tipo_perfil", profile)
    .whereNull("u.excluido_em");
  if (profile === "aluno") query.select("a.telefone_responsavel").join("aluno as a", "a.id_usuario", "u.id_usuario");

  const row = await query.first() as Record<string, unknown> | undefined;
  if (!row) return undefined;

  const common = {
    name: row.nome_completo,
    email: row.email_institucional,
    activationStatus: activationStatus(row.ativado_em as Date | string | null),
    ...(row.telefone_contato === null ? {} : { contactPhone: row.telefone_contato })
  };
  if (profile === "professor") return { teacherId: String(row.id_usuario), ...common };
  if (profile === "administrador") return { administratorId: String(row.id_usuario), ...common };

  const enrollments = await knex("matricula as m")
    .join("turma as t", "t.id_turma", "m.id_turma")
    .select("m.id_matricula", "m.inicio_vigencia", "m.fim_vigencia", "m.cancelada_em", "t.serie", "t.ano_letivo")
    .where("m.id_usuario_aluno", userId)
    .orderBy("m.inicio_vigencia", "desc")
    .orderBy("m.id_matricula", "desc") as Array<Record<string, unknown>>;
  const active = enrollments.find((enrollment) => enrollment.fim_vigencia === null
    && enrollment.cancelada_em === null);

  return {
    studentId: String(row.id_usuario),
    ...common,
    guardianPhone: row.telefone_responsavel,
    enrollmentStatus: active ? "active" : "no_active_enrollment",
    currentClass: active ? {
      series: Number(active.serie),
      schoolYear: Number(active.ano_letivo)
    } : null,
    enrollments: enrollments.map((enrollment) => ({
      enrollmentId: String(enrollment.id_matricula),
      class: { series: Number(enrollment.serie), schoolYear: Number(enrollment.ano_letivo) },
      startDate: enrollment.inicio_vigencia,
      cancellationDate: enrollment.cancelada_em
    }))
  };
}

export async function createAccount(
  knex: Knex,
  profile: AccountProfile,
  input: NewAccount
): Promise<string> {
  return knex.transaction(async (transaction) => {
    const [created] = await transaction("usuario")
      .insert({
        tipo_perfil: profile,
        nome_completo: input.name,
        email_institucional: input.email,
        telefone_contato: input.contactPhone ?? null
      })
      .returning("id_usuario") as Array<{ id_usuario: string | number }>;
    const id = created.id_usuario;

    if (profile === "aluno") {
      await transaction("aluno").insert({
        id_usuario: id,
        telefone_responsavel: input.guardianPhone
      });
    } else if (profile === "professor") {
      await transaction("professor").insert({ id_usuario: id });
    }

    return String(id);
  });
}

export type AccountUpdateResult =
  | { status: "updated"; previousEmail?: string }
  | { status: "not-found" }
  | { status: "stale" };

export async function updateAccount(
  knex: Knex,
  profile: AccountProfile,
  userId: string,
  expectedEmail: string,
  input: AccountPatch
): Promise<AccountUpdateResult> {
  const emailChanged = input.email !== undefined && input.email !== expectedEmail;
  return knex.transaction(async (transaction) => {
    if (emailChanged && profile === "administrador") {
      await transaction.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [ADMIN_MEMBERSHIP_LOCK]);
    }

    const account = await transaction("usuario")
      .select("id_usuario", "email_institucional")
      .where({ id_usuario: userId, tipo_perfil: profile })
      .whereNull("excluido_em")
      .forUpdate()
      .first() as { id_usuario: string | number; email_institucional: string } | undefined;
    if (!account) return { status: "not-found" };
    if (account.email_institucional !== expectedEmail) return { status: "stale" };

    const update: Record<string, unknown> = {};
    if (input.name !== undefined) update.nome_completo = input.name;
    if (input.contactPhone !== undefined) update.telefone_contato = input.contactPhone;
    if (profile === "aluno" && input.guardianPhone !== undefined) {
      await transaction("aluno")
        .where({ id_usuario: userId })
        .forUpdate()
        .update({ telefone_responsavel: input.guardianPhone });
    }
    if (emailChanged) {
      await transaction("token_ativacao").where({ id_usuario: userId }).delete();
      update.email_pendente = input.email;
      update.ativado_em = null;
    }

    if (Object.keys(update).length > 0) {
      await transaction("usuario").where({ id_usuario: userId }).update(update);
    }
    return { status: "updated", ...(emailChanged ? { previousEmail: account.email_institucional } : {}) };
  });
}

export type AccountDeleteResult =
  | { status: "deleted" }
  | { status: "not-found" }
  | { status: "student-linked-data" }
  | { status: "teacher-linked-data" }
  | { status: "cannot-delete-self" }
  | { status: "last-active-administrator" };

export async function deleteAccount(
  knex: Knex,
  profile: AccountProfile,
  userId: string,
  actorId: string
): Promise<AccountDeleteResult> {
  return knex.transaction(async (transaction) => {
    if (profile === "administrador") {
      await transaction.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [ADMIN_MEMBERSHIP_LOCK]);
    }

    await transaction("sessao")
      .select("id_sessao")
      .where({ id_usuario: userId })
      .whereNull("revogada_em")
      .orderBy("id_sessao")
      .forUpdate();

    const account = await transaction("usuario")
      .select("id_usuario", "ativado_em")
      .where({ id_usuario: userId, tipo_perfil: profile })
      .whereNull("excluido_em")
      .forUpdate()
      .first() as { id_usuario: string | number; ativado_em: Date | string | null } | undefined;
    if (!account) return { status: "not-found" };
    if (profile === "administrador" && String(account.id_usuario) === actorId) {
      return { status: "cannot-delete-self" };
    }

    if (profile === "aluno") {
      await transaction("aluno").select("id_usuario").where({ id_usuario: userId }).forUpdate().first();
      const activeEnrollment = await transaction("matricula")
        .select("id_matricula")
        .where({ id_usuario_aluno: userId })
        .whereNull("fim_vigencia")
        .whereNull("cancelada_em")
        .first();
      if (activeEnrollment) {
        const completedSimulation = await transaction("simulado_aluno as sa")
          .join("simulado as s", "s.id_simulado", "sa.id_simulado")
          .select("sa.id_usuario_aluno")
          .where("sa.id_usuario_aluno", userId)
          .whereNotNull("s.instante_confirmacao_realizacao")
          .first();
        if (completedSimulation) return { status: "student-linked-data" };
      }
    }

    if (profile === "professor") {
      await transaction("professor").select("id_usuario").where({ id_usuario: userId }).forUpdate().first();
      const linked = await transaction("turma_disciplina_professor")
        .select("id_turma_disciplina")
        .where({ id_usuario_professor: userId })
        .first();
      if (linked) return { status: "teacher-linked-data" };
    }

    if (profile === "administrador" && account.ativado_em !== null) {
      const activeAdministrators = await transaction("usuario")
        .select("id_usuario")
        .where({ tipo_perfil: "administrador" })
        .whereNotNull("ativado_em")
        .whereNull("excluido_em")
        .orderBy("id_usuario")
        .forUpdate();
      if (activeAdministrators.length <= 1) return { status: "last-active-administrator" };
    }

    await transaction("usuario")
      .where({ id_usuario: userId })
      .whereNull("excluido_em")
      .update({ excluido_em: transaction.raw("clock_timestamp()") });
    await transaction("sessao")
      .where({ id_usuario: userId })
      .whereNull("revogada_em")
      .update({ revogada_em: transaction.raw("clock_timestamp()") });
    return { status: "deleted" };
  });
}
