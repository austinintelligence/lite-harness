# Third-party notices

No OpenClaw or pxpipe source has been copied into the current Lite-Harness
kernel.

The architecture and behavior research references:

- OpenClaw, MIT license, pinned at
  `834810b3d6e367cbdf69b4c822d220f1a150b14c`.
- pxpipe, MIT license, evaluated as a future optional context renderer.
- Microsoft Playwright, Apache-2.0 license. The managed-browser image uses the
  Playwright 1.61.0 package and base image. The vendored
  `docker/browser-runtime/seccomp_profile.json` is copied from Playwright
  commit `7b02a7a6d85aad2efc5ef46d63bf2f22e276fff2`, with only line-ending
  normalization.

Before adapting upstream code or shipping assets, copy the complete applicable
license and notice text here and add a machine-readable entry to
`PROVENANCE.json`.
