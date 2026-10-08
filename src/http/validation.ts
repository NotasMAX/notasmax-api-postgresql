import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { z } from "zod";

export type ValidationSource =
  | { in: "body" }
  | { in: "path" | "query"; name?: string };

export type InputValidationResult<Schema extends z.ZodType> =
  | { success: true; data: z.output<Schema> }
  | { success: false; response: HttpResponseInit };

type PublicErrorCode =
  | "FIELD_REQUIRED"
  | "INVALID_TYPE"
  | "INVALID_FORMAT"
  | "VALUE_OUT_OF_RANGE"
  | "INVALID_VALUE";

type ValidationIssue = z.ZodError["issues"][number];
type ValidationProblemError = {
  code: PublicErrorCode;
  detail: string;
  source: { in: "body"; pointer: string } | { in: "path" | "query"; name: string };
};

const problemContentType = "application/problem+json";
const issueDetails: Record<PublicErrorCode, string> = {
  FIELD_REQUIRED: "Este campo é obrigatório.",
  INVALID_TYPE: "O tipo informado é inválido.",
  INVALID_FORMAT: "O formato informado é inválido.",
  VALUE_OUT_OF_RANGE: "O valor está fora do intervalo permitido.",
  INVALID_VALUE: "O valor informado é inválido."
};

function isMissingInput(input: unknown, path: PropertyKey[]): boolean {
  if (path.length === 0) return input === undefined;

  let current = input;
  for (const part of path) {
    if (current === null || (typeof current !== "object" && typeof current !== "function")) {
      return false;
    }
    if (!Object.hasOwn(current, part)) return true;
    current = (current as Record<PropertyKey, unknown>)[part];
  }
  return current === undefined;
}

function publicCode(issue: ValidationIssue, input: unknown): PublicErrorCode {
  if (issue.code === "invalid_type") {
    return isMissingInput(input, issue.path) ? "FIELD_REQUIRED" : "INVALID_TYPE";
  }

  switch (issue.code) {
    case "invalid_format":
      return "INVALID_FORMAT";
    case "too_small":
    case "too_big":
      return "VALUE_OUT_OF_RANGE";
    case "invalid_value":
      return "INVALID_VALUE";
    default:
      return "INVALID_VALUE";
  }
}

function jsonPointer(path: PropertyKey[]): string {
  if (path.length === 0) return "";
  return `/${path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function sourceForIssue(issue: ValidationIssue, source: ValidationSource): ValidationProblemError["source"] {
  if (source.in === "body") {
    return { in: "body", pointer: jsonPointer(issue.path) };
  }

  const name = issue.path.length > 0 ? String(issue.path[0]) : source.name ?? "parameters";
  return { in: source.in, name };
}

function validationProblem(
  status: 400 | 422,
  detail: string,
  errors: ValidationProblemError[]
): HttpResponseInit {
  return {
    status,
    headers: { "content-type": problemContentType },
    jsonBody: {
      type: "about:blank",
      title: status === 400 ? "Requisição inválida" : "Conteúdo não processável",
      status,
      code: "VALIDATION_ERROR",
      detail,
      errors
    }
  };
}

function queryValues(query: URLSearchParams): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
  query.forEach((value, name) => {
    if (!Object.hasOwn(values, name)) {
      values[name] = value;
      return;
    }

    const current = values[name];
    values[name] = Array.isArray(current) ? [...current, value] : [current, value];
  });
  return values;
}

export function validateInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  source: ValidationSource
): InputValidationResult<Schema> {
  const candidate = source.in === "query" && input instanceof URLSearchParams
    ? queryValues(input)
    : input;
  const result = schema.safeParse(candidate);
  if (result.success) return { success: true, data: result.data };

  const errors = result.error.issues.map((issue): ValidationProblemError => {
    const code = publicCode(issue, candidate);
    return {
      code,
      detail: issueDetails[code],
      source: sourceForIssue(issue, source)
    };
  });
  const status = source.in === "body" ? 422 : 400;
  const detail = source.in === "body"
    ? "O conteúdo enviado não atende aos critérios de validação."
    : "Um ou mais parâmetros da requisição são inválidos.";
  return { success: false, response: validationProblem(status, detail, errors) };
}

export async function validateJsonBody<Schema extends z.ZodType>(
  request: Pick<HttpRequest, "json">,
  schema: Schema
): Promise<InputValidationResult<Schema>> {
  let input: unknown;
  try {
    input = await request.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return {
      success: false,
      response: validationProblem(400, "O corpo da requisição não contém um JSON válido.", [{
        code: "INVALID_FORMAT",
        detail: "O corpo da requisição deve conter um JSON válido.",
        source: { in: "body", pointer: "" }
      }])
    };
  }

  return validateInput(schema, input, { in: "body" });
}
