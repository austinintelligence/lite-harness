import { join } from "node:path";
import { AccessTokenService, DEFAULT_APP_SCOPES } from "@lite-harness/auth";
import { loadGatewayConfiguration } from "@lite-harness/config";
import { SqliteAccessTokenStore } from "@lite-harness/storage-sqlite";
import { buildGatewayServer } from "./server.js";
import { ManagerClient } from "./manager-client.js";

const configuration = loadGatewayConfiguration();
const {
  dataDir, socketPath, internalToken, appToken, bootstrapIdentity,
  port, host, authFailureLimit, authFailureWindowMs,
} = configuration;
const accessTokenStore = new SqliteAccessTokenStore(join(dataDir, "auth.db"));
const accessTokens = new AccessTokenService(accessTokenStore);
await accessTokens.ensureBootstrapAppToken(appToken, {
  ...bootstrapIdentity,
  scopes: [...DEFAULT_APP_SCOPES],
});

const app = buildGatewayServer({
  manager: new ManagerClient(socketPath, internalToken),
  accessTokens,
  authFailureLimit,
  authFailureWindowMs,
  logger: true,
});
app.addHook("onClose", async () => accessTokenStore.close());

await app.listen({ host, port });
installShutdownHandlers(app);

function installShutdownHandlers(server: { close(): Promise<void> }): void {
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    process.stderr.write(`lite-harness gateway: received ${signal}, shutting down\n`);
    void server.close().catch((error) => {
      process.stderr.write(`lite-harness gateway: shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
