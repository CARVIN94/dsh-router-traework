/**
 * tsdown build for dsh-router-traework — HOST half only.
 *
 * Produces `lib/index.js`: the Node host half that provides the
 * `router.suppliers` cordis service for dsh-router.
 */
import { builtinModules } from 'node:module'
import type { UserConfig } from 'tsdown'

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      neverBundle: [/^@deepseek-ai\//],
    },
  },
] satisfies UserConfig[]
