# Repository Guidelines

## Commit Rules

- Use English conventional commits, for example `feat: reorganize source layout`.
- Do not commit until `bun run lint`, `bun run format:check`, `bun run typecheck`, `bun run test:coverage`, and `bun run build` all pass.
- Unit test coverage must stay at or above 90%; do not commit code below the enforced coverage threshold.

## Code Style

- Write comments in English only.
- Keep README, deployment manifests, GitHub Actions, and Dependabot aligned with the current repository structure.
- Prefer Bun for dependency management and local commands.
- Prefer TypeScript for application and test code whenever a new file or rewrite is needed.
- Use arrow functions only. Do not introduce `function` declarations; prefer `const name = () => {}` consistently.
- Do not leave unused variables in committed code. Remove them or rename intentionally ignored values with a leading underscore only when the linter rule allows it.
- When changing user-visible copy, review every supported locale in `messages/` and keep equivalent wording aligned across them.

## Verification Before Commit

- Run `bun run lint`.
- Run `bun run format:check`.
- Run `bun run typecheck`.
- Treat unit test coverage below 90% as a blocking failure.
- Run `bun run test:coverage` and confirm the reported coverage stays at or above 90%.
- Run `bun run build`.

## Release

Publishing is `scripts/release.sh`. Do not reinvent the tag, the build command,
or the deploy steps, and do not ask the maintainer how releasing works.

- Image: `registry.cn-hangzhou.aliyuncs.com/hucx/codebuddy2api`, tag scheme `YYYYMMDD.TNN`.
- `scripts/release.sh` builds `linux/amd64`, pushes to ACR, rewrites the tag in all
  three deployment manifests (`deploy/swarm-stack.yml`, `deploy/docker-compose.yml`,
  `deploy/k8s/codebuddy2api.yaml`), commits, and prints the server command.
- `--provenance=false --sbom=false` is mandatory: ACR refuses the attestation
  manifest buildx attaches by default, and the push fails with an unknown
  manifest class error naming `application/vnd.oci.empty.v1+json`.
- Deploying is `node scripts/deploy-swarm.mjs <tag>`. It talks to the project's
  Docker Swarm MCP endpoint declared in the gitignored `.mcp.json`
  (`mcpServers["docker-swarm"]`) and polls `updateState` until the task runs the
  new tag. There is no ssh access from this machine, so the MCP is the only path
  to the swarm manager — do not report a release as done until
  `scripts/deploy-swarm.mjs --check <tag>` prints the new image.
- `scripts/release.sh --deploy` runs the whole loop: build, push, bump the
  manifests, commit, deploy, verify.
- The deployed tag and the tag in `deploy/swarm-stack.yml` drift easily; the
  service is the source of truth, read it with `scripts/deploy-swarm.mjs --check`.
- Rollback is the previous tag in the same manifests plus a redeploy.

## Verification Before PR

- Run `bun run test:ci` to generate `coverage/lcov.info` and `test-report.junit.xml`.
- Run `bun run test:patch-branches --base "$(git merge-base HEAD origin/main)"` after coverage; changed branch coverage must be at least 90%.
- Confirm Codecov's `patch` status is successful and meets the target configured in `codecov.yml`; do not lower the patch target or threshold to bypass a coverage failure.
- Use the Codecov PR report as the source of truth for patch coverage because it compares the uploaded `lcov.info` against the PR base commit.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use `openwiki_search` for just-in-time context and `openwiki_read` for the relevant complete sections. If search returns `workspace_required`, ask which listed workspace to use and retry with its ID.
- Use `openwiki_list_workspaces` or `openwiki_list_wikis` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read `openwiki/quickstart.md` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
