/**
 * dsh-local-sub2api — Host half.
 *
 * Runs a private Sub2API stack (Sub2API + PostgreSQL + Redis, official Docker
 * images) on this machine as part of DeepSeek Harness, and exposes a small
 * reverse proxy so the Web UI can embed the Sub2API admin console in a
 * same-machine iframe without a login step.
 *
 * Responsibilities:
 *  - own the local runtime directory (compose file, generated secrets, volumes);
 *  - start Docker Desktop when it is installed but not running;
 *  - `docker compose up -d` the stack and wait for the Sub2API health endpoint;
 *  - log in as the auto-created local admin and inject that session into the
 *    admin console HTML served by the proxy (no login UI for the user);
 *  - strip `X-Frame-Options` / CSP frame restrictions so the console can render
 *    inside the Harness panel;
 *  - publish status/actions on the Harness web server for the Client half.
 *
 * Nothing binds to a non-loopback address; this is a local, single-user setup.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as adapter from './lib/adapter.js'
import { collectHarnessProviders, redactProviders } from './lib/harness-providers.js'

export const name = 'local-sub2api'
/**
 * Only `webServer` is a hard dependency: start/stop/console must keep working on
 * any Harness build. The provider-import feature needs `llm` and `credentials`,
 * so it resolves those through `ctx.get()` and reports itself unavailable when
 * they are missing, instead of failing the whole plugin's mount.
 */
export const inject = ['webServer']

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const COMPOSE_TEMPLATE = path.join(PACKAGE_DIR, 'runtime', 'docker-compose.local.yml')
const DEFAULT_IMAGE = 'weishaw/sub2api:0.2.19'
const DEFAULT_SUB2API_PORT = 18080
const DEFAULT_PROXY_PORT = 18081
const DEFAULT_DOCKER_DESKTOP = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'
const STATUS_PATH = '/local-sub2api/status'
const ACTION_PATH = '/local-sub2api/action'
const TOKEN_TTL_MS = 5 * 60 * 1000

const DEFAULTS = Object.freeze({
  enabled: true,
  // Whether opening DeepSeek Harness brings the stack up by itself. Off by
  // default: the stack keeps Docker Desktop busy, so the user opts in with the
  // runtime switch in the panel (or in Settings) instead of paying for it on
  // every launch.
  autoStart: false,
  autoStartDocker: true,
  sub2apiPort: DEFAULT_SUB2API_PORT,
  proxyPort: DEFAULT_PROXY_PORT,
  image: DEFAULT_IMAGE,
  dockerCommand: 'docker',
  dockerDesktopPath: DEFAULT_DOCKER_DESKTOP,
  dataDir: '',
  runMode: 'simple',
  timezone: '',
  dockerStartTimeoutMs: 180000,
  composeTimeoutMs: 600000,
  healthTimeoutMs: 180000,
  stopOnUnload: false,
  adapterEnabled: true,
  adapterAutoProvision: true,
  adapterSecretBaseDir: '',
  adapterProviders: {
    pikaqiu: {
      name: '皮卡丘中转',
      platform: 'openai',
      type: 'apikey',
      baseUrl: 'https://sub.pikaqiu.shop/v1',
      apiKeySource: 'refs:PIKAQIU_API_KEY',
      concurrency: 3,
      priority: 50,
    },
    'our-free-model': {
      name: 'DSh Our Free Model',
      platform: 'openai',
      type: 'apikey',
      // The vendored channel pack serves every absorbed channel through one
      // OpenAI-compatible gateway bound to the host loopback (port 8326, or
      // DSH_OPENAI_GATEWAY_PORT). Sub2API relays from *inside its container*,
      // where 127.0.0.1 is the container itself — Docker Desktop publishes the
      // host loopback as host.docker.internal, so that is the address used here.
      baseUrl: 'http://host.docker.internal:8326/v1',
      apiKeySource: 'file:openai-gateway\\api-key',
      concurrency: 3,
      priority: 50,
    },
    qodercn: {
      // Qoder 中国版（qoder.cn）的免费 Qwen3.8-Flash。它在 channel pack 里的
      // 内部 id 是 `qfmodel`（isFree=true / priceFactor=0，不消耗积分），由同一个
      // 宿主机 OpenAI 网关按 `/v1/models` 里的 `qodercn/qfmodel` 暴露。
      // 接入 Sub2API 后，客户端把 model 选成 `qodercn/qfmodel` 即可。
      name: 'Qoder CN Qwen3.8-Flash',
      platform: 'openai',
      type: 'apikey',
      baseUrl: 'http://host.docker.internal:8326/v1',
      apiKeySource: 'file:openai-gateway\\api-key',
      concurrency: 3,
      priority: 50,
    },
  },
})

