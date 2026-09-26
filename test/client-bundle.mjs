/**
 * Client-bundle smoke test — no browser and no DSH needed.
 *
 * Loads lib/client.js the way the DSH client does (`window.__ModuleLoader__.load`), runs its factory
 * with a stubbed `react`, applies it to stubbed services, and asserts the contract the harness
 * actually relies on for a **right-sidebar tab**:
 *   · a tab *type* goes into `sidebarRightTabs` with a unique id, a kind of our own, a title and a
 *     guide capsule (that is what makes it show up next to Subagents / Tasks)
 *   · the body registers into `sidebar.right.pane.tab` under that same id
 *   · the chip title registers into `sidebar.right.pane.tab.title` under that same id
 *   · `settings.plugin.item` carries a card under this plugin's namespace
 *   · the on/off switch adds and removes all three
 *
 * It also asserts the tab does NOT go back into the left rail (`sidebar.panellist` + `main`), since
 * the panel was deliberately moved to the right sidebar.
 *
 * run: node test/client-bundle.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const results = []
const check = (label, ok, detail = '') => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

// ── stubs: just enough of the client runtime to run the bundle ──────────────
const storage = new Map()
const g = globalThis
g.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  __ModuleLoader__: { load: (spec) => { g.__loaded = spec } },
}
g.document = { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) }

const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
// eslint-disable-next-line no-new-func -- executing the bundle is the point of this test
new Function(source)()

const spec = g.__loaded
check('bundle registers itself with the module loader', spec?.id === 'dsh-zcode-connect', String(spec?.id))

// A tiny React stand-in: elements are plain objects, hooks are real enough for this contract.
const element = (type, props, ...children) => ({ type, props: props ?? {}, children })
const React = {
  createElement: element,
  Fragment: 'Fragment',
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}
const bundle = spec.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})
check('bundle exports apply + inject', typeof bundle.apply === 'function' && Array.isArray(bundle.inject), JSON.stringify(bundle.inject))
check('the client half requires the right-sidebar tab registry', bundle.inject.includes('sidebarRightTabs'), JSON.stringify(bundle.inject))

// ── stubs for the slot registry and the tab registry ───────────────────────
const registrations = []
const tabTypes = []
const ctx = {
  slots: {
    // Mirrors the real engine: inject() returns a disposer for whatever the callback registered.
    inject: (slotName, callback) => callback(),
    register: (options, component) => {
      const entry = { options, component }
      registrations.push(entry)
      return () => {
        const index = registrations.indexOf(entry)
        if (index !== -1) registrations.splice(index, 1)
      }
    },
  },
  sidebarRightTabs: {
    // Mirrors the real registry: a unique id is required, the disposer is idempotent.
    register: (definition) => {
      if (tabTypes.some((entry) => entry.id === definition.id)) throw new Error(`tab type id "${definition.id}" is already registered`)
      tabTypes.push(definition)
      return () => {
        const index = tabTypes.indexOf(definition)
        if (index !== -1) tabTypes.splice(index, 1)
      }
    },
  },
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
}

bundle.apply(ctx)

const find = (slot) => registrations.filter((r) => r.options.name === slot)
const type = tabTypes[0]
const body = find('sidebar.right.pane.tab')[0]
const title = find('sidebar.right.pane.tab.title')[0]
const card = find('settings.plugin.item')[0]

check('registers exactly one tab type', tabTypes.length === 1, JSON.stringify(tabTypes.map((t) => t.id)))
check('the tab type carries a unique id and its own kind', typeof type?.id === 'string' && typeof type?.kind === 'string' && type.kind !== 'files', `${type?.id} / kind=${type?.kind}`)
check('the tab type has a title function', typeof type?.title === 'function' && type.title() === 'ZCode', String(type?.title?.()))
check('the tab type contributes a guide capsule (how it shows up in the right sidebar)', Array.isArray(type?.guide) && typeof type.guide[0]?.title === 'function' && typeof type.guide[0]?.icon === 'function', JSON.stringify(type?.guide?.[0]?.order ?? null))
check('the body registers keyed by the tab id', body?.options.key === type?.id, `${body?.options.key} vs ${type?.id}`)
check('the chip title registers keyed by the same id', title?.options.key === type?.id, `${title?.options.key} vs ${type?.id}`)
check('registers a settings card under this plugin namespace', card?.options.key === 'dsh-zcode-connect', String(card?.options.key))
check('it no longer registers into the left rail', find('sidebar.panellist').length === 0 && find('main').length === 0)

// The body must point at the host route that renders the panel.
const iframe = body.component({})
check('the body frames the host panel route', iframe?.type === 'iframe' && String(iframe.props.src).includes('/plugins/dsh-zcode-connect/panel'), String(iframe?.props?.src))
// The chip must not blow up when the frame hands it a tab title.
const chip = title.component({ useTabInfo: () => ({ tab: { title: 'ZCode' } }) })
check('the chip title renders from the frame-provided title', chip?.type === 'span' && Array.isArray(chip.children) && chip.children.includes('ZCode'), JSON.stringify(chip?.children ?? null))
const chipBare = title.component({})
check('the chip title survives a missing tab title', chipBare?.type === 'span' && chipBare.children.includes('ZCode'))

// ── the switch: off removes all three, on brings them back ─────────────────
check('a manual handle is exposed for scripting', typeof g.window.__zcodeConnectSidebar?.toggle === 'function')
g.window.__zcodeConnectSidebar.disable()
check('switching off removes the tab type', tabTypes.length === 0)
check('switching off removes the body and the chip title', find('sidebar.right.pane.tab').length === 0 && find('sidebar.right.pane.tab.title').length === 0)
check('the settings card survives being switched off', find('settings.plugin.item').length === 1)
g.window.__zcodeConnectSidebar.enable()
check('switching on restores the tab type', tabTypes.length === 1)
check('switching on restores the body and the chip title', find('sidebar.right.pane.tab').length === 1 && find('sidebar.right.pane.tab.title').length === 1)
check('the preference is persisted', storage.get('dsh-zcode-connect:sidebar') === 'on', String(storage.get('dsh-zcode-connect:sidebar')))

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} FAILED: ${failed.map((r) => r.label).join('; ')}`}`)
process.exit(failed.length === 0 ? 0 : 1)
