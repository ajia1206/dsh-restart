/** The hand-written client bundle must keep the loader's lazy-CJS contract. */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const SOURCE = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const HOST_SOURCE = await readFile(new URL('../lib/http.js', import.meta.url), 'utf8')

/**
 * Minimal React stub. useState hands back the initial value unless the call
 * index is overridden, so a spec can drive one render state per index.
 * Each hook records its value in `holder.values`; the setter also writes the
 * new value into `holder.last` and re-renders the component, exactly like
 * React would, so a spec can assert the resulting UI instead of raw setters.
 * @param overrides - useState call index to value.
 * @param holder - receives the per-hook value lists, `last`, and the root tree.
 */
function fakeReact(overrides = {}, holder = {}) {
  let call = 0
  // The holder outlives every render, so a spec can assert what a setter did
  // even though the re-render below builds a fresh stub.
  holder.values = holder.values ?? []
  holder.last = holder.last ?? []
  holder.render = holder.render ?? (() => { throw new Error('this spec must set holder.render') })
  const createElement = (type, props, ...children) => {
    if (typeof type === 'function') {
      call = 0
      const rendered = type(props)
      if (rendered !== null && rendered !== undefined) holder.tree = rendered
      return rendered
    }
    return { type, props, children }
  }
  return {
    createElement,
    useState: initial => {
      const index = call
      call += 1
      // The first render of a hook seeds its record; later re-renders must not
      // reset it, or a spec could no longer see what a setter wrote.
      const values = holder.values[index] ?? []
      if (values.length === 0) {
        values.push(Object.prototype.hasOwnProperty.call(overrides, index) ? overrides[index] : initial)
      }
      holder.values[index] = values
      const setter = value => {
        values.push(value)
        holder.last[index] = value
        // Re-render against the recorded values so the assertion sees the new
        // UI: React would do this, and only the component is stateful here.
        const rerenderOverrides = {}
        for (let slot = 0; slot < holder.last.length; slot += 1) {
          if (holder.last[slot] !== undefined) rerenderOverrides[slot] = holder.last[slot]
        }
        holder.tree = holder.render(rerenderOverrides)
      }
      return [values[values.length - 1], setter]
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

/** A fetch stub: records every call and answers from a path-keyed script. */
function fakeFetch(routes) {
  const calls = []
  const fetch = async (path, init) => {
    calls.push({ path, init })
    const scripted = routes[path]
    if (scripted === undefined) throw new Error('no scripted response for ' + path)
    const answered = typeof scripted === 'function' ? scripted(calls.length) : scripted
    return {
      ok: answered.ok !== false,
      status: answered.status ?? 200,
      json: async () => answered.body,
    }
  }
  fetch.calls = calls
  return fetch
}

/** Let one click's promise chain settle, including the fetch stub's awaits. */
async function flush() {
  for (let round = 0; round < 5; round += 1) await new Promise(resolve => setImmediate(resolve))
}

/**
 * Render the control with a fetch stub installed.
 * @param react - React stub carrying the state holder.
 * @param routes - fetch script keyed by path.
 */
function renderWithFetch(react, holder, routes) {
  globalThis.fetch = fakeFetch(routes)
  // Re-render by re-registering the component through a fresh stub that shares
  // the same holder: that is what keeps the holder accurate, because it records
  // every state hook the component reads.
  holder.render = overrides => registerControl(fakeReact(overrides, holder)).Component()
  holder.tree = registerControl(react).Component()
}

/** Find the single button whose visible label matches. */
function buttonByLabel(root, label) {
  const found = findAll(root, node => node.type === 'button' && labelOf(node) === label)
  assert.equal(found.length, 1, 'expected exactly one "' + label + '" button, found ' + found.length)
  return found[0]
}

test('the confirm action enters the countdown when the host armed the restart', async () => {
  const holder = {}
  const react = fakeReact({ 0: STATUS, 1: true }, holder)
  renderWithFetch(react, holder, {
    '/dsh-restart/arm': {
      body: {
        armed: true,
        delaySeconds: 30,
        fireAt: '2026-09-18 18:00:30',
        logPath: '/tmp/x.log',
        summary: '将派发 detached supervisor。',
      },
    },
    '/dsh-restart/status': { body: STATUS },
  })
  buttonByLabel(holder.tree, '确认重启').props.onClick()
  await flush()
  // useState index 4 is the armed state: its last recorded value is the
  // scheduled restart, and it started from the empty initial state.
  const armedValues = holder.values[4]
  assert.equal(armedValues.length, 2)
  assert.equal(armedValues[0], null)
  assert.equal(armedValues[1].fireAt, '2026-09-18 18:00:30')
  assert.equal(armedValues[1].delaySeconds, 30)
  assert.equal(typeof armedValues[1].at, 'number')
  const text = textOf(holder.tree)
  assert.ok(text.includes('已安排重启'), text)
  assert.ok(text.includes('18:00:30'), text)
})

test('an arm answered with armed:false shows the explanation and starts no countdown', async () => {
  const holder = {}
  const react = fakeReact({ 0: STATUS, 1: true }, holder)
  renderWithFetch(react, holder, {
    '/dsh-restart/arm': {
      body: {
        armed: false,
        dryRun: false,
        restartable: false,
        summary: '拒绝重启：无法确认桌面主进程及 IPC 连接，请使用桌面原生重启菜单。',
        notes: ['未安排重启：无法确认桌面主进程及 IPC 连接，请使用桌面原生重启菜单。'],
      },
    },
    '/dsh-restart/status': { body: STATUS },
  })
  buttonByLabel(holder.tree, '确认重启').props.onClick()
  await flush()
  // setArmed(null) was applied and no countdown replaced the form.
  assert.deepEqual(holder.values[4], [null, null])
  const text = textOf(holder.tree)
  assert.ok(text.includes('未安排重启：无法确认桌面主进程'), text)
  assert.ok(!text.includes('已安排重启'), text)
  // The form is still there, so the dialog did not switch to the countdown.
  assert.ok(text.includes('确认重启'), text)
})

test('an armed:false answer whose detail lives in notes still shows that detail', async () => {
  const holder = {}
  const react = fakeReact({ 0: STATUS, 1: true }, holder)
  renderWithFetch(react, holder, {
    '/dsh-restart/arm': {
      body: {
        armed: false,
        // The plan summary is benign here; the refusal is in the notes.
        summary: '将派发 detached supervisor：等本进程退出后用同一命令行拉起。',
        notes: ['未安排重启：写入重启记录失败（EACCES）。'],
      },
    },
    '/dsh-restart/status': { body: STATUS },
  })
  buttonByLabel(holder.tree, '确认重启').props.onClick()
  await flush()
  assert.deepEqual(holder.values[4], [null, null])
  const text = textOf(holder.tree)
  assert.ok(text.includes('写入重启记录失败'), text)
  assert.ok(!text.includes('已安排重启'), text)
})

test('a cancel answered with cancelled:false keeps the countdown and shows the explanation', async () => {
  const holder = {}
  const armed = { fireAt: '2026-09-18 18:00:00', delaySeconds: 10, at: Date.now(), plan: { logPath: '/tmp/x.log' } }
  const react = fakeReact({ 0: STATUS, 1: true, 4: armed }, holder)
  renderWithFetch(react, holder, {
    '/dsh-restart/cancel': {
      body: { cancelled: false, wasArmed: true, notes: ['重启已经开始；桌面任务退出确认仍可取消退出。'] },
    },
    '/dsh-restart/status': { body: { ...STATUS, armed: true } },
  })
  buttonByLabel(holder.tree, '取消这次重启').props.onClick()
  await flush()
  // The armed state was never cleared.
  assert.deepEqual(holder.values[4], [armed])
  const text = textOf(holder.tree)
  assert.ok(text.includes('重启已经开始'), text)
  assert.ok(text.includes('已安排重启'), text)
  assert.ok(text.includes('取消这次重启'), text)
})

test('a real cancellation clears the countdown', async () => {
  const holder = {}
  const armed = { fireAt: '2026-09-18 18:00:00', delaySeconds: 10, at: Date.now(), plan: { logPath: '/tmp/x.log' } }
  const react = fakeReact({ 0: STATUS, 1: true, 4: armed }, holder)
  renderWithFetch(react, holder, {
    '/dsh-restart/cancel': { body: { cancelled: true, wasArmed: true, notes: ['已取消。'] } },
    '/dsh-restart/status': { body: STATUS },
  })
  buttonByLabel(holder.tree, '取消这次重启').props.onClick()
  await flush()
  assert.deepEqual(holder.values[4], [armed, null])
  assert.ok(!textOf(holder.tree).includes('已安排重启'))
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
