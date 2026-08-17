/** Mounted-files dashboard: coverage map, search, sort, net savings + a rough
 * CNY figure (plan items 16 + 17), matching the DSH tab styling. */

import { useMemo, useRef, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  MountFold,
  freshnessLevel,
  worstFreshness,
} from './mounted-files.ts'
import { formatRange } from '../render.ts'
import css from './MountedFilesView.module.css'

export type MountedFilesViewProps = ConvViewProps & PropsLocale<'file-mount'>

/** Rough conversion for the savings figure: yuan per one million tokens. */
const CNY_PER_MILLION_TOKENS = 1

function mountedLines(mount: { ranges: { start: number; end: number }[] }): number {
  return mount.ranges.reduce((n, range) => n + (range.end - range.start + 1), 0)
}

function splitPath(path: string): { dir: string; name: string } {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (i < 0) return { dir: '', name: path }
  return { dir: path.slice(0, i), name: path.slice(i + 1) }
}

/** Map a freshness level to its locale key (typed lookup). */
const LEVEL_KEYS = {
  fresh: 'freshness.fresh',
  ok: 'freshness.ok',
  warn: 'freshness.warn',
  expired: 'freshness.expired',
  unknown: 'freshness.unknown',
} as const

function levelKey(level: keyof typeof LEVEL_KEYS) {
  return LEVEL_KEYS[level]
}

/**
 * Dashboard over the conversation snapshot: fold the injected mount messages
 * through a persistent {@link MountFold} (one per view instance), so mounts
 * whose messages scroll out of the client's paginated history window stay on
 * the dashboard, then render one row per file with a coverage map, search,
 * and sorting. The fold resets when the conversation (sessionId) changes.
 * @param props - slot standard kit (useSession) plus the view locale seat.
 * @returns the mounted-files dashboard, or the localized empty hint.
 */
