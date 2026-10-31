/**
 * @dsh-external/dsh-task-notifier-desktop — Desktop (Electron) side.
 *
 * Codex-style task notifications for the DSH Desktop app. The window is served
 * from the shell's privileged `dsh-app://app/` origin, and the Electron session
 * grants non-media permissions (`installMicrophonePermissions()` in the shell:
 * `permission !== "media" → callback(true)`), so the Web Notification API is
 * available and already authorized without any browser site-setting detour.
 *
 * The event logic is deliberately shared with the Web twin of this plugin; this
 * copy differs only where the Desktop environment requires it:
 *
 *   1. **Identity isolation** — package id, locale namespace, slot entry id and
 *      both localStorage keys are distinct, so the two builds can never collide
 *      (duplicate slot ids, shared settings, shared dedup window) even if one
 *      profile ever listed both bundles.
 *   2. **Permission copy** — talks about the Desktop shell / Windows notification
 *      settings instead of browser site settings, and is resolved at render time
 *      so a permission change is reflected without a page reload.
 *   3. **Session titles** — Desktop rows expose `displayTitle`, but a fresh
 *      ("blank") session may not have one yet; the notification falls back to
 *      the session id instead of rendering an empty title.
 *   4. **Window focus on click** — the preload bridge intentionally exposes no
 *      show/restore call, so the renderer-side lever stays `window.focus()`,
 *      which can focus but cannot un-hide a window that the shell hid to the
 *      tray. See the `focusShell()` note: this is a documented limitation, not
 *      a guarantee.
 *   5. **Sound** — `sound` maps onto the toast's `silent` flag, so `false` is a
 *      genuinely quiet toast and `true` uses the OS chime. The WebAudio beep
 *      only runs on the no-system-toast fallback path.
 *
 * Behavior rules (same as the Web twin):
 *   - only notify when the window is not focused (Codex-style)
 *   - per-event dedup (3s window, in-memory + localStorage broadcast)
 *   - notification click focuses the window and opens the owning session
 *   - fallback when permission is unavailable: document.title flash + an
 *     optional short two-tone beep (WebAudio, no asset files)
 */

import React, { useState } from 'react'

const PLUGIN_ID = '@dsh-external/dsh-task-notifier-desktop'
const NS = 'taskNotifierDesktop'
const SETTINGS_KEY = 'dsh-task-notifier-desktop:settings'
const DEDUP_PREFIX = 'dsh-task-notifier-desktop:last'
const DEDUP_WINDOW_MS = 3000
/** Distinct from the Web twin's `task-notifier-toggle`. */
const SLOT_ID = 'task-notifier-toggle-desktop'
/** The Desktop shell's privileged application origin. */
const DESKTOP_ORIGIN_SCHEME = 'dsh-app:'

// -------------------------------------------------------------- settings ---

interface Settings {
  /** Master switch. */
  enabled: boolean
  /** Only notify while the window is not focused (Codex-style). */
  notifyOnlyWhenHidden: boolean
  /** Play a short two-tone beep with the notification. */
  sound: boolean
}

const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  notifyOnlyWhenHidden: true,
  sound: false,
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw === null) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      enabled: parsed.enabled ?? DEFAULT_SETTINGS.enabled,
      notifyOnlyWhenHidden: parsed.notifyOnlyWhenHidden ?? DEFAULT_SETTINGS.notifyOnlyWhenHidden,
      sound: parsed.sound ?? DEFAULT_SETTINGS.sound,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // storage unavailable (private mode): settings stay in-memory for the session
  }
}

// ----------------------------------------------------------- environment ---

const isZh = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language)

/** True inside the Electron shell's `dsh-app://app/` window (never in a browser). */
function isDesktopShell(): boolean {
  try {
    return location.protocol === DESKTOP_ORIGIN_SCHEME
  } catch {
    return false
  }
}

/**
 * Tooltip text for the footer switch, computed at render time so the label
 * tracks the live permission state. Desktop copy points at the OS notification
 * settings because the shell — not a site setting — owns the grant.
 * @returns one short human-readable sentence.
 */