function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  const int = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(n)))
  }
  cfg.enabled = cfg.enabled !== false
  // opt-in: only an explicit true turns it on (absent stays off, as shipped).
  cfg.autoStart = cfg.autoStart === true
  cfg.autoStartDocker = cfg.autoStartDocker !== false
  cfg.stopOnUnload = cfg.stopOnUnload === true
  cfg.sub2apiPort = int(cfg.sub2apiPort, DEFAULT_SUB2API_PORT, 1, 65535)
  cfg.proxyPort = int(cfg.proxyPort, DEFAULT_PROXY_PORT, 1, 65535)
  cfg.dockerStartTimeoutMs = int(cfg.dockerStartTimeoutMs, DEFAULTS.dockerStartTimeoutMs, 30000, 900000)
  cfg.composeTimeoutMs = int(cfg.composeTimeoutMs, DEFAULTS.composeTimeoutMs, 60000, 3600000)
  cfg.healthTimeoutMs = int(cfg.healthTimeoutMs, DEFAULTS.healthTimeoutMs, 30000, 1800000)
  cfg.image = typeof cfg.image === 'string' && cfg.image.trim() !== '' ? cfg.image.trim() : DEFAULT_IMAGE
  cfg.dockerCommand = typeof cfg.dockerCommand === 'string' && cfg.dockerCommand.trim() !== ''
    ? cfg.dockerCommand.trim()
    : 'docker'
  cfg.dockerDesktopPath = typeof cfg.dockerDesktopPath === 'string' && cfg.dockerDesktopPath.trim() !== ''
    ? cfg.dockerDesktopPath.trim()
    : DEFAULT_DOCKER_DESKTOP
  cfg.dataDir = typeof cfg.dataDir === 'string' && cfg.dataDir.trim() !== ''
    ? cfg.dataDir.trim()
    : path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'local-sub2api')
  cfg.runMode = cfg.runMode === 'standard' ? 'standard' : 'simple'
  cfg.timezone = typeof cfg.timezone === 'string' && cfg.timezone.trim() !== ''
    ? cfg.timezone.trim()
    : systemTimezone()

  // ---- model-vendor adapter ----
  cfg.adapterEnabled = cfg.adapterEnabled !== false
  cfg.adapterAutoProvision = cfg.adapterAutoProvision !== false
  cfg.adapterSecretBaseDir = typeof cfg.adapterSecretBaseDir === 'string' && cfg.adapterSecretBaseDir.trim() !== ''
    ? cfg.adapterSecretBaseDir.trim()
    : path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
  cfg.adapterProvidersList = normalizeAdapterProviders(cfg.adapterProviders)
  return cfg
}

/**
 * Normalize the adapterProviders config into a stable ordered list. Accepts
 * either an object keyed by logical id, or an array. Each entry is validated and
 * given safe defaults; entries without a name or baseUrl are skipped. apiKeySource
 * may be `env:NAME`, `file:PATH`, or `refs:NAME`.
 */
function normalizeAdapterProviders(raw) {
  const entries = []
  const push = (id, value) => {
    if (!value || typeof value !== 'object') return
    const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name.trim() : String(id)
    const baseUrl = typeof value.baseUrl === 'string' && value.baseUrl.trim() !== '' ? value.baseUrl.trim() : ''
    const platform = typeof value.platform === 'string' && value.platform.trim() !== '' ? value.platform.trim() : 'openai'
    const type = typeof value.type === 'string' && value.type.trim() !== '' ? value.type.trim() : 'apikey'
    const apiKeySource = typeof value.apiKeySource === 'string' && value.apiKeySource.trim() !== ''
      ? value.apiKeySource.trim()
      : (value.apiKey ? `refs:${value.apiKey}` : '')
    if (!baseUrl) return
    entries.push({
      id,
      name,
      platform,
      type,
      baseUrl,
      apiKeySource,
      concurrency: Number.isInteger(value.concurrency) ? value.concurrency : 3,
      priority: Number.isInteger(value.priority) ? value.priority : 50,
      group_ids: Array.isArray(value.group_ids) ? value.group_ids.filter(Number.isInteger) : [],
      credentials: value.credentials && typeof value.credentials === 'object' ? value.credentials : {},
    })
  }
  if (Array.isArray(raw)) {
    for (const item of raw) push(item && item.id, item && item.value ? item.value : item)
  } else if (raw && typeof raw === 'object') {
    for (const [id, value] of Object.entries(raw)) push(id, value)
  }
  return entries
}

function systemTimezone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone !== '' ? zone : 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

function tail(text, limit = 1200) {
  if (typeof text !== 'string') return ''
  const trimmed = text.trim()
  return trimmed.length > limit ? trimmed.slice(trimmed.length - limit) : trimmed
}

function firstLine(text) {
  const line = String(text || '').split(/\r?\n/).find((entry) => entry.trim() !== '')
  return (line || '').trim()
}

function sendJson(res, statusCode, payload) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readRequestBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Spawn a process and collect its output. Never rejects for a non-zero exit;
 * the caller decides what a failure means. Kills on timeout.
 */
function runProcess(command, args, options = {}) {
  const { cwd, timeoutMs = 120000, env } = options
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: String(error && error.message ? error.message : error), error })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish({ code: null, stdout, stderr, timedOut: true })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.length > 256 * 1024) stdout = stdout.slice(-128 * 1024)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-128 * 1024)
    })
    child.on('error', (error) => finish({ code: null, stdout, stderr, error }))
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })
}

function httpJson(url, options = {}) {
  const { method = 'GET', body, timeoutMs = 15000, headers: extraHeaders } = options
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const target = new URL(url)
    const request = httpRequest({
      host: target.hostname,
      port: Number(target.port || 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        accept: 'application/json',
        ...(extraHeaders || {}),
        ...(payload
          ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
          : {}),
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => {
        chunks.push(chunk)
        if (chunks.reduce((total, item) => total + item.length, 0) > 2 * 1024 * 1024) request.destroy()
      })
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json
        try { json = text === '' ? undefined : JSON.parse(text) } catch { json = undefined }
        resolve({ statusCode: response.statusCode, headers: response.headers, text, json })
      })
    })
    request.on('timeout', () => request.destroy(new Error('request timeout')))
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex')
}

function writeFileAtomicSync(file, content) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, content, 'utf8')
  fs.renameSync(temporary, file)
}

function parseEnvFile(text) {
  const result = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[match[1]] = value
  }
  return result
}

