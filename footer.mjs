import { visibleWidth, truncateToWidth } from '@earendil-works/pi-tui';
import { sessionUsage, STATUS_KEY } from './core.mjs';
import { isSubscription } from './auth.mjs';

// 口径对齐 pi core 的 footer（dist/modes/interactive/components/footer.js）。
// 接管 footer 只为把扩展状态并进统计行；保留的显示尽量与内置一致，pi 升级时由
// 集成测试的版本断言提示复核。两处有意不同：拿不到 autoCompactionEnabled，
// 不显示 (auto)；token 明细（↑↓RW/CH）已由费用和上下文段覆盖，不再复刻。
export const formatTokens = (count) =>
  count < 1000 ? `${count}`
  : count < 10_000 ? `${(count / 1000).toFixed(1)}k`
  : count < 1_000_000 ? `${Math.round(count / 1000)}k`
  : count < 10_000_000 ? `${(count / 1_000_000).toFixed(1)}M`
  : `${Math.round(count / 1_000_000)}M`;

const sanitize = (text) => text.replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim();
const MODEL_ICON = '🤖';
const BAR_WIDTH = 10;
const BAR_FILLED = '█';
const BAR_EMPTY = '░';
// 用 pi 自己的 thinking 分级色（灰→蓝→紫→品红），强度一眼可辨且与 pi 其余界面一致。
// thinkingMax 在主题里是可选色，退回 Xhigh 以免主题没定义时取不到。
const THINKING_COLOR = {
  off: 'thinkingOff', minimal: 'thinkingMinimal', low: 'thinkingLow', medium: 'thinkingMedium',
  high: 'thinkingHigh', xhigh: 'thinkingXhigh', max: 'thinkingMax',
};

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
  // 思考强度在前、模型名在后；不显示厂商，模型 id 本身已经说明是哪一家。
  modelSegment(ctx) {
    const name = this.theme.fg('dim', ctx.model?.id ?? 'no-model');
    if (!ctx.model?.reasoning) return name;
    const level = ctx.thinkingLevel || 'off';
    const color = THINKING_COLOR[level] ?? 'thinkingXhigh';
    return `${this.theme.fg(color, level)}${this.theme.fg('borderMuted', ' · ')}${name}`;
  }
  render(width) {
    const ctx = this.getContext();
    if (!ctx || width <= 0) return [];
    const dim = (text) => this.theme.fg('dim', text);
    const usage = sessionUsage(ctx.sessionManager.getEntries());

    // 工作目录里唯一会变、值得盯的是分支；目录名自己知道，不占列。
    // 不在 git 仓库里就整段消失。
    const branch = this.footerData.getGitBranch();
    const subscription = isSubscription(ctx, this.readCredential);
    const cost = usage.cost.amount;
    // 费用未知时显示 $?，不拿 0 冒充已知的零花费。
    const costText = cost || subscription || usage.cost.state === 'unknown'
      ? `$${cost === null ? '?' : cost.toFixed(3)}${subscription ? ' (sub)' : ''}` : null;

    // 只取本扩展自己的状态。pi 原本把所有扩展的 setStatus 内容排在第三行，
    // 这一行取代了它，因此其他扩展的状态不会出现在这里 —— 是有意的取舍，
    // 代价是同时装了别的状态类扩展时，它们没有显示位置。
    const quota = sanitize(this.footerData.getExtensionStatuses().get(STATUS_KEY) ?? '');
    // 放不下就逐级降级：先丢上下文的绝对计数（进度条和百分比已经说明了同一件事），
    // 再丢分支。额度是这一行的主角，任何一级都不丢。
    // 段落靠 │ 分隔，只有模型段带图标。
    const separator = this.theme.fg('borderMuted', ' │ ');
    const compose = (level) => {
      const groups = [`${MODEL_ICON} ${this.modelSegment(ctx)}`];
      if (level < 2 && branch) groups.push(dim(branch));
      groups.push(this.contextSegment(ctx, level < 1));
      if (costText) groups.push(this.theme.fg('warning', costText));
      if (quota) groups.push(quota);
      return groups.join(separator);
    };

    // 单行、左对齐：pi 内置 footer 的三行全部并进这一行，模型不再右对齐。
    let line = compose(0);
    for (let level = 1; level <= 2 && visibleWidth(line) > width; level++) line = compose(level);
    return [truncateToWidth(line, width, dim('…'))];
  }
}