function permissionHint(): string {
  if (typeof Notification === 'undefined') {
    return isZh ? '系统通知：当前环境不支持' : 'System notifications: unsupported here'
  }
  const desktop = isDesktopShell()
  switch (Notification.permission) {
    case 'granted':
      return isZh
        ? `系统通知：已允许${desktop ? '（由桌面应用授予）' : ''}`
        : `System notifications: granted${desktop ? ' (granted by the app)' : ''}`
    case 'denied':
      return isZh
        ? (desktop
          ? '系统通知：已拒绝（请在 Windows 设置 → 系统 → 通知 中允许 DeepSeek Harness）'
          : '系统通知：已拒绝（请在浏览器站点设置中重新允许）')
        : (desktop
          ? 'System notifications: denied (allow DeepSeek Harness in Windows Settings → System → Notifications)'
          : 'System notifications: denied (re-allow it in the browser site settings)')
    default:
      return isZh ? '系统通知：尚未授权（点击后请求）' : 'System notifications: not asked yet (click to ask)'
  }
}

// --------------------------------------------------------------- copy ---

/** Notification body copy (window-language pick, no locale service needed). */
const COPY: Record<'taskDone' | 'taskEnd' | 'question' | 'approval' | 'planReview', string> = isZh
  ? {
    taskDone: '任务已完成',
    taskEnd: '任务已结束',
    question: '需要你回答',
    approval: '等待你的审批',
    'planReview': '计划待评审',
  }
  : {
    taskDone: 'Task finished',
    taskEnd: 'Task finished',
    question: 'Your input is needed',
    approval: 'Approval needed',
    'planReview': 'Plan review requested',
  }

/** Sidebar footer copy, registered into the `taskNotifierDesktop` namespace. */
const zh = {
  'footer.label': '通知已',
  'footer.state.on': '开',
  'footer.state.off': '关',
  'footer.aria': '切换任务通知开关',
}

const en = {
  'footer.label': 'Notifications ',
  'footer.state.on': 'on',
  'footer.state.off': 'off',
  'footer.aria': 'Toggle task notifications',
}

type Translate = (key: string, params?: Record<string, unknown>) => string

// ------------------------------------------------------- structural ctx ---

/** The session-row fields this plugin reads (wide public face, structural). */
interface SummaryLike {
  id: string
  /** Absent on a fresh/blank session row. */
  displayTitle?: string
  running: boolean
  /** Public ownership counts identify the selected main-view Session. */
  retainedBy?: Readonly<Record<string, number>>
  /** Pre-0.2 host "finished while not selected" flag; replaced by completionUnread. */
  completed?: boolean
}

interface SessionsFaceLike {
  list: {
    getSnapshot(): { current?: string | undefined; byId: Record<string, SummaryLike> }
    subscribe(fn: () => void): () => void
  }
}

/**
 * One domain-owned pending interaction as the uiSession service publishes it
 * (the sidebar's own "waiting on you" source).
 */
interface PendingInteractionLike {
  /** Opaque request identity; a replacement request carries a new key. */
  key: string
  /** Presentation discriminator: 'approval' | 'question' | 'plan-review'. */
  kind: string
  /** Session whose UI can answer this interaction. */
  sessionId: string
}

/** Legacy uiSession root observable: every session's pending interaction. */
interface PendingInteractionsLike {
  getSnapshot(): ReadonlyMap<string, PendingInteractionLike>
  subscribe(fn: () => void): () => void
}

/**
 * 0.2.0 `uiSession` root observable (provided by
 * `@deepseek-ai/dsh-client-ui-session`). It unifies the legacy pending map, the
 * running bit, and the sidebar's completion reminder into one row per Session,
 * and exposes at most one highest-precedence pending interaction.
 */
interface SessionStatusObservableLike {
  getSnapshot(): ReadonlyMap<string, SessionStatusLike>
  subscribe(fn: () => void): () => void
}

/** The `uiSession` service face (both generations stay optional). */
interface UiSessionFaceLike {
  /** 0.2.0+: unified per-Session status. */
  sessionStatus?: SessionStatusObservableLike
  /** Pre-0.2 generations: the pending map this plugin originally consumed. */
  pendingInteractions?: PendingInteractionsLike
}

/** Public workspace navigation capability. */
interface UiWorkspaceFaceLike {
  openSession(id: string): void
}

/** Structural client context: effect + slots + locale + sessions + uiSession. */
interface ClientContextLike {
  effect(fn: () => void | (() => void), label?: string): () => void
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(options: {
      name: string
      id?: string
      order?: number
      priority?: number
      locale?: string
      inject?: () => Record<string, unknown>
    }, component: unknown): () => void
  }
  locale: {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  }
  sessions: SessionsFaceLike
  uiSession?: UiSessionFaceLike
  /** Required public navigation service; no private selection fields are read. */
  uiWorkspace: UiWorkspaceFaceLike
}

