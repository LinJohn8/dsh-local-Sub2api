/**
 * dsh-local-sub2api — model-vendor adapter ("适配现有厂商").
 *
 * After the local Sub2API stack is ready and the plugin has logged in as the
 * local admin, this module ensures that a set of configured OpenAI-compatible
 * upstream endpoints are provisioned as Sub2API **accounts** so the user's
 * existing model vendors become usable through Sub2API.
 *
 * Sub2API terms (verified against v0.2.19 source + the live instance):
 *   - An Account (`POST /api/v1/admin/accounts`) is the thing that actually
 *     connects and relays to an upstream endpoint.
 *   - platform = 'openai' uses the OpenAI-compatible Chat Completions gateway.
 *   - type    = 'apikey' makes the runtime read credentials.base_url as the
 *     relay target and credentials.api_key as the upstream API key
 *     (Account.GetBaseURL() -> GetCredential("base_url") for apikey accounts).
 *   - So an arbitrary OpenAI-compatible endpoint is added as an 'openai/apikey'
 *     account with credentials { base_url, api_key }.
 *
 * Security model:
 *   - No secret is ever written back into this plugin package or into git.
 *   - API keys are resolved at runtime from the environment, the DSH credential
 *     store (refs), or a local readable file, then sent to the local Sub2API
 *     admin API (loopback only) — they live only in the Sub2API database.
 *   - Secrets are never logged; any status output masks them.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// Mask rendering for any status / diagnostic output. It is only ever the first
// few characters + length hint; the full value never leaves module boundaries
// except into the Sub2API admin API call.
export function maskSecret(secret) {
  if (!secret) return ''
  const s = String(secret)
  if (s.length <= 6) return '***'
  return `${s.slice(0, 4)}…(${s.length})`
}

function defaultDataDir() {
  const dsh = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return dsh
}

/**
 * Resolve an API key from a configured source string. Supported sources:
 *   env:NAME        -> process.env[NAME]
 *   file:PATH       -> first non-empty line of a readable file
 *   refs:NAME       -> DSH credential store (~/.dsh/.credentials.yaml) refs[NAME]
 * Returns null when unavailable (caller decides whether to skip the provider).
 */
export async function resolveKeySource(source, baseDir) {
  if (!source || typeof source !== 'string') return null
  try {
    if (source.startsWith('env:')) {
      const name = source.slice(4).trim()
      const value = name ? (process.env[name] || '') : ''
      return value || null
    }
    if (source.startsWith('file:')) {
      const file = source.slice(5).trim()
      if (!file) return null
      const resolved = path.isAbsolute(file) ? file : path.resolve(baseDir || defaultDataDir(), file)
      const text = await fsp.readFile(resolved, 'utf8')
      const line = String(text).split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '')
      return line || null
    }
    if (source.startsWith('refs:')) {
      const name = source.slice(5).trim()
      if (!name) return null
      const credsPath = path.join(defaultDataDir(), '.credentials.yaml')
      const yaml = await fsp.readFile(credsPath, 'utf8')
      return readRefsValue(yaml, name)
    }
  } catch {
    return null
  }
  return null
}

/**
 * Minimal read of the DSH credential file's top-level `refs:` mapping.
 * refs maps env-var-style key strings to secret values. We only read the ref we
 * are configured for and never persist it.
 */
function readRefsValue(yaml, name) {
  const text = String(yaml || '')
  const refsMatch = /(?:^|\n)refs:\s*\n([\s\S]*?)(?:\n\S|$)/.exec(text)
  if (!refsMatch) return null
  const block = refsMatch[1]
  const linePattern = new RegExp(
    `^\\s*${escapeRegExp(name)}\\s*:\\s*(.*?)\\s*$`,
    'm',
  )
  const m = linePattern.exec(block)
  if (!m) return null
  return unquote(m[1])
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function unquote(value) {
  const v = String(value).trim()
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1)
  }
  return v
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/**
 * Ensure an account (idempotent by name) is present. Returns a per-provider
 * outcome string for status reporting. `httpJson` matches index.js's signature:
 *   httpJson(url, { method, body, headers?, timeoutMs }) -> {statusCode, json,...}
 */
