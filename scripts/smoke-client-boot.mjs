/**
 * Artifact-level boot smoke for the client half.
 *
 * Loads the **built** `lib/client.js` exactly the way the DSH web shell does:
 * the frozen 0.2.0-rc.2 platform module table is the only `require` surface, the
 * bundle registers itself through `window.__ModuleLoader__.load({ id, factory })`,
 * and the resulting plugin is driven through a minimal cordis-ish client context.
 * Then the registered `conversation.view` component is mounted into real
 * jsdom + React and checked for the empty hint and the focus-request ack.
 *
 * Run at the repo root (needs `react`, `react-dom`, `jsdom`):
 *   node scripts/smoke-client-boot.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The frozen platform module table of `dsh-client-modules@0.2.0-rc.2`. */
const SEED_WORDS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]
const EXPECTED_ID = 'dsh-file-mount'
const EXPECTED_VIEW_ID = 'file-mount'
const EXPECTED_SLOT = 'conversation.view'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = path.join(root, 'lib', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

const failures = []
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.log(`  FAIL ${label}: ${error.message}`)
  }
}

// --- DOM first: react-dom binds to these globals on import -------------------
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
// Mirror the jsdom test environment (vitest does the same): the DOM globals have
// to exist on globalThis, and Node 24 exposes `navigator` as a getter-only global,
// so define rather than assign.
const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'location',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
]
for (const key of DOM_GLOBALS) {
  const value = key === 'window' ? dom.window : dom.window[key]
  if (value === undefined) continue
  Object.defineProperty(globalThis, key, {
    value: typeof value === 'function' && key === 'getComputedStyle' ? value.bind(dom.window) : value,
    configurable: true,
    writable: true,
  })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = require('react-dom/test-utils')

// --- capture the module-table registration -----------------------------------
let entry
const loader = { load: (value) => { entry = value } }
dom.window.__ModuleLoader__ = loader
// The bundle is a plain script (`window.__ModuleLoader__.load({...})`), not a module.
new Function('window', 'document', 'console', source)(dom.window, dom.window.document, console)

const installed = new Map([
  ['react', React],
  ['react/jsx-runtime', require('react/jsx-runtime')],
])
const touched = []
const bundleRequire = (specifier) => {
  const value = installed.get(specifier)
  if (value !== undefined) {
    touched.push(specifier)
    return value
  }
  if (SEED_WORDS.includes(specifier)) throw new Error(`bundle reached for an unexpected seed word: ${specifier}`)
  throw new Error(`client-modules: require("${specifier}") missed the module table`)
}

console.log(`smoke: ${path.relative(root, bundlePath)} (${source.length} chars)`)

check('registers under the plugin package id', () => {
  assert.ok(entry, 'window.__ModuleLoader__.load was never called')
  assert.equal(entry.id, EXPECTED_ID)
  assert.equal(typeof entry.factory, 'function')
})

let mod
check('factory resolves against the frozen module table only', () => {
  mod = entry.factory(bundleRequire)
  assert.equal(typeof mod.apply, 'function', 'missing apply()')
  assert.deepEqual([...touched].sort(), ['react', 'react/jsx-runtime'])
})

// --- drive a minimal cordis-ish client context -------------------------------
const dictionaries = new Map()
const effects = []
const slotCalls = []
let contribution
const ctx = {
  effect(callback, label) {
    effects.push(label)
    return callback()
  },
  locale: {
    register(namespace, dict) {
      dictionaries.set(namespace, dict)
      return () => dictionaries.delete(namespace)
    },
    bind(namespace) {
      return (key) => dictionaries.get(namespace)?.zh?.[key] ?? key
    },
  },
  slots: {
    inject(name, callback) {
      slotCalls.push(['inject', name])
      return callback()
    },
    register(description, component) {
      slotCalls.push(['register', description])
      contribution = { description, component }
      return () => undefined
    },
  },
}

check('apply() registers the locale dictionaries and the slot contribution', () => {
  assert.deepEqual(mod.inject, ['slots', 'locale'])
  mod.apply(ctx)
  assert.ok(dictionaries.has(EXPECTED_VIEW_ID), 'locale namespace not registered')
  assert.ok(dictionaries.get(EXPECTED_VIEW_ID).zh['list.empty'], 'zh dictionary is empty')
  assert.deepEqual(slotCalls.map(([kind]) => kind), ['inject', 'register'])
  assert.equal(slotCalls[0][1], EXPECTED_SLOT)
  assert.deepEqual(
    { ...contribution.description },
    { name: EXPECTED_SLOT, id: EXPECTED_VIEW_ID, order: 20, locale: EXPECTED_VIEW_ID, label: contribution.description.label },
  )
  assert.equal(contribution.description.label(), dictionaries.get(EXPECTED_VIEW_ID).zh['view.fileMount'])
  assert.equal(typeof contribution.component, 'function')
})

// --- mount the registered component for real --------------------------------
const zh = () => dictionaries.get(EXPECTED_VIEW_ID).zh
const propsFor = (viewRequest, acks) => ({
  useSession: (selector) => selector({ sessionId: 'smoke' }),
  useSessions: () => undefined,
  useConversation: (selector) =>
    selector({
      views: { get: (target) => (target === 'chat' ? { legacy: { nodes: [] } } : undefined) },
      activeTargets: new Set(['chat']),
    }),
  useProjection: () => undefined,
  useInput: () => undefined,
  inputActions: {},
  sessionId: 'smoke',
  inspectCall: undefined,
  viewRequest,
  openView: () => undefined,
  completeViewRequest: () => acks.push(Date.now()),
  t: (key) => zh()[key] ?? key,
})

const mount = (props) => {
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const reactRoot = createRoot(container)
  act(() => reactRoot.render(React.createElement(contribution.component, props)))
  return container
}

check('renders the localized empty hint from the bundle dictionary', () => {
  const container = mount(propsFor(null, []))
  const empty = container.querySelector('[data-mount-empty]')
  assert.ok(empty, 'missing [data-mount-empty]')
  assert.equal(empty.textContent, zh()['list.empty'])
})

check('acks a focus request addressed to this view', () => {
  const acks = []
  mount(propsFor({ view: EXPECTED_VIEW_ID, focus: 'opaque' }, acks))
  assert.equal(acks.length, 1)
})

check('leaves a request addressed to another view pending', () => {
  const acks = []
  mount(propsFor({ view: 'token-viewer', focus: 'opaque' }, acks))
  assert.equal(acks.length, 0)
})

for (const label of effects) console.log(`  note effect: ${label}`)
dom.window.close()

if (failures.length > 0) {
  console.error(`\nsmoke FAILED (${failures.length}):`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exitCode = 1
} else {
  console.log('\nsmoke PASSED')
}
