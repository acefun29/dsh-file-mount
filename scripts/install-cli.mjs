#!/usr/bin/env node
/**
 * One-click install into a DeepSeek Harness profile.
 *
 *   npx dsh-file-mount
 *   pnpm dsh:install
 *   node scripts/install-cli.mjs
 *
 * Windows cannot `dsh plugin add .` — pnpm turns `E:\...` into a junction
 * under the profile directory (`profile\E:\...`) and DSH then misses the
 * bundle. This installer packs a tarball and adds `file:E:/...tgz` instead.
 * It also prefers an already-installed dsh CLI under ~/.dsh, because
 * `npx @deepseek-ai/dsh` may sit for minutes downloading the full tree.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Turn an absolute path into a pnpm `file:` spec that keeps the drive letter. */
export function toFileUrlSpec(absPath) {
  return 'file:' + resolve(absPath).replace(/\\/g, '/')
}

export function isCheckout(root = ROOT) {
  return existsSync(join(root, 'src', 'index.ts'))
}

export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function bundledDshBin(home = dshHome()) {
  return join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function shell() {
  return process.platform === 'win32'
}

function run(command, args, opts = {}) {
  return spawnSync(command, args, { stdio: 'inherit', shell: shell(), ...opts })
}

function fail(message, code = 1) {
  process.stderr.write(`dsh-file-mount: ${message}\n`)
  process.exit(code)
}

/** Prefer a local dsh that already booted once; npx is last because it is slow. */
export function resolveDshLauncher(home = dshHome()) {
  const bundled = bundledDshBin(home)
  if (existsSync(bundled)) return { kind: 'node', command: process.execPath, args: [bundled] }
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], {
    encoding: 'utf8',
    shell: shell(),
  })
  if ((probe.status ?? 1) === 0 && (probe.stdout ?? '').trim().length > 0) {
    return { kind: 'dsh', command: 'dsh', args: [] }
  }
  return { kind: 'npx', command: 'npx', args: ['--yes', '@deepseek-ai/dsh'] }
}

function runDsh(dshArgs, home = dshHome()) {
  const launcher = resolveDshLauncher(home)
  return run(launcher.command, [...launcher.args, ...dshArgs], { shell: launcher.kind !== 'node' && shell() })
}

function ensureBuilt(root = ROOT) {
  if (existsSync(join(root, 'lib', 'index.js')) && existsSync(join(root, 'lib', 'client.js'))) return
  process.stderr.write('dsh-file-mount: building lib/\n')
  let result = run('pnpm', ['run', 'build'], { cwd: root })
  if ((result.status ?? 1) !== 0) result = run('npm', ['run', 'build'], { cwd: root })
  if ((result.status ?? 1) !== 0) fail('build failed (need pnpm or npm run build)', result.status ?? 1)
}

function packTarball(root = ROOT) {
  ensureBuilt(root)
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const tgz = join(root, `${pkg.name}-${pkg.version}.tgz`)
  process.stderr.write(`dsh-file-mount: packing ${pkg.name}-${pkg.version}.tgz\n`)
  const result = run('npm', ['pack', '--ignore-scripts'], { cwd: root })
  if ((result.status ?? 1) !== 0) fail('npm pack failed', result.status ?? 1)
  if (!existsSync(tgz)) fail(`packed tarball missing: ${tgz}`)
  return tgz
}

export function resolveInstallSpec(root = ROOT) {
  if (process.env.DSH_FILE_MOUNT_SPEC) return process.env.DSH_FILE_MOUNT_SPEC
  if (isCheckout(root)) return toFileUrlSpec(packTarball(root))
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return pkg.name
}

export function main() {
  const profile = process.env.DSH_PROFILE ?? 'web'
  const spec = resolveInstallSpec()
  const installed = join(dshHome(), 'profiles', profile, 'node_modules', 'dsh-file-mount')
  if (existsSync(installed)) {
    rmSync(installed, { recursive: true, force: true })
  }
  process.stderr.write(`dsh-file-mount: installing into profile ${profile} via ${spec}\n`)
  const result = runDsh(['plugin', '--profile', profile, 'add', spec, '--force'])
  if ((result.status ?? 1) !== 0) {
    fail(
      `dsh plugin add failed (${result.status ?? 1}). Need pnpm on PATH, and a DSH profile (run: npx --yes @deepseek-ai/dsh --profile ${profile}).`,
      result.status ?? 1,
    )
  }
  process.stderr.write(`dsh-file-mount: installed. Restart the harness (npx @deepseek-ai/dsh --profile ${profile}); a page refresh is not enough.\n`)
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) main()
