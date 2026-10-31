// Offline behavior tests for the Desktop twin's client bundle.
//
// The bundle is a lazy CJS factory registered on `window.__ModuleLoader__`; this
// loads it in a sandbox with fake Notification/localStorage/window/document
// hosts, then drives the two runtime sources it watches. No real notification,
// network request, or DSH host is involved.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

const BUNDLE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function observable(value) {
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) { value = next; for (const fn of listeners) fn() },
    listeners,
  }
}

/**
 * Load the bundle and apply it to a structural client context.
 * @param options.protocol - page origin protocol (desktop shell vs browser).
 * @param options.permission - fake `Notification.permission`.
 * @param options.focused - fake `document.hasFocus()`.
 */
function fixture({ protocol = 'dsh-app:', permission = 'granted', focused = false } = {}) {
  const notifications = []
  const opens = []
  const errors = []
  const effects = []
  const storage = new Map()
  const storageReads = []
  const storageWrites = []
  const injectedStyles = []
  const slotRegistrations = []
  const localeRegistrations = []
  let plugin
  class FakeNotification {
    static permission = permission
    static requestPermission() { return Promise.resolve(permission) }
    constructor(title, options) { Object.assign(this, { title, ...options }); notifications.push(this) }
    close() {}
  }
  // A minimal React stand-in: enough for the footer component to render into plain
  // objects, so the UI contract can be asserted without a DOM.
  // Note: tsdown wraps this with `__toESM(react, 1)`, whose `default` export is
  // the stub object itself — so `createElement` must sit on the stub, not on a
  // nested `default`.
  const react = {
    useState: initial => [initial, () => {}],
    // Mirrors React: a single child lands on `props.children`, several stay an array.
    createElement: (type, props, ...children) => ({
      type,
      props: { ...props, children: children.length <= 1 ? children[0] : children },
      children,
    }),
  }
  const window = {
    __ModuleLoader__: { load: row => { plugin = row.factory(id => { assert.equal(id, 'react'); return react }) } },
    focus() { window.focusedByClick = true },
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: handle => clearTimeout(handle),
  }
  const document = {
    hasFocus: () => focused,
    title: 'DSH',
    head: { appendChild: element => injectedStyles.push(element) },
    createElement: tag => ({
      tag,
      attrs: {},
      textContent: '',
      removed: false,
      setAttribute(name, value) { this.attrs[name] = value },
      remove() { this.removed = true },
    }),
  }
  runInNewContext(BUNDLE, {
    window,
    Notification: FakeNotification,
    document,
    navigator: { language: 'en' },
    localStorage: {
      getItem: key => { storageReads.push(key); return storage.get(key) ?? null },
      setItem: (key, value) => { storageWrites.push(key); storage.set(key, value) },
    },
    location: { protocol },
    console: { info() {}, warn: (...args) => errors.push(args), error: (...args) => errors.push(args) },
  })
  assert.ok(plugin, 'bundle registered a module factory')

  const list = observable({
    byId: {
      main: { id: 'main', displayTitle: 'Main', running: true, retainedBy: { mainView: 1 } },
      other: { id: 'other', displayTitle: 'Other', running: true, retainedBy: {} },
    },
  })
  const status = observable(new Map([
    ['main', { running: true, completionUnread: false }],
    ['other', { running: true, completionUnread: false }],
  ]))
  const ctx = {
    sessions: { list },
    uiSession: { sessionStatus: status },
    uiWorkspace: { openSession: id => opens.push(id) },
    locale: { register: (ns, dicts) => { localeRegistrations.push({ ns, dicts }); return () => {} } },
    effect: fn => { const off = fn(); if (off) effects.push(off); return off },
    slots: {
      inject: (_name, fn) => { const off = fn(); effects.push(off); return off },
      register: (options, component) => { slotRegistrations.push({ ...options, component }); return () => {} },
    },
  }
  plugin.apply(ctx)
  return {
    plugin, notifications, opens, errors, list, status, storage, document, window,
    slotRegistrations, localeRegistrations, storageReads, storageWrites, injectedStyles,
    dispose: () => effects.reverse().forEach(off => off()),
  }
}

