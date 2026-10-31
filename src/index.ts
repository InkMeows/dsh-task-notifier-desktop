/**
 * @dsh-external/dsh-task-notifier-desktop — host entry.
 *
 * Desktop twin of the Web task-notifier package. This plugin is browser-only:
 * the client half watches the session runtime and raises system notifications
 * (Web Notification API, delivered as OS toasts by the Electron shell) when a
 * task finishes or the model asks for user input. The host entry exists so the
 * package is a normal DSH bundle and can be built and installed through the
 * standard profile pipeline.
 */

import z from '@deepseek-ai/schemastery'

/**
 * This plugin is browser-only and the host entry is a no-op, so we deliberately
 * avoid importing `Context` from `cordis`: the standalone build compiles against
 * the public npm package, while DSH ships its own compatible fork at runtime.
 */
type ContextLike = unknown

export const name = '@dsh-external/dsh-task-notifier-desktop'
export const inject = []

export interface Config {
  /** Master switch. Client-side defaults are mirrored in localStorage. */
  enabled?: boolean
  /** Only notify while the window is not focused (Codex-style). */
  notifyOnlyWhenHidden?: boolean
  /** Play a short alert sound with the notification. */
  sound?: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  notifyOnlyWhenHidden: z.boolean().default(true),
  sound: z.boolean().default(false),
})

export function apply(_ctx: ContextLike, _config: Config): void {}