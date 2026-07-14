# Lite tool runtime

This deliberately small image supplies BusyBox shell and archive tools. The
base image is pinned by manifest digest. Lite-Harness adds runtime restrictions
at container creation: no network, read-only root, non-root execution, dropped
capabilities, `no-new-privileges`, PID/CPU/memory limits, and a bounded tmpfs.

Build locally:

```sh
docker build -t lite-harness/tool-runtime:dev docker/tool-runtime
docker image inspect lite-harness/tool-runtime:dev --format '{{.Id}}'
```

Pass the resulting immutable `sha256:...` image ID as
`LITE_HARNESS_RUNTIME_IMAGE`. Published images must use a repository digest.