export async function provisionProvider({ provider, api, httpJson, log }) {
  const outcome = {
    name: provider.name,
    baseUrl: provider.baseUrl,
    action: 'skipped',
    message: '',
  }
  try {
    const session = await api.login()
    const authHeaders = {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    }

    // List existing accounts (idempotency).
    const listUrl = `${api.base()}/api/v1/admin/accounts?page=1&page_size=50`
    const list = await httpJson(listUrl, { method: 'GET', headers: authHeaders, timeoutMs: 20000 })
    if (list.statusCode !== 200) {
      outcome.action = 'error'
      outcome.message = `list accounts HTTP ${list.statusCode}`
      return outcome
    }
    const items = (list.json && list.json.data && list.json.data.items) || []
    const existing = items.find((acct) => String(acct.name).trim() === String(provider.name).trim())

    if (existing) {
      outcome.action = 'exists'
      outcome.message = `account #${existing.id} already present`
      return outcome
    }

    const credentials = Object.assign({ base_url: provider.baseUrl }, provider.credentials || {})
    const body = {
      name: provider.name,
      platform: provider.platform || 'openai',
      type: provider.type || 'apikey',
      credentials,
      concurrency: Number.isInteger(provider.concurrency) ? provider.concurrency : 3,
      priority: Number.isInteger(provider.priority) ? provider.priority : 50,
      ...(Array.isArray(provider.group_ids) ? { group_ids: provider.group_ids } : {}),
    }

    const createUrl = `${api.base()}/api/v1/admin/accounts`
    const created = await httpJson(createUrl, { method: 'POST', headers: authHeaders, body, timeoutMs: 30000 })
    if (created.statusCode === 200 && created.json && created.json.code === 0) {
      const id = created.json.data && created.json.data.id
      outcome.action = 'created'
      outcome.message = id ? `created account #${id}` : 'created'
    } else {
      outcome.action = 'error'
      outcome.message = `create HTTP ${created.statusCode}: ${firstLineText(created.text)}`
    }
    return outcome
  } catch (error) {
    outcome.action = 'error'
    outcome.message = error && error.message ? error.message : String(error)
    return outcome
  }
}

function firstLineText(text) {
  return String(text || '').split(/\r?\n/).find((l) => l.trim() !== '') || ''
}

/**
 * Provision all configured providers. Returns an array of outcome objects.
 * Providers whose key cannot be resolved are left as 'skipped:no key' — the
 * plugin itself never fails because of a missing third-party key.
 */
export async function provisionAll({ config, api, httpJson, log }) {
  const providers = config.adapterProvidersList
  const results = []
  for (const provider of providers) {
    const key = await resolveKeySource(provider.apiKeySource, config.adapterSecretBaseDir)
    if (!key) {
      results.push({
        name: provider.name,
        baseUrl: provider.baseUrl,
        action: 'skipped',
        message: `no api key (source ${provider.apiKeySource})`,
      })
      continue
    }
    // Attach the resolved key into credentials (never logged).
    const providerWithKey = {
      ...provider,
      credentials: { ...(provider.credentials || {}) },
    }
    providerWithKey.credentials.base_url = provider.baseUrl
    providerWithKey.credentials.api_key = key
    const outcome = await provisionProvider({ provider: providerWithKey, api, httpJson, log })
    results.push(outcome)
  }
  return results
}

export function statusSummary(results) {
  const created = results.filter((r) => r.action === 'created').map((r) => r.name)
  const existed = results.filter((r) => r.action === 'exists').map((r) => r.name)
  const skipped = results.filter((r) => r.action === 'skipped').map((r) => r.name)
  const failed = results.filter((r) => r.action === 'error').map((r) => ({ name: r.name, message: r.message }))
  return { created, existed, skipped, failed }
}

export function wasSuccessful(outcome) {
  return outcome && outcome.action === 'created'
}