export function MountedFilesView({ useSession, t }: MountedFilesViewProps) {
  const sessionId = useSession((snapshot) => snapshot.sessionId)
  const nodes = useSession((snapshot) => snapshot.nodes)
  const foldRef = useRef<MountFold | undefined>(undefined)
  const mounts = useMemo(() => {
    const fold = foldRef.current ?? (foldRef.current = new MountFold())
    return fold.fold(sessionId, nodes)
  }, [sessionId, nodes])
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<'net' | 'path'>('net')
  const [showHelp, setShowHelp] = useState(false)
  // Freshness segment rows are expanded by default; clicking collapses one file.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const foldedThreshold = mounts[0]?.freshnessThreshold ?? 0.6

  const { savedTotal, spentTotal, netTotal } = useMemo(() => {
    let saved = 0
    let spent = 0
    for (const mount of mounts) {
      saved += mount.savedTokens
      spent += mount.spentTokens
    }
    return { savedTotal: saved, spentTotal: spent, netTotal: saved - spent }
  }, [mounts])
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
  const cny = (Math.max(0, netTotal) / 1_000_000) * CNY_PER_MILLION_TOKENS

  const toggle = (path: string) => {
    const next = new Set(collapsed)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setCollapsed(next)
  }

  return (
    <div className={css.root} data-mount-list>
      <div
        className={css.summary + (netTotal > 0 ? ' ' + css.summaryPositive : ' ' + css.summaryNeutral)}
        data-mount-summary
        title={t('summary.breakdown').replace('{saved}', String(savedTotal)).replace('{spent}', String(spentTotal))}
      >
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
        <button
          type="button"
          className={css.tierHelp + (showHelp ? ' ' + css.tierHelpActive : '')}
          onClick={() => setShowHelp(!showHelp)}
          title={t('help.title')}
          aria-label={t('help.title')}
        >
          ?
        </button>
      </div>
      {showHelp && (
        <div className={css.helpCard} data-mount-help-card>
          <div className={css.helpHeader}>
            <span>{t('help.title')}</span>
            <button type="button" className={css.helpClose} onClick={() => setShowHelp(false)}>{t('help.close')}</button>
          </div>
          <div className={css.helpSection}>
            <div className={css.helpSectionTitle}>{t('help.modelTitle')}</div>
            <div className={css.helpSectionDesc}>{t('help.modelDesc')}</div>
          </div>
          <div className={css.helpSection}>
            <div className={css.helpSectionTitle}>{t('help.savingsTitle')}</div>
            <div className={css.helpSectionDesc}>{t('help.savingsDesc')}</div>
          </div>
        </div>
      )}
      {visible.map((mount) => {
        const lines = mountedLines(mount)
        const pct = mount.totalLines > 0 ? Math.min(100, Math.round((lines / mount.totalLines) * 100)) : 0
        const isCollapsed = collapsed.has(mount.path)
        const levels = mount.ranges.map((seg) => freshnessLevel(seg.born, mount.contextL, foldedThreshold, seg.tokens, { expired: seg.expired }))
        const worst = worstFreshness(levels)
        const netDiff = mount.savedTokens - mount.spentTokens
        const { dir, name } = splitPath(mount.path)
        const coverageTitle = t('row.coverageTitle')
        return (
          <div key={mount.path} className={css.row} data-mount-row data-mount-kind={mount.mountKind}>
            <div
              className={css.pathRow}
              role="button"
              tabIndex={0}
              onClick={() => toggle(mount.path)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  toggle(mount.path)
                }
              }}
            >
              <button
                type="button"
                className={css.expand}
                data-mount-expand
                aria-expanded={!isCollapsed}
                onClick={(event) => {
                  event.stopPropagation()
                  toggle(mount.path)
                }}
              >
                {isCollapsed ? '▸' : '▾'}
              </button>
              <div className={css.pathBlock} title={mount.path}>
                <div className={css.pathName}>{name}</div>
                {dir.length > 0 && <div className={css.pathDir}>{dir}</div>}
              </div>
              <span className={css.freshnessDot + ' ' + (css['freshnessDot_' + worst] ?? '')} data-mount-file-freshness={worst} title={t(levelKey(worst))} />
            </div>
            <div className={css.coverage} title={coverageTitle}>
              <span className={css.coverageLabel} data-mount-lines>
                {t('row.coverage').replace('{n}', String(lines)).replace('{total}', String(mount.totalLines))}
              </span>
              <div
                className={css.coverageTrack}
                data-mount-progress
                role="progressbar"
                aria-label={coverageTitle}
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                {mount.totalLines > 0 && mount.ranges.map((seg, i) => {
                  const left = ((seg.start - 1) / mount.totalLines) * 100
                  const width = ((seg.end - seg.start + 1) / mount.totalLines) * 100
                  return (
                    <span
                      key={i}
                      className={css.coverageSeg}
                      style={{ left: `${left}%`, width: `${Math.max(width, 0.6)}%` }}
                    />
                  )
                })}
              </div>
            </div>
            <div className={css.meta}>
              <span className={css.badge + ' ' + (css['badge_' + mount.mountKind] ?? '')} data-mount-badge>{t(`kind.${mount.mountKind}`)}</span>
              <span className={css.ranges} data-mount-ranges>
                {mount.ranges.map((range) => formatRange(range.start, range.end)).join(', ')}
              </span>
              <span className={css.hash} data-mount-hash title={t('list.hash')}>{mount.hash.slice(0, 8)}</span>
              <span className={css.saved + (netDiff > 0 ? ' ' + css.savedPositive : '')} data-mount-net>
                {t('row.net').replace('{n}', String(netDiff))}
              </span>
              {mount.mountKind === 'remount' && (
                <span className={css.changed} data-mount-changed>{t('row.changed')}</span>
              )}
            </div>
            {!isCollapsed && mount.ranges.length > 0 && (
              <div className={css.segmentsList}>
                {mount.ranges.map((seg, i) => {
                  const level = freshnessLevel(seg.born, mount.contextL, foldedThreshold, seg.tokens, { expired: seg.expired })
                  return (
                    <div key={i} className={css.segment} data-mount-segment data-freshness={level}>
                      <span className={css.segmentBar + ' ' + (css['segmentBar_' + level] ?? '')} />
                      <span className={css.segmentRange}>{formatRange(seg.start, seg.end)}</span>
                      <span className={css.segmentLevel}>{t(levelKey(level))}</span>
                      {seg.expired > 0 && (
                        <span className={css.expiredBadge} data-mount-expired-badge title={t('freshness.expiredTitle')}>
                          {t('freshness.expiredBadge').replace('{n}', String(seg.expired))}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
