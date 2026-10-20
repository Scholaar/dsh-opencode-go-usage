/**
 * Browser half of dsh-opencode-go-usage.
 *
 * Adds one entry to the left sidebar's panel list ("OpenCode Go 用量"). Clicking it
 * opens a floating usage window with the 5-hour, weekly and monthly subscription
 * meters and their reset countdowns. The same body also backs the right-sidebar page
 * so a previously opened tab keeps working.
 *
 * Data comes from a Host route that keeps the API key; the browser never sees it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-usage',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'opencode-go-usage'
    const PANEL_ID = 'opencode-go-usage'
    const ROUTE = '/dsh-opencode-go-usage/usage.json'
    const REFRESH_MS = 60000
    const WINDOWS = ['rolling', 'weekly', 'monthly']

    const DICT = {
      zh: {
        panel: 'OpenCode Go 用量',
        title: 'OpenCode Go 用量',
        subtitle: '订阅用量 · 每分钟自动刷新',
        rolling: '5 小时用量',
        weekly: '每周用量',
        monthly: '每月用量',
        used: '已用',
        resetPrefix: '',
        resetSuffix: '后重置',
        startsOnFirstUse: '首次使用时开始',
        updated: '更新于',
        refresh: '刷新',
        refreshNote: '每分钟自动刷新',
        close: '关闭',
        loading: '正在读取用量…',
        unavailable: '无法读取用量',
        retry: '重试',
        rateLimited: '已达上限',
        stale: '显示上次数据',
        unitDay: ' 天',
        unitHour: ' 小时',
        unitMinute: ' 分',
        unitSecond: ' 秒',
        noKey: '未配置 OpenCode Go API Key（OPENCODE_GO_API_KEY）',
      },
      en: {
        panel: 'OpenCode Go usage',
        title: 'OpenCode Go usage',
        subtitle: 'Subscription usage · refreshes every minute',
        rolling: 'Rolling usage',
        weekly: 'Weekly usage',
        monthly: 'Monthly usage',
        used: 'used',
        resetPrefix: 'Resets in ',
        resetSuffix: '',
        startsOnFirstUse: 'Starts on first use',
        updated: 'Updated',
        refresh: 'Refresh',
        refreshNote: 'Refreshes every minute',
        close: 'Close',
        loading: 'Reading usage…',
        unavailable: 'Usage unavailable',
        retry: 'Retry',
        rateLimited: 'Limit reached',
        stale: 'Showing previous data',
        unitDay: 'd',
        unitHour: 'h',
        unitMinute: 'm',
        unitSecond: 's',
        noKey: 'OpenCode Go API key is not configured (OPENCODE_GO_API_KEY)',
      },
    }

    const TONE = {
      ok: { light: '#0f8a5f', dark: '#4ade80', fill: '#1f9d63' },
      warn: { light: '#a56900', dark: '#f5c451', fill: '#e0a12b' },
      danger: { light: '#c62f35', dark: '#ff7b81', fill: '#e5484d' },
    }

    // Shared visibility of the floating window. It lives on the page window so a second
    // materialization of this bundle cannot orphan the mounted component's listener.
    const OVERLAY_KEY = '__dshOpencodeGoUsageOverlay'

    function overlayStore() {
      const scope = window
      if (!scope[OVERLAY_KEY]) scope[OVERLAY_KEY] = { open: false, anchor: null, listeners: new Set() }
      return scope[OVERLAY_KEY]
    }

    function notifyOverlay() {
      for (const listener of [...overlayStore().listeners]) {
        try {
          listener()
        } catch {
          /* one listener must not break the others */
        }
      }
    }

    function openOverlay(anchor) {
      const store = overlayStore()
      store.open = true
      store.anchor = anchor || null
      notifyOverlay()
    }

    function closeOverlay() {
      const store = overlayStore()
      if (!store.open) return
      store.open = false
      notifyOverlay()
    }

    function pick(dark, tone) {
      const palette = TONE[tone] || TONE.ok
      return dark ? palette.dark : palette.light
    }

    function toneOf(percent) {
      if (percent >= 90) return 'danger'
      if (percent >= 70) return 'warn'
      return 'ok'
    }

    function detectDark() {
      try {
        const probe = document.createElement('div')
        probe.style.position = 'fixed'
        probe.style.left = '-1px'
        probe.style.top = '-1px'
        probe.style.width = '1px'
        probe.style.height = '1px'
        probe.style.visibility = 'hidden'
        probe.style.backgroundColor = 'var(--dsw-alias-bg-base, #ffffff)'
        document.body.appendChild(probe)
        const color = getComputedStyle(probe).backgroundColor
        document.body.removeChild(probe)
        const match = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(color)
        if (!match) return false
        const luminance = 0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3])
        return luminance < 128
      } catch {
        return false
      }
    }

    function formatDuration(t, target, now) {
      const totalSeconds = Math.max(0, Math.round((target - now) / 1000))
      const days = Math.floor(totalSeconds / 86400)
      const hours = Math.floor((totalSeconds % 86400) / 3600)
      const minutes = Math.floor((totalSeconds % 3600) / 60)
      const seconds = totalSeconds % 60
      if (days > 0) return `${days}${t('unitDay')} ${hours}${t('unitHour')}`
      if (hours > 0) return `${hours}${t('unitHour')} ${minutes}${t('unitMinute')}`
      if (minutes > 0) return `${minutes}${t('unitMinute')}`
      return `${seconds}${t('unitSecond')}`
    }

    function formatClock(language, value) {
      try {
        return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
      } catch {
        return ''
      }
    }

    function formatAbsolute(language, iso) {
      try {
        return new Intl.DateTimeFormat(language, {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(iso))
      } catch {
        return iso
      }
    }

    function createStyles(dark) {
      const labelPrimary = 'var(--dsw-alias-label-primary, inherit)'
      const labelSecondary = 'var(--dsw-alias-label-secondary, #4b5563)'
      const labelTertiary = 'var(--dsw-alias-label-tertiary, #8b8f96)'
      const divider = 'var(--dsw-alias-border-l1, rgba(0,0,0,0.06))'
      const cardBorder = 'var(--dsw-alias-border-l2, rgba(0,0,0,0.10))'
      return {
        header: {
          display: 'flex',
          alignItems: 'flex-start',
          gap: '10px',
          marginBottom: '10px',
        },
        headerText: {
          display: 'flex',
          flexDirection: 'column',
          gap: '1px',
          minWidth: 0,
        },
        title: {
          fontSize: '14px',
          fontWeight: 600,
          lineHeight: '20px',
          color: labelPrimary,
          whiteSpace: 'nowrap',
        },
        subtitle: {
          fontSize: '11px',
          lineHeight: '16px',
          color: labelTertiary,
          whiteSpace: 'nowrap',
        },
        actions: {
          marginLeft: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          flex: '0 0 auto',
        },
        iconButton: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '24px',
          height: '24px',
          padding: 0,
          border: 'none',
          borderRadius: '6px',
          background: 'transparent',
          color: labelTertiary,
          cursor: 'pointer',
          fontSize: '13px',
          lineHeight: 1,
          fontFamily: 'inherit',
        },
        row: {
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          padding: '10px 0 11px',
          borderTop: `1px solid ${divider}`,
        },
        rowFirst: {
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          padding: '4px 0 11px',
          borderTop: 'none',
        },
        rowHead: {
          display: 'flex',
          alignItems: 'center',
          gap: '7px',
          minHeight: '18px',
        },
        rowLabel: {
          fontSize: '13px',
          fontWeight: 600,
          lineHeight: '18px',
          color: labelPrimary,
          whiteSpace: 'nowrap',
        },
        badge: {
          display: 'inline-flex',
          alignItems: 'center',
          height: '18px',
          padding: '0 6px',
          borderRadius: '6px',
          fontSize: '11px',
          fontWeight: 600,
          lineHeight: '18px',
          whiteSpace: 'nowrap',
          boxSizing: 'border-box',
        },
        resets: {
          marginLeft: 'auto',
          fontSize: '12px',
          lineHeight: '18px',
          color: labelSecondary,
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
        },
        track: {
          position: 'relative',
          height: '8px',
          borderRadius: '999px',
          background: dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(17, 24, 39, 0.16)',
          overflow: 'hidden',
        },
        fill: {
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          borderRadius: '999px',
          transition: 'width 320ms ease, background-color 200ms ease',
        },
        footer: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          paddingTop: '8px',
          borderTop: `1px solid ${divider}`,
          fontSize: '11px',
          lineHeight: '16px',
          color: labelTertiary,
        },
        error: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginTop: '8px',
          padding: '7px 9px',
          borderRadius: '8px',
          fontSize: '11px',
          lineHeight: '16px',
          color: dark ? '#ffb4b6' : '#b42318',
          background: dark ? 'rgba(229, 72, 77, 0.14)' : 'rgba(229, 72, 77, 0.08)',
        },
        retry: {
          border: 'none',
          background: 'transparent',
          color: dark ? '#fca5a5' : '#b42318',
          fontSize: '11px',
          fontWeight: 600,
          cursor: 'pointer',
          padding: 0,
          textDecoration: 'underline',
          fontFamily: 'inherit',
          flex: '0 0 auto',
        },
        placeholder: {
          padding: '8px 0 12px',
          fontSize: '12px',
          lineHeight: '18px',
          color: labelTertiary,
        },
        page: {
          boxSizing: 'border-box',
          width: '100%',
          height: '100%',
          overflowY: 'auto',
          padding: '18px 20px 24px',
          color: labelPrimary,
          font: 'inherit',
        },
        pageInner: {
          width: '100%',
          maxWidth: '560px',
          margin: '0 auto',
          boxSizing: 'border-box',
          border: `1px solid ${cardBorder}`,
          borderRadius: 'var(--dsw-radius-md, 12px)',
          background: 'var(--dsw-alias-bg-base, transparent)',
          padding: '14px 16px 10px',
        },
        floatingLayer: {
          position: 'fixed',
          inset: 0,
          zIndex: 900,
          background: 'transparent',
        },
        floatingCard: {
          position: 'fixed',
          zIndex: 901,
          width: '360px',
          maxWidth: 'calc(100vw - 24px)',
          boxSizing: 'border-box',
          background: 'var(--dsw-alias-bg-base, #ffffff)',
          border: `1px solid ${cardBorder}`,
          borderRadius: 'var(--dsw-radius-md, 12px)',
          boxShadow: dark ? '0 16px 40px rgba(0, 0, 0, 0.5)' : '0 16px 40px rgba(16, 24, 40, 0.18)',
          padding: '12px 14px 10px',
          color: labelPrimary,
          font: 'inherit',
        },
      }
    }

    function useUsage(enabled) {
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState(null)
      const [pending, setPending] = useState(false)
      const mounted = useRef(true)

      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      const load = useCallback(async (force) => {
        setPending(true)
        try {
          const response = await fetch(force ? `${ROUTE}?refresh=1` : ROUTE, {
            cache: 'no-store',
            headers: { Accept: 'application/json' },
          })
          const body = await response.json().catch(() => null)
          if (!mounted.current) return
          if (body && body.ok && body.usage) {
            setSnapshot(body)
            setError(null)
          } else {
            setError((body && body.error) || { code: 'BAD_RESPONSE', message: 'Invalid usage response' })
          }
        } catch (err) {
          if (!mounted.current) return
          setError({ code: 'NETWORK', message: String((err && err.message) || err) })
        } finally {
          if (mounted.current) setPending(false)
        }
      }, [])

      useEffect(() => {
        if (!enabled) return undefined
        load(false)
        const tick = () => {
          if (!document.hidden) load(false)
        }
        const timer = window.setInterval(tick, REFRESH_MS)
        const onVisibility = () => {
          if (!document.hidden) load(false)
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [enabled, load])

      return { snapshot, error, pending, refresh: () => load(true) }
    }

    function MeterRow(props) {
      const { label, row, now, t, language, styles, dark, first } = props
      const percent = Math.round(Number(row && row.percent) || 0)
      const tone = toneOf(percent)
      const limited = row && row.status === 'rate-limited'
      const target = row && row.resetsAt ? Date.parse(row.resetsAt) : NaN
      const accent = pick(dark, tone)
      return React.createElement(
        'div',
        { style: first ? styles.rowFirst : styles.row },
        React.createElement(
          'div',
          { style: styles.rowHead },
          React.createElement('span', { style: styles.rowLabel }, label),
          React.createElement(
            'span',
            {
              style: {
                ...styles.badge,
                color: accent,
                background: `color-mix(in srgb, ${accent} 12%, transparent)`,
                border: `1px solid color-mix(in srgb, ${accent} 28%, transparent)`,
              },
            },
            `${percent}% ${t('used')}`,
          ),
          React.createElement(
            'span',
            {
              style: styles.resets,
              title: Number.isFinite(target) ? formatAbsolute(language, new Date(target).toISOString()) : undefined,
            },
            limited
              ? t('rateLimited')
              : Number.isFinite(target)
                ? `${t('resetPrefix')}${formatDuration(t, target, now)}${t('resetSuffix')}`
                : t('startsOnFirstUse'),
          ),
        ),
        React.createElement(
          'div',
          { style: styles.track },
          React.createElement('div', {
            style: {
              ...styles.fill,
              width: `${percent}%`,
              backgroundColor: accent,
              opacity: percent === 0 ? 0 : 1,
            },
          }),
        ),
      )
    }

    function UsageBody(props) {
      const { t, language, snapshot, error, pending, refresh, now, styles, dark, showHeader } = props
      const usage = snapshot && snapshot.usage ? snapshot.usage : null
      const rows = [
        { key: 'rolling', label: t('rolling') },
        { key: 'weekly', label: t('weekly') },
        { key: 'monthly', label: t('monthly') },
      ]
      const updated = snapshot && snapshot.fetchedAt
        ? `${t('updated')} ${formatClock(language, snapshot.fetchedAt)}`
        : ''

      return React.createElement(
        React.Fragment,
        null,
        showHeader
          ? React.createElement(
              'div',
              { style: styles.header },
              React.createElement(
                'div',
                { style: styles.headerText },
                React.createElement('span', { style: styles.title }, t('title')),
                React.createElement('span', { style: styles.subtitle }, t('subtitle')),
              ),
              React.createElement(
                'div',
                { style: styles.actions },
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    style: styles.iconButton,
                    title: t('refresh'),
                    'aria-label': t('refresh'),
                    onClick: refresh,
                  },
                  pending ? '…' : '⟳',
                ),
              ),
            )
          : null,
        usage
          ? rows.map((entry, index) =>
              React.createElement(MeterRow, {
                key: entry.key,
                label: entry.label,
                row: usage[entry.key],
                now,
                t,
                language,
                styles,
                dark,
                first: index === 0 && !showHeader,
              }),
            )
          : React.createElement(
              'div',
              { style: styles.placeholder },
              pending ? t('loading') : error && error.code === 'NO_KEY' ? t('noKey') : t('unavailable'),
            ),
        error
          ? React.createElement(
              'div',
              { style: styles.error },
              React.createElement(
                'span',
                null,
                usage
                  ? `${t('stale')} · ${error.code === 'NO_KEY' ? t('noKey') : error.message || error.code}`
                  : `${t('unavailable')} · ${error.code === 'NO_KEY' ? t('noKey') : error.message || error.code}`,
              ),
              React.createElement('button', { type: 'button', style: styles.retry, onClick: refresh }, t('retry')),
            )
          : null,
        React.createElement(
          'div',
          { style: styles.footer },
          updated ? React.createElement('span', null, updated) : null,
          updated ? React.createElement('span', null, '·') : null,
          React.createElement('span', null, t('refreshNote')),
        ),
      )
    }

    function FloatingWindow(props) {
      const { t, language } = props
      const [open, setOpen] = useState(() => overlayStore().open)
      const [now, setNow] = useState(() => Date.now())
      const dark = useMemo(() => detectDark(), [open])
      const styles = useMemo(() => createStyles(dark), [dark])
      const { snapshot, error, pending, refresh } = useUsage(open)

      useEffect(() => {
        const store = overlayStore()
        const listener = () => setOpen(store.open)
        store.listeners.add(listener)
        // Polling fallback: the store lives on the page window, so this stays correct even
        // when the bundle is materialized twice and the listener set is not shared.
        const timer = window.setInterval(() => {
          setOpen((previous) => (store.open === previous ? previous : store.open))
        }, 250)
        return () => {
          store.listeners.delete(listener)
          window.clearInterval(timer)
        }
      }, [])

      useEffect(() => {
        if (!open) return undefined
        setNow(Date.now())
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        const onKeyDown = (event) => {
          if (event.key === 'Escape') closeOverlay()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          window.clearInterval(timer)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      if (!open) return null

      const anchor = overlayStore().anchor
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const cardWidth = 360
      const left = Math.max(12, Math.min((anchor ? anchor.x + 12 : 300), viewportWidth - cardWidth - 12))
      const top = Math.max(12, Math.min(anchor ? anchor.y - 8 : 96, viewportHeight - 320))

      return React.createElement(
        React.Fragment,
        null,
        React.createElement('div', {
          style: styles.floatingLayer,
          onMouseDown: () => closeOverlay(),
        }),
        React.createElement(
          'div',
          {
            style: { ...styles.floatingCard, left: `${left}px`, top: `${top}px` },
            role: 'dialog',
            'aria-label': t('title'),
            'data-opencode-go-usage': 'floating',
            onMouseDown: (event) => event.stopPropagation(),
          },
          React.createElement(UsageBody, {
            t,
            language,
            snapshot,
            error,
            pending,
            refresh,
            now,
            styles,
            dark,
            showHeader: true,
          }),
        ),
      )
    }

    function UsagePage(props) {
      const { t, language } = props
      const [now, setNow] = useState(() => Date.now())
      const dark = useMemo(() => detectDark(), [])
      const styles = useMemo(() => createStyles(dark), [dark])
      const { snapshot, error, pending, refresh } = useUsage(true)

      useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
      }, [])

      return React.createElement(
        'div',
        { style: styles.page, 'data-opencode-go-usage': 'page' },
        React.createElement(
          'div',
          { style: styles.pageInner },
          React.createElement(UsageBody, {
            t,
            language,
            snapshot,
            error,
            pending,
            refresh,
            now,
            styles,
            dark,
            showHeader: true,
          }),
        ),
      )
    }

    function Glyph(props) {
      const size = Number(props && props.size) || 18
      return React.createElement(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        React.createElement('rect', { x: 3, y: 13, width: 4, height: 8, rx: 1.4, fill: 'currentColor', opacity: 0.55 }),
        React.createElement('rect', { x: 10, y: 9, width: 4, height: 12, rx: 1.4, fill: 'currentColor', opacity: 0.8 }),
        React.createElement('rect', { x: 17, y: 4, width: 4, height: 17, rx: 1.4, fill: 'currentColor' }),
      )
    }

    return {
      inject: ['slots', 'locale', 'layout', 'sidebarRightTabs'],
      apply(ctx) {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          const off = ctx.locale.register(NS, DICT)
          if (typeof off === 'function') ctx.effect(() => off)
        }
        const t = ctx.locale && typeof ctx.locale.bind === 'function'
          ? ctx.locale.bind(NS)
          : (key) => {
              const zh = document.documentElement.lang === 'zh' || String(navigator.language || '').startsWith('zh')
              return DICT[zh ? 'zh' : 'en'][key] ?? key
            }
        const language = document.documentElement.lang || String(navigator.language || 'en')

        // Remember the main panel the user came from, so the sidebar row can hand it back.
        let previousPanelId = null
        try {
          const panelInfo = ctx.layout.panelInfo
          const sync = () => {
            const id = panelInfo.getSnapshot().activePanelId
            if (id !== PANEL_ID) previousPanelId = id
          }
          sync()
          const off = panelInfo.subscribe(sync)
          if (typeof off === 'function') ctx.effect(() => off)
        } catch {
          /* the layout service is unavailable */
        }

        const restorePanel = () => {
          try {
            ctx.layout.selectPanel(previousPanelId === undefined ? null : previousPanelId)
          } catch {
            try {
              ctx.layout.selectPanel(null)
            } catch {
              /* nothing left to restore */
            }
          }
        }

        const anchorOfEntry = () => {
          try {
            const node = document.querySelector('[data-opencode-go-usage-entry="true"]')
            if (!node) return null
            const rect = node.getBoundingClientRect()
            return { x: rect.right, y: rect.top }
          } catch {
            return null
          }
        }

        const Launcher = () => {
          useEffect(() => {
            openOverlay(anchorOfEntry())
            restorePanel()
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [])
          return null
        }

        const UsageIcon = (props) =>
          React.createElement(
            'span',
            {
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: Number(props && props.size) || 18,
                height: Number(props && props.size) || 18,
              },
              'data-opencode-go-usage-entry': 'true',
              onMouseDown: (event) => event.stopPropagation(),
              onClick: (event) => {
                event.preventDefault()
                event.stopPropagation()
                const rect = event.currentTarget.getBoundingClientRect()
                openOverlay({ x: rect.right, y: rect.top })
              },
            },
            React.createElement(Glyph, { size: props && props.size }),
          )

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => t('panel'),
              locale: NS,
            },
            UsageIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, Launcher),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: PANEL_ID, order: 40 }, () =>
            React.createElement(FloatingWindow, { t, language }),
          ),
        )

        // Keep the previous right-sidebar page available for layouts that already saved it.
        ctx.effect(() =>
          ctx.sidebarRightTabs.register({
            id: PANEL_ID,
            kind: PANEL_ID,
            priority: 'extension',
            title: () => t('panel'),
            guide: [
              {
                id: 'usage',
                order: 30,
                title: () => t('title'),
                description: () => t('subtitle'),
                icon: Glyph,
              },
            ],
          }),
        )
        ctx.effect(() =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: PANEL_ID },
              () => React.createElement(UsagePage, { t, language }),
            ),
          ),
        )
      },
    }
  },
})
