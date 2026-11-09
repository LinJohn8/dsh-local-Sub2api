/**
 * dsh-local-sub2api — Client half.
 *
 * Adds a "Local Sub2api" entry to the sidebar panel list (left side of the
 * window) and a matching central panel. The panel starts the local Sub2API
 * stack through the Host half's action route and renders the Sub2API admin
 * console in an iframe served by the local loopback proxy, so the console
 * boots already logged in.
 */
window.__ModuleLoader__.load({
  id: 'dsh-local-sub2api',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'local-sub2api'
    const STATUS_URL = 'local-sub2api/status'
    const ACTION_URL = 'local-sub2api/action'
    const POLL_READY_MS = 8000
    const POLL_STARTING_MS = 2000

    const DICT = {
      en: {
        title: 'Local Sub2api',
        subtitle: 'Local Sub2API gateway',
        'phase.ready': 'Running',
        'phase.starting': 'Starting…',
        'phase.stopped': 'Stopped',
        'phase.error': 'Failed',
        'phase.disabled': 'Disabled',
        'phase.idle': 'Idle',
        'body.waiting': 'Waiting for the local Sub2API service…',
        'body.starting': 'Starting the local Sub2API stack. The first launch downloads Docker images and can take a few minutes.',
        'body.error': 'Local Sub2API could not start.',
        'body.stopped': 'Local Sub2API is stopped.',
        'body.disabled': 'The plugin is disabled in its configuration.',
        'body.loadingConsole': 'Loading the Sub2API console…',
        'action.start': 'Start',
        'action.stop': 'Stop',
        'action.restart': 'Restart',
        'action.reload': 'Reload',
        'action.open': 'Open in browser',
        'action.retry': 'Retry',
        'status.autoLogin': 'Auto login',
        'status.noAutoLogin': 'Login required',
        'detail.port': 'Port',
        'detail.data': 'Data',
        'hint.console': 'If the console keeps loading, press Reload. Service logs: docker logs dsh-local-sub2api',
        'error.statusUnavailable': 'The Harness status endpoint is unavailable.',
        'error.actionFailed': 'The action failed.',
        'settings.title': 'Local Sub2api',
        'settings.desc': 'A private Sub2API stack (Sub2API + PostgreSQL + Redis in Docker) that runs alongside DeepSeek Harness.',
        'settings.run': 'Service',
        'settings.runDesc': 'Whether the local Sub2API stack is running right now.',
        'settings.runOn': 'Running',
        'settings.runOff': 'Stopped',
        'settings.runToggle': 'Turn the service on or off',
        'settings.autoStart': 'Start with DeepSeek Harness',
        'settings.autoStartDesc': 'Start the stack automatically whenever DeepSeek Harness opens. Off by default; the stack keeps Docker busy, so start it manually when you need it.',
        'settings.autoStartOn': 'On',
        'settings.autoStartOff': 'Off',
        'settings.autoStartToggle': 'Start automatically on the next launch',
        'settings.state': 'Current state',
        'settings.busy': 'Working…',
        'settings.saved': 'Saved',
        'settings.port': 'Service port',
        'settings.proxy': 'Console proxy',
      },
      zh: {
        title: 'Local Sub2api',
        subtitle: '本地 Sub2API 网关',
        'phase.ready': '运行中',
        'phase.starting': '启动中…',
        'phase.stopped': '已停止',
        'phase.error': '启动失败',
        'phase.disabled': '已禁用',
        'phase.idle': '空闲',
        'body.waiting': '正在等待本地 Sub2API 服务…',
        'body.starting': '正在启动本地 Sub2API 服务。首次启动需要拉取 Docker 镜像，可能需要几分钟。',
        'body.error': '本地 Sub2API 启动失败。',
        'body.stopped': '本地 Sub2API 已停止。',
        'body.disabled': '插件配置中已禁用。',
        'body.loadingConsole': '正在加载 Sub2API 管理界面…',
        'action.start': '启动',
        'action.stop': '停止',
        'action.restart': '重启',
        'action.reload': '刷新',
        'action.open': '在浏览器打开',
        'action.retry': '重试',
        'status.autoLogin': '自动登录',
        'status.noAutoLogin': '需要登录',
        'detail.port': '端口',
        'detail.data': '数据目录',
        'hint.console': '如果界面一直加载，请点击刷新。服务日志：docker logs dsh-local-sub2api',
        'error.statusUnavailable': '无法访问 Harness 状态接口。',
        'error.actionFailed': '操作失败。',
        'settings.title': 'Local Sub2api',
        'settings.desc': '随 DeepSeek Harness 一起使用的本地 Sub2API 网关（Docker 中的 Sub2API + PostgreSQL + Redis）。',
        'settings.run': '服务开关',
        'settings.runDesc': '本地 Sub2API 服务当前是否在运行。',
        'settings.runOn': '运行中',
        'settings.runOff': '已停止',
        'settings.runToggle': '开启或关闭服务',
        'settings.autoStart': '打开 Harness 时自动启动',
        'settings.autoStartDesc': '每次打开 DeepSeek Harness 时自动启动本地 Sub2API。默认关闭：该服务会持续占用 Docker，需要时再手动开启即可。',
        'settings.autoStartOn': '开',
        'settings.autoStartOff': '关',
        'settings.autoStartToggle': '下次启动时自动运行',
        'settings.state': '当前状态',
        'settings.busy': '处理中…',
        'settings.saved': '已保存',
        'settings.port': '服务端口',
        'settings.proxy': '管理界面代理',
      },
    }

    const CSS = [
      '.dsh-ls2a-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45}',
      '.dsh-ls2a-bar{display:flex;align-items:center;gap:8px;flex:none;min-height:40px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-ls2a-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}',
      '.dsh-ls2a-pill{display:inline-flex;align-items:center;gap:6px;flex:none;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}',
      '.dsh-ls2a-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}',
      '.dsh-ls2a-dot[data-phase="ready"]{background:var(--dsw-alias-state-success-primary)}',
      '.dsh-ls2a-dot[data-phase="starting"]{background:var(--dsw-alias-state-warn-primary)}',
      '.dsh-ls2a-dot[data-phase="error"]{background:var(--dsw-alias-state-error-primary)}',
      '.dsh-ls2a-spacer{flex:1 1 auto;min-width:8px}',
      '.dsh-ls2a-btn{appearance:none;display:inline-flex;align-items:center;gap:5px;flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:4px 10px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.dsh-ls2a-btn:hover{background:var(--dsw-alias-bg-overlay)}',
      '.dsh-ls2a-btn:disabled{opacity:.5;cursor:default}',
      '.dsh-ls2a-btn[data-variant="primary"]{border-color:transparent;background:var(--dsw-alias-brand-primary);color:#fff}',
      '.dsh-ls2a-body{position:relative;flex:1 1 auto;min-height:0;display:flex;overflow:hidden}',
      '.dsh-ls2a-frame{width:100%;height:100%;border:0;display:block;background:var(--dsw-alias-bg-base)}',
      '.dsh-ls2a-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:28px;text-align:center;background:var(--dsw-alias-bg-base)}',
      '.dsh-ls2a-overlay-title{font-size:14px;font-weight:600;max-width:760px}',
      '.dsh-ls2a-overlay-text{color:var(--dsw-alias-label-secondary);max-width:760px;white-space:pre-wrap;word-break:break-word}',
      '.dsh-ls2a-error{color:var(--dsw-alias-state-error-primary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;max-width:820px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-word;text-align:left;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;width:100%;box-sizing:border-box}',
      '.dsh-ls2a-hint{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;max-width:760px}',
      '.dsh-ls2a-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}',
      '.dsh-ls2a-spinner{width:26px;height:26px;border-radius:50%;border:3px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-state-warn-primary);animation:dsh-ls2a-spin .9s linear infinite}',
      '@keyframes dsh-ls2a-spin{to{transform:rotate(360deg)}}',
      '.dsh-ls2a-foot{flex:none;display:flex;gap:14px;padding:4px 12px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;background:var(--dsw-alias-bg-layer-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      // --- settings page ---
      '.dsh-ls2a-set{display:flex;flex-direction:column;gap:14px;padding:4px 2px;max-width:760px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dsh-ls2a-set-desc{color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.dsh-ls2a-set-row{display:flex;align-items:flex-start;gap:16px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-ls2a-set-row-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.dsh-ls2a-set-row-title{font-weight:600}',
      '.dsh-ls2a-set-row-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}',
      '.dsh-ls2a-set-row-side{flex:none;display:flex;align-items:center;gap:10px;padding-top:2px}',
      '.dsh-ls2a-switch{position:relative;appearance:none;flex:none;width:40px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .15s ease,border-color .15s ease;padding:0}',
      '.dsh-ls2a-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s ease,background .15s ease}',
      '.dsh-ls2a-switch[data-on="true"]{background:var(--dsw-alias-brand-primary);border-color:transparent}',
      '.dsh-ls2a-switch[data-on="true"]::after{transform:translateX(18px);background:#fff}',
      '.dsh-ls2a-switch:disabled{opacity:.5;cursor:default}',
      '.dsh-ls2a-switch-label{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;min-width:3.5em;text-align:right}',
      '.dsh-ls2a-set-state{display:inline-flex;align-items:center;gap:7px;padding:2px 10px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}',
      '.dsh-ls2a-set-meta{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsh-ls2a-set-err{color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap;word-break:break-word}',
    ].join('\n')

    const ICON_PATH = 'M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v1A2.5 2.5 0 0 1 17.5 11h-11A2.5 2.5 0 0 1 4 8.5v-1Z'
      + 'M6 13.5h12M4 16.5h12M8 19.5h8'

    function Glyph(props) {
      const size = typeof props.size === 'number' ? props.size : 18
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      }, h('path', { d: 'M4 7.5A2.5 2.5 0 0 1 6.5 5h8A2.5 2.5 0 0 1 17 7.5v1A2.5 2.5 0 0 1 14.5 11h-8A2.5 2.5 0 0 1 4 8.5v-1Z' }),
      h('path', { d: 'M17 8.5h2.5A1.5 1.5 0 0 1 21 10v1a2 2 0 0 1-2 2h-2' }),
      h('path', { d: 'M6.5 14.5h12M6.5 17.5h9M6.5 20.5h5' }))
    }

    function readTheme() {
      try {
        const body = document.body
        if (body && body.hasAttribute('data-ds-dark-theme')) return 'dark'
        if (document.documentElement && document.documentElement.getAttribute('data-theme') === 'dark') return 'dark'
      } catch {}
      try {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      } catch {
        return 'light'
      }
    }

    function statusUrl() {
      try {
        return new URL(STATUS_URL, document.baseURI).toString()
      } catch {
        return `/${STATUS_URL}`
      }
    }

    function actionUrl() {
      try {
        return new URL(ACTION_URL, document.baseURI).toString()
      } catch {
        return `/${ACTION_URL}`
      }
    }

    function createPanel(t) {
      return function LocalSub2apiPanel() {
        const [status, setStatus] = React.useState(null)
        const [statusError, setStatusError] = React.useState(null)
        const [actionError, setActionError] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [theme, setTheme] = React.useState(readTheme)
        const [reloadKey, setReloadKey] = React.useState(0)
        const [frameLoaded, setFrameLoaded] = React.useState(false)
        const statusRef = React.useRef(null)
        statusRef.current = status

        const refresh = React.useCallback(async () => {
          try {
            const response = await fetch(statusUrl(), { headers: { accept: 'application/json' }, cache: 'no-store' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            setStatus(data)
            setStatusError(null)
          } catch (error) {
            setStatusError(error && error.message ? error.message : String(error))
          }
        }, [])

        React.useEffect(() => {
          let cancelled = false
          let timer = 0
          const tick = async () => {
            if (cancelled) return
            await refresh()
            if (cancelled) return
            const phase = statusRef.current && statusRef.current.phase
            timer = window.setTimeout(tick, phase === 'ready' ? POLL_READY_MS : POLL_STARTING_MS)
          }
          tick()
          return () => {
            cancelled = true
            if (timer) window.clearTimeout(timer)
          }
        }, [refresh])

        React.useEffect(() => {
          const update = () => setTheme(readTheme())
          update()
          let observer = null
          try {
            observer = new MutationObserver(update)
            if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
          } catch {}
          let media = null
          try {
            media = window.matchMedia('(prefers-color-scheme: dark)')
            media.addEventListener?.('change', update)
          } catch {}
          return () => {
            try { observer?.disconnect() } catch {}
            try { media?.removeEventListener?.('change', update) } catch {}
          }
        }, [])

        React.useEffect(() => { setFrameLoaded(false) }, [reloadKey, status && status.phase, theme])

        const runAction = React.useCallback(async (action) => {
          setBusy(true)
          setActionError(null)
          try {
            const response = await fetch(actionUrl(), {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ action }),
            })
            if (!response.ok) {
              let detail = `HTTP ${response.status}`
              try {
                const data = await response.json()
                if (data && data.error) detail = data.error
              } catch {}
              throw new Error(detail)
            }
            const data = await response.json()
            if (data && data.phase) setStatus(data)
            await refresh()
          } catch (error) {
            setActionError(error && error.message ? error.message : String(error))
          } finally {
            setBusy(false)
          }
        }, [refresh])

        const phase = status && status.phase ? status.phase : (statusError ? 'error' : 'idle')
        const ready = phase === 'ready' && status && typeof status.proxyUrl === 'string' && status.proxyUrl !== ''
        const canStart = phase === 'error' || phase === 'stopped' || phase === 'idle'
        const showError = phase === 'error'
        const frameSrc = ready ? `${status.proxyUrl}?__dsh_theme=${encodeURIComponent(theme)}&_r=${reloadKey}` : ''
        const frameKey = `frame-${reloadKey}-${theme}-${status && status.readyAt ? status.readyAt : 0}`

        const style = h('style', null, CSS)
        const header = h('div', { className: 'dsh-ls2a-bar' },
          h('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-secondary)' } }, h(Glyph, { size: 17 })),
          h('span', { className: 'dsh-ls2a-title' }, t('title')),
          h('span', { className: 'dsh-ls2a-pill' },
            h('span', { className: 'dsh-ls2a-dot', 'data-phase': phase }),
            h('span', null, phaseLabel(t, phase))),
          h('span', { className: 'dsh-ls2a-spacer' }),
          ready ? h('button', { type: 'button', className: 'dsh-ls2a-btn', disabled: busy, onClick: () => setReloadKey((value) => value + 1) }, t('action.reload')) : null,
          canStart ? h('button', { type: 'button', className: 'dsh-ls2a-btn', 'data-variant': 'primary', disabled: busy, onClick: () => runAction('start') }, t('action.retry')) : null,
          ready ? h('button', { type: 'button', className: 'dsh-ls2a-btn', disabled: busy, onClick: () => runAction('stop') }, t('action.stop')) : null,
          ready ? h('button', { type: 'button', className: 'dsh-ls2a-btn', disabled: busy, onClick: () => runAction('restart') }, t('action.restart')) : null,
          ready ? h('button', {
            type: 'button',
            className: 'dsh-ls2a-btn',
            disabled: busy,
            onClick: () => {
              try { window.open(status.proxyUrl, '_blank', 'noopener,noreferrer') } catch {}
            },
          }, t('action.open')) : null)

        let body = null
        if (ready) {
          body = h('div', { className: 'dsh-ls2a-body' },
            h('iframe', {
              key: frameKey,
              title: t('title'),
              src: frameSrc,
              className: 'dsh-ls2a-frame',
              allow: 'clipboard-read; clipboard-write; fullscreen',
              referrerPolicy: 'no-referrer',
              onLoad: () => setFrameLoaded(true),
            }),
            frameLoaded ? null : h('div', { className: 'dsh-ls2a-overlay' },
              h('div', { className: 'dsh-ls2a-spinner' }),
              h('div', { className: 'dsh-ls2a-overlay-text' }, t('body.loadingConsole'))))
        } else {
          const starting = phase === 'starting'
          const bodyText = statusError
            ? `${t('error.statusUnavailable')} (${statusError})`
            : t(`body.${phase === 'idle' ? 'waiting' : phase}`)
          body = h('div', { className: 'dsh-ls2a-body' },
            h('div', { className: 'dsh-ls2a-overlay' },
              starting ? h('div', { className: 'dsh-ls2a-spinner' }) : null,
              h('div', { className: 'dsh-ls2a-overlay-title' }, statusText(t, phase)),
              h('div', { className: 'dsh-ls2a-overlay-text' }, bodyText),
              status && status.error ? h('div', { className: 'dsh-ls2a-error' }, status.error) : null,
              actionError ? h('div', { className: 'dsh-ls2a-error' }, `${t('error.actionFailed')}\n${actionError}`) : null,
              status && status.hint ? h('div', { className: 'dsh-ls2a-hint' }, status.hint) : null,
              h('div', { className: 'dsh-ls2a-actions' },
                canStart ? h('button', { type: 'button', className: 'dsh-ls2a-btn', 'data-variant': 'primary', disabled: busy, onClick: () => runAction('start') }, t('action.start')) : null,
                h('button', { type: 'button', className: 'dsh-ls2a-btn', disabled: busy, onClick: () => { refresh() } }, t('action.reload')))))
        }

        const footerParts = []
        if (status) {
          if (status.proxyPort) footerParts.push(`${t('detail.port')} ${status.proxyPort}`)
          footerParts.push(status.autoLogin ? t('status.autoLogin') : t('status.noAutoLogin'))
        }
        return h(React.Fragment, null,
          style,
          h('div', { className: 'dsh-ls2a-root' },
            header,
            body,
            footerParts.length > 0 ? h('div', { className: 'dsh-ls2a-foot' }, footerParts.join('  ·  ')) : null))
      }
    }

    function phaseLabel(t, phase) {
      return t(`phase.${phase}`)
    }

    function statusText(t, phase) {
      if (phase === 'error') return t('body.error')
      if (phase === 'stopped') return t('body.stopped')
      if (phase === 'disabled') return t('body.disabled')
      if (phase === 'starting') return t('phase.starting')
      return t('subtitle')
    }

    /**
     * The settings page. Two switches, both persisted by the Host:
     *   - 「服务开关」 controls the stack right now (start/stop);
     *   - 「打开 Harness 时自动启动」 records what the next launch should do.
     * It also reports the live phase so the user can tell at a glance whether
     * the service is currently up.
     */
    function createSettingsSection(t) {
      return function LocalSub2apiSettings() {
        const [status, setStatus] = React.useState(null)
        const [statusError, setStatusError] = React.useState(null)
        const [actionError, setActionError] = React.useState(null)
        const [busy, setBusy] = React.useState(null)
        const statusRef = React.useRef(null)
        statusRef.current = status

        const refresh = React.useCallback(async () => {
          try {
            const response = await fetch(statusUrl(), { headers: { accept: 'application/json' }, cache: 'no-store' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            setStatus(await response.json())
            setStatusError(null)
          } catch (error) {
            setStatusError(error && error.message ? error.message : String(error))
          }
        }, [])

        React.useEffect(() => {
          let cancelled = false
          let timer = 0
          const tick = async () => {
            if (cancelled) return
            await refresh()
            if (cancelled) return
            const phase = statusRef.current && statusRef.current.phase
            timer = window.setTimeout(tick, phase === 'ready' ? POLL_READY_MS : POLL_STARTING_MS)
          }
          tick()
          return () => {
            cancelled = true
            if (timer) window.clearTimeout(timer)
          }
        }, [refresh])

        const runAction = React.useCallback(async (action, extra) => {
          setBusy(action)
          setActionError(null)
          try {
            const response = await fetch(actionUrl(), {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ action, ...(extra || {}) }),
            })
            if (!response.ok) {
              let detail = `HTTP ${response.status}`
              try {
                const data = await response.json()
                if (data && data.error) detail = data.error
              } catch {}
              throw new Error(detail)
            }
            const data = await response.json()
            if (data && data.phase) setStatus(data)
            await refresh()
          } catch (error) {
            setActionError(error && error.message ? error.message : String(error))
          } finally {
            setBusy(null)
          }
        }, [refresh])

        const phase = status && status.phase ? status.phase : (statusError ? 'error' : 'idle')
        // 「运行中」 follows the live phase; a starting/restarting stack counts as
        // wanted-on so the switch does not flip back while it boots.
        const running = phase === 'ready' || phase === 'starting'
        const autoStart = status ? status.autoStart === true : false
        const canToggle = status !== null && phase !== 'disabled'
        const disabled = busy !== null || !canToggle

        const switchEl = (on, onToggle, labelOn, labelOff, key) => h('div', { className: 'dsh-ls2a-set-row-side' },
          h('span', { className: 'dsh-ls2a-switch-label' }, on ? labelOn : labelOff),
          h('button', {
            key,
            type: 'button',
            className: 'dsh-ls2a-switch',
            'data-on': on ? 'true' : 'false',
            disabled,
            role: 'switch',
            'aria-checked': on ? 'true' : 'false',
            onClick: onToggle,
          }))

        return h(React.Fragment, null,
          h('style', null, CSS),
          h('div', { className: 'dsh-ls2a-set' },
            h('div', { className: 'dsh-ls2a-set-desc' }, t('settings.desc')),

            h('div', { className: 'dsh-ls2a-set-row' },
              h('div', { className: 'dsh-ls2a-set-row-main' },
                h('div', { className: 'dsh-ls2a-set-row-title' }, t('settings.run')),
                h('div', { className: 'dsh-ls2a-set-row-desc' }, t('settings.runDesc')),
                statusError ? h('div', { className: 'dsh-ls2a-set-err' }, `${t('error.statusUnavailable')} (${statusError})`) : null,
                actionError ? h('div', { className: 'dsh-ls2a-set-err' }, `${t('error.actionFailed')} ${actionError}`) : null),
              switchEl(running, () => runAction('set-runtime', { on: !running }), t('settings.runOn'), t('settings.runOff'), 'run')),

            h('div', { className: 'dsh-ls2a-set-row' },
              h('div', { className: 'dsh-ls2a-set-row-main' },
                h('div', { className: 'dsh-ls2a-set-row-title' }, t('settings.autoStart')),
                h('div', { className: 'dsh-ls2a-set-row-desc' }, t('settings.autoStartDesc'))),
              switchEl(autoStart, () => runAction('set-auto-start', { on: !autoStart }), t('settings.autoStartOn'), t('settings.autoStartOff'), 'auto')),

            h('div', { className: 'dsh-ls2a-set-meta' },
              h('span', { className: 'dsh-ls2a-set-state' },
                h('span', { className: 'dsh-ls2a-dot', 'data-phase': phase }),
                h('span', null, `${t('settings.state')}：${phaseLabel(t, phase)}`)),
              busy ? h('span', null, t('settings.busy')) : null,
              status && status.sub2apiPort ? h('span', null, `${t('settings.port')} ${status.sub2apiPort}`) : null,
              status && status.proxyPort ? h('span', null, `${t('settings.proxy')} ${status.proxyPort}`) : null),
            status && status.error ? h('div', { className: 'dsh-ls2a-error' }, status.error) : null,
            status && status.hint ? h('div', { className: 'dsh-ls2a-hint' }, status.hint) : null))
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en: DICT.en, zh: DICT.zh }), 'local-sub2api: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'local-sub2api',
          order: 15,
          label: () => t('title'),
          locale: NS,
        }, (props) => h(Glyph, { size: typeof props.size === 'number' ? props.size : 18 })))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'local-sub2api',
          locale: NS,
        }, createPanel(t)))

        // Settings → 本地 Sub2api：the two switches the user asked for.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'local-sub2api',
          order: 36,
          label: () => t('settings.title'),
          locale: NS,
        }, createSettingsSection(t)))
      },
    }
  },
})