/** Resolve selection from public Controller ownership, not UI service internals. */
function currentSessionId(ctx: ClientContextLike): string | undefined {
  const snapshot = ctx.sessions.list.getSnapshot()
  return snapshot.current ?? Object.values(snapshot.byId)
    .find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id
}

/**
 * Read each Session's "needs acknowledgement" completion reminder.
 *
 * The legacy host exposed this as the list row's `completed` flag. 0.2.0 dropped
 * that field and publishes `completionUnread` on `uiSession.sessionStatus`
 * instead — the same running→idle edge on a non-selected Session.
 * @param ctx - the browser plugin context.
 * @returns sessionId -> completion reminder flag.
 */
function completionSource(ctx: ClientContextLike): ReadonlyMap<string, boolean> {
  const flags = new Map<string, boolean>()
  const byId = ctx.sessions.list.getSnapshot().byId
  const status = ctx.uiSession?.sessionStatus
  if (status === undefined) {
    for (const id of Object.keys(byId)) flags.set(id, byId[id].completed === true)
    return flags
  }
  for (const [id, row] of status.getSnapshot()) flags.set(id, row.completionUnread)
  return flags
}

/** Display title for a notification, falling back to the session id when absent. */
function sessionTitleOf(row: SummaryLike | undefined, fallbackId: string): string {
  const title = row?.displayTitle?.trim()
  return title !== undefined && title.length > 0 ? title : fallbackId
}

// ------------------------------------------------------------- delivery ---

interface NotifyOpts {
  /** Stack/dedup identity: `<kind>:<sessionId>`. */
  tag: string
  title: string
  body: string
  sessionId: string
}

let flashTimer: number | undefined
let flashedTitle: string | undefined

/** Fallback when system notifications are unavailable: a 5s document.title flash. */
function flashTitle(text: string): void {
  try {
    const base = document.title
    if (flashTimer !== undefined) clearTimeout(flashTimer)
    document.title = text
    flashedTitle = text
    flashTimer = window.setTimeout(() => {
      // Only restore our own flash — never clobber a title another part set meanwhile.
      if (flashedTitle !== undefined && document.title === flashedTitle) document.title = base
      flashedTitle = undefined
      flashTimer = undefined
    }, 5000)
  } catch {
    // title flash is a fallback; never throw into the runtime
  }
}

/**
 * Best-effort attempt to bring the Desktop window forward after a toast click.
 *
 * The preload bridge (`window.dshDesktop`) exposes no window show/restore call —
 * only `browser`, `deviceInfo`, `keyboard.closeWindow`, `shortcuts` and
 * `updates` — and the Electron shell only re-shows the window through
 * `focusPrimaryWindow()`, which is reached from macOS `activate`,
 * `second-instance`, or the `dsh://open` deep link. A `window.hide()`n window is
 * therefore not guaranteed to come back on a toast click, and the renderer
 * cannot show it. `window.focus()` still raises the window when it is merely
 * behind another app, so it stays as the only renderer-side lever.
 */
function focusShell(): void {
  try {
    window.focus()
  } catch {
    // focus is best-effort; never throw into the runtime
  }
}

/** Cross-window dedup stamp: one notification per tag per DEDUP_WINDOW_MS. */
function alreadyNotified(tag: string): boolean {
  const now = Date.now()
  const key = `${DEDUP_PREFIX}:${tag}`
  let last = 0
  try {
    last = Number(localStorage.getItem(key) ?? 0)
  } catch {
    // storage unavailable: fall back to always-notify
  }
  if (now - last < DEDUP_WINDOW_MS) return true
  try {
    localStorage.setItem(key, String(now))
  } catch {
    // ignore
  }
  return false
}

let audioCtx: AudioContext | undefined

/** Short two-tone alert beep (WebAudio, no assets). Optional setting. */
function beep(): void {
  try {
    const AC = window.AudioContext
    if (AC === undefined) return
    audioCtx ??= new AC()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    const now = audioCtx.currentTime
    for (const [freq, at] of [[660, 0], [880, 0.12]] as const) {
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, now + at)
      gain.gain.exponentialRampToValueAtTime(0.08, now + at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.1)
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.start(now + at)
      osc.stop(now + at + 0.12)
    }
  } catch {
    // audio is strictly optional
  }
}

