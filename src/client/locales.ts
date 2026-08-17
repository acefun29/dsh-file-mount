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
  | 'kind.new'
  | 'kind.increment'
  | 'kind.remount'
  | 'kind.dedup'
  | 'summary.netTotal'
  | 'summary.cny'
  | 'summary.breakdown'
  | 'row.net'
  | 'row.changed'
  | 'row.coverage'
  | 'row.coverageTitle'
  | 'freshness.fresh'
  | 'freshness.ok'
  | 'freshness.warn'
  | 'freshness.expired'
  | 'freshness.unknown'
  | 'freshness.expiredBadge'
  | 'freshness.expiredTitle'
  | 'help.title'
  | 'help.modelTitle'
  | 'help.modelDesc'
  | 'help.savingsTitle'
  | 'help.savingsDesc'
  | 'help.close'

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
  'kind.new': '新挂载',
  'kind.increment': '增量',
  'kind.remount': '重挂载',
  'kind.dedup': '去重',
  'summary.netTotal': '本次会话净节省 ≈ {n} tokens',
  'summary.cny': '（约 ¥{n}）',
  'summary.breakdown': '累计去重节省 {saved} tokens，状态通知开销 {spent} tokens',
  'row.net': '净节省 ≈ {n}',
  'row.changed': '已重挂',
  'row.coverage': '已挂载 {n}/{total}',
  'row.coverageTitle': '色块表示已进入上下文的行在文件中的位置',
  'freshness.fresh': '新鲜',
  'freshness.ok': '一般',
  'freshness.warn': '接近过期',
  'freshness.expired': '已过期',
  'freshness.unknown': '未知',
  'freshness.expiredBadge': '过期 ×{n}',
  'freshness.expiredTitle': '该段已过期过 N 次；重新读取后恢复新鲜，历史计数保留',
  'help.title': '新鲜度与节省机制说明',
  'help.modelTitle': '压力 × 深度新鲜度与安全阀',
  'help.modelDesc': '上下文未到窗口的 95% 时挂载不过期；接近上限后越靠前的内容才会重发，且每段最多重发一次。连续 2 次全覆盖去重触发安全阀放行。找不到上文内容时，先 file_mount_forget 再 read。',
  'help.savingsTitle': '净节省 Token 说明',
  'help.savingsDesc': '净节省 = 去重省下的 Token − 插件状态通知开销；为负时界面显示 0（初次挂载只有纸条开销，还没去重）。多轮对话中一旦触发去重或增量补发，净节省会转为正值。',
  'help.close': '收起说明',
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
  'kind.new': 'new',
  'kind.increment': 'increment',
  'kind.remount': 'remount',
  'kind.dedup': 'dedup',
  'summary.netTotal': 'Net saved this session ≈ {n} tokens',
  'summary.cny': '(≈ ¥{n})',
  'summary.breakdown': 'Dedup saved {saved} tokens, notice overhead {spent} tokens',
  'row.net': 'net ≈ {n}',
  'row.changed': 'remounted',
  'row.coverage': 'mounted {n}/{total}',
  'row.coverageTitle': 'Filled spans show which lines are already in context',
  'freshness.fresh': 'fresh',
  'freshness.ok': 'aging',
  'freshness.warn': 'stale',
  'freshness.expired': 'expired',
  'freshness.unknown': 'unknown',
  'freshness.expiredBadge': 'expired ×{n}',
  'freshness.expiredTitle': 'This segment expired N times; a re-read refreshes it but keeps the count',
  'help.title': 'Freshness & Token Savings Guide',
  'help.modelTitle': 'Pressure × Depth Freshness & Safety Valve',
  'help.modelDesc': 'Mounts stay fresh until the prompt reaches 95% of the window. Near the cap, only deep content is re-sent, and each segment is re-sent at most once. 2 consecutive full dedups trigger the safety valve. If the content is not in the conversation, call file_mount_forget then read again.',
  'help.savingsTitle': 'Net Savings Accounting',
  'help.savingsDesc': 'Net savings = deduplicated tokens − plugin notice overhead; the UI floors negatives at 0 (a first mount has only notice cost, no dedup yet). Once dedup or increment triggers, the figure turns positive.',
  'help.close': 'Close',
}