/**
 * dsh-restart browser half: a bottom-right restart control with a confirm
 * dialog.
 *
 * Hand-written in the client module loader's lazy-CJS shape instead of being
 * built by the repository tsdown preset, so this package needs no build step:
 * executing the bundle only registers the factory below, and the module body
 * (including the CSS-free inline styling) runs when the loader materializes it.
 *
 * The three route paths are duplicated from lib/http.js by hand: the module
 * table only answers the baseline specifiers, so a bundle cannot import its own
 * package's server half.
 */

window.__ModuleLoader__.load({ id: 'dsh-restart', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

var React = require('react')
var useState = React.useState
var useEffect = React.useEffect
var useRef = React.useRef
var createElement = React.createElement

var STATUS_PATH = '/dsh-restart/status'
var ARM_PATH = '/dsh-restart/arm'
var CANCEL_PATH = '/dsh-restart/cancel'

/** Delay choices offered in the dialog, in seconds. */
var DELAY_CHOICES = [0, 10, 30, 60]

/** Seconds between the click and the exit; matches the tool default. */
var DEFAULT_DELAY = 10

/** Colors come from the app's own theme tokens, with neutral fallbacks. */
var TOKEN = {
  text: 'var(--dsw-alias-label-primary, inherit)',
  surface: 'var(--dsw-alias-bg-layer-3, #ffffff)',
  border: 'var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28))',
  mask: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.35))',
  float: 'var(--dsw-alias-button-floating-fill, rgba(255, 255, 255, 0.96))',
  floatHover: 'var(--dsw-alias-button-floating-hover, rgba(245, 245, 245, 0.98))',
  primary: 'var(--dsw-alias-button-primary-fill, #4d6bfe)',
  primaryHover: 'var(--dsw-alias-button-primary-hover, #3f5ae0)',
  // The dark theme's primary fill is near-white, so the label on it is the
  // theme's own foreground token, never a hard-coded white.
  onPrimary: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
  ghostHover: 'var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12))',
}

/**
 * Read a JSON response, or throw with the host's own message.
 * @param {string} path - route path.
 * @param {object} [init] - fetch init.
 * @returns {Promise<object>} the parsed body.
 */
async function request(path, init) {
  var response = await fetch(path, init)
  var payload = null
  try {
    payload = await response.json()
  } catch (error) {
    payload = null
  }
  if (!response.ok) {
    var detail = payload !== null && typeof payload.message === 'string' ? payload.message : 'HTTP ' + String(response.status)
    throw new Error(detail)
  }
  return payload === null ? {} : payload
}

/**
 * Seconds left before the armed restart fires.
 * @param {string} fireAt - host-formatted timestamp (informational only).
 * @param {number} delaySeconds - delay that was armed.
 * @param {number} armedAt - local epoch ms of the arming.
 * @returns {number} seconds remaining, never below zero.
 */
function secondsLeft(delaySeconds, armedAt) {
  if (armedAt === 0) return 0
  return Math.max(0, delaySeconds - Math.round((Date.now() - armedAt) / 1000))
}

/**
 * The host's own explanation for why an arm did not happen. The host answers
 * 200 with armed:false in several cases: an outright refusal, which it puts in
 * `summary` ("拒绝重启：…"), and a late failure after the plan was built, which
 * it puts in `notes` ("未安排重启：…"). Either way the dialog quotes the host
 * verbatim instead of inventing a message.
 * @param {object} value - an arm result.
 * @returns {string} the explanation, or '' when the host sent none.
 */
function explain(value) {
  if (value === null || typeof value !== 'object') return ''
  var fromNotes = firstNote(value.notes)
  if (fromNotes !== '') return fromNotes
  if (typeof value.summary !== 'string') return ''
  return value.summary.split('\n')[0].trim()
}

/**
 * The host's explanation for a cancel that did not happen: it returns
 * { cancelled: false, notes: ['重启已经开始；…'] } once execution has started.
 * @param {object} value - a cancel result.
 * @returns {string} the explanation, or '' when the host sent none.
 */
