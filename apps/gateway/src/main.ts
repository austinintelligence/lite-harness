import { loadGatewayConfiguration } from "@lite-harness/config";
import { buildGatewayServer } from "./server.js";
import { ManagerClient } from "./manager-client.js";

const configuration = loadGatewayConfiguration();
const { socketPath, internalToken, appToken, port, host } = configuration;

const app = buildGatewayServer({
  manager: new ManagerClient(socketPath, internalToken),
  appToken,
  logger: true,
});

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