/** Raise a notification for one event; no-op when gated or deduplicated. */
function notify(
  ctx: ClientContextLike,
  opts: NotifyOpts,
): void {
  const settings = loadSettings()
  if (!settings.enabled) return
  if (alreadyNotified(opts.tag)) return
  // Codex-style gate: the user is assumed to be watching the GUI when the
  // window is focused. Electron keeps `document.hasFocus()` false while the
  // window is hidden to the tray / minimized / behind another app, which is
  // exactly when a toast is wanted.
  if (settings.notifyOnlyWhenHidden && document.hasFocus()) return

  const useSystem = typeof Notification !== 'undefined' && Notification.permission === 'granted'
  if (useSystem) {
    try {
      // Desktop-specific: the OS toast owns the sound, so `sound` maps onto
      // Electron/Chromium's `silent` flag instead of layering the WebAudio beep
      // on top of the system chime (which would double up). `sound: false` is a
      // genuinely quiet toast.
      const n = new Notification(opts.title, {
        body: opts.body,
        tag: opts.tag,
        silent: !settings.sound,
      })
      n.onclick = () => {
        n.close()
        focusShell()
        try {
          ctx.uiWorkspace.openSession(opts.sessionId)
        } catch (error) {
          console.error(`[${PLUGIN_ID}] could not open session on notification click:`, error)
        }
      }
      return
    } catch (error) {
      console.warn(`[${PLUGIN_ID}] system notification failed, falling back to title flash:`, error)
    }
  }
  // No system toast: the title flash and the WebAudio beep are the only
  // signals left, so the beep runs here rather than alongside a toast.
  if (settings.sound) beep()
  flashTitle(`${opts.body} — ${opts.title}`)
}

/** Ask for Notification permission on a user gesture (browsers require one). */
function requestPermissionIfDefault(): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return
  void Notification.requestPermission().catch(() => {})
}

// -------------------------------------------------------------- watcher ---

interface PrevState {
  running: boolean
  completed: boolean
}

/**
 * One row of the `uiSession.sessionStatus` snapshot. The legacy
 * `pendingInteractions` map is gone: the Host publishes a single
 * highest-precedence `pendingInteraction` plus a `completionUnread` reminder
 * per Session.
 */
interface SessionStatusLike {
  running: boolean | undefined
  pendingInteraction: { key: string; kind: string } | undefined
  completionUnread: boolean
}

/**
 * Watch the two runtime sources behind the three event classes:
 *
 *  - non-selected session finished: the sessions list's `completionUnread`
 *    reminder (the exact signal the sidebar's green "done" badge uses; set on
 *    the live running→idle edge of a non-selected session)
 *  - selected session finished: its own running edge (the runtime never marks
 *    the selected session completed)
 *  - session started waiting on the user: a new entry in the uiSession pending
 *    map (question / approval / plan-review)
 */
