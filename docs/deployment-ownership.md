# Deployment ownership

Proxx owns application source, tests, and portable packaging. The Dockerfiles,
Compose overlays, Caddy templates, and runtime policy contracts in this
repository describe how Proxx can run; they do not select a production host or
authorize a deployment.

`open-hax/services` is the only production deployment authority. Its declared
DigitalOcean host contract owns inventory, pinned SSH trust, image builds,
runtime configuration, deployment order, and live verification. A reviewed
Services pull request carrying `deploy` at merge time deploys the stack.

Proxx has a single trunk, `main`; there is no `staging` branch or promotion PR.
Services builds Proxx from a ref of `main` using the root `Dockerfile`. Proxx's
release workflow validates source but intentionally does not mutate a host. There
is no testing or staging target declared here.

The former Promethean deployment implementation is retired. Direct remote
deployment scripts, checked-in host target files, and the label-triggered test
deployment were deleted together. Historical receipts remain evidence; they
are not runnable instructions or current desired state.

When adding packaging for a new runtime shape:

1. Keep provider/model policy in EDN and ClojureScript.
2. Prove the package locally without embedding a host, SSH identity, or trust
   bootstrap.
3. Add host placement and promotion mechanics to `open-hax/services`.
4. Deploy through the Services-owned DigitalOcean workflow and its protected
   environment.