function explainCancel(value) {
  return firstNote(value === null || typeof value !== 'object' ? null : value.notes)
}

/**
 * The first non-empty note, if the value carries a notes array.
 * @param {Array} notes - the host's notes field.
 * @returns {string} the first non-empty note, or ''.
 */
function firstNote(notes) {
  if (!Array.isArray(notes)) return ''
  for (var index = 0; index < notes.length; index += 1) {
    if (typeof notes[index] === 'string' && notes[index].trim() !== '') return notes[index].trim()
  }
  return ''
}

/**
 * The bottom-right control and its confirm dialog.
 * @returns {object} the overlay entry.
 */
function RestartControl() {
  var statusState = useState(null)
  var status = statusState[0]
  var setStatus = statusState[1]
  var openState = useState(false)
  var open = openState[0]
  var setOpen = openState[1]
  var busyState = useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]
  var errorState = useState('')
  var error = errorState[0]
  var setError = errorState[1]
  var armedState = useState(null)
  var armed = armedState[0]
  var setArmed = armedState[1]
  var delayState = useState(DEFAULT_DELAY)
  var delay = delayState[0]
  var setDelay = delayState[1]
  var reasonState = useState('')
  var reason = reasonState[0]
  var setReason = reasonState[1]
  // A once-per-second bump that only exists to re-render the countdown.
  var tickState = useState(0)
  var tick = tickState[0]
  var setTick = tickState[1]
  var timer = useRef(null)

  // Availability probe: no host routes means no control at all.
  useEffect(function () {
    var live = true
    request(STATUS_PATH, { headers: { accept: 'application/json' } })
      .then(function (value) { if (live) setStatus(value) })
      .catch(function () { if (live) setStatus(null) })
    return function () { live = false }
  }, [])

  // Countdown while a restart is armed, so the click has visible feedback.
  useEffect(function () {
    if (armed === null) return undefined
    timer.current = setInterval(function () { setTick(function (value) { return value + 1 }) }, 1000)
    return function () { clearInterval(timer.current) }
  }, [armed])

  var refresh = function () {
    return request(STATUS_PATH, { headers: { accept: 'application/json' } })
      .then(function (value) { setStatus(value); return value })
      .catch(function () { return null })
  }

  if (status === null) return null

  var confirm = function () {
    setBusy(true)
    setError('')
    request(ARM_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delaySeconds: delay, reason: reason }),
    }).then(function (value) {
      setBusy(false)
      // The host can answer 200 with armed:false (nothing restartable, or a
      // dry run), and then no countdown is running: show why instead.
      if (value.armed !== true) {
        setArmed(null)
        setError(explain(value))
        return
      }
      setArmed({ fireAt: value.fireAt, delaySeconds: value.delaySeconds, at: Date.now(), plan: value })
    }).catch(function (failure) {
      setError(failure.message)
      setBusy(false)
    })
  }

  var cancelArmed = function () {
    setBusy(true)
    setError('')
    request(CANCEL_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (value) {
        setBusy(false)
        // Once execution has started the host answers cancelled:false. Keep the
        // countdown, refresh the facts, and show what it said.
        if (value.cancelled !== true) {
          setError(explainCancel(value))
          return refresh()
        }
        setArmed(null)
        return refresh()
      })
      .catch(function (failure) { setError(failure.message); setBusy(false) })
  }

  var close = function () {
    setOpen(false)
    setError('')
    void refresh()
  }

  var remaining = armed === null ? 0 : secondsLeft(armed.delaySeconds, armed.at)
  // Read the counter so the interval bump re-renders this component.
  void tick

  var strategyLabel = status.strategy === 'launchd'
    ? 'launchd（' + (status.label || 'KeepAlive') + '）'
    : (status.strategy === 'desktop' ? '桌面应用与 Host' : (status.strategy === 'supervisor' ? 'supervisor 兜底' : '无托管'))

  var summary = status.lastRestartAt === ''
    ? '尚无已完成的重启记录'
    : '上次重启 ' + status.lastRestartAt + '，停机 ' + (status.lastRestartDowntimeMs / 1000).toFixed(1) + 's'

  var button = createElement('button', {
    type: 'button',
    title: '重启 DSH',
    'aria-label': '重启 DSH',
    onClick: function () { setOpen(true); setArmed(null); void refresh() },
    style: {
      pointerEvents: 'auto',
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '8px 14px',
      borderRadius: '999px',
      border: '1px solid ' + TOKEN.border,
      background: TOKEN.float,
      color: 'inherit',
      font: 'inherit',
      fontSize: '13px',
      lineHeight: '1',
      cursor: 'pointer',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.18)',
    },
    onMouseEnter: function (event) { event.currentTarget.style.background = TOKEN.floatHover },
    onMouseLeave: function (event) { event.currentTarget.style.background = TOKEN.float },
  }, createElement('span', { 'aria-hidden': 'true', style: { fontSize: '15px' } }, '\u21bb'), '重启')

  var dialog = null
  if (open) {
    var rows = [
      ['托管方式', strategyLabel + (status.restartable ? '' : '（不可重启）')],
      ['进程', 'pid ' + String(status.pid) + '，已运行 ' + String(status.uptimeSeconds) + 's'],
      ['端口', status.port === 0 ? '未识别' : String(status.port) + (status.portResponds ? '（有响应）' : '（无响应）')],
      ['历史', summary],
    ]

    var body = armed !== null
      ? createElement('div', null,
        createElement('p', { style: { margin: '0 0 8px', fontSize: '14px' } },
          '已安排重启：' + armed.fireAt + '（' + String(armed.delaySeconds) + ' 秒后）'),
        createElement('p', { style: { margin: '0 0 8px', fontSize: '13px', opacity: 0.7 } },
          remaining > 0 ? (status.strategy === 'desktop'
            ? '约 ' + String(remaining) + ' 秒后退出并重新打开桌面应用；若有任务，请处理原生退出确认。'
            : '约 ' + String(remaining) + ' 秒后本页连接会断开，刷新即可回到界面。') : '正在退出…'),
        createElement('p', { style: { margin: 0, fontSize: '13px', opacity: 0.7 } },
          '重启记录：' + String(armed.plan.logPath || '')),
        error === '' ? null : createElement('p', {
          style: { margin: '12px 0 0', fontSize: '13px', color: 'var(--dsw-alias-brand-primary, #e5484d)' },
        }, error),
        createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '18px' } },
          createElement('button', {
            type: 'button', disabled: busy, onClick: cancelArmed,
            style: ghostButtonStyle(),
          }, '取消这次重启'),
          createElement('button', {
            type: 'button', onClick: close, style: ghostButtonStyle(),
          }, '关闭'),
        ),
      )
      : createElement('div', null,
        createElement('div', null, rows.map(function (row) {
          return createElement('div', {
            key: row[0],
            style: { display: 'flex', gap: '10px', fontSize: '13px', padding: '3px 0' },
          },
          createElement('span', { style: { opacity: 0.6, minWidth: '68px' } }, row[0]),
          createElement('span', null, row[1]))
        })),
        createElement('div', { style: { marginTop: '14px', fontSize: '13px' } },
          createElement('div', { style: { opacity: 0.6, marginBottom: '6px' } }, '延迟'),
          createElement('div', { style: { display: 'flex', gap: '6px' } }, DELAY_CHOICES.map(function (choice) {
            var active = choice === delay
            return createElement('button', {
              key: choice,
              type: 'button',
              onClick: function () { setDelay(choice) },
              style: {
                padding: '5px 12px',
                borderRadius: '6px',
                cursor: 'pointer',
                font: 'inherit',
                fontSize: '13px',
                border: '1px solid ' + (active ? TOKEN.primary : TOKEN.border),
                background: active ? TOKEN.primary : 'transparent',
                color: active ? TOKEN.onPrimary : 'inherit',
              },
            }, choice === 0 ? '立即' : String(choice) + 's')
          })),
        ),
        createElement('div', { style: { marginTop: '12px', fontSize: '13px' } },
          createElement('div', { style: { opacity: 0.6, marginBottom: '6px' } }, '原因（可选，写入重启日志）'),
          createElement('input', {
            type: 'text',
            value: reason,
            placeholder: '例如：让新插件生效',
            onChange: function (event) { setReason(event.target.value) },
            style: {
              width: '100%',
              boxSizing: 'border-box',
              padding: '7px 10px',
              borderRadius: '6px',
              border: '1px solid ' + TOKEN.border,
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: '13px',
            },
          }),
        ),
        error === '' ? null : createElement('p', {
          style: { margin: '12px 0 0', fontSize: '13px', color: 'var(--dsw-alias-brand-primary, #e5484d)' },
        }, error),
        createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '18px' } },
          createElement('button', { type: 'button', onClick: close, style: ghostButtonStyle() }, '取消'),
          createElement('button', {
            type: 'button',
            disabled: busy || !status.restartable,
            onClick: confirm,
            style: primaryButtonStyle(busy || !status.restartable),
          }, busy ? '提交中…' : '确认重启'),
        ),
      )

    dialog = createElement('div', {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '重启 DSH',
      onClick: function (event) { if (event.target === event.currentTarget) close() },
      style: {
        pointerEvents: 'auto',
        position: 'fixed',
        inset: '0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: TOKEN.mask,
        zIndex: 1,
      },
    }, createElement('div', {
      style: {
        width: 'min(420px, calc(100vw - 32px))',
        maxHeight: 'calc(100vh - 64px)',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '20px',
        borderRadius: '12px',
        border: '1px solid ' + TOKEN.border,
        background: TOKEN.surface,
        color: TOKEN.text,
        boxShadow: '0 16px 48px rgba(0, 0, 0, 0.28)',
      },
    },
    createElement('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '14px' } },
      createElement('h2', { style: { margin: 0, fontSize: '16px', fontWeight: 600 } }, '重启 DSH'),
      createElement('span', { style: { fontSize: '12px', opacity: 0.55 } }, 'dsh-restart'),
    ),
    body))
  }

  return createElement('div', {
    style: {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: 1,
      pointerEvents: 'none',
      color: TOKEN.text,
    },
  }, button, dialog)
}

