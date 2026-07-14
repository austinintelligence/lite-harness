# OpenClaw migration

Lite-Harness is a GitHub-network fork with preserved OpenClaw ancestry, but its
production kernel does not import legacy OpenClaw modules. Migration is an
explicit data and compatibility workflow.

Preview a bounded, symlink-safe inventory:

```powershell
pnpm lite migrate openclaw C:\path\to\openclaw
```

The report lists recognized configuration key names and skill/plugin metadata;
it does not print configuration values or secrets. Apply supported SKILL.md
imports into the isolated Lite data directory with `--apply` after reviewing
the preview. Provider credentials must be re-entered through Lite's environment
or OS secret store rather than copied from OpenClaw.

Supported compatibility plugins run only through the bounded child-worker ABI
documented in [`PLUGINS.md`](PLUGINS.md). Arbitrary Gateway routes, internal SDK
imports, global mutation, and in-process legacy plugin execution are not
migrated. Keep the original OpenClaw data directory until the imported skills,
workspaces, and recovery backup have been verified.
