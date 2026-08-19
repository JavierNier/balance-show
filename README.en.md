# @javierni/balance-show

A DeepSeek balance card plugin for the DeepSeek Harness (dsh) Web GUI: a
bottom-right floating card showing your account balance (color-tiered) plus the
current conversation's live token usage, cache-hit rate, and cost (priced per
peak/off-peak buckets).

## Development & data notes

- **Built entirely on DeepSeek Harness**: this is a Cordis plugin for the dsh
  ecosystem — a dual-face package (host half `lib/index.js` + browser half
  `lib/client.js`) that works through the harness's native services
  (`credentials`, `webServer`, `sessionPersistence`). No third-party runtime
  dependencies.
- **It queries the installer's own account**: the plugin embeds no API key. At
  runtime it resolves the `DEEPSEEK_API_KEY` configured on the current harness,
  so whoever installs it sees **their own** account balance.
- **Pricing follows official rates**: `lib/pricing.js` curates the official
  DeepSeek price table (https://api-docs.deepseek.com/zh-cn/quick_start/pricing/),
  including the official policy timeline (from 2026-08-17: peak 09:00–12:00 /
  14:00–18:00 Beijing time, off-peak at half price). The active policy is chosen
  per message by its timestamp. If official prices change, update this file.
- **Cost is a local estimate**: token data comes from the harness session
  records (live `session/event` + replay of the persisted log); the cost is
  computed locally from the bundled price table — it is not DeepSeek's
  authoritative billing.

## Features

- **Balance card** (`shell.overlay` bottom-right): amount colored by tier
  (green ≥¥50, orange ¥10–50, red <¥10), availability chip, manual refresh,
  header arrow to collapse/expand (collapsed shows only the balance).
- **Current conversation stats** (small text under the balance, live-updating):
  - Total tokens (replays the full log, covering pre-restart history)
  - Cache-hit status & rate (hover `?` explains what it means)
  - Conversation cost (hover `?` shows the per-bucket breakdown split by
    **peak/off-peak**: 输入(未命中)/输入(命中)/output × peak/off-peak,
    tok × ¥/M = cost)
  - Current window (peak/off-peak; hover `!` explains peak hours
    9:00–12:00 / 14:00–18:00)
- **Official link**: the DeepSeek platform site link below the 充值/赠送 row.
- **Friendly errors**: fetch failures show a friendly message (no raw error
  codes).

## Install (one-liner, recommended)

```sh
dsh plugin --profile web add @javierni/balance-show
```

- The package is zero-dependency, no-build pure JS; `dsh plugin add` handles the
  install. Its imports (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-credentials`,
  `react`) resolve from the dsh bundled closure — nothing extra to install.

### Required profile settings (so other harnesses recognize it)

After installing, make sure the profile's `pnpm-workspace.yaml` contains both of
the following, or the plugin won't mount correctly / click-to-update won't work:

```yaml
# 1. hoisted layout so the bundle's ESM deps (@deepseek-ai/*, react) resolve
nodeLinker: hoisted

# 2. exclude the release-age gate: otherwise pnpm silently refuses freshly
#    published versions, so click-to-update can't reach the latest
minimumReleaseAgeExclude:
  - '@javierni/*'
```

> If an older install left a stale range (e.g. `^0.2.x`) in the profile's
> package.json, run `dsh plugin --profile web update @javierni/balance-show`
> to rewrite the range to the latest (in-card click-to-update also rewrites it
> via `add @latest`).

Then restart `dsh web` (new bundles are scanned at startup) and refresh the
browser to see the card.

## Updates

The plugin **automatically checks** the npm registry (at startup and hourly);
the card footer always shows:

```
更新于 21:00:00        本地版本 v0.3.2  线上版本 v0.3.2
```

- Grey when versions match; turns **orange** when an update exists, and the
  `线上版本 vX.Y.Z` becomes clickable.
- Clicking `线上版本 vX.Y.Z` runs `pnpm add @javierni/balance-show@latest` through a
  locally detected pnpm (PATH → corepack → npx), then prompts you to restart
  `dsh web`.
- Updating requires pnpm or corepack on the machine (Node ships corepack on
  Windows, usually nothing extra to install).
- **It never auto-updates** — it only checks and notifies; updates are always
  triggered by your manual click.

## Install (local development)

1. Copy this package into the profile dependency tree (a real copy, not a
   junction/symlink — the plugin's ESM deps resolve up from
   `profiles\node_modules`):

   ```powershell
   Copy-Item -Path "<your plugin source dir>" -Destination "$env:USERPROFILE\.dsh\profiles\node_modules\@javierni\balance-show" -Recurse -Force
   ```

2. Append to the patch array in `$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml`
   (CLI; desktop: `%APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml`)
   (new rows must go inside an `- insert:` list):

   ```yaml
   - insert:
       - id: balance-show
         name: '@javierni/balance-show'
   ```

3. Restart the harness (`dsh web`) and refresh the page. **After editing the
   source, re-copy and restart.**

## Uninstall

Remove the patch row and the `@javierni` directory (or
`dsh plugin --profile web remove @javierni/balance-show`), then restart.

## Verify

```powershell
node plugins/balance-show/scripts/test-balance.mjs   # host smoke test
curl http://127.0.0.1:3080/balance                  # balance route
curl "http://127.0.0.1:3080/api/session-stats?sessionId=x"  # session stats route
```

## License

MIT
