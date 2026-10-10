export type AccountEmailKind = "activation" | "password-reset";

export type AccountEmail =
  | { kind: AccountEmailKind; recipient: string; url: string }
  | { kind: "email-change-notice"; recipient: string };

export type EmailTransport = {
  send(message: AccountEmail | undefined): Promise<void>;
};

export type FakeEmailAdapter = {
  transport: EmailTransport;
  webBaseUrl: string;
};

export function resolveAccountEmailAdapter(options: {
  environment?: Environment;
  transport?: EmailTransport;
  webBaseUrl?: string;
} = {}): FakeEmailAdapter {
  if (!options.transport) return createFakeEmailAdapter(options.environment);
  if (!options.webBaseUrl) throw new Error("Account email transport is unavailable.");
  return { transport: options.transport, webBaseUrl: options.webBaseUrl };
}

type Environment = Record<string, string | undefined>;

function configuredWebBaseUrl(environment: Environment): string {
  const configured = environment.NOTASMAX_WEB_BASE_URL;
  if (!configured) throw new Error("Account email transport is unavailable.");

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("Account email transport is unavailable.");
  }

  if (parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== "") {
    throw new Error("Account email transport is unavailable.");
  }

  return parsed.origin;
}

export function createFakeEmailAdapter(environment: Environment = process.env): FakeEmailAdapter {
  const isAzure = Boolean(
    environment.WEBSITE_INSTANCE_ID
    || environment.WEBSITE_SITE_NAME
    || environment.WEBSITE_HOSTNAME
  );
  const isDevelopmentOrTest = environment.NODE_ENV === "development" || environment.NODE_ENV === "test";
  if (isAzure || !isDevelopmentOrTest || environment.NOTASMAX_EMAIL_TRANSPORT !== "fake") {
    throw new Error("Account email transport is unavailable.");
  }

  const webBaseUrl = configuredWebBaseUrl(environment);
  return {
    webBaseUrl,
    transport: {
      async send(_message) {
        // The local adapter acknowledges messages without delivering or displaying them.
      }
    }
  };
}

export function accountActionUrl(
  webBaseUrl: string,
  kind: AccountEmailKind,
  token: string
): string {
  const url = new URL(kind === "activation" ? "/ativar-conta" : "/redefinir-senha", webBaseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}