function startWatcher(ctx: ClientContextLike): () => void {
  const prev = new Map<string, PrevState>()
  // sessionId -> the pending-interaction key already announced (or seeded).
  const seenPending = new Map<string, string>()
  let pendingSeeded = false

  const scan = (): void => {
    try {
      const byId = ctx.sessions.list.getSnapshot().byId
      const current = currentSessionId(ctx)
      const completed = completionSource(ctx)
      for (const id of Object.keys(byId)) {
        const row = byId[id]
        const done = completed.get(id) ?? row.completed === true
        const running = ctx.uiSession?.sessionStatus?.getSnapshot().get(id)?.running ?? row.running
        const last = prev.get(id)
        if (last === undefined) {
          // First observation: seed only — no startup notification spam.
          prev.set(id, { running, completed: done })
          continue
        }
        if (id === current) {
          if (last.running && !running) {
            notify(ctx, {
              tag: `end:${id}`,
              title: sessionTitleOf(row, id),
              body: COPY.taskEnd,
              sessionId: id,
            })
          }
        } else if (!last.completed && done) {
          notify(ctx, {
            tag: `done:${id}`,
            title: sessionTitleOf(row, id),
            body: COPY.taskDone,
            sessionId: id,
          })
        }
        prev.set(id, { running, completed: done })
      }
      for (const id of prev.keys()) {
        if (!(id in byId)) prev.delete(id)
      }
    } catch (error) {
      console.error(`[${PLUGIN_ID}] session scan failed:`, error)
    }
  }

  /**
   * Announce newly published pending interactions. The first pass only seeds:
   * a page load must not replay interactions the user may already be looking at.
   */
  const scanPending = (): void => {
    try {
      const pending = pendingSource(ctx)
      for (const [id, interaction] of pending) {
        if (interaction === undefined) continue
        if (seenPending.get(id) === interaction.key) continue
        seenPending.set(id, interaction.key)
        if (!pendingSeeded) continue
        const body = interaction.kind === 'approval'
          ? COPY.approval
          : interaction.kind === 'plan-review' ? COPY.planReview
            : interaction.kind === 'question' ? COPY.question : undefined
        if (body === undefined) continue
        const title = sessionTitleOf(ctx.sessions.list.getSnapshot().byId[id], id)
        notify(ctx, { tag: `pending:${interaction.kind}:${id}`, title, body, sessionId: id })
      }
      for (const id of [...seenPending.keys()]) {
        if (pending.get(id) === undefined) seenPending.delete(id)
      }
      pendingSeeded = true
    } catch (error) {
      console.error(`[${PLUGIN_ID}] pending-interaction scan failed:`, error)
    }
  }

  scan()
  scanPending()
  const stopSessions = ctx.sessions.list.subscribe(scan)
  const stopPending = subscribePending(ctx, () => {
    // The unified source can publish completion without a list change.
    scan()
    scanPending()
  })
  return () => {
    stopSessions()
    stopPending?.()
    prev.clear()
    seenPending.clear()
  }
}

/**
 * Read the pending interaction of every Session across host generations.
 *
 * 0.2.0 replaced the `pendingInteractions` map with `sessionStatus`, whose rows
 * carry at most one highest-precedence `pendingInteraction`; the older map is
 * still preferred when present so an older host behaves exactly as before.
 * @param ctx - the browser plugin context.
 * @returns sessionId -> pending interaction (rows without one carry undefined).
 */
function pendingSource(
  ctx: ClientContextLike,
): ReadonlyMap<string, { key: string; kind: string } | undefined> {
  const status = ctx.uiSession?.sessionStatus
  if (status !== undefined) {
    const projected = new Map<string, { key: string; kind: string } | undefined>()
    for (const [id, row] of status.getSnapshot()) projected.set(id, row.pendingInteraction)
    return projected
  }
  return ctx.uiSession?.pendingInteractions?.getSnapshot() ?? new Map()
}

/**
 * Subscribe to whichever pending source this host provides.
 * @param ctx - the browser plugin context.
 * @param fn - the rescan callback.
 * @returns the unsubscribe function, or undefined when neither source exists.
 */
function subscribePending(ctx: ClientContextLike, fn: () => void): (() => void) | undefined {
  const status = ctx.uiSession?.sessionStatus
  if (status !== undefined) return status.subscribe(fn)
  return ctx.uiSession?.pendingInteractions?.subscribe(fn)
}

// ------------------------------------------------------- footer toggle ---

interface NotifyToggleProps {
  wide: boolean
  t: Translate
}

/**
 * Sidebar footer master switch. Reads settings at render so the label always
 * reflects the current state; clicking toggles and (as a user gesture) asks
 * for Notification permission the first time.
 */
function NotifyToggle({ wide, t }: NotifyToggleProps) {
  const [rev, setRev] = useState(0)
  const settings = loadSettings()
  const toggle = (): void => {
    const next = { ...settings, enabled: !settings.enabled }
    saveSettings(next)
    if (next.enabled) requestPermissionIfDefault()
    setRev(rev + 1)
  }
  const enabled = settings.enabled
  const stateText = t(enabled ? 'footer.state.on' : 'footer.state.off')
  // The state character itself carries the signal: green for on, red for off.
  const stateStyle: React.CSSProperties = {
    color: enabled ? '#4caf50' : '#e57373',
    fontWeight: 600,
  }
  return React.createElement(
    'button',
    {
      type: 'button',
      onClick: (event: { preventDefault: () => void; stopPropagation: () => void }) => {
        event.preventDefault()
        event.stopPropagation()
        toggle()
      },
      title: t('footer.aria') + (wide ? ` — ${permissionHint()}` : ''),
      'aria-label': t('footer.aria'),
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        width: '100%',
        minHeight: 28,
        padding: wide ? '6px 10px' : '0',
        border: '1px solid var(--dsw-alias-border, rgba(127, 127, 127, 0.25))',
        borderRadius: '8px',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
    },
    wide
      ? React.createElement(
        'span',
        null,
        t('footer.label'),
        React.createElement('span', { style: stateStyle }, stateText),
      )
      : React.createElement('span', { style: stateStyle }, stateText),
  )
}

