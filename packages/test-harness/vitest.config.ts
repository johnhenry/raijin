import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (pkg: string) =>
  fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url))

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
  },
  resolve: {
    /**
     * Resolve the workspace packages to their SOURCE, not to their built
     * `dist`.
     *
     * Every other package's suite runs against `src` (it imports relatively).
     * This one did not: `@johnhenry/raijin-*` resolves through the package
     * `exports` map to `dist/index.js`, so the harness was testing whatever
     * was last built. Two ways that goes wrong, both silent:
     *
     *  - a change to consensus or validator source that nobody rebuilt is not
     *    covered here at all, and the suite reports green for code that is not
     *    the code in the tree;
     *  - the harness reaches directly into `../../consensus/test/helpers.ts`
     *    (see `src/index.ts`), which is source. Mixing a source helper with a
     *    built package means two copies of `ValidatorSet` and two versions of
     *    the vote payload — and a payload mismatch is an invalid signature,
     *    which looks like consensus quietly refusing to make progress rather
     *    than like a build problem.
     *
     * Pointing at source removes both. Nothing here needs the bundler.
     */
    alias: {
      '@johnhenry/raijin-core': src('core'),
      '@johnhenry/raijin-consensus': src('consensus'),
      '@johnhenry/raijin-mempool': src('mempool'),
      '@johnhenry/raijin-validator': src('validator'),
    },
  },
})
