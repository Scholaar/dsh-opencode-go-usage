/**
 * Host half of dsh-opencode-go-usage.
 *
 * Reads the OpenCode Go subscription usage from the gateway (`GET {baseURL}/usage`,
 * the same endpoint the official console uses) with the API key stored in the DSH
 * credential service, and serves a sanitized snapshot to the browser half over one
 * read-only same-origin route. The key never leaves the Host.
 */

const DEFAULT_BASE_URL = 'https://opencode.ai/inference/go/v1'
const DEFAULT_API_KEY_ENVS = Object.freeze(['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'])
const DEFAULT_ROUTE = '/dsh-opencode-go-usage/usage.json'
const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_CACHE_MS = 20000
const WINDOWS = Object.freeze(['rolling', 'weekly', 'monthly'])
const STATUSES = Object.freeze(['ok', 'rate-limited'])

export const inject = ['webServer', 'credentials']

export function apply(ctx, config) {
  const options = normalizeOptions(config)
  let cache = null
  let inflight = null

  const route = {
    kind: 'exact',
    path: options.route,
    handler: (req, res) => handle(req, res),
  }

  const dispose = ctx.effect(() => {
    if (!ctx.webServer || typeof ctx.webServer.register !== 'function') {
      warn('webServer.register is unavailable; the usage panel has no data route')
      return () => {}
    }
    const off = ctx.webServer.register(route)
    return typeof off === 'function' ? off : () => {}
  })
  void dispose

  async function handle(req, res) {
    if (!sameOrigin(req)) {
      writeJson(res, 403, failure('FORBIDDEN', 'Cross-origin requests are not allowed'))
      return
    }
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      writeJson(res, 405, failure('METHOD_NOT_ALLOWED', 'Only GET is supported'))
      return
    }
    let payload
    try {
      payload = await readUsage(hasRefresh(req))
    } catch (err) {
      payload = failure('INTERNAL', describe(err))
    }
    writeJson(res, 200, payload)
  }

  async function readUsage(force) {
    const now = Date.now()
    if (!force && cache && now - cache.at < options.cacheMs) {
      return { ...cache.payload, cached: true }
    }
    if (inflight) return inflight
    inflight = fetchUsage()
      .then((payload) => payload)
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  async function fetchUsage() {
    const key = await resolveKey()
    if (!key) {
      return failure(
        'NO_KEY',
        `No OpenCode Go API key found (looked for ${options.apiKeyEnvs.join(', ')})`,
      )
    }
    let response
    try {
      response = await fetch(`${options.baseURL}/usage`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          'User-Agent': 'dsh-opencode-go-usage/0.1',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs),
      })
    } catch (err) {
      const name = err && err.name
      const timedOut = name === 'TimeoutError' || name === 'AbortError'
      return failure(timedOut ? 'TIMEOUT' : 'NETWORK', describe(err))
    }
    if (!response.ok) {
      return failure(statusCodeFor(response.status), `OpenCode Go usage endpoint returned HTTP ${response.status}`)
    }
    let body
    try {
      const text = await response.text()
      if (text.length > 1024 * 1024) return failure('BAD_RESPONSE', 'Usage response is too large')
      body = JSON.parse(text)
    } catch (err) {
      return failure('BAD_RESPONSE', `Could not parse the usage response: ${describe(err)}`)
    }
    const usage = normalizeUsage(body && body.usage)
    if (!usage) {
      return failure('BAD_RESPONSE', 'The usage response did not contain rolling, weekly and monthly windows')
    }
    const payload = {
      ok: true,
      fetchedAt: new Date().toISOString(),
      baseURL: options.baseURL,
      usage,
    }
    cache = { at: Date.now(), payload }
    return payload
  }

  async function resolveKey() {
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const ref of options.apiKeyEnvs) {
        try {
          const credential = await ctx.credentials.resolve(ref)
          const value = readCredentialValue(credential)
          if (value) return value
        } catch (err) {
          lastError = err
        }
      }
      if (attempt === 0) await delay(300)
    }
    if (lastError) warn(`could not resolve the API key: ${describe(lastError)}`)
    return null
  }
}

function normalizeOptions(config) {
  const input = config && typeof config === 'object' ? config : {}
  const baseURL = trimSlash(
    String(input.baseURL || process.env.OPENCODE_GO_BASE_URL || DEFAULT_BASE_URL),
  )
  const route = String(input.route || DEFAULT_ROUTE)
  const apiKeyEnvs = Array.isArray(input.apiKeyEnvs)
    ? input.apiKeyEnvs.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
    : typeof input.apiKeyEnv === 'string' && input.apiKeyEnv.trim()
      ? [input.apiKeyEnv.trim()]
      : [...DEFAULT_API_KEY_ENVS]
  return {
    baseURL,
    route: route.startsWith('/') ? route : `/${route}`,
    apiKeyEnvs: apiKeyEnvs.length > 0 ? apiKeyEnvs : [...DEFAULT_API_KEY_ENVS],
    timeoutMs: positiveNumber(input.timeoutMs, DEFAULT_TIMEOUT_MS),
    cacheMs: positiveNumber(input.cacheMs, DEFAULT_CACHE_MS),
  }
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null
  const usage = {}
  for (const window of WINDOWS) {
    const row = raw[window]
    if (!row || typeof row !== 'object') return null
    const percent = Number(row.percent)
    if (!Number.isFinite(percent)) return null
    const resetsAt = typeof row.resetsAt === 'string' && Number.isFinite(Date.parse(row.resetsAt))
      ? new Date(row.resetsAt).toISOString()
      : null
    usage[window] = {
      status: STATUSES.includes(row.status) ? row.status : 'ok',
      percent: Math.min(100, Math.max(0, percent)),
      resetsAt,
    }
  }
  return usage
}

function readCredentialValue(credential) {
  if (!credential) return null
  if (typeof credential === 'string') return credential.trim() || null
  if (typeof credential === 'object') {
    for (const field of ['value', 'secret', 'token', 'key']) {
      const candidate = credential[field]
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    }
  }
  return null
}

function sameOrigin(req) {
  const headers = (req && req.headers) || {}
  const site = String(headers['sec-fetch-site'] || '').toLowerCase()
  if (site === 'cross-site') return false
  const origin = headers.origin
  if (typeof origin === 'string' && origin && origin !== 'null') {
    try {
      const parsed = new URL(origin)
      if (parsed.host.toLowerCase() !== String(headers.host || '').toLowerCase()) return false
    } catch {
      return false
    }
  }
  return true
}

function hasRefresh(req) {
  const url = String((req && req.url) || '')
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  return query.split('&').some((pair) => pair === 'refresh=1' || pair === 'refresh=true')
}

function writeJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': String(Buffer.byteLength(body)),
    })
    res.end(body)
  } catch (err) {
    try {
      res.statusCode = 500
      res.end()
    } catch {
      /* the response is already gone */
    }
    warn(`could not write the usage response: ${describe(err)}`)
  }
}

function failure(code, message) {
  return {
    ok: false,
    fetchedAt: new Date().toISOString(),
    error: { code, message },
  }
}

function statusCodeFor(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 404) return 'NOT_FOUND'
  if (status === 408) return 'TIMEOUT'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function trimSlash(value) {
  return value.replace(/\/+$/, '')
}

function describe(error) {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  return String(error.message || error)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function warn(message) {
  try {
    console.warn(`[opencode-go-usage] ${message}`)
  } catch {
    /* console is unavailable */
  }
}
