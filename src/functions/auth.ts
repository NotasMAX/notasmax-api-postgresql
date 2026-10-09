import { app } from "@azure/functions";
import { createAuthHandlers } from "../auth/handler";

const authHandlers = createAuthHandlers();

app.http("authSessions", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "v1/auth/sessions",
  handler: authHandlers.createSession
});

app.http("authCurrentSession", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "v1/auth/me",
  handler: authHandlers.currentSession
});

app.http("authDeleteCurrentSession", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "v1/auth/sessions/current",
  handler: authHandlers.deleteCurrentSession
});
