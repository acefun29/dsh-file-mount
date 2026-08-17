/**
 * Browser half of dsh-file-mount: contributes the Mounted Files tab to the
 * conversation view ring. The trajectory tab and the conversation context
 * rows need no code here — the harness projects the plugin-injected
 * messages onto them from their standard sources.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MountedFilesView } from './MountedFilesView.tsx'
import { en, NS, zh } from './locales.ts'

/** Required services: the slot registry and the locale service. */
export const inject = ['slots', 'locale']

/** Client plugin name (bundle diagnostics). */
export const name = 'file-mount-ui'

/**
 * Register the Mounted Files tab. The registration rides the slot
 * service's effect wrapper, so plugin unload removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'file-mount-ui: dictionaries')
  // Registration-time text (the tab label) reads through the bound
  // translate as a thunk, so it follows the active locale.
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'file-mount',
    order: 20,
    locale: NS,
    label: () => t('view.fileMount'),
  }, MountedFilesView))
}