// ----------------------------------------------------------- host glue ---

/**
 * Hide DSH's session-list bottom fade.
 *
 * `@deepseek-ai/dsh-client-ui-workspace` paints a 24px overlay at the bottom of
 * the session list:
 *
 *   .<hash>_fade { position:absolute; bottom:0; pointer-events:none;
 *     background:linear-gradient(to bottom, transparent, var(--dsw-specific-sidebar-fill)); }
 *
 * In the stock opaque theme that colour IS the sidebar's own background, so the
 * overlay is invisible. With a translucent/wallpaper theme (Oh My DSH here) the
 * sidebar paints something else while the fade still ends in the dark opaque
 * fill, so it renders as a black smear directly above this plugin's footer
 * switch — which is exactly where the user reported "黑色淡化".
 *
 * The overlay is host chrome whose class is a build-hashed CSS-module name, so
 * match it by its local-name suffix: `…_fade` is the list fade, while the chat
 * transcript uses `…_fadeTop` / `…_fadeBottom` and attachments use `…_fade-in`,
 * none of which end in `_fade`. The element is absolutely positioned, so hiding
 * it cannot move anything — the only effect is that scrolled rows stop being
 * masked at the list's bottom edge. If a future DSH build renames the class the
 * rule simply stops matching and the fade returns; nothing breaks.
 *
 * Remove this function + its `ctx.effect(...)` call in `apply()` to restore the
 * host's stock behaviour.
 */
const FADE_OVERRIDE_TAG = 'dsh-task-notifier-desktop:session-list-fade'
const FADE_OVERRIDE_CSS = '[class$="_fade"]{display:none !important}'

function suppressSessionListFade(): () => void {
  try {
    const style = document.createElement('style')
    style.setAttribute('data-plugin-css', FADE_OVERRIDE_TAG)
    style.textContent = FADE_OVERRIDE_CSS
    document.head.appendChild(style)
    return () => {
      style.remove()
    }
  } catch (error) {
    console.warn(`[${PLUGIN_ID}] could not suppress the session-list fade:`, error)
    return () => {}
  }
}

// ------------------------------------------------------------------ apply ---

export const name = PLUGIN_ID
// Navigation now belongs to uiWorkspace; required services gate activation.
export const inject = ['slots', 'locale', 'sessions', 'uiSession', 'uiWorkspace']

export function apply(ctx: ClientContextLike): void {
  console.info(`[${PLUGIN_ID}] active on ${isDesktopShell() ? 'the Desktop shell (dsh-app://)' : 'a web origin'};`
    + ` notifications ${loadSettings().enabled ? 'enabled' : 'disabled'},`
    + ` system permission: ${typeof Notification === 'undefined' ? 'unsupported' : Notification.permission}`)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${PLUGIN_ID}: dictionaries`)
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: SLOT_ID,
    order: 5,
    locale: NS,
  }, NotifyToggle))

  ctx.effect(() => startWatcher(ctx), `${PLUGIN_ID}: session watcher`)

  // The session list's own bottom fade renders as a black smear above this
  // switch under translucent themes; see suppressSessionListFade().
  ctx.effect(() => suppressSessionListFade(), `${PLUGIN_ID}: session-list fade override`)

  // First user gesture anywhere on the page requests permission. In the Desktop
  // shell non-media permissions are granted by the Electron session, so this
  // resolves immediately; in a browser it satisfies the gesture requirement.
  ctx.effect(() => {
    const request = (): void => {
      cleanup()
      requestPermissionIfDefault()
    }
    const cleanup = (): void => {
      window.removeEventListener('pointerdown', request, true)
      window.removeEventListener('keydown', request, true)
    }
    window.addEventListener('pointerdown', request, true)
    window.addEventListener('keydown', request, true)
    return cleanup
  }, `${PLUGIN_ID}: notification permission request`)
}