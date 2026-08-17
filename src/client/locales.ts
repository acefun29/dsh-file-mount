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
  | 'summary.breakdown'
  | 'row.net'
  | 'row.changed'
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
  'tier.label': '新鲜度阈值',
  'tier.hint': '新鲜度阈值（得分低于此值视为过期重读）：宽松(0.45) / 标准(0.55) / 敏感(0.65) / 激进(0.75)',
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
  'summary.breakdown': '累计去重节省 {saved} tokens，状态通知开销 {spent} tokens',
  'row.net': '净节省 ≈ {n} tokens',
  'row.changed': '文件已变更，已重挂',
  'freshness.fresh': '新鲜',
  'freshness.ok': '一般',
  'freshness.warn': '接近过期',
  'freshness.expired': '已过期',
  'freshness.unknown': '未知',
  'freshness.expiredBadge': '过期 ×{n}',
  'freshness.expiredTitle': '该段已过期过 N 次；重新读取后恢复新鲜，历史计数保留',
  'help.title': '新鲜度与节省机制说明',
  'help.modelTitle': '压力 × 深度新鲜度与安全阀',
  'help.modelDesc': '短上下文保持新鲜；随着窗口被填满，越靠前（越深）的内容分数越低，低于阈值则下次读取重发。同一段过期达到钉住次数后不再摘除。连续 2 次全覆盖去重触发安全阀放行。',
  'help.savingsTitle': '净节省 Token 说明',
  'help.savingsDesc': '净节省 = 去重省下的 Token − 插件状态通知开销。初次挂载时仅有微小的通知开销（约 20-30 tokens），多轮对话中一旦触发去重或增量补发，净节省将迅速转为大幅正收益。',
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
  'tier.label': 'Freshness threshold',
  'tier.hint': 'Freshness threshold (scores below this expire and re-read): Lenient(0.45) / Standard(0.55) / Sensitive(0.65) / Aggressive(0.75)',
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
  'summary.breakdown': 'Dedup saved {saved} tokens, notice overhead {spent} tokens',
  'row.net': 'net ≈ {n} tokens',
  'row.changed': 'changed, remounted',
  'freshness.fresh': 'fresh',
  'freshness.ok': 'aging',
  'freshness.warn': 'stale',
  'freshness.expired': 'expired',
  'freshness.unknown': 'unknown',
  'freshness.expiredBadge': 'expired ×{n}',
  'freshness.expiredTitle': 'This segment expired N times; a re-read refreshes it but keeps the count',
  'help.title': 'Freshness & Token Savings Guide',
  'help.modelTitle': 'Pressure × Depth Freshness & Safety Valve',
  'help.modelDesc': 'Short prompts stay fresh. As the window fills, deeper (older) content scores lower and is re-sent when below the threshold. A segment that has expired pinAfter times stays mounted. 2 consecutive full dedups trigger the safety valve.',
  'help.savingsTitle': 'Net Savings Accounting',
  'help.savingsDesc': 'Net Savings = Deduplicated Tokens − Plugin Notice Overhead. Initial mounts have a tiny overhead (~20-30 tokens); once dedup or increment triggers in multi-turn dialogues, net savings turn strongly positive.',
  'help.close': 'Close',
}