function renderEnvFile(values) {
  const order = [
    'SUB2API_IMAGE',
    'SUB2API_HOST_PORT',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'POSTGRES_DB',
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
    'JWT_SECRET',
    'RUN_MODE',
    'TZ',
  ]
  const lines = ['# Managed by the DeepSeek Harness plugin "dsh-local-sub2api".', '# Secrets are generated once; do not publish this file.']
  for (const key of order) {
    if (values[key] !== undefined) lines.push(`${key}=${values[key]}`)
  }
  for (const key of Object.keys(values)) {
    if (!order.includes(key)) lines.push(`${key}=${values[key]}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Inject the authenticated session into the Sub2API admin console HTML.
 * Runs as a classic script before the deferred module bundle, so the Vue
 * application boots already logged in.
 */
function buildBootstrapScript(session, theme) {
  const payload = session
    ? {
      token: session.access_token,
      refresh: session.refresh_token,
      expiresIn: session.expires_in,
      user: session.user,
    }
    : null
  const safeJson = JSON.stringify(payload).replace(/</g, '\\u003c')
  const safeTheme = theme === 'dark' || theme === 'light' ? JSON.stringify(theme) : 'null'
  return `<script data-dsh-local-sub2api="bootstrap">(function(){try{` +
    `var p=new URLSearchParams(location.search);var t=p.get('__dsh_theme');if(t!=='dark'&&t!=='light'){t=${safeTheme};}` +
    `if(t==='dark'||t==='light'){try{localStorage.setItem('theme',t);}catch(e){}}` +
    `var d=${safeJson};if(d&&d.token){try{localStorage.setItem('auth_token',d.token);` +
    `if(d.refresh){localStorage.setItem('refresh_token',d.refresh);}` +
    `if(typeof d.expiresIn==='number'&&d.expiresIn>0){localStorage.setItem('token_expires_at',String(Date.now()+d.expiresIn*1000));}` +
    `if(d.user){localStorage.setItem('auth_user',JSON.stringify(d.user));}` +
    `}catch(e){}}` +
    `}catch(e){}})();</script>`
}

function injectIntoHtml(html, snippet) {
  const headPattern = /<head(\s[^>]*)?>/i
  const match = headPattern.exec(html)
  if (match) {
    const at = match.index + match[0].length
    return html.slice(0, at) + snippet + html.slice(at)
  }
  const htmlTag = /<html(\s[^>]*)?>/i.exec(html)
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length
    return html.slice(0, at) + snippet + html.slice(at)
  }
  return snippet + html
}

/**
 * Host plugin: owns the local runtime and the Harness-side routes.
 */
export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(rawConfig)
  const log = (level, message, error) => {
    try {
      const logger = ctx.logger
      if (!logger) return
      const fn = logger[level] || logger.info
      if (typeof fn === 'function') fn.call(logger, `[local-sub2api] ${message}${error ? `: ${error && error.message ? error.message : error}` : ''}`)
    } catch {}
  }

  const state = {
    phase: cfg.enabled ? 'idle' : 'disabled',
    message: '',
    error: null,
    hint: null,
    startedAt: null,
    readyAt: null,
    updatedAt: Date.now(),
    dockerAvailable: false,
    dockerStarting: false,
    autoLogin: false,
    autoStart: cfg.autoStart,
    proxyPort: null,
    proxyUrl: null,
    adapter: { enabled: cfg.adapterEnabled, done: false, running: false, lastRunAt: null, summary: null, providers: [] },
    version: 1,
  }

  const composePath = path.join(cfg.dataDir, 'docker-compose.local.yml')
  const envPath = path.join(cfg.dataDir, '.env')
  // The settings page's own state. It lives beside the stack (not in the
  // profile config) so toggling it never rewrites the user's YAML and takes
  // effect on the next launch without a plugin remount.
  const prefsPath = path.join(cfg.dataDir, 'preferences.json')
  let prefs = { autoStart: cfg.autoStart }
  /**
   * Provider-import bookkeeping, keyed by Harness provider route: which of its
   * models the user chose to expose through Sub2API. Persisted with the other
   * preferences so a re-import offers the same selection instead of starting
   * over.
   */
  const importPath = path.join(cfg.dataDir, 'imported-providers.json')
  let importSelection = {}
  let envValues = null
  let authSession = null
  let authFetchedAt = 0
  let startPromise = null
  let proxyServer = null
  let disposed = false

  const setState = (patch) => {
    Object.assign(state, patch, { updatedAt: Date.now() })
  }

  const upstreamBase = () => `http://127.0.0.1:${cfg.sub2apiPort}`

  // ---------------------------------------------------------------------------
  // preferences (the settings page's persisted switches)
  // ---------------------------------------------------------------------------

  /**
   * Load the persisted switches. A missing or malformed file keeps the shipped
   * defaults: this runs on every activation, so a hand-damaged file must never
   * stop the plugin from mounting.
   */
  async function loadPreferences() {
    try {
      const raw = await fsp.readFile(prefsPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        prefs = {
          autoStart: parsed.autoStart === true,
          // An explicit runtime stop survives a reload: the stack stays down
          // until the user turns it back on.
          runtimeOn: parsed.runtimeOn !== false,
        }
        state.autoStart = prefs.autoStart
      }
    } catch { /* first run, or a file we cannot read: keep the defaults */ }
  }

  /** Persist the switches; never throws into the caller's action path. */
  async function savePreferences() {
    try {
      await fsp.mkdir(cfg.dataDir, { recursive: true })
      await fsp.writeFile(prefsPath, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8')
    } catch (error) {
      log('warn', 'could not persist preferences', error)
    }
  }

  // ---------------------------------------------------------------------------
  // provider import ("把 Harness 里的厂商导入 Sub2API")
  // ---------------------------------------------------------------------------

  /** Load the remembered per-provider model selection. */
  async function loadImportSelection() {
    try {
      const parsed = JSON.parse(await fsp.readFile(importPath, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) importSelection = parsed
    } catch { /* nothing imported yet */ }
  }

  /** Remember which models of one provider the user chose. */
  async function saveImportSelection() {
    try {
      await fsp.mkdir(cfg.dataDir, { recursive: true })
      await fsp.writeFile(importPath, `${JSON.stringify(importSelection, null, 2)}\n`, 'utf8')
    } catch (error) {
      log('warn', 'could not persist the import selection', error)
    }
  }

  /**
   * Import the chosen Harness providers into Sub2API as accounts, one account
   * per provider. Idempotent by account name: an existing account is updated in
   * place (endpoint + key are re-synced, since the Harness is the source of
   * truth) rather than duplicated.
   *
   * @param {{providers?: string[], models?: Record<string, string[]>}} request
   *   Provider routes to import; omitted means every importable provider. Each
   *   entry is the account name Sub2API will show.
   */
  async function importHarnessProviders(request = {}) {
    const wanted = Array.isArray(request.providers) ? request.providers : null
    const modelChoice = request.models && typeof request.models === 'object' ? request.models : {}

    // Enumerate once, un-redacted: this is the only place a resolved key is
    // allowed to exist, and it goes straight into the Sub2API admin call.
    const llm = ctx.get('llm')
    if (!llm) return { ok: false, error: '这个 Harness 没有 llm 服务，无法枚举厂商', results: [] }
    const full = await collectHarnessProviders({ llm, credentials: ctx.get('credentials'), env: process.env })

    const session = await loginAdmin()
    const authHeaders = {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    }
    const listUrl = `${upstreamBase()}/api/v1/admin/accounts?page=1&page_size=200`
    const list = await httpJson(listUrl, { method: 'GET', headers: authHeaders, timeoutMs: 20000 })
    const existing = list.statusCode === 200 && list.json && list.json.data && Array.isArray(list.json.data.items)
      ? list.json.data.items
      : []

    const results = []
    for (const provider of full) {
      if (wanted && !wanted.includes(provider.provider)) continue
      const name = `Harness · ${provider.displayName}`.slice(0, 60)

      if (!provider.importable) {
        results.push({
          provider: provider.provider,
          name,
          action: 'skipped',
          message: provider.reason || 'not importable',
        })
        continue
      }

      // The chosen model subset: an explicit list wins; empty means all of them.
      const chosen = Array.isArray(modelChoice[provider.provider])
        ? modelChoice[provider.provider]
        : provider.importedModels.map((model) => model.id)
      const models = provider.importedModels
        .filter((model) => chosen.includes(model.id))
        .map((model) => ({
          id: model.id,
          name: model.name,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
          ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
          ...(model.inputModalities ? { input: model.inputModalities } : {}),
        }))

      const body = {
        name,
        platform: 'openai',
        type: 'apikey',
        credentials: { base_url: provider.baseUrl, api_key: provider._key },
        concurrency: 3,
        priority: 50,
        // Sub2API keeps a per-account model list; it is what its own
        // `/accounts/{id}/models` surfaces and what the gateway advertises.
        extra: { harness_provider: provider.provider, harness_models: models },
      }

      const found = existing.find((item) => String(item.name).trim() === name)
      try {
        if (found) {
          const updateUrl = `${upstreamBase()}/api/v1/admin/accounts/${found.id}`
          const updated = await httpJson(updateUrl, { method: 'PUT', headers: authHeaders, body, timeoutMs: 30000 })
          if (updated.statusCode === 200 && updated.json && updated.json.code === 0) {
            results.push({
              provider: provider.provider, name, action: 'updated',
              message: `account #${found.id} re-synced`, models: models.length,
            })
          } else {
            results.push({
              provider: provider.provider, name, action: 'error',
              message: `update HTTP ${updated.statusCode}: ${firstLine(updated.text || '')}`,
            })
          }
        } else {
          const createUrl = `${upstreamBase()}/api/v1/admin/accounts`
          const created = await httpJson(createUrl, { method: 'POST', headers: authHeaders, body, timeoutMs: 30000 })
          if (created.statusCode === 200 && created.json && created.json.code === 0) {
            const id = created.json.data && created.json.data.id
            results.push({
              provider: provider.provider, name, action: 'created',
              message: id ? `account #${id}` : 'created', models: models.length,
            })
          } else {
            results.push({
              provider: provider.provider, name, action: 'error',
              message: `create HTTP ${created.statusCode}: ${firstLine(created.text || '')}`,
            })
          }
        }
      } catch (error) {
        results.push({
          provider: provider.provider, name, action: 'error',
          message: error && error.message ? error.message : String(error),
        })
      }

      // Remember the selection even when Sub2API errored, so a retry is cheap.
      importSelection[provider.provider] = { models: chosen, at: Date.now() }
    }

    await saveImportSelection()
    return { ok: true, results }
  }


  /**
   * Enumerate the Harness's own providers. Resolves `llm`/`credentials` lazily
   * so a build without them degrades to "feature unavailable" instead of a
   * failed mount.
   */
  async function readHarnessProviders() {
    const llm = ctx.get('llm')
    if (!llm) {
      return { available: false, reason: '这个 Harness 没有 llm 服务，无法枚举厂商', providers: [] }
    }
    try {
      const providers = await collectHarnessProviders({
        llm,
        credentials: ctx.get('credentials'),
        env: process.env,
      })
      // Attach the remembered selection so the UI opens where the user left it.
      const withSelection = providers.map((provider) => {
        const saved = importSelection[provider.provider]
        const allIds = provider.importedModels.map((model) => model.id)
        const selected = Array.isArray(saved && saved.models)
          ? saved.models.filter((id) => allIds.includes(id))
          : allIds
        return { ...provider, selectedModels: selected }
      })
      return { available: true, providers: redactProviders(withSelection) }
    } catch (error) {
      return {
        available: false,
        reason: error && error.message ? error.message : String(error),
        providers: [],
      }
    }
  }

  // ---------------------------------------------------------------------------
  // runtime directory
  // ---------------------------------------------------------------------------

  async function prepareRuntime() {
    await fsp.mkdir(cfg.dataDir, { recursive: true })
    for (const dir of [
      path.join(cfg.dataDir, 'data', 'postgres'),
      path.join(cfg.dataDir, 'data', 'redis'),
      path.join(cfg.dataDir, 'data', 'sub2api'),
    ]) {
      await fsp.mkdir(dir, { recursive: true })
    }

    let existing = {}
    try { existing = parseEnvFile(await fsp.readFile(envPath, 'utf8')) } catch {}
    envValues = {
      ...existing,
      SUB2API_IMAGE: cfg.image,
      SUB2API_HOST_PORT: String(cfg.sub2apiPort),
      POSTGRES_USER: existing.POSTGRES_USER || 'sub2api',
      POSTGRES_PASSWORD: existing.POSTGRES_PASSWORD || randomHex(12),
      POSTGRES_DB: existing.POSTGRES_DB || 'sub2api',
      ADMIN_EMAIL: existing.ADMIN_EMAIL || 'admin@dsh.local',
      ADMIN_PASSWORD: existing.ADMIN_PASSWORD || `L2a-1${randomHex(10)}`,
      JWT_SECRET: existing.JWT_SECRET || randomHex(32),
      RUN_MODE: cfg.runMode,
      TZ: cfg.timezone,
    }
    writeFileAtomicSync(envPath, renderEnvFile(envValues))

    const template = await fsp.readFile(COMPOSE_TEMPLATE, 'utf8')
    writeFileAtomicSync(composePath, template)
  }

  // ---------------------------------------------------------------------------
  // docker
  // ---------------------------------------------------------------------------

  async function dockerInfo() {
    const result = await runProcess(cfg.dockerCommand, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20000 })
    if (result.code === 0) return { available: true, version: result.stdout.trim() }
    if (result.error && result.error.code === 'ENOENT') {
      return { available: false, missing: true }
    }
    return { available: false, detail: firstLine(result.stderr) || (result.timedOut ? 'docker info timed out' : 'docker daemon unavailable') }
  }

  async function ensureDocker() {
    const first = await dockerInfo()
    if (first.available) {
      setState({ dockerAvailable: true, dockerStarting: false })
      return
    }
    setState({ dockerAvailable: false, dockerStarting: false, message: 'Docker daemon is not running', error: null, hint: null })
    if (first.missing) {
      throw new Error(`Docker CLI "${cfg.dockerCommand}" was not found. Install Docker Desktop, or set config.dockerCommand / disable the plugin.`)
    }
    if (!cfg.autoStartDocker) {
      throw new Error('Docker Desktop is not running. Start Docker Desktop and retry (or enable config.autoStartDocker).')
    }
    if (!fs.existsSync(cfg.dockerDesktopPath)) {
      throw new Error(`Docker Desktop was not found at "${cfg.dockerDesktopPath}". Start Docker manually, or set config.dockerDesktopPath.`)
    }
    log('info', 'starting Docker Desktop')
    setState({ dockerStarting: true, message: 'Starting Docker Desktop…' })
    try {
      const child = spawn(cfg.dockerDesktopPath, [], { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', () => {})
      child.unref()
    } catch (error) {
      throw new Error(`Could not start Docker Desktop: ${error && error.message ? error.message : error}`)
    }
    const deadline = Date.now() + cfg.dockerStartTimeoutMs
    while (Date.now() < deadline) {
      if (disposed) throw new Error('plugin unloaded while starting Docker Desktop')
      await sleep(3000)
      const probe = await dockerInfo()
      if (probe.available) {
        setState({ dockerAvailable: true, dockerStarting: false })
        log('info', 'Docker daemon is ready')
        return
      }
    }
    setState({ dockerStarting: false })
    throw new Error('Docker Desktop did not become ready in time. Open Docker Desktop once and wait for "Engine running", then retry.')
  }

  async function composeUp() {
    setState({ message: 'Starting the Sub2API containers…', phase: 'starting' })
    const result = await runProcess(
      cfg.dockerCommand,
      ['compose', '-f', composePath, 'up', '-d', '--remove-orphans'],
      { cwd: cfg.dataDir, timeoutMs: cfg.composeTimeoutMs },
    )
    if (result.code !== 0) {
      const detail = tail(result.stderr || result.stdout)
      throw new Error(`docker compose up failed${result.timedOut ? ' (timed out)' : ''}: ${detail || 'unknown error'}`)
    }
  }

  async function composeCommand(args, timeoutMs = 120000) {
    const result = await runProcess(cfg.dockerCommand, ['compose', '-f', composePath, ...args], { cwd: cfg.dataDir, timeoutMs })
    if (result.code !== 0) {
      throw new Error(`docker compose ${args.join(' ')} failed: ${tail(result.stderr || result.stdout) || 'unknown error'}`)
    }
    return result
  }

  async function waitForHealth(timeoutMs = cfg.healthTimeoutMs) {
    const deadline = Date.now() + timeoutMs
    setState({ message: 'Waiting for the Sub2API service…' })
    let lastDetail = ''
    while (Date.now() < deadline) {
      if (disposed) throw new Error('plugin unloaded while waiting for Sub2API')
      try {
        const response = await httpJson(`${upstreamBase()}/health`, { timeoutMs: 5000 })
        if (response.statusCode === 200) return
        lastDetail = `health ${response.statusCode}`
      } catch (error) {
        lastDetail = error && error.message ? error.message : String(error)
      }
      await sleep(1500)
    }
    throw new Error(`Sub2API did not become healthy: ${lastDetail || 'timeout'}. First start can take a while; retry, or check "docker logs dsh-local-sub2api".`)
  }

  async function loginAdmin(force = false) {
    if (!envValues) throw new Error('runtime is not prepared')
    if (!force && authSession && Date.now() - authFetchedAt < TOKEN_TTL_MS) return authSession
    const response = await httpJson(`${upstreamBase()}/api/v1/auth/login`, {
      method: 'POST',
      body: { email: envValues.ADMIN_EMAIL, password: envValues.ADMIN_PASSWORD },
      timeoutMs: 20000,
    })
    const data = response.json && response.json.data
    if (response.statusCode !== 200 || !data || !data.access_token) {
      throw new Error(`auto-login failed (HTTP ${response.statusCode}): ${firstLine(response.text) || 'no response body'}`)
    }
    authSession = data
    authFetchedAt = Date.now()
    setState({ autoLogin: true })
    return authSession
  }

  async function waitForLogin(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs
    let lastDetail = ''
    while (Date.now() < deadline) {
      if (disposed) throw new Error('plugin unloaded while logging in')
      try {
        return await loginAdmin(true)
      } catch (error) {
        lastDetail = error && error.message ? error.message : String(error)
      }
      await sleep(2500)
    }
    throw new Error(`Sub2API is up but the local admin login failed: ${lastDetail}`)
  }

  // ---------------------------------------------------------------------------
  // model-vendor adapter (适配现有厂商): provision configured upstream accounts
  // ---------------------------------------------------------------------------

  let adapterPromise = null

  /**
   * Provision every configured provider as an idempotent Sub2API account.
   * Individual provider failures (e.g. missing API key) are reported in the
   * result but never let this function throw — the plugin must not fail because
   * a third-party key is absent.
   */
  async function provisionProviders() {
    if (!cfg.adapterEnabled) {
      setState({ adapter: { enabled: false, done: true, running: false, lastRunAt: Date.now(), summary: { disabled: true }, providers: cfg.adapterProvidersList } })
      return null
    }
    if (adapterPromise) return adapterPromise
    adapterPromise = (async () => {
      setState({ adapter: { enabled: true, running: true, lastRunAt: Date.now(), done: false, summary: null, providers: cfg.adapterProvidersList } })
      try {
        const session = await loginAdmin(true)
        const api = {
          base: () => upstreamBase(),
          login: () => Promise.resolve(session),
        }
        const results = await adapter.provisionAll({ config: cfg, api, httpJson, log })
        const summary = adapter.statusSummary(results)
        setState({
          adapter: {
            enabled: true,
            running: false,
            done: true,
            lastRunAt: Date.now(),
            summary,
            providers: cfg.adapterProvidersList,
          },
        })
        log('info', `adapter provision done: ${summary.created.length} created, ${summary.existed.length} existing, ${summary.skipped.length} skipped, ${summary.failed.length} failed`)
        return results
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        setState({
          adapter: {
            enabled: true,
            running: false,
            done: false,
            lastRunAt: Date.now(),
            summary: { error: message },
            providers: cfg.adapterProvidersList,
          },
        })
        log('warn', 'adapter provision failed', error)
        return null
      } finally {
        adapterPromise = null
      }
    })()
    return adapterPromise
  }

  async function startStack() {
    if (!cfg.enabled) {
      setState({ phase: 'disabled', message: 'Disabled in configuration' })
      return
    }
    setState({
      phase: 'starting',
      message: 'Preparing the local Sub2API runtime…',
      error: null,
      hint: null,
      startedAt: Date.now(),
      readyAt: null,
    })
    try {
      await prepareRuntime()
      await ensureDocker()
      await composeUp()
      await waitForHealth()
      await waitForLogin()
      setState({
        phase: 'ready',
        message: 'Local Sub2API is running',
        error: null,
        hint: null,
        readyAt: Date.now(),
      })
      log('info', `Sub2API ready on ${upstreamBase()}`)
      if (cfg.adapterEnabled && cfg.adapterAutoProvision && cfg.adapterProvidersList.length > 0) {
        provisionProviders().catch(() => {})
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      setState({ phase: 'error', message: 'Local Sub2API could not start', error: message, hint: hintForError(message) })
      log('warn', 'start failed', error)
    }
  }

  function hintForError(message) {
    if (/Docker/i.test(message)) {
      return 'Docker Desktop must be installed and its engine running. Open Docker Desktop, wait until it says "Engine running", then press Retry.'
    }
    if (/port|bind|EADDRINUSE/i.test(message)) {
      return 'A required local port is already used. Change sub2apiPort in the plugin configuration.'
    }
    return 'Check the plugin configuration, then press Retry. Runtime logs: docker logs dsh-local-sub2api'
  }

  function ensureStack({ force = false } = {}) {
    if (!cfg.enabled) return Promise.resolve()
    if (startPromise) return startPromise
    if (!force && state.phase === 'ready') return Promise.resolve()
    startPromise = startStack().finally(() => { startPromise = null })
    return startPromise
  }

  async function stopStack() {
    try {
      if (envValues === null) await prepareRuntime()
      setState({ message: 'Stopping the Sub2API containers…' })
      await composeCommand(['stop'], 180000)
      authSession = null
      setState({ phase: 'stopped', message: 'Local Sub2API is stopped', readyAt: null })
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      setState({ phase: 'error', message: 'Could not stop Local Sub2API', error: message })
    }
  }

  async function restartStack() {
    if (startPromise) return startPromise
    startPromise = (async () => {
      try {
        if (envValues === null) await prepareRuntime()
        setState({ phase: 'starting', message: 'Restarting the Sub2API containers…', error: null, hint: null })
        await ensureDocker()
        await composeUp()
        await waitForHealth()
        await waitForLogin()
        setState({ phase: 'ready', message: 'Local Sub2API is running', readyAt: Date.now(), error: null, hint: null })
        if (cfg.adapterEnabled && cfg.adapterAutoProvision && cfg.adapterProvidersList.length > 0) {
          provisionProviders().catch(() => {})
        }
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        setState({ phase: 'error', message: 'Local Sub2API could not restart', error: message, hint: hintForError(message) })
      }
    })().finally(() => { startPromise = null })
    return startPromise
  }

  // ---------------------------------------------------------------------------
  // reverse proxy (Sub2API origin -> loopback proxy origin usable in an iframe)
  // ---------------------------------------------------------------------------

  async function handleProxy(req, res) {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${cfg.proxyPort}`)
    if (requestUrl.pathname === '/__dsh_local_sub2api/health') {
      sendJson(res, 200, { ok: state.phase === 'ready', phase: state.phase })
      return
    }
    if (state.phase !== 'ready') {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Local Sub2API</title></head><body style="font-family:system-ui;padding:24px"><h3>Local Sub2API is not ready yet</h3><p>${escapeHtml(state.message || '')}</p></body></html>`)
      return
    }

    const headers = { ...req.headers }
    headers.host = `127.0.0.1:${cfg.sub2apiPort}`
    headers['accept-encoding'] = 'identity'
    delete headers['if-none-match']
    delete headers['if-modified-since']

    const upstream = httpRequest({
      host: '127.0.0.1',
      port: cfg.sub2apiPort,
      method: req.method,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      headers,
      timeout: 120000,
    }, (upstreamRes) => {
      const contentType = String(upstreamRes.headers['content-type'] || '')
      const statusCode = upstreamRes.statusCode || 502
      const isHtml = contentType.includes('text/html')
      const isRedirect = statusCode >= 300 && statusCode < 400

      if (isRedirect) {
        const outHeaders = { ...upstreamRes.headers }
        const location = outHeaders.location
        if (typeof location === 'string') {
          outHeaders.location = location
            .replace(`http://127.0.0.1:${cfg.sub2apiPort}`, `http://127.0.0.1:${cfg.proxyPort}`)
            .replace(upstreamBase(), `http://127.0.0.1:${cfg.proxyPort}`)
        }
        outHeaders['cache-control'] = 'no-store'
        res.writeHead(statusCode, outHeaders)
        upstreamRes.pipe(res)
        return
      }

      if (!isHtml) {
        const outHeaders = { ...upstreamRes.headers }
        delete outHeaders['x-frame-options']
        res.writeHead(statusCode, outHeaders)
        upstreamRes.pipe(res)
        return
      }

      const chunks = []
      let size = 0
      upstreamRes.on('data', (chunk) => {
        size += chunk.length
        if (size > 32 * 1024 * 1024) {
          upstreamRes.destroy()
          return
        }
        chunks.push(chunk)
      })
      upstreamRes.on('end', async () => {
        let html = Buffer.concat(chunks).toString('utf8')
        let session = null
        try { session = await loginAdmin() } catch { session = null }
        let theme = null
        try {
          const requested = requestUrl.searchParams.get('__dsh_theme')
          theme = requested === 'dark' || requested === 'light' ? requested : null
        } catch {}
        html = injectIntoHtml(html, buildBootstrapScript(session, theme))
        const outHeaders = { ...upstreamRes.headers }
        for (const key of [
          'content-security-policy',
          'content-security-policy-report-only',
          'x-frame-options',
          'content-encoding',
          'content-length',
          'etag',
          'last-modified',
          'transfer-encoding',
        ]) delete outHeaders[key]
        outHeaders['content-type'] = 'text/html; charset=utf-8'
        outHeaders['cache-control'] = 'no-store'
        outHeaders['content-length'] = String(Buffer.byteLength(html))
        res.writeHead(statusCode, outHeaders)
        res.end(html)
      })
      upstreamRes.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        }
        res.end('Sub2API upstream stream error')
      })
    })

    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')))
    upstream.on('error', (error) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Local Sub2API</title></head><body style="font-family:system-ui;padding:24px"><h3>Local Sub2API unreachable</h3><p>${escapeHtml(error && error.message ? error.message : String(error))}</p></body></html>`)
    })
    req.pipe(upstream)
  }

  function handleUpgrade(req, socket, head) {
    if (state.phase !== 'ready') {
      socket.destroy()
      return
    }
    const headers = { ...req.headers }
    headers.host = `127.0.0.1:${cfg.sub2apiPort}`
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: cfg.sub2apiPort,
      method: req.method,
      path: req.url,
      headers,
    })
    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      if (upstreamHead && upstreamHead.length > 0) upstreamSocket.unshift(upstreamHead)
      const lines = [`HTTP/1.1 101 ${upstreamRes.statusMessage || 'Switching Protocols'}`]
      for (let index = 0; index < upstreamRes.rawHeaders.length; index += 2) {
        lines.push(`${upstreamRes.rawHeaders[index]}: ${upstreamRes.rawHeaders[index + 1]}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head && head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
      const destroy = () => {
        try { upstreamSocket.destroy() } catch {}
        try { socket.destroy() } catch {}
      }
      upstreamSocket.on('error', destroy)
      socket.on('error', destroy)
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  }

  async function startProxy() {
    for (let attempt = 0; attempt < 12; attempt++) {
      const port = cfg.proxyPort + attempt
      const server = createServer((req, res) => {
        handleProxy(req, res).catch((error) => {
          log('warn', 'proxy error', error)
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          }
          res.end('proxy error')
        })
      })
      server.on('upgrade', handleUpgrade)
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject)
            resolve()
          })
        })
        proxyServer = server
        setState({ proxyPort: port, proxyUrl: `http://127.0.0.1:${port}/` })
        log('info', `admin console proxy listening on http://127.0.0.1:${port}/`)
        return
      } catch (error) {
        try { server.close() } catch {}
        if (!(error && error.code === 'EADDRINUSE')) throw error
      }
    }
    throw new Error(`No free proxy port in range ${cfg.proxyPort}-${cfg.proxyPort + 11}`)
  }

  // ---------------------------------------------------------------------------
  // actions
  // ---------------------------------------------------------------------------

  function statusPayload() {
    return {
      enabled: cfg.enabled,
      phase: state.phase,
      message: state.message,
      error: state.error,
      hint: state.hint,
      autoLogin: state.autoLogin,
      dockerAvailable: state.dockerAvailable,
      dockerStarting: state.dockerStarting,
      sub2apiPort: cfg.sub2apiPort,
      proxyPort: state.proxyPort,
      proxyUrl: state.proxyUrl,
      image: cfg.image,
      runMode: cfg.runMode,
      pluginVersion: 3,
      dataDir: cfg.dataDir,
      startedAt: state.startedAt,
      readyAt: state.readyAt,
      updatedAt: state.updatedAt,
      // Settings-page switches: `autoStart` is the launch preference,
      // `runtimeOn` is whether the user wants the service up right now.
      autoStart: prefs.autoStart,
      runtimeOn: prefs.runtimeOn !== false,
      // Whether the provider-import feature can run on this Harness build.
      importAvailable: Boolean(ctx.get('llm')),
      adapter: {
        enabled: cfg.adapterEnabled,
        autoProvision: cfg.adapterAutoProvision,
        running: !!state.adapter.running,
        done: !!state.adapter.done,
        lastRunAt: state.adapter.lastRunAt,
        summary: state.adapter.summary,
        providers: cfg.adapterProvidersList.map((p) => ({
          id: p.id,
          name: p.name,
          baseUrl: p.baseUrl,
          apiKeySource: p.apiKeySource,
        })),
      },
    }
  }

  async function handleAction(request, response) {
    let payload = {}
    try {
      const raw = await readRequestBody(request)
      payload = raw ? JSON.parse(raw) : {}
    } catch {}
    const action = payload && typeof payload.action === 'string' ? payload.action : ''
    if (action === 'start') {
      if (state.phase === 'ready') sendJson(response, 200, statusPayload())
      else {
        ensureStack({ force: true }).catch(() => {})
        sendJson(response, 202, statusPayload())
      }
      return
    }
    if (action === 'restart') {
      restartStack().catch(() => {})
      sendJson(response, 202, statusPayload())
      return
    }
    if (action === 'stop') {
      stopStack().catch(() => {})
      sendJson(response, 202, statusPayload())
      return
    }
    if (action === 'provision-providers') {
      provisionProviders().then((results) => {
        sendJson(response, 200, {
          ...statusPayload(),
          provisioned: results || null,
        })
      }).catch((error) => {
        sendJson(response, 500, { error: String(error && error.message ? error.message : error) })
      })
      return
    }
    if (action === 'set-auto-start') {
      // Launch preference only: it decides what the next Harness start does and
      // never touches the stack that is running now.
      prefs = { ...prefs, autoStart: payload.on === true }
      state.autoStart = prefs.autoStart
      await savePreferences()
      sendJson(response, 200, statusPayload())
      return
    }
    if (action === 'set-runtime') {
      // The on/off switch: start brings the stack up and marks it as wanted,
      // stop brings it down and remembers the user does not want it up.
      const on = payload.on === true
      prefs = { ...prefs, runtimeOn: on }
      await savePreferences()
      if (on) {
        ensureStack({ force: true }).catch(() => {})
        sendJson(response, 202, statusPayload())
      } else {
        stopStack().catch(() => {})
        sendJson(response, 202, statusPayload())
      }
      return
    }
    if (action === 'list-harness-providers') {
      // Read-only enumeration: what the Harness can serve, and what of it is
      // importable. Never starts the stack and never writes.
      try {
        const enumerated = await readHarnessProviders()
        sendJson(response, 200, {
          ...enumerated,
          stackReady: state.phase === 'ready',
        })
      } catch (error) {
        sendJson(response, 500, { error: String(error && error.message ? error.message : error) })
      }
      return
    }
    if (action === 'import-providers') {
      // The import button. Requires a running stack because the accounts are
      // created through the local Sub2API admin API.
      if (state.phase !== 'ready') {
        sendJson(response, 409, { error: '本地 Sub2API 还没就绪，先把服务打开再导入。', phase: state.phase })
        return
      }
      try {
        const result = await importHarnessProviders({
          providers: Array.isArray(payload.providers) ? payload.providers : undefined,
          models: payload.models && typeof payload.models === 'object' ? payload.models : undefined,
        })
        sendJson(response, result.ok ? 200 : 500, { ...result, ...statusPayload() })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
      return
    }
    if (action === 'save-import-selection') {
      // Remember the ticked models without importing, so reopening the page
      // shows the same choice.
      const models = payload.models && typeof payload.models === 'object' ? payload.models : {}
      for (const [provider, ids] of Object.entries(models)) {
        if (Array.isArray(ids)) importSelection[provider] = { models: ids, at: Date.now() }
      }
      await saveImportSelection()
      sendJson(response, 200, { ok: true, saved: Object.keys(models).length })
      return
    }
    sendJson(response, 400, { error: `unknown action: ${action || '(empty)'}` })
  }

  // ---------------------------------------------------------------------------
  // wiring
  // ---------------------------------------------------------------------------

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      sendJson(res, 200, statusPayload())
    },
  }), 'local-sub2api: status route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ACTION_PATH,
    handler: (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      handleAction(req, res).catch((error) => sendJson(res, 500, { error: String(error && error.message ? error.message : error) }))
    },
  }), 'local-sub2api: action route')

  ctx.effect(() => {
    startProxy().catch((error) => {
      setState({ phase: 'error', error: `proxy: ${error && error.message ? error.message : error}`, hint: null })
      log('warn', 'proxy failed to start', error)
    })
    return async () => {
      disposed = true
      const server = proxyServer
      proxyServer = null
      if (server) {
        try { server.close() } catch {}
        try { server.closeAllConnections?.() } catch {}
      }
      if (cfg.stopOnUnload) {
        try { await stopStack() } catch {}
      }
    }
  }, 'local-sub2api: proxy server')

  // The persisted switches outrank the profile config: they are what the
  // settings page edits, and the page must not be silently overruled by the
  // YAML the user never re-opened.
  loadPreferences().then(() => {
    if (!cfg.enabled) {
      setState({ phase: 'disabled', message: 'Disabled in configuration' })
      return
    }
    if (prefs.autoStart) {
      setState({ phase: 'starting', message: 'Starting the local Sub2API stack…' })
      ensureStack().catch(() => {})
    } else if (prefs.runtimeOn === false) {
      setState({ phase: 'stopped', message: 'Stopped from the settings switch' })
    } else {
      // Not auto-started: the panel shows "Stopped" with a Start button.
      setState({ phase: 'stopped', message: 'Idle — start it when you need it' })
    }
    // The remembered model selection is read once; a failure only costs the
    // pre-ticked state, never the feature.
    loadImportSelection().catch(() => {})
  }).catch((error) => {
    log('warn', 'could not load preferences', error)
  })

  log('info', `plugin active (data dir ${cfg.dataDir})`)
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]))
}