// The Web twin's settings/dedup keys, used as negative controls.
const WEB_SETTINGS_KEY = 'dsh-task-notifier:settings'
const WEB_DEDUP_PREFIX = 'dsh-task-notifier:last'

test('identities are isolated from the Web twin', () => {
  const f = fixture()
  // Slots and dictionaries.
  assert.deepEqual(f.localeRegistrations.map(r => r.ns), ['taskNotifierDesktop'])
  assert.deepEqual(f.slotRegistrations.map(r => r.id), ['task-notifier-toggle-desktop'])
  assert.equal(f.slotRegistrations[0].locale, 'taskNotifierDesktop')
  assert.equal(f.slotRegistrations[0].name, 'sidebar.footer.action')
  // Settings live under the Desktop twin's own key.
  assert.ok(f.storageReads.includes('dsh-task-notifier-desktop:settings'))
  assert.ok(!f.storageReads.includes(WEB_SETTINGS_KEY), 'must not read the Web twin settings')
  // Dedup stamps live under the Desktop twin's own prefix.
  f.status.set(new Map([
    ['main', { running: false, completionUnread: false }],
    ['other', { running: false, completionUnread: true }],
  ]))
  const written = f.storageWrites.filter(key => key.includes(':last:'))
  assert.deepEqual(written.sort(), [
    'dsh-task-notifier-desktop:last:done:other',
    'dsh-task-notifier-desktop:last:end:main',
  ])
  assert.ok(written.every(key => !key.startsWith(WEB_DEDUP_PREFIX)), 'must not write the Web twin dedup keys')
  f.dispose()
})

test('the module declares its isolated identity and the full service gate', () => {
  const f = fixture()
  assert.equal(f.plugin.name, '@dsh-external/dsh-task-notifier-desktop')
  // cordis only calls apply() once every injected service exists, so a renamed
  // or missing service is a silent total failure. Pin the list here.
  // (Spread into a host-realm array: the bundle's array has the VM's prototype.)
  assert.deepEqual([...f.plugin.inject], ['slots', 'locale', 'sessions', 'uiSession', 'uiWorkspace'])
  f.dispose()
})

test('the sound setting maps onto the toast silent flag', () => {
  // sound omitted (default false) → a genuinely quiet toast.
  const quiet = fixture()
  quiet.status.set(new Map([['other', { running: false, completionUnread: true }]]))
  assert.equal(quiet.notifications.length, 1)
  assert.equal(quiet.notifications[0].silent, true)
  quiet.dispose()

  // sound true → the OS chime is allowed, and no WebAudio beep is layered on top.
  const loud = fixture()
  loud.storage.set('dsh-task-notifier-desktop:settings', JSON.stringify({ sound: true }))
  loud.status.set(new Map([['other', { running: false, completionUnread: true }]]))
  assert.equal(loud.notifications.length, 1)
  assert.equal(loud.notifications[0].silent, false)
  loud.dispose()
})

test('approval and plan-review interactions carry their own copy', () => {
  const f = fixture()
  f.status.set(new Map([['other', { running: true, completionUnread: false, pendingInteraction: { key: 'a1', kind: 'approval' } }]]))
  f.status.set(new Map([['other', { running: true, completionUnread: false, pendingInteraction: { key: 'p1', kind: 'plan-review' } }]]))
  assert.deepEqual(f.notifications.map(n => n.body), ['Approval needed', 'Plan review requested'])
  assert.deepEqual(f.notifications.map(n => n.tag), ['pending:approval:other', 'pending:plan-review:other'])
  assert.deepEqual(f.errors, [])
  f.dispose()
})

test('the session-list fade override is injected and removed with the plugin', () => {
  const f = fixture()
  assert.equal(f.injectedStyles.length, 1)
  const style = f.injectedStyles[0]
  assert.equal(style.tag, 'style')
  assert.equal(style.attrs['data-plugin-css'], 'dsh-task-notifier-desktop:session-list-fade')
  // Matches the list fade only — the chat transcript's `..._fadeTop` /
  // `..._fadeBottom` and the attachment's `..._fade-in` must not be hit.
  assert.match(style.textContent, /\[class\$="_fade"\]/)
  assert.doesNotMatch(style.textContent, /fadeTop|fadeBottom|fade-in/)
  assert.match(style.textContent, /display:none/)
  f.dispose()
  assert.equal(style.removed, true, 'the override is removed with the plugin fiber')
})