/**
 * Add hover feedback: inline styles cannot express :hover.
 * @param {object} base - resting style.
 * @param {string} hoverBackground - background while hovered.
 * @returns {object} the style with pointer handlers merged in.
 */
function withHover(base, hoverBackground) {
  return Object.assign({}, base, {
    onMouseEnter: function (event) { event.currentTarget.style.background = hoverBackground },
    onMouseLeave: function (event) { event.currentTarget.style.background = base.background },
  })
}

/** Neutral secondary button. */
function ghostButtonStyle() {
  return withHover({
    padding: '7px 14px',
    borderRadius: '6px',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '13px',
    border: '1px solid ' + TOKEN.border,
    background: 'transparent',
    color: 'inherit',
  }, TOKEN.ghostHover)
}

/**
 * Primary button, dimmed while disabled.
 * @param {boolean} disabled - whether the action is unavailable.
 */
function primaryButtonStyle(disabled) {
  var base = {
    padding: '7px 14px',
    borderRadius: '6px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    font: 'inherit',
    fontSize: '13px',
    border: '1px solid ' + TOKEN.primary,
    background: TOKEN.primary,
    color: TOKEN.onPrimary,
    opacity: disabled ? 0.4 : 1,
  }
  return disabled ? base : withHover(base, TOKEN.primaryHover)
}

exports.name = 'dsh-restart'
exports.inject = ['slots']

/**
 * Client plugin body: contribute the control into the frame-wide overlay seat.
 * @param {object} ctx - client root context.
 */
exports.apply = function apply(ctx) {
  ctx.effect(function () {
    return ctx.slots.inject('shell.overlay', function () {
      return ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-restart',
        order: 100,
        label: '重启 DSH',
      }, RestartControl)
    })
  }, 'dsh-restart: browser control')
}

return module.exports; } });
