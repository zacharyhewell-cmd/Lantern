# DV1 development and deployment

Lantern is the active repository for DV1. Make optimizer changes in `packages/delineator` and application changes in Lantern’s `src/dv1`, `public/dv1`, or host integration code. The npm workspace builds the TypeScript optimizer used by both the local fixture runner and the hosted DV1 application.

Run `npm test` before committing DV1 changes. When the user asks to push or deploy DV1 or Delineator, commit the relevant changes in Lantern and push `main` to `origin`. Follow the resulting Render deployment and verify the deployed commit and health endpoint.

The former standalone Delineator checkout is historical. Its worktree and branches are useful for reference.
