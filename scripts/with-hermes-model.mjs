import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const path = resolve(process.cwd(), ".env.hermes.local");
const configured = parseEnvironment(readFileSync(path, "utf8"));
for (const required of ["LITE_HARNESS_PROVIDER", "LITE_HARNESS_PROVIDER_BASE_URL", "LITE_HARNESS_PROVIDER_API_KEY", "LITE_HARNESS_MODEL"]) {
  if (!configured[required]) throw new Error(`Missing ${required} in ${path}`);
}
if (configured.LITE_HARNESS_PROVIDER !== "openai-compatible" ||
    configured.LITE_HARNESS_PROVIDER_BASE_URL !== "http://127.0.0.1:8645/v1" ||
    configured.LITE_HARNESS_MODEL !== "gpt-5.6-luna") {
  throw new Error("Local Hermes configuration does not match the required Lite-Harness testing policy");
}
const [requestedCommand, ...args] = process.argv.slice(2);
if (!requestedCommand) throw new Error("Usage: node scripts/with-hermes-model.mjs <command> [...args]");
const command = requestedCommand === "node" ? process.execPath : requestedCommand;
const child = spawn(command, args, {
  cwd: process.cwd(), env: { ...process.env, ...configured }, stdio: "inherit", shell: false, windowsHide: true,
});
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

function parseEnvironment(text) {
  const output = {};
  const allowed = new Set([
    "LITE_HARNESS_PROVIDER", "LITE_HARNESS_PROVIDER_BASE_URL", "LITE_HARNESS_PROVIDER_API_KEY",
    "LITE_HARNESS_CREDENTIAL_PROFILE", "LITE_HARNESS_MODEL", "LITE_HARNESS_LIVE_MODEL_TEST",
  ]);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) throw new Error("Malformed local Hermes environment line");
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!allowed.has(name) || !value) throw new Error("Malformed or unsupported local Hermes environment entry");
    output[name] = value;
  }
  return output;
}
