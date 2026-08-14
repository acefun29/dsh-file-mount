/**
 * Standalone build for dsh-file-mount (dual-face plugin).
 * The host half bundles lib/index.js against externalized @deepseek-ai/* modules
 * (resolved at runtime from the DSH profile). The client half is added together
 * with src/client in a later phase; it must follow the DSH module-loader banner
 * convention (see packages/client/tsdown.client.ts in the harness repo).
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-file-mount',
  entry: ['src/index.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: [/^@deepseek-ai\//, 'react', 'react/jsx-runtime'],
})
