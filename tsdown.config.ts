/**
 * Standalone dual-face build for dsh-file-mount.
 *
 * Host half: lib/index.js, all @deepseek-ai/* modules externalized
 * (the DSH profile resolves them at runtime).
 *
 * Client half: lib/client.js following the harness's module-loader
 * convention (window.__ModuleLoader__.load banner; externals from the
 * frozen platform module table; CSS modules inlined as hashed class maps
 * with a plugin-owned style tag). Cross-plugin VALUE imports are forbidden
 * by the purity gate — collaboration goes through cordis services.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PACKAGE_ID = 'dsh-file-mount'

/** The module specifiers the web shell shares into the frozen module table. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Browser-safe inline CSS modules with hashed class maps (the DSH preset). */
const cssModulesInline = {
  name: 'dsh-css-modules-inline',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css')) return null
    const abs = importer !== undefined ? resolve(dirname(importer), source) : source
    return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
  },
  async load(virtualId: string) {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    const source = await readFile(fileId)
    const { code, exports: cssExports } = transform({
      filename: fileId,
      code: source,
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
    const tagId = JSON.stringify(`${PACKAGE_ID}/${basename(fileId)}`)
    return [
      `const css = ${JSON.stringify(code.toString())};`,
      `const tagId = ${tagId};`,
      "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
      '  const tag = document.createElement(\'style\');',
      `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      `export default ${JSON.stringify(classMap)};`,
    ].join('\n')
  },
}

/** Purity gate: any @deepseek-ai/* value import must be a platform module. */
const purityGate = {
  name: 'dsh-client-bundle-purity',
  resolveId(source: string) {
    if (!source.startsWith('@deepseek-ai/')) return null
    if ((PLATFORM_MODULES as readonly string[]).includes(source)) return null
    throw new Error(
      `client bundle purity: "${source}" is not a platform module — `
      + 'cross-plugin value imports are forbidden; collaborate through cordis services',
    )
  },
}

export default defineConfig([
  {
    name: PACKAGE_ID,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: [/^@deepseek-ai\//, 'react', 'react/jsx-runtime'] },
  },
  {
    name: `${PACKAGE_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: { neverBundle: [...PLATFORM_MODULES] },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [purityGate, cssModulesInline],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])