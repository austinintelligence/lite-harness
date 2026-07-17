import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const workflowDirectory = resolve(root, ".github", "workflows");
const gatePredicate = "inputs.gate == 'all' || inputs.gate == matrix.gate";

const matrixWorkflowPolicies = new Map([
  ["external-platform-evidence.yml", {
    job: "rootless-product-evidence",
    gates: [
      "linuxRootful", "linuxRootless", "linuxArm64",
      "macosIntelDockerDesktop", "macosAppleSiliconDockerDesktop", "windows11DockerDesktopWsl2",
    ],
    producer: "pnpm evidence:external --gate",
  }],
  ["external-provider-evidence.yml", {
    job: "provider-live-evidence",
    gates: ["openaiLive", "anthropicLive", "codexLive"],
    producer: "pnpm evidence:provider --gate",
  }],
]);

export function validateWorkflowStructure(text, filename) {
  const failures = [];
  const policy = matrixWorkflowPolicies.get(filename);
  if (policy) {
    const block = jobBlock(text, policy.job);
    if (!block) {
      failures.push(`${filename}: missing matrix job ${policy.job}`);
    } else {
      if (/^ {4}if:.*\bmatrix\./m.test(block)) {
        failures.push(`${filename}: matrix filtering must not use matrix in a job-level if`);
      }
      if (!/^ {4}strategy:\s*$/m.test(block) || !/^ {6}matrix:\s*$/m.test(block)) {
        failures.push(`${filename}: ${policy.job} must declare a matrix strategy`);
      }
      const gates = [...block.matchAll(/^\s+- gate:\s*([^\s#]+)/gm)].map((match) => match[1]);
      for (const gate of policy.gates) if (!gates.includes(gate)) failures.push(`${filename}: matrix is missing gate ${gate}`);
      for (const gate of gates) if (!policy.gates.includes(gate)) failures.push(`${filename}: matrix has unexpected gate ${gate}`);
      const steps = stepBlocks(block);
      if (!steps.length) failures.push(`${filename}: ${policy.job} has no steps`);
      for (const step of steps) {
        if (!step.includes(gatePredicate)) {
          failures.push(`${filename}: every matrix step must be gated by the selected input gate`);
        }
      }
      if (!block.includes(policy.producer)) failures.push(`${filename}: matrix job is missing its evidence producer`);
    }
    if (!text.includes("workflow_call:")) failures.push(`${filename}: reusable workflow must declare workflow_call`);
    if (!/workflow_call:[\s\S]*?inputs:[\s\S]*?gate:[\s\S]*?type:\s*string/.test(text)) {
      failures.push(`${filename}: workflow_call gate input must be a string`);
    }
    if (!/workflow_dispatch:[\s\S]*?inputs:[\s\S]*?gate:[\s\S]*?type:\s*choice/.test(text)) {
      failures.push(`${filename}: workflow_dispatch gate input must be a choice`);
    }
  }
  for (const match of text.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/g)) {
    if (!/^[a-f0-9]{40}$/.test(match[1])) failures.push(`${filename}: action reference is not pinned: ${match[0]}`);
  }
  return failures;
}

export function validateWorkflowFiles(files = workflowFiles()) {
  return files.flatMap((filename) => {
    const text = readFileSync(resolve(workflowDirectory, filename), "utf8");
    return validateWorkflowStructure(text, filename);
  });
}

export function workflowFiles() {
  return readdirSync(workflowDirectory).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml")).sort();
}

export function runActionlint() {
  const command = process.env.ACTIONLINT_BIN?.trim() || "actionlint";
  const result = spawnSync(command, ["-color=false"], { cwd: root, encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    return ["actionlint is required but was not found; install actionlint or set ACTIONLINT_BIN (see https://github.com/rhysd/actionlint)"];
  }
  if (result.error) return [`actionlint failed to start: ${result.error.message}`];
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    return [`actionlint reported workflow errors${detail ? `:\n${detail}` : ""}`];
  }
  return [];
}

function jobBlock(text, jobId) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start < 0) return undefined;
  const end = lines.slice(start + 1).findIndex((line) => /^  [A-Za-z0-9_-]+:\s*$/.test(line));
  return lines.slice(start, end < 0 ? lines.length : start + 1 + end).join("\n");
}

function stepBlocks(block) {
  const lines = block.split(/\r?\n/);
  const starts = lines.map((line, index) => /^      - /.test(line) ? index : -1).filter((index) => index >= 0);
  return starts.map((start, position) => lines.slice(start, starts[position + 1] ?? lines.length).join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const failures = validateWorkflowFiles();
  if (!process.argv.includes("--no-actionlint")) failures.push(...runActionlint());
  if (failures.length) {
    process.stderr.write(`Workflow checks failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Workflow structure and actionlint checks passed for ${workflowFiles().length} workflow files.\n`);
  }
}
