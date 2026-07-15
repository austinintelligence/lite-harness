# Lite tool runtime

This deliberately bounded image supplies the Node coding profile used by
Manager-brokered tools. The base image is pinned by manifest digest. Lite-Harness adds runtime restrictions
at container creation: no network, read-only root, non-root execution, dropped
capabilities, `no-new-privileges`, PID/CPU/memory limits, and a bounded tmpfs.

Build locally:

```sh
docker build -t lite-harness/tool-runtime:dev docker/tool-runtime
docker image inspect lite-harness/tool-runtime:dev --format '{{.Id}}'
```

The default `node-profile` is Debian bookworm-slim/glibc with Node 24,
CA certificates, tini, Bash, Git, patch, ripgrep, procps, npm/Corepack, and
pnpm 11.7.0. Build the opt-in Python profile with:

```bash
docker build --build-arg LITE_TOOL_PROFILE=python-profile -t lite-harness/tool-runtime:python docker/tool-runtime
```

The final runtime remains non-root. Manager starts every tool container with
network disabled, a read-only root filesystem, dropped capabilities, bounded
CPU/memory/PIDs/output/time, and only the owned workspace mounted writable.

The Docker runtime advertises `read_file`, `write_file`, `shell_exec`,
`process_exec`, `search_text`, `patch_apply`, `git_exec`, `test_run`,
`build_run`, and `package_run`; artifact promotion remains the separate
Manager-owned `artifact_publish` tool. Shell scripts and patch bodies travel on
stdin instead of Docker argv. Direct process arguments, paths, schemas, output,
time, and Git subcommands are bounded; Git hooks are disabled and containers
have no network route.

Pass the resulting immutable `sha256:...` image ID as
`LITE_HARNESS_RUNTIME_IMAGE`. Published images must use a repository digest.
