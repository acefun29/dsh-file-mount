/** Mounted-files view: the live ledger as a plain list (DSH tab styling). */

import { useMemo } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { foldMounts } from './mounted-files.ts'
import { formatRange } from '../render.ts'
import css from './MountedFilesView.module.css'

export type MountedFilesViewProps = ConvViewProps & PropsLocale<'file-mount'>

/**
 * Pure reader over the conversation snapshot: fold the injected mount
 * messages once per snapshot revision, then render one row per file.
 * @param props - slot standard kit (useSession) plus the view locale seat.
 * @returns the mounted-files list, or the localized empty hint.
 */
export function MountedFilesView({ useSession, t }: MountedFilesViewProps) {
  const nodes = useSession((snapshot) => snapshot.nodes)
  const mounts = useMemo(() => foldMounts(nodes), [nodes])
  const savedTotal = useMemo(
    () => mounts.reduce((total, mount) => total + mount.savedTokens, 0),
    [mounts],
  )
  if (mounts.length === 0) {
    return (
      <div className={css.root}>
        <div className={css.empty} data-mount-empty>{t('list.empty')}</div>
      </div>
    )
  }
  return (
    <div className={css.root} data-mount-list>
      <div className={css.summary} data-mount-summary>
        {t('summary.savedTotal').replace('{n}', String(savedTotal))}
      </div>
      {mounts.map((mount) => (
        <div key={mount.path} className={css.row} data-mount-row data-mount-kind={mount.mountKind}>
          <div className={css.path} title={mount.path}>{mount.path}</div>
          <div className={css.meta}>
            <span className={css.badge} data-mount-badge>{t(`kind.${mount.mountKind}`)}</span>
            <span className={css.ranges} data-mount-ranges>
              {mount.ranges.map((range) => formatRange(range.start, range.end)).join(', ')}
            </span>
            <span className={css.hash} data-mount-hash>{t('list.hash')} {mount.hash.slice(0, 8)}</span>
            <span className={css.lines} data-mount-lines>{mount.totalLines} {t('list.lines')}</span>
            <span className={css.saved} data-mount-saved>{t('row.saved').replace('{n}', String(mount.savedTokens))}</span>
          </div>
        </div>
      ))}
    </div>
  )
}