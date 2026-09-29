/**
 * Browser-facing HTTP routes for the restart control.
 *
 * The browser half is a hand-written client bundle that cannot import this
 * module (the client module table only answers baseline specifiers), so the
 * three paths below are duplicated there by hand; keep both in sync.
 *
 * No @deepseek-ai import lives here, so this module unit-tests without a host.
 */

/** Arm a restart. POST, body {delaySeconds?, reason?}. */
export const RESTART_ARM_PATH = '/dsh-restart/arm'

/** Read supervision facts, the armed state and the restart history. GET. */
export const RESTART_STATUS_PATH = '/dsh-restart/status'

/** Cancel an armed restart before it fires. POST. */
export const RESTART_CANCEL_PATH = '/dsh-restart/cancel'

/** Largest accepted request body; every real body here is a tiny object. */
const MAX_BODY_BYTES = 4096

/**
 * Answer with JSON.
 * @param res - server response.
 * @param statusCode - HTTP status.
 * @param payload - JSON-serializable value.
 */
function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Answer 405 with the methods this route accepts.
 * @param res - server response.
 * @param allowed - the one accepted method.
 */
function sendMethodNotAllowed(res, allowed) {
  res.statusCode = 405
  res.setHeader('allow', allowed)
  res.end()
}

/**
 * Read a bounded JSON object body.
 * @param req - incoming request.
 * @returns the parsed object (empty for an empty body), or null when it is
 * oversized or not a JSON object.
 */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Reject an untrusted request through the host connection service.
 *
 * Registered web routes are not authenticated by the server itself, so a route
 * that can restart the process must ask. A host without the service cannot
 * answer, and the loopback default makes that acceptable.
 * @param connection - the ctx.connection service, or undefined.
 * @param req - incoming request.
 * @param res - server response.
 * @returns true when the request was rejected and the response is finished.
 */
export function rejectUntrusted(connection, req, res) {
  if (connection === undefined || typeof connection.requestRejection !== 'function') return false
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

/**
 * Register the three restart routes on the host web server.
 * @param ctx - context carrying the webServer service.
 * @param handlers - arm, cancel and status implementations (the same ones the tools use).
 * @returns a disposer that unregisters all three routes.
 */
export function registerRestartRoutes(ctx, handlers) {
  const connection = ctx.get?.('connection')
  const guard = (req, res) => rejectUntrusted(connection, req, res)
  const fail = (res, code, error) => {
    sendJson(res, 500, { code, message: error instanceof Error ? error.message : String(error) })
  }

  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: RESTART_STATUS_PATH,
      handler: async (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'GET') {
          sendMethodNotAllowed(res, 'GET')
          return
        }
        try {
          sendJson(res, 200, await handlers.status())
        } catch (error) {
          fail(res, 'status-failed', error)
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: RESTART_ARM_PATH,
      handler: async (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'POST') {
          sendMethodNotAllowed(res, 'POST')
          return
        }
        const body = await readJsonBody(req)
        if (body === null) {
          sendJson(res, 400, { code: 'bad-request', message: 'body must be a JSON object under 4096 bytes' })
          return
        }
        try {
          sendJson(res, 200, await handlers.arm(body))
        } catch (error) {
          fail(res, 'arm-failed', error)
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: RESTART_CANCEL_PATH,
      handler: async (req, res) => {
        if (guard(req, res)) return
        if (req.method !== 'POST') {
          sendMethodNotAllowed(res, 'POST')
          return
        }
        try {
          sendJson(res, 200, await handlers.cancel())
        } catch (error) {
          fail(res, 'cancel-failed', error)
        }
      },
    }),
  ]

  return () => {
    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose()
    }
  }
}
