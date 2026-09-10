# pi-quota-dashboard

**English** · [简体中文](./README.zh-CN.md)

A read-only quota, balance and session dashboard for the [pi coding agent](https://pi.dev) — **Claude, OpenAI Codex and DeepSeek in a single footer line**.

Every other pi extension covers either subscription windows (Anthropic OAuth, Codex) *or* API balance (DeepSeek). This one does both, because they are different billing concepts and a dashboard should not pretend otherwise.

![The merged footer line](./docs/footer.png)

That shot is a Codex Pro account: `7d 25% (4d9h)` is the single 7-day window it returns — no 5h, because Pro does not have one. The branch segment is absent because that session is not in a git repository. The quota segment on the other providers:

```
5h 98% (3h12m) · 7d 49% · Fable 13%   Claude — one entry per window
(nothing)                             DeepSeek — a funded balance stays out of the way
```

Verified against **pi 0.85.1 / Node 22.20.0**.

## What it does

- **Shows remaining quota, not consumed** — you care about what is left.
- **One line, not three.** pi's built-in footer takes three rows (cwd / stats / extension statuses). This collapses all of them into one.
- **Only the windows your account actually has.** A Codex Pro account returns exactly one 7-day window — no 5h, no code-review bucket. Those are not invented as "unavailable" rows.
- **Never writes credentials.** No auto-login, no token refresh, no writes to `auth.json`. An expired credential is reported as `expired` and left alone.
- **Never claims more than it knows.** `activeAccountVerified` is permanently `false` — see [Honest by construction](#honest-by-construction).

## Install

```sh
pi install npm:pi-quota-dashboard
```

Or straight from the repository:

```sh
pi install git:github.com/mufeiyu-ayu/pi-quota-dashboard
```

Then run `/reload` in your pi session. No `npm install` needed — pi provides the dependencies.

For local development, clone it and point pi at the directory:

```sh
git clone https://github.com/mufeiyu-ayu/pi-quota-dashboard.git
pi install ./pi-quota-dashboard
```

## The footer line

pi's built-in footer is three rows: working directory, stats, extension statuses. This extension uses `ui.setFooter()` to collapse all three into **one**, segments separated by `│`:

```
🤖 high · gpt-6-astra │ main │ ██░░░░░░░░ 18.5% 185k/1.0M │ $0.061 │ 7d 25% (4d11h)
  └─── model ────┘   └branch┘  └──────── context ─────────┘  └─ cost ─┘  └── quota ──┘
```

Everything is left-aligned — nothing is pushed to the far right where it gets truncated first.

- **Thinking level comes before the model name**, coloured with pi's own thinking scale (grey → blue → violet → magenta), so the strength reads at a glance.
- **The provider is not shown.** `gpt-6-astra`, `deepseek-v4-flash` and `claude-fable-5-1` already say which vendor they are; the prefix cost 16 columns for nothing.
- **Only the git branch, no working directory.** The branch is the part that changes and is worth watching; you already know which project you are in. Outside a repository the segment disappears entirely.

### Context

A 10-cell progress bar, the percentage, and the absolute count. Bar and number share a colour, using pi's own thresholds: **70% amber, 90% red**. Right after a compaction the percentage shows `?` until the next response — pi genuinely does not know yet, so nothing is guessed.

### Quota

| Element | Meaning |
|---|---|
| `25%` colour | Graded on **remaining**: >50% green, >20% amber, else red. Windows are separated by `·` |
| `~` | Data is stale (not refreshed this cycle). Percentages also lose their colour — a colour scale only means something on freshly fetched data |
| `5h` `7d` `1d` | Window length, derived from `durationSeconds`. Model-scoped weekly windows get the model name (`7d Opus`), `weekly_scoped` uses the service's own display name (`Fable`), Codex code-review buckets are prefixed `CR` |
| `25%` | **Remaining**, not consumed |
| `(4d11h)` | Reset countdown, shown only for the shortest window — it resets first and is the one you hit |
| `¥0.00` (red) | API balance, shown **only when it runs dry** (the service reports `is_available:false`, or the amount truncates to zero/negative). A balance does not run out mid-session the way a quota does, so it stays out of the way. Full figures via `/dashboard` |
| `…` / status word | Querying / could not fetch (`?`, `n/a`, `auth`, `expired`, `403`, `429`, `error`). Definite problems are red, merely-missing data stays dim. A healthy `ok` prints no status word at all |

Windows with no data are **omitted entirely** rather than occupying a `?%` slot. If the active provider has no quota concept, the whole segment is withdrawn instead of leaving a gap.

### Responsive degradation

A narrow terminal must not push the quota — the whole point of the extension — off the end of the line. So segments are dropped by priority instead of truncating blindly:

| Width | Shows |
|---|---|
| Wide | `🤖 high · model │ main │ ██░░░░░░░░ 18.5% 185k/1.0M │ $0.061 │ quota` |
| Narrower | absolute token count dropped — the bar and the percentage already say it |
| Narrower still | branch dropped |
| Narrowest | the line is truncated from the right. Model, quota and other extension statuses are never dropped as segments |

`setStatus()` is still published normally, so if another extension takes over the footer this one keeps showing up there. `session_shutdown` hands the built-in footer back.

**Only this extension's own status is rendered.** pi normally lines up every extension's `setStatus()` output on a third row; this line replaces that row, so other status-publishing extensions have nowhere to show. A deliberate trade-off for a clean single line — if you rely on another statusline-style extension, this one will hide it.

### Differences from the built-in footer

These are extension-API boundaries, not preferences:

| Item | Why |
|---|---|
| `(auto)` | **Not shown.** `autoCompactionEnabled` lives on pi's internal session object and is unreachable from `ExtensionContext`. Better absent than possibly stale |
| provider prefix | **Not shown.** pi prints `(openai-codex)` when several providers are configured; the model id already identifies the vendor |
| `(sub)` | Mirrors pi's `isUsingSubscription`, but the `snapshot.auth` map behind `isUsingOAuth` is unreachable, so it uses `readStoredCredential(id)?.type === 'oauth' && provider.auth.oauth.isSubscription`. OAuth from environment/runtime is missed — under-reporting beats guessing |
| `↑↓RW` `CH` | **Not shown.** The per-direction token breakdown and cache-hit rate are covered by the cost and context segments; cumulative token counts remain in `/dashboard`. |
| `$?` | pi prints the running total; this keeps the conservative reading — if a **billable** response reports a cost of 0, the figure is untrustworthy, so it says so. An all-zero empty response (an abort, a model switch) is self-consistent and does not poison the session |

Everything else — context thresholds, truncation behaviour — matches the built-in footer.

## Commands

| Command | Effect |
|---|---|
| `/dashboard` | Re-reads the stored/environment credential source and prints the full redacted JSON snapshot. Quota is reused within a 60s TTL |
| `/dashboard refresh` | Bypasses the TTL — but **not** the failure backoff |

Snapshots never enter the model's context and are never written to disk.

## Honest by construction

The reason this extension is worth reading: it is careful about what it claims.

- **`activeAccountVerified` is always `false`.** The guards below reject visible overrides, but they cannot rule out a `before_provider_headers` hook silently swapping accounts, and on-disk config can differ from loaded config. So even a successful 200 is labelled as representing *the stored/environment account*, not a verified active request account. It never reads private runtime state or executes header hooks to guess.
- **Subscription quota and API balance are strictly separate** (`kind`). An allowance and a balance are not interchangeable numbers.
- **Balances stay decimal strings.** No float conversion, no currency conversion. The footer truncates to two places and appends `+` when it drops non-zero digits, so a tiny positive balance never renders as a flat `0.00`.
- **Zero is not free.** pi initialises missing prices to zero; a billable response reporting `cost: 0` is reported as unknown rather than as a measured free call.
- **Stale is not fresh.** A failed refresh keeps the previous `fetchedAt` and is marked `stale` — it is never relabelled as a successful fetch.

### Credential handling

- Reuses pi's exported `readStoredCredential` and the **stock** provider `oauth.toAuth` / DeepSeek `apiKey.resolve`. Never calls `getProviderAuth` / `getApiKeyAndHeaders`, which may refresh or write.
- API keys accept a literal, or a single `$ENV` / `${ENV}` reference (provider-scoped env wins). `!command` credentials and compound templates are **never executed** — they report `unsupported`.
- Runtime credential overrides, registered provider overrides, non-official `baseUrl`, visible headers, and per-provider auth config in `models.json` all fall back to `unsupported`.
- Requests go to fixed official HTTPS paths only. Redirects are refused (`redirect: 'manual'`), the model's `baseUrl` is never used as a quota target, and tokens, headers, raw error bodies, account ids and fingerprints are never logged.

### Endpoints

| Provider | Endpoint | Auth |
|---|---|---|
| Claude | `GET https://api.anthropic.com/api/oauth/usage` | OAuth bearer + `anthropic-beta: oauth-2025-04-20` |
| Codex | `GET https://chatgpt.com/backend-api/wham/usage` | OAuth bearer + `ChatGPT-Account-Id` |
| DeepSeek | `GET https://api.deepseek.com/user/balance` | Bearer API key |

Claude and Codex expose internal/unstable quota endpoints with no compatibility promise. DeepSeek follows its [documented balance API](https://api-docs.deepseek.com/api/get-user-balance).

### Caching and lifecycle

Cache is keyed by a SHA-256 fingerprint of provider + fixed endpoint + token + account (never emitted), so two accounts can never read each other's data. Concurrent requests for one key are coalesced, at most 16 entries. HTTP deadline 8s including the body, auth derivation 8s separately, response body capped at 256 KiB. Failures back off 60/120/240/300s and honour `Retry-After` (seconds or HTTP-date, capped at one day). 401/403/429 are never routed around.

Refresh polls every 60s, and only in UI mode. Every publish path and async continuation independently re-checks provider/model/baseUrl identity, so a model switch cancels in-flight requests and discards late results rather than attributing them to the new model. Credentials are re-read after the HTTP call — if they changed mid-flight, the result is dropped instead of published against the wrong account. Cache is memory-only.

## Provider support

| Provider | Reported |
|---|---|
| `anthropic` | `five_hour`, `seven_day`, model-scoped weekly windows (`seven_day_opus`, `seven_day_sonnet`, `weekly_scoped`) |
| `openai-codex` | `rate_limit` and `code_review_rate_limit` primary/secondary windows — whichever the account actually returns |
| `deepseek` | Exact CNY/USD API balances as decimal strings |

Any other provider reports `unsupported` and the segment is withdrawn.

> **Note on Claude:** pi's docs state that third-party harness calls against a Claude subscription consume extra usage and are billed per token rather than against plan windows. The 5h/7d figures here are the account's plan allowance as returned by the official endpoint — **not a pi budget**. No `extra_usage` field or session cost estimate is mixed into the plan windows.

## Development

The npm package ships only the runtime files, so clone the repository to run the tests:

```sh
git clone https://github.com/mufeiyu-ayu/pi-quota-dashboard.git
cd pi-quota-dashboard
node --test test/*.test.mjs

# prints usage only, no network
node scripts/smoke.mjs

# explicit, free, read-only real GET; prints redacted business fields and HTTP status, never credentials
node scripts/smoke.mjs --live
node scripts/smoke.mjs --live deepseek
```

All `FAKE_*` fixtures are simulated. Tests also cover the real installed extension loader, the stock auth functions against fake credentials, and both the built-in `FooterComponent` and this extension's merged footer at 0/1/2/3/8/20/40/80/160 columns — without starting the pi CLI or issuing a model request. The merged footer is rendered through the factory registered by pi's real extension loader, not by bypassing the load path.

Standalone scripts locate pi from the current Node's global install directory; set `PI_DASHBOARD_PI_ROOT` for other layouts. Integration tests assert `pi.VERSION === '0.85.1'` — on a pi upgrade that assertion fails deliberately, as a prompt to re-check the auth, loader and footer APIs before bumping it.

## Attribution

Endpoint and response-field research for Claude and Codex referenced [claude-dashboard](https://github.com/uppinote20/claude-dashboard) by uppinote (MIT). This package implements its own credential handling, parsers, cache and lifecycle integration, and does not execute or redistribute that bundle. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## License

MIT
