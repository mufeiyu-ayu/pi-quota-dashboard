import { isAbsolute, relative, resolve, sep } from 'node:path';
import { visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';
import { sessionUsage } from './core.mjs';
import { isSubscription } from './auth.mjs';

// 口径对齐 pi core 的 footer（dist/modes/interactive/components/footer.js）。
// 接管 footer 只为把扩展状态并进统计行；其余显示尽量与内置一致，pi 升级时由
// 集成测试的版本断言提示复核。拿不到 autoCompactionEnabled，因此不显示 (auto)。
export const formatTokens = (count) =>
  count < 1000 ? `${count}`
  : count < 10_000 ? `${(count / 1000).toFixed(1)}k`
  : count < 1_000_000 ? `${Math.round(count / 1000)}k`
  : count < 10_000_000 ? `${(count / 1_000_000).toFixed(1)}M`
  : `${Math.round(count / 1_000_000)}M`;

export function relativeCwd(cwd, home) {
  if (!home) return cwd;
  const rel = relative(resolve(home), resolve(cwd));
  const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  return !inside ? cwd : rel === '' ? '~' : `~${sep}${rel}`;
}

// 最后一次 assistant 响应的缓存命中率，与 pi 一致：只看最新一条，不做全会话平均。
export function cacheHitRate(entries) {
  const usage = entries.findLast((e) => e.type === 'message' && e.message?.role === 'assistant')?.message?.usage;
  const prompt = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
  return prompt > 0 ? (usage.cacheRead / prompt) * 100 : null;
}

const sanitize = (text) => text.replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim();
const BAR_WIDTH = 10;
const BAR_FILLED = '█';
const BAR_EMPTY = '░';

export class MergedFooter {
  constructor(theme, footerData, getContext, readCredential) {
    Object.assign(this, { theme, footerData, getContext, readCredential });
  }
  // 进度条 + 百分比 + 计数，阈值沿用 pi 的 70/90。条身与数字同色，空槽走边框色。
  contextSegment(ctx, withCounts = true) {
    const usage = ctx.getContextUsage();
    const windowTokens = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const percent = usage?.percent ?? null;
    const tokens = usage?.tokens ?? null;
    const level = percent === null ? 'muted' : percent > 90 ? 'error' : percent > 70 ? 'warning' : 'success';
    const filled = percent === null ? 0 : Math.round(Math.min(100, Math.max(0, percent)) / 100 * BAR_WIDTH);
    const bar = (filled ? this.theme.fg(level, BAR_FILLED.repeat(filled)) : '')
      + (filled < BAR_WIDTH ? this.theme.fg('borderMuted', BAR_EMPTY.repeat(BAR_WIDTH - filled)) : '');
    const pct = this.theme.fg(level, percent === null ? '?' : `${percent.toFixed(1)}%`);
    if (!withCounts) return `${bar} ${pct}`;
    const counts = `${tokens === null ? '?' : formatTokens(tokens)}/${formatTokens(windowTokens)}`;
    return `${bar} ${pct} ${this.theme.fg('dim', counts)}`;
  }
  modelSegment(ctx) {
    const name = ctx.model?.id ?? 'no-model';
    if (!ctx.model?.reasoning) return name;
    const level = ctx.thinkingLevel || 'off';
    return level === 'off' ? `${name} • thinking off` : `${name} • ${level}`;
  }
  render(width) {
    const ctx = this.getContext();
    if (!ctx || width <= 0) return [];
    const dim = (text) => this.theme.fg('dim', text);
    const entries = ctx.sessionManager.getEntries();
    const usage = sessionUsage(entries);

    let pwd = relativeCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
    const branch = this.footerData.getGitBranch();
    if (branch) pwd = `${pwd} (${branch})`;
    const sessionName = ctx.sessionManager.getSessionName?.();
    if (sessionName) pwd = `${pwd} • ${sessionName}`;

    const stats = [];
    for (const [mark, key] of [['↑', 'input'], ['↓', 'output'], ['R', 'cacheRead'], ['W', 'cacheWrite']])
      if (usage.tokens[key]) stats.push(`${mark}${formatTokens(usage.tokens[key])}`);
    const hit = cacheHitRate(entries);
    if (hit !== null && (usage.tokens.cacheRead || usage.tokens.cacheWrite)) stats.push(`CH${hit.toFixed(1)}%`);
    const subscription = isSubscription(ctx, this.readCredential);
    const cost = usage.cost.amount;
    // 费用未知时显示 $?，不拿 0 冒充已知的零花费。
    const costText = cost || subscription || usage.cost.state === 'unknown'
      ? `$${cost === null ? '?' : cost.toFixed(3)}${subscription ? ' (sub)' : ''}` : null;

    // 扩展状态并进统计行，这是接管 footer 的唯一理由。排序与 pi 一致。
    const statuses = [...this.footerData.getExtensionStatuses()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => sanitize(text))
      .filter(Boolean);
    // 放不下就按优先级降级：先丢 token 明细，再丢上下文的绝对计数（进度条和百分比
    // 已经说明了同一件事）。额度和其他扩展状态是这一行的主角，任何一级都不丢。
    // 空 stats 不能交给 dim()：空串包上 SGR 后非空，会在行首留一个空格。
    const separator = this.theme.fg('borderMuted', ' │ ');
    const compose = (level) => {
      const groups = level < 1 && stats.length ? [dim(stats.join(' '))] : [];
      groups.push(this.contextSegment(ctx, level < 2));
      if (costText) groups.push(this.theme.fg('warning', costText));
      if (statuses.length) groups.push(statuses.join(' '));
      return groups.join(separator);
    };

    const bare = this.modelSegment(ctx);
    let left = compose(0);
    for (let level = 1; level <= 2 && visibleWidth(left) + 2 + visibleWidth(bare) > width; level++)
      left = compose(level);
    let leftWidth = visibleWidth(left);
    if (leftWidth > width) {
      left = truncateToWidth(left, width, '…');
      leftWidth = visibleWidth(left);
    }

    let right = bare;
    if (this.footerData.getAvailableProviderCount() > 1 && ctx.model) {
      const withProvider = `(${ctx.model.provider}) ${right}`;
      if (leftWidth + 2 + visibleWidth(withProvider) <= width) right = withProvider;
    }
    let rightWidth = visibleWidth(right);
    if (leftWidth + 2 + rightWidth > width) {
      right = truncateToWidth(right, Math.max(0, width - leftWidth - 2), '');
      rightWidth = visibleWidth(right);
    }
    const gap = width - leftWidth - rightWidth;
    const line = gap > 0 ? `${left}${' '.repeat(gap)}${dim(right)}` : left;
    return [truncateToWidth(dim(pwd), width, dim('…')), line];
  }
}