test('the footer switch renders an accessible, toggleable button', () => {
  const f = fixture()
  const render = settings => {
    if (settings !== undefined) {
      f.storage.set('dsh-task-notifier-desktop:settings', JSON.stringify(settings))
    }
    return f.slotRegistrations[0].component({ wide: true, t: key => key })
  }

  const on = render()
  assert.equal(on.type, 'button')
  assert.equal(on.props['aria-label'], 'footer.aria')
  assert.equal(typeof on.props.onClick, 'function')
  const onLabel = on.children[0]
  assert.equal(onLabel.type, 'span')
  assert.equal(onLabel.children[1].props.children, 'footer.state.on')

  const off = render({ enabled: false })
  assert.equal(off.children[0].children[1].props.children, 'footer.state.off')
  f.dispose()
})

test('status-only completion signals and notification clicks use current public APIs', () => {
  const f = fixture()
  assert.equal(f.notifications.length, 0, 'startup only seeds the watcher')
  f.status.set(new Map([
    ['main', { running: false, completionUnread: false }],
    ['other', { running: false, completionUnread: true }],
  ]))
  assert.deepEqual(f.notifications.map(n => n.tag).sort(), ['done:other', 'end:main'])
  f.notifications.find(n => n.tag === 'done:other').onclick()
  assert.deepEqual(f.opens, ['other'])
  assert.equal(f.window.focusedByClick, true, 'click focuses the shell window')
  assert.deepEqual(f.errors, [])
  f.dispose()
  assert.equal(f.list.listeners.size, 0)
  assert.equal(f.status.listeners.size, 0)
})

test('cleared unified-status pending rows can publish the same key again', () => {
  const f = fixture()
  const pending = { running: true, completionUnread: false, pendingInteraction: { key: 'q1', kind: 'question' } }
  f.status.set(new Map([['other', pending]]))
  assert.equal(f.notifications.length, 1)
  f.status.set(new Map([['other', { running: true, completionUnread: false }]]))
  f.storage.clear()
  f.status.set(new Map([['other', pending]]))
  assert.equal(f.notifications.length, 2)
  f.dispose()
})

test('the Desktop shell origin delivers a system notification, never a title flash', () => {
  const f = fixture({ protocol: 'dsh-app:' })
  f.status.set(new Map([
    ['main', { running: false, completionUnread: false }],
    ['other', { running: false, completionUnread: true }],
  ]))
  // Both edges fire: the selected session ends, the background one has unread completion.
  assert.deepEqual(f.notifications.map(n => n.tag).sort(), ['done:other', 'end:main'])
  assert.equal(f.document.title, 'DSH', 'document.title is left untouched when a toast is shown')
  f.dispose()
})

test('a blank Desktop session row falls back to the session id as the title', () => {
  const f = fixture()
  // A fresh ("blank") session has no displayTitle yet.
  f.list.set({ byId: { blank: { id: 'blank', running: true, retainedBy: {} } } })
  f.status.set(new Map([['blank', { running: false, completionUnread: true }]]))
  assert.equal(f.notifications.length, 1)
  assert.equal(f.notifications[0].title, 'blank')
  f.dispose()
})

test('the focus gate suppresses toasts while the window is focused', () => {
  const f = fixture({ focused: true })
  f.status.set(new Map([
    ['main', { running: false, completionUnread: false }],
    ['other', { running: false, completionUnread: true }],
  ]))
  assert.equal(f.notifications.length, 0)
  f.dispose()
})

test('denied permission degrades to the title flash instead of throwing', () => {
  const f = fixture({ permission: 'denied' })
  f.status.set(new Map([
    ['main', { running: false, completionUnread: false }],
    ['other', { running: false, completionUnread: true }],
  ]))
  assert.equal(f.notifications.length, 0)
  assert.match(f.document.title, /Task finished/)
  assert.deepEqual(f.errors, [])
  f.dispose()
})