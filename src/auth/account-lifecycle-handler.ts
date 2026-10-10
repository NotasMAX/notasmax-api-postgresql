import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Knex } from "knex";
import { z } from "zod";
import { getKnex } from "../database/knex";
import { createProblemResponse, validateInput, validateJsonBody } from "../http/validation";
import {
  configuredOrigins,
  internalFailure,
  mutationRejection,
  requireAdminSession,
  resourceNotFound
} from "./handler";
import {
  activateAccount as activateAccountService,
  completePasswordReset as completePasswordResetService,
  issueActivationToken,
  reservePasswordReset
} from "./account-lifecycle-service";
import { accountActionUrl, createFakeEmailAdapter, type EmailTransport } from "./email-transport";

const MAX_LIFECYCLE_BODY_BYTES = 8 * 1024;
const passwordResetMessage = "Se houver uma conta ativa associada a este e-mail, enviaremos um link para redefinir sua senha.";
const passwordResetRequestSchema = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(254)
});
const tokenPasswordSchema = z.strictObject({
  token: z.string(),
  password: z.string().min(15).max(1024)
});
const resendRouteSchema = z.strictObject({
  userId: z.string().refine((value) => /^[1-9]\d{0,18}$/.test(value)
    && BigInt(value) <= 9223372036854775807n)
});

type RequestHandler = (
  request: HttpRequest,
  context: InvocationContext
) => Promise<HttpResponseInit>;

type LifecycleHandlerOptions = {
  getDatabase?: () => Knex;
  allowedOrigins?: readonly string[];
  emailTransport?: EmailTransport;
  webBaseUrl?: string;
};

function tokenFailure(kind: "activation" | "password-reset"): HttpResponseInit {
  const activation = kind === "activation";
  return createProblemResponse({
    status: 400,
    title: "Link inválido ou expirado",
    code: activation ? "ACTIVATION_TOKEN_INVALID" : "PASSWORD_RESET_TOKEN_INVALID",
    detail: activation
      ? "O link de ativação é inválido, expirou ou já foi utilizado."
      : "O link de redefinição é inválido, expirou ou já foi utilizado.",
    headers: { "cache-control": "no-store" }
  });
}

function alreadyActivated(): HttpResponseInit {
  return createProblemResponse({
    status: 409,
    title: "Conta já ativada",
    code: "ACCOUNT_ALREADY_ACTIVATED",
    detail: "A conta informada já está ativada.",
    headers: { "cache-control": "no-store" }
  });
}

function deliveryAdapter(options: LifecycleHandlerOptions) {
  if (!options.emailTransport) return createFakeEmailAdapter();
  const webBaseUrl = options.webBaseUrl;
  if (!webBaseUrl) throw new Error("Account email transport is unavailable.");
  return { transport: options.emailTransport, webBaseUrl };
}

function logLifecycle(
  context: InvocationContext,
  event: string,
  result: string,
  startedAt: number
): void {
  try {
    context.log(JSON.stringify({
      event,
      invocationId: context.invocationId,
      result,
      durationMs: Math.max(0, Date.now() - startedAt)
    }));
  } catch {
    // A logging failure must not change an account lifecycle result.
  }
}

