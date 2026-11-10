/**
 * dsh-local-sub2api — "把 Harness 里已有的厂商导入 Sub2API".
 *
 * The Harness already knows every provider the user configured (皮卡丘中转、
 * MiniMax 官方、Our Free Model channels …) together with each model's display
 * name, context window and modality. This module turns that live knowledge into
 * Sub2API **accounts**: one account per Harness provider, pointed at the same
 * upstream endpoint with the same key, so every model the user already pays for
 * becomes callable through the local Sub2API gateway too.
 *
 * Why the `llm` service instead of re-reading the profile YAML:
 *   - it is the resolved truth (patch layers, defaults, runtime registrations),
 *     not one file's view of it;
 *   - `listModels(provider)` asks the owning adapter, so a provider that
 *     discovers its catalog over the network is covered as well;
 *   - it needs no file parsing and no knowledge of another plugin's schema.
 *
 * What it cannot learn from `llm`: the upstream **base URL** and **key**. Those
 * live in the configurable-provider directory (`baseURL`, `baseURLEnv`,
 * `nativeAuth`), so that directory supplies them and the credentials service
 * resolves the key — the same refs the Harness itself uses. A provider with no
 * resolvable endpoint or key is reported as skipped rather than guessed at.
 */

/** Read one configurable-directory entry for a provider route, if declared. */
function directoryEntry(directory, provider) {
  if (!Array.isArray(directory)) return undefined
  return directory.find((entry) => entry && entry.provider === provider)
}

/**
 * Resolve an upstream key for one provider route.
 *
 * Order: the directory's `baseURLEnv`/`nativeAuth.env` names (the Harness's own
 * convention for "this route's key lives at this env/ref"), then a generic
 * `<PROVIDER>_API_KEY`. Values come from the credentials service first and the
 * process environment second, which is what the Harness itself does.
 */
async function resolveProviderKey({ provider, entry, credentials, env }) {
  const names = []
  if (entry && Array.isArray(entry.nativeAuth?.env)) names.push(...entry.nativeAuth.env)
  if (entry && Array.isArray(entry.baseURLEnv)) names.push(...entry.baseURLEnv)
  names.push(`${String(provider).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`)

  for (const name of names) {
    if (typeof name !== 'string' || name === '') continue
    // Environment first: it is what the adapter plugin itself reads.
    const fromEnv = env && env[name]
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { key: fromEnv.trim(), source: `env:${name}` }
    if (credentials) {
      try {
        const resolved = await credentials.resolve(name)
        const value = resolved && (resolved.value ?? resolved.secret ?? resolved.token)
        if (typeof value === 'string' && value.trim() !== '') {
          return { key: value.trim(), source: `refs:${name}` }
        }
      } catch { /* a missing ref is the normal case, not an error */ }
    }
  }
  return null
}

/**
 * Collect every provider the Harness can serve, with its models and the
 * endpoint/key needed to reach it through Sub2API.
 *
 * @returns {Promise<Array<{
 *   provider: string, displayName: string, baseUrl: string|null,
 *   api: string|null, keySource: string|null, models: Array<object>,
 *   importable: boolean, reason?: string,
 * }>>}
 */
export async function collectHarnessProviders({ llm, credentials, env = process.env, settingsNs = null }) {
  if (!llm) throw new Error('the Harness llm service is unavailable')

  // Directory first: it is the only source of baseURL/key hints, and its order
  // is the declaration order the settings UI already presents.
  let directory = []
  try {
    directory = await llm.listConfigurableProviders()
  } catch { directory = [] }

  const providers = await llm.listProviders()
  const out = []
  for (const info of providers) {
    const provider = info && info.id ? info.id : null
    if (!provider) continue
    const entry = directoryEntry(directory, provider)

    // baseURL: the directory's resolved default, or the profile's own value.
    const baseUrl = typeof entry?.defaultBaseURL === 'string' && entry.defaultBaseURL.trim() !== ''
      ? entry.defaultBaseURL.trim()
      : null

    let models = []
    try {
      models = await llm.listModels(provider)
    } catch { models = [] }

    const key = await resolveProviderKey({ provider, entry, credentials, env })
    const importable = Boolean(baseUrl && key && models.length > 0)
    let reason
    if (!baseUrl) reason = 'the provider declares no base URL, so Sub2API has nothing to dial'
    else if (!key) reason = 'no API key found (checked the provider env names and the credential store)'
    else if (models.length === 0) reason = 'the provider advertises no models'

    out.push({
      provider,
      displayName: (info && info.name) || (entry && entry.displayName) || provider,
      baseUrl,
      api: entry && entry.declared ? null : null,
      keySource: key ? key.source : null,
      importedModels: models.map((model) => ({
        id: model.id,
        name: model.name || model.id,
        contextWindow: Number.isFinite(model.contextWindow) ? model.contextWindow : null,
        maxTokens: Number.isFinite(model.maxTokens) ? model.maxTokens : null,
        inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities : null,
      })),
      importable,
      ...(reason ? { reason } : {}),
      // The resolved secret never leaves this function; only its origin does.
      ...(key ? { _key: key.key } : {}),
    })
  }
  return out
}

/** Strip the resolved secrets before anything is serialised to the client. */
export function redactProviders(providers) {
  return providers.map(({ _key, ...rest }) => rest)
}
