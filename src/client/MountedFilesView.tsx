/** Mounted-files dashboard: progress bars, search, sort, net savings + a rough
 * CNY figure (plan items 16 + 17), matching the DSH tab styling. */

import { useMemo, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { foldMounts } from './mounted-files.ts'
import { formatRange } from '../render.ts'
import css from './MountedFilesView.module.css'

export type MountedFilesViewProps = ConvViewProps & PropsLocale<'file-mount'>

/** Rough conversion for the savings figure: yuan per one million tokens. */
const CNY_PER_MILLION_TOKENS = 1

function mountedLines(mount: { ranges: { start: number; end: number }[] }): number {
  return mount.ranges.reduce((n, range) => n + (range.end - range.start + 1), 0)
}

/**
 * Pure reader over the conversation snapshot: fold the injected mount
 * messages once per snapshot revision, then render one dashboard row per
 * file with a progress bar, search, and sorting.
 * @param props - slot standard kit (useSession) plus the view locale seat.
 * @returns the mounted-files dashboard, or the localized empty hint.
 */
export function MountedFilesView({ useSession, t }: MountedFilesViewProps) {
  const nodes = useSession((snapshot) => snapshot.nodes)
  const mounts = useMemo(() => foldMounts(nodes), [nodes])
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<'net' | 'path'>('net')

  const netTotal = useMemo(
    () => mounts.reduce((total, mount) => total + mount.savedTokens - mount.spentTokens, 0),
    [mounts],
  )

  if (mounts.length === 0) {
    return (
      <div className={css.root}>
        <div className={css.empty} data-mount-empty>{t('list.empty')}</div>
      </div>
    )
  }

  const filter = query.trim().toLowerCase()
  const visible = mounts
    .filter((mount) => filter.length === 0 || mount.path.toLowerCase().includes(filter))
    .sort((a, b) => sortBy === 'path'
      ? a.path.localeCompare(b.path)
      : (b.savedTokens - b.spentTokens) - (a.savedTokens - a.spentTokens))
  const cny = (netTotal / 1_000_000) * CNY_PER_MILLION_TOKENS

  return (
    <div className={css.root} data-mount-list>
      <div className={css.summary} data-mount-summary>
        <span data-mount-net-total>{t('summary.netTotal').replace('{n}', String(netTotal))}</span>
        <span className={css.cny} data-mount-cny>{t('summary.cny').replace('{n}', cny.toFixed(2))}</span>
      </div>
      <div className={css.toolbar}>
        <input
          className={css.search}
          data-mount-search
          type="search"
          placeholder={t('list.searchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className={css.sort}
          data-mount-sort
          value={sortBy}
          onChange={(event) => setSortBy(event.target.value as 'net' | 'path')}
        >
          <option value="net">{t('list.sortNet')}</option>
          <option value="path">{t('list.sortPath')}</option>
        </select>
      </div>
      {visible.map((mount) => {
        const lines = mountedLines(mount)
        const pct = mount.totalLines > 0 ? Math.min(100, Math.round((lines / mount.totalLines) * 100)) : 0
        return (
          <div key={mount.path} className={css.row} data-mount-row data-mount-kind={mount.mountKind}>
            <div className={css.path} title={mount.path}>{mount.path}</div>
            <div className={css.progress} data-mount-progress role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className={css.progressFill} style={{ width: `${pct}%` }} />
            </div>
            <div className={css.meta}>
              <span className={css.badge} data-mount-badge>{t(`kind.${mount.mountKind}`)}</span>
              <span className={css.ranges} data-mount-ranges>
                {mount.ranges.map((range) => formatRange(range.start, range.end)).join(', ')}
              </span>
              <span className={css.hash} data-mount-hash>{t('list.hash')} {mount.hash.slice(0, 8)}</span>
              <span className={css.lines} data-mount-lines>{lines}/{mount.totalLines} {t('list.lines')}</span>
              <span className={css.saved} data-mount-net>{t('row.net').replace('{n}', String(mount.savedTokens - mount.spentTokens))}</span>
              {mount.mountKind === 'remount' && (
                <span className={css.changed} data-mount-changed>{t('row.changed')}</span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
