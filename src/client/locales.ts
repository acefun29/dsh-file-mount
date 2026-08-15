/** `file-mount` namespace dictionaries (view tab label + list strings). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'file-mount'

/** The file-mount dictionary key set (the source of truth for both locales). */
export type FileMountKey =
  | 'view.fileMount'
  | 'list.empty'
  | 'list.hash'
  | 'list.lines'
  | 'list.searchPlaceholder'
  | 'list.sortNet'
  | 'list.sortPath'
  | 'tier.label'
  | 'tier.hint'
  | 'tier.lenient'
  | 'tier.standard'
  | 'tier.sensitive'
  | 'tier.aggressive'
  | 'kind.new'
  | 'kind.increment'
  | 'kind.remount'
  | 'kind.dedup'
  | 'summary.netTotal'
  | 'summary.cny'
  | 'row.net'
  | 'row.changed'
  | 'freshness.fresh'
  | 'freshness.ok'
  | 'freshness.warn'
  | 'freshness.expired'
  | 'freshness.unknown'
  | 'freshness.expiredBadge'
  | 'freshness.expiredTitle'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The mounted-files view tab label and list strings. */
    'file-mount': FileMountKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<FileMountKey, string> = {
  'view.fileMount': '挂载文件',
  'list.empty': '尚无文件挂载：模型读取文件后，这里会显示已进入上下文的行范围。若一直为空，可能是插件未启用或当前环境不兼容。',
  'list.hash': '指纹',
  'list.lines': '行',
  'list.searchPlaceholder': '搜索路径…',
  'list.sortNet': '按净节省排序',
  'list.sortPath': '按路径排序',
  'tier.label': '新鲜度阈值',
  'tier.hint': '新鲜度阈值（得分低于此值视为过期重读）：宽松(0.2) / 标准(0.3) / 敏感(0.4) / 激进(0.5)',
  'tier.lenient': '宽松',
  'tier.standard': '标准',
  'tier.sensitive': '敏感',
  'tier.aggressive': '激进',
  'kind.new': '新挂载',
  'kind.increment': '增量',
  'kind.remount': '重挂载',
  'kind.dedup': '去重',
  'summary.netTotal': '本次会话净节省 ≈ {n} tokens',
  'summary.cny': '（约 ¥{n}）',
  'row.net': '净节省 ≈ {n} tokens',
  'row.changed': '文件已变更，已重挂',
  'freshness.fresh': '新鲜',
  'freshness.ok': '一般',
  'freshness.warn': '接近过期',
  'freshness.expired': '已过期',
  'freshness.unknown': '未知',
  'freshness.expiredBadge': '过期 ×{n}',
  'freshness.expiredTitle': '该段已过期过 N 次；重新读取后恢复新鲜，历史计数保留',
}

/** English dictionary. */
export const en: Record<FileMountKey, string> = {
  'view.fileMount': 'Mounted Files',
  'list.empty': 'Nothing mounted yet: when the model reads a file, the line ranges already in context show up here. If it stays empty, the plugin may be disabled or incompatible with this DSH build.',
  'list.hash': 'hash',
  'list.lines': 'lines',
  'list.searchPlaceholder': 'Search paths…',
  'list.sortNet': 'Sort by net savings',
  'list.sortPath': 'Sort by path',
  'tier.label': 'Freshness threshold',
  'tier.hint': 'Freshness threshold (scores below this expire and re-read): Lenient(0.2) / Standard(0.3) / Sensitive(0.4) / Aggressive(0.5)',
  'tier.lenient': 'Lenient',
  'tier.standard': 'Standard',
  'tier.sensitive': 'Sensitive',
  'tier.aggressive': 'Aggressive',
  'kind.new': 'new',
  'kind.increment': 'increment',
  'kind.remount': 'remount',
  'kind.dedup': 'dedup',
  'summary.netTotal': 'Net saved this session ≈ {n} tokens',
  'summary.cny': '(≈ ¥{n})',
  'row.net': 'net ≈ {n} tokens',
  'row.changed': 'changed, remounted',
  'freshness.fresh': 'fresh',
  'freshness.ok': 'aging',
  'freshness.warn': 'stale',
  'freshness.expired': 'expired',
  'freshness.unknown': 'unknown',
  'freshness.expiredBadge': 'expired ×{n}',
  'freshness.expiredTitle': 'This segment expired N times; a re-read refreshes it but keeps the count',
}