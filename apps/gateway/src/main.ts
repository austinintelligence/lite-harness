import { join } from "node:path";
import { buildGatewayServer } from "./server.js";
import { ManagerClient } from "./manager-client.js";

const dataDir = process.env.LITE_HARNESS_DATA_DIR ?? join(process.cwd(), ".lite-harness");
const socketPath =
  process.env.LITE_HARNESS_MANAGER_SOCKET ??
  (process.platform === "win32" ? "\\\\.\\pipe\\lite-harness-manager" : join(dataDir, "manager.sock"));
const internalToken = requiredEnvironment("LITE_HARNESS_INTERNAL_TOKEN");
const appToken = requiredEnvironment("LITE_HARNESS_APP_TOKEN");
const port = Number.parseInt(process.env.LITE_HARNESS_PORT ?? "3210", 10);
const host = process.env.LITE_HARNESS_HOST ?? "127.0.0.1";

const app = buildGatewayServer({
  manager: new ManagerClient(socketPath, internalToken),
  appToken,
  logger: true,
});

await app.listen({ host, port });

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