export function createAccountLifecycleHandlers(options: LifecycleHandlerOptions = {}): {
  requestPasswordReset: RequestHandler;
  completePasswordReset: RequestHandler;
  activate: RequestHandler;
  resendActivation: RequestHandler;
} {
  const getDatabase = options.getDatabase ?? getKnex;
  const allowedOrigins = options.allowedOrigins ?? configuredOrigins();

  const requestPasswordReset: RequestHandler = async (request, context) => {
    const validated = await validateJsonBody(request, passwordResetRequestSchema, { maxBytes: MAX_LIFECYCLE_BODY_BYTES });
    if (!validated.success) return validated.response;

    const startedAt = Date.now();
    let adapter: ReturnType<typeof deliveryAdapter> | undefined;
    try {
      adapter = deliveryAdapter(options);
    } catch {
      logLifecycle(context, "password_reset_request", "not-sent", startedAt);
      return { status: 200, headers: { "cache-control": "no-store" }, jsonBody: { message: passwordResetMessage } };
    }

    try {
      const reservation = await reservePasswordReset(getDatabase(), validated.data.email);
      const message = reservation.status === "reserved"
        ? {
            kind: "password-reset",
            recipient: reservation.recipient,
            url: accountActionUrl(adapter.webBaseUrl, "password-reset", reservation.token)
          } as const
        : undefined;
      try {
        await adapter.transport.send(message);
      } catch {
        // Reset requests keep their approved generic response when delivery fails.
      }
      logLifecycle(context, "password_reset_request", "completed", startedAt);
      return { status: 200, headers: { "cache-control": "no-store" }, jsonBody: { message: passwordResetMessage } };
    } catch {
      logLifecycle(context, "password_reset_request", "failed", startedAt);
      return internalFailure();
    }
  };

  const completePasswordReset: RequestHandler = async (request, _context) => {
    const validated = await validateJsonBody(request, tokenPasswordSchema, { maxBytes: MAX_LIFECYCLE_BODY_BYTES });
    if (!validated.success) return validated.response;

    const startedAt = Date.now();
    try {
      const completed = await completePasswordResetService(
        getDatabase(),
        validated.data.token,
        validated.data.password
      );
      if (!completed) {
        logLifecycle(_context, "password_reset_completion", "rejected", startedAt);
        return tokenFailure("password-reset");
      }
      logLifecycle(_context, "password_reset_completion", "completed", startedAt);
      return {
        status: 200,
        headers: { "cache-control": "no-store" }
      };
    } catch {
      logLifecycle(_context, "password_reset_completion", "failed", startedAt);
      return internalFailure();
    }
  };

  const activate: RequestHandler = async (request, _context) => {
    const validated = await validateJsonBody(request, tokenPasswordSchema, { maxBytes: MAX_LIFECYCLE_BODY_BYTES });
    if (!validated.success) return validated.response;

    const startedAt = Date.now();
    try {
      const activated = await activateAccountService(getDatabase(), validated.data.token, validated.data.password);
      if (!activated) {
        logLifecycle(_context, "account_activation", "rejected", startedAt);
        return tokenFailure("activation");
      }
      logLifecycle(_context, "account_activation", "completed", startedAt);
      return {
        status: 200,
        headers: { "cache-control": "no-store" }
      };
    } catch {
      logLifecycle(_context, "account_activation", "failed", startedAt);
      return internalFailure();
    }
  };

  const resendActivation: RequestHandler = async (request, context) => {
    const rejected = mutationRejection(request, allowedOrigins);
    if (rejected) return rejected;

    const route = validateInput(resendRouteSchema, request.params, { in: "path" });
    if (!route.success) return route.response;

    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;

    let adapter: ReturnType<typeof deliveryAdapter>;
    try {
      adapter = deliveryAdapter(options);
    } catch {
      return internalFailure();
    }

    const startedAt = Date.now();
    try {
      const issue = await issueActivationToken(getDatabase(), route.data.userId);
      if (issue.status === "not-found") return resourceNotFound();
      if (issue.status === "already-active") return alreadyActivated();

      let result: "sent" | "failed" = "sent";
      try {
        await adapter.transport.send({
          kind: "activation",
          recipient: issue.recipient,
          url: accountActionUrl(adapter.webBaseUrl, "activation", issue.token)
        });
      } catch {
        result = "failed";
      }
      logLifecycle(context, "activation_resend", result, startedAt);
      return {
        status: 200,
        headers: { "cache-control": "no-store" },
        jsonBody: { activationEmailStatus: result }
      };
    } catch {
      logLifecycle(context, "activation_resend", "failed", startedAt);
      return internalFailure();
    }
  };

  return { requestPasswordReset, completePasswordReset, activate, resendActivation };
}
