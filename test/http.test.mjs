/** Host route behaviour: body bounds, auth guard, method and status handling. */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isLoopbackAddress, readJsonBody, registerRestartRoutes, rejectUntrusted,
  RESTART_ARM_PATH, RESTART_CANCEL_PATH, RESTART_STATUS_PATH,
} from '../lib/http.js'

/** A request carrying an optional body, as an async iterable of Buffers. */
function makeReq(body, options = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  return {
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    socket: 'socket' in options ? options.socket : { remoteAddress: options.remoteAddress ?? '::ffff:127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A response recorder. */
function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    finished: false,
    setHeader(name, value) { res.headers[name] = value },
    end(body) {
      if (body !== undefined) res.body += String(body)
      res.finished = true
    },
  }
  return res
}

/** A ctx whose webServer records every registered route. */
function makeCtx(connection) {
  const routes = []
  return {
    routes,
    get(key) { return key === 'connection' ? connection : undefined },
    webServer: {
      register(route) {
        routes.push(route)
        return () => { route.disposed = true }
      },
    },
  }
}

const HANDLERS = {
  arm: async body => ({ armed: true, echo: body }),
  cancel: async () => ({ cancelled: true }),
  status: async () => ({ pid: 123, strategy: 'launchd' }),
}

test('readJsonBody parses an object, an empty body and rejects the rest', async () => {
  assert.deepEqual(await readJsonBody(makeReq('{"delaySeconds":30}')), { delaySeconds: 30 })
  assert.deepEqual(await readJsonBody(makeReq()), {})
  assert.deepEqual(await readJsonBody(makeReq('   ')), {})
  assert.equal(await readJsonBody(makeReq('[1,2]')), null)
  assert.equal(await readJsonBody(makeReq('"text"')), null)
  assert.equal(await readJsonBody(makeReq('{oops')), null)
})

test('readJsonBody refuses a body over the bound', async () => {
  assert.equal(await readJsonBody(makeReq('{"a":"' + 'x'.repeat(5000) + '"}')), null)
})

test('isLoopbackAddress accepts the whole loopback range and nothing else', () => {
  for (const address of ['127.0.0.1', '127.5.5.5', '127.0.0.1:0', '::1', '::ffff:127.0.0.1', '::ffff:127.5.5.5', '[::1]']) {
    assert.equal(isLoopbackAddress(address), true, address + ' is loopback')
  }
  for (const address of ['192.168.1.2', '::ffff:192.168.1.2', '', '   ', 'localhost', '0.0.0.0', '::', undefined, null, 42]) {
    assert.equal(isLoopbackAddress(address), false, String(address) + ' is not loopback')
  }
})

test('rejectUntrusted without a connection service admits a loopback caller', () => {
  const res = makeRes()
  assert.equal(rejectUntrusted(undefined, makeReq(undefined, { remoteAddress: '127.0.0.1' }), res), false)
  assert.equal(res.finished, false)
})

test('rejectUntrusted without a connection service refuses a non-loopback caller', () => {
  const res = makeRes()
  assert.equal(rejectUntrusted(undefined, makeReq(undefined, { remoteAddress: '192.168.1.2' }), res), true)
  assert.equal(res.statusCode, 403)
  assert.equal(res.finished, true)
  assert.deepEqual(JSON.parse(res.body), {
    code: 'forbidden',
    message: 'restart routes accept loopback requests only',
  })
})

test('rejectUntrusted without a connection service fails closed when the address is unreadable', () => {
  const res = makeRes()
  assert.equal(rejectUntrusted(undefined, makeReq(undefined, { socket: undefined }), res), true)
  assert.equal(res.statusCode, 403)
  assert.equal(res.finished, true)
})

test('rejectUntrusted finishes the response when the host connection refuses', () => {
  const res = makeRes()
  const connection = { requestRejection: () => 401 }
  assert.equal(rejectUntrusted(connection, makeReq(), res), true)
  assert.equal(res.statusCode, 401)
  assert.equal(res.finished, true)
})

test('registerRestartRoutes registers one exact route per path and disposes them', () => {
  const ctx = makeCtx(undefined)
  const dispose = registerRestartRoutes(ctx, HANDLERS)
  assert.deepEqual(ctx.routes.map(route => [route.kind, route.path]), [
    ['exact', RESTART_STATUS_PATH],
    ['exact', RESTART_ARM_PATH],
    ['exact', RESTART_CANCEL_PATH],
  ])
  dispose()
  assert.deepEqual(ctx.routes.map(route => route.disposed), [true, true, true])
})

test('the status route answers GET with the shared implementation', async () => {
  const ctx = makeCtx(undefined)
  registerRestartRoutes(ctx, HANDLERS)
  const res = makeRes()
  await ctx.routes[0].handler(makeReq(undefined, { method: 'GET' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(res.body), { pid: 123, strategy: 'launchd' })
})

test('the arm route parses the body and forwards it', async () => {
  const ctx = makeCtx(undefined)
  registerRestartRoutes(ctx, HANDLERS)
  const res = makeRes()
  await ctx.routes[1].handler(
    makeReq('{"delaySeconds":30,"reason":"x"}', { method: 'POST', headers: { 'content-type': 'application/json' } }),
    res,
  )
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { armed: true, echo: { delaySeconds: 30, reason: 'x' } })
})

test('a wrong method is refused with 405 and an Allow header', async () => {
  const ctx = makeCtx(undefined)
  registerRestartRoutes(ctx, HANDLERS)
  const res = makeRes()
  await ctx.routes[1].handler(makeReq('{}', { method: 'GET' }), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'POST')
})

test('a malformed body is refused with 400 before the handler runs', async () => {
  const ctx = makeCtx(undefined)
  let called = false
  registerRestartRoutes(ctx, { ...HANDLERS, arm: async () => { called = true; return {} } })
  const res = makeRes()
  await ctx.routes[1].handler(makeReq('nope', { method: 'POST' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(called, false)
})

test('an untrusted request never reaches the handler', async () => {
  const ctx = makeCtx({ requestRejection: () => 403 })
  let called = false
  registerRestartRoutes(ctx, { ...HANDLERS, status: async () => { called = true; return {} } })
  const res = makeRes()
  await ctx.routes[0].handler(makeReq(undefined, { method: 'GET' }), res)
  assert.equal(res.statusCode, 403)
  assert.equal(called, false)
})

test('a throwing handler becomes a 500 with its message', async () => {
  const ctx = makeCtx(undefined)
  registerRestartRoutes(ctx, { ...HANDLERS, cancel: async () => { throw new Error('boom') } })
  const res = makeRes()
  await ctx.routes[2].handler(makeReq('{}', { method: 'POST' }), res)
  assert.equal(res.statusCode, 500)
  assert.deepEqual(JSON.parse(res.body), { code: 'cancel-failed', message: 'boom' })
})

test('a route without a connection service still serves a loopback caller', async () => {
  const ctx = makeCtx(undefined)
  registerRestartRoutes(ctx, HANDLERS)
  const res = makeRes()
  await ctx.routes[0].handler(makeReq(undefined, { method: 'GET', remoteAddress: '127.0.0.1' }), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { pid: 123, strategy: 'launchd' })
})

test('a route without a connection service refuses a non-loopback caller', async () => {
  const ctx = makeCtx(undefined)
  let called = false
  registerRestartRoutes(ctx, { ...HANDLERS, arm: async () => { called = true; return {} } })
  const res = makeRes()
  await ctx.routes[1].handler(
    makeReq('{}', { method: 'POST', remoteAddress: '::ffff:192.168.1.2' }),
    res,
  )
  assert.equal(res.statusCode, 403)
  assert.equal(res.finished, true)
  assert.equal(called, false)
})

test('a request stream that fails mid-read becomes a JSON error, not a rejection', async () => {
  const ctx = makeCtx(undefined)
  registerRestartRoutes(ctx, HANDLERS)
  const req = {
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{"delaySeconds":', 'utf8')
      throw new Error('aborted')
    },
  }
  const res = makeRes()
  await assert.doesNotReject(ctx.routes[1].handler(req, res))
  assert.equal(res.statusCode, 500)
  assert.deepEqual(JSON.parse(res.body), { code: 'arm-failed', message: 'aborted' })
  assert.equal(res.finished, true)
})

test('a guard that throws also becomes a JSON error, not a rejection', async () => {
  const ctx = makeCtx({ requestRejection: () => { throw new Error('guard exploded') } })
  registerRestartRoutes(ctx, HANDLERS)
  const res = makeRes()
  await assert.doesNotReject(ctx.routes[2].handler(makeReq('{}', { method: 'POST' }), res))
  assert.equal(res.statusCode, 500)
  assert.deepEqual(JSON.parse(res.body), { code: 'cancel-failed', message: 'guard exploded' })
})
