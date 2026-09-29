/** The hand-written client bundle must keep the loader's lazy-CJS contract. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const SOURCE = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const HOST_SOURCE = await readFile(new URL('../lib/http.js', import.meta.url), 'utf8')

/**
 * Minimal React stub. useState hands back the initial value unless the call
 * index is overridden, so a spec can drive one render state per index.
 * @param overrides - useState call index to value.
 */
function fakeReact(overrides = {}) {
  let call = 0
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => {
      const index = call
      call += 1
      return [Object.prototype.hasOwnProperty.call(overrides, index) ? overrides[index] : initial, () => {}]
    },
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
}

/** Evaluate the bundle against a fake loader global and return its registration. */
function loadRegistration() {
  const entries = []
  const window = { __ModuleLoader__: { load(entry) { entries.push(entry) } } }
  // eslint-disable-next-line no-new-func -- the bundle is a browser artifact, not a module.
  new Function('window', SOURCE)(window)
  assert.equal(entries.length, 1, 'the bundle must register exactly one factory')
  return entries[0]
}

/**
 * Materialize the registered factory with the loader's require.
 * @param entry - the loader registration.
 * @param react - React stub to hand the factory.
 */
function materialize(entry, react = fakeReact()) {
  const stubs = { react }
  return entry.factory(specifier => {
    if (specifier in stubs) return stubs[specifier]
    throw new Error('unexpected module request: ' + specifier)
  })
}

/**
 * Register the overlay component under a recording ctx.
 * @param react - React stub.
 * @returns the registered component plus the recorded options.
 */
function registerControl(react = fakeReact()) {
  const exports = materialize(loadRegistration(), react)
  const registered = []
  let injectedName = ''
  exports.apply({
    effect: fn => { fn() },
    slots: {
      inject(name, fn) { injectedName = name; return fn() },
      register(options, Component) { registered.push({ options, Component }); return () => {} },
    },
  })
  assert.equal(registered.length, 1)
  return { options: registered[0].options, Component: registered[0].Component, injectedName }
}

/** Depth-first search over the stub element tree. */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  return out
}

/** Visible label of a stub element: its string children, joined. */
function labelOf(node) {
  return (node.children ?? []).map(child => (typeof child === 'string' ? child : '')).join('')
}

/** Every string anywhere in the subtree, space-joined. */
function textOf(node) {
  if (typeof node === 'string') return node
  if (node === null || node === undefined || typeof node !== 'object') return ''
  const children = Array.isArray(node) ? node : (node.children ?? [])
  return children.map(textOf).join(' ')
}

const STATUS = {
  pid: 4242,
  ppid: 42,
  uptimeSeconds: 90,
  strategy: 'launchd',
  restartable: true,
  label: 'com.example.job',
  port: 28000,
  healthUrl: 'http://127.0.0.1:28000/',
  portResponds: true,
  lastRestartAt: '2026-09-18 17:33:28',
  lastRestartDowntimeMs: 3104,
  armed: false,
}

test('the bundle registers one factory under the package id', () => {
  assert.equal(loadRegistration().id, 'dsh-restart')
})

test('the factory resolves only baseline specifiers', () => {
  const seen = []
  loadRegistration().factory(specifier => {
    seen.push(specifier)
    if (specifier === 'react') return fakeReact()
    throw new Error('unexpected module request: ' + specifier)
  })
  assert.deepEqual(seen, ['react'])
})

test('the client half declares the slots service only', () => {
  const exports = materialize(loadRegistration())
  assert.equal(exports.name, 'dsh-restart')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('apply contributes one entry into the frame-wide overlay seat', () => {
  const { options, Component, injectedName } = registerControl()
  assert.equal(injectedName, 'shell.overlay')
  assert.equal(options.name, 'shell.overlay')
  assert.equal(options.id, 'dsh-restart')
  assert.equal(typeof options.order, 'number')
  assert.equal(typeof Component, 'function')
})

test('the control renders nothing until the host answers the status probe', () => {
  // useState index 0 is the status, still null before the probe settles.
  assert.equal(registerControl().Component(), null)
})

test('the control renders its floating button once the host has answered', () => {
  const tree = registerControl(fakeReact({ 0: STATUS })).Component()
  assert.notEqual(tree, null)
  // The overlay layer is click-through, so the root must not swallow the app.
  assert.equal(tree.props.style.pointerEvents, 'none')
  const buttons = findAll(tree, node => node.type === 'button')
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].props['aria-label'], '重启 DSH')
  assert.equal(labelOf(buttons[0]), '重启')
  // No dialog while closed.
  assert.equal(findAll(tree, node => node.props?.role === 'dialog').length, 0)
})

test('opening the dialog renders the facts, the delay choices and the confirm button', () => {
  const tree = registerControl(fakeReact({ 0: STATUS, 1: true })).Component()
  const dialog = findAll(tree, node => node.props?.role === 'dialog')
  assert.equal(dialog.length, 1)
  const labels = findAll(dialog[0], node => node.type === 'button').map(labelOf)
  for (const expected of ['立即', '10s', '30s', '60s', '取消', '确认重启']) {
    assert.ok(labels.includes(expected), 'missing ' + expected + ' in ' + JSON.stringify(labels))
  }
  // The dialog is the one interactive surface in a click-through layer.
  assert.equal(dialog[0].props.style.pointerEvents, 'auto')
})

test('the armed branch replaces the form with the countdown and a cancel action', () => {
  const armed = { fireAt: '2026-09-18 18:00:00', delaySeconds: 10, at: Date.now(), plan: { logPath: '/tmp/x.log' } }
  const tree = registerControl(fakeReact({ 0: STATUS, 1: true, 4: armed })).Component()
  const dialog = findAll(tree, node => node.props?.role === 'dialog')[0]
  const labels = findAll(dialog, node => node.type === 'button').map(labelOf)
  assert.deepEqual(labels, ['取消这次重启', '关闭'])
  const text = textOf(dialog)
  assert.ok(text.includes('已安排重启'), text)
  assert.ok(text.includes('18:00:00'), text)
})

test('the browser half duplicates exactly the host route paths', () => {
  const paths = [...HOST_SOURCE.matchAll(/export const RESTART_[A-Z]+_PATH = '([^']+)'/g)].map(match => match[1])
  assert.equal(paths.length, 3, 'lib/http.js should export three route paths')
  for (const path of paths) {
    assert.ok(SOURCE.includes("'" + path + "'"), 'lib/client.js must know ' + path)
  }
})

test('the bundle never requests a module the loader table cannot answer', () => {
  const requests = [...SOURCE.matchAll(/require\('([^']+)'\)/g)].map(match => match[1])
  const allowed = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit'])
  for (const specifier of requests) {
    assert.ok(allowed.has(specifier), specifier + ' is not a baseline module')
  }
})
