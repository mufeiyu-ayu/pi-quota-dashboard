import { TTL_MS, STATUS_KEY, snapshot, statusText, unavailable } from './core.mjs';
import { resolveCredential } from './auth.mjs';
import { QuotaCache } from './quota.mjs';

export { STATUS_KEY };
const modelIdentity = (ctx) => {
  const model = ctx.model;
  return JSON.stringify([model?.provider, model?.id, model?.baseUrl]);
};
export class Dashboard {
  constructor(authDeps, { cache = new QuotaCache(), setIntervalFn = setInterval, clearIntervalFn = clearInterval, now = Date.now, createFooter } = {}) {
    Object.assign(this, { authDeps, cache, setIntervalFn, clearIntervalFn, now, createFooter });
    this.generation = 0;
    this.refreshId = 0;
    this.quota = unavailable(null, 'unavailable', 'session_not_started');
    this.authControllers = new Set();
  }
  start(ctx) {
    this.stop();
    this.ctx = ctx;
    this.quota = unavailable(ctx.model?.provider, 'loading', null);
    this.local(ctx);
    if (ctx.hasUI) {
      // 接管 footer 只为把扩展状态行并进统计行；状态仍照常经 setStatus 发布，
      // 这样别的扩展接管 footer 时本插件依然显示。footer 由接线层注入，
      // 使本模块不依赖 pi-tui。
      if (this.createFooter && ctx.ui.setFooter) {
        ctx.ui.setFooter((_tui, theme, footerData) =>
          this.createFooter(theme, footerData, () => this.ctx, this.authDeps.readCredential));
        this.footerOwned = true;
      }
      this.timer = this.setIntervalFn(() => { void this.refresh(); }, TTL_MS);
      this.timer?.unref?.();
      void this.refresh();
    }
  }
  select(ctx) {
    this.local(ctx);
    if (ctx.hasUI) void this.refresh();
  }
  local(ctx = this.ctx) {
    if (!this.ctx || !ctx) return;
    this.ctx = ctx;
    const identity = modelIdentity(ctx);
    // ctx.model 是实时 getter，thinking 事件可能先于 model_select；每个发布入口独立检查。
    if (identity !== this.modelIdentity) {
      this.modelIdentity = identity;
      this.generation++;
      this.refreshId++;
      this.cache.cancelPending();
      for (const controller of this.authControllers) controller.abort();
      this.key = undefined;
      this.quota = unavailable(ctx.model?.provider, 'loading', 'model_changed');
    }
    // 仅发布已重读核对存储/环境凭据的数据，不表示验证了活动请求账户。
    // cache 内的新响应可能仍在等待这次重读，不能直接取来显示。
    if (this.quota.fetchedAt !== undefined && this.now() - this.quota.fetchedAt >= TTL_MS)
      this.quota = { ...this.quota, state: 'stale' };
    const s = snapshot(ctx, this.quota);
    // 当前 provider 查不到额度时整条撤掉，不在底栏留一个空位。
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, statusText(s) || undefined);
    return s;
  }
  async refresh(force = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.local(ctx);
    const identity = this.modelIdentity;
    const generation = this.generation;
    const refreshId = ++this.refreshId;
    const current = () => {
      if (!this.ctx) return false;
      // 即便没有任何事件先到，也不能让实时 getter 的新模型接收旧请求结果。
      if (modelIdentity(this.ctx) !== identity) { this.local(); return false; }
      return generation === this.generation && refreshId === this.refreshId;
    };
    const controller = new AbortController();
    this.authControllers.add(controller);
    // Bound each auth derivation, separately from the HTTP deadline.
    const resolve = async () => {
      const timer = setTimeout(() => controller.abort(), 8000);
      let onAbort;
      try {
        return await Promise.race([
          resolveCredential(ctx, this.authDeps, controller.signal, this.now()),
          new Promise((done) => {
            onAbort = () => done({ result: unavailable(ctx.model?.provider, 'error', 'auth_timeout_or_cancelled') });
            if (controller.signal.aborted) onAbort();
            else controller.signal.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
      }
    };
    try {
      const auth = await resolve();
      if (!current()) return;
      if (auth.result) {
        this.key = undefined;
        this.cache.cancelPending();
        this.quota = auth.result;
        return this.local();
      }
      if (this.key !== auth.key) {
        this.key = auth.key;
        this.quota = { ...unavailable(auth.provider, 'loading', null), credentialSource: auth.credentialSource };
      }
      this.local();
      const result = await this.cache.get(auth, force);
      if (!current()) return;
      // 请求期间存储/环境凭据可能改变；重读只核对该来源，不执行或推断请求 header hook。
      const confirmed = await resolve();
      if (!current()) return;
      if (confirmed.result || confirmed.key !== auth.key || confirmed.credentialSource !== auth.credentialSource) {
        this.key = undefined;
        this.cache.cancelPending();
        this.quota = confirmed.result ?? unavailable(auth.provider, 'unavailable', 'account_changed_refresh_required');
      } else this.quota = result;
      return this.local();
    } catch {
      if (current()) {
        this.key = undefined;
        this.quota = unavailable(ctx.model?.provider, 'error', 'dashboard_refresh_failed');
        return this.local();
      }
    } finally {
      this.authControllers.delete(controller);
    }
  }
  stop() {
    this.generation++;
    this.refreshId++;
    if (this.timer !== undefined) this.clearIntervalFn(this.timer);
    this.timer = undefined;
    for (const controller of this.authControllers) controller.abort();
    this.authControllers.clear();
    this.cache.clear();
    if (this.ctx?.hasUI) {
      this.ctx.ui.setStatus(STATUS_KEY, undefined);
      if (this.footerOwned) this.ctx.ui.setFooter?.(undefined); // 交还内置 footer
    }
    this.footerOwned = false;
    this.ctx = undefined;
    this.modelIdentity = undefined;
    this.key = undefined;
    this.quota = unavailable(null, 'unavailable', 'session_stopped');
  }
}
export function registerDashboard(pi, dashboard) {
  pi.on('session_start', (_event, ctx) => { dashboard.start(ctx); });
  pi.on('session_shutdown', () => { dashboard.stop(); });
  pi.on('model_select', (_event, ctx) => { dashboard.select(ctx); });
  // ponytail: O(session entries) aggregation; throttle streaming to 4Hz. Use
  // incremental accounting only if very large sessions make this measurable.
  let lastStreamUpdate = 0;
  pi.on('message_update', (_event, ctx) => {
    const now = Date.now();
    if (now - lastStreamUpdate >= 250) { lastStreamUpdate = now; dashboard.local(ctx); }
  });
  for (const event of ['thinking_level_select', 'message_end', 'turn_end', 'agent_settled', 'session_compact', 'session_tree']) {
    pi.on(event, (_event, ctx) => { dashboard.local(ctx); });
  }
  pi.registerCommand('dashboard', {
    description: 'Read-only unified snapshot; /dashboard refresh bypasses TTL (not backoff)',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if (args.trim() && args.trim() !== 'refresh') {
        ctx.ui.notify('Usage: /dashboard [refresh]', 'info');
        return;
      }
      // No sendMessage/appendEntry: snapshots never enter model context or disk.
      dashboard.local(ctx);
      const s = await dashboard.refresh(args.trim() === 'refresh');
      if (s && dashboard.ctx) dashboard.ctx.ui.notify(JSON.stringify(s, null, 2), 'info');
    },
  });
}
