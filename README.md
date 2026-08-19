# @javierni/balance-show

> **定位说明**：本插件是**基于 DeepSeek Harness（dsh）开发的余额卡片插件**，
> **不是 DeepSeek 官方余额卡片**，与 DeepSeek 平台无隶属关系。它读取的是
> 当前 harness 里配置的 `DEEPSEEK_API_KEY` 所对应账户的余额。

右下角浮窗卡片显示余额（按档位着色），以及当前对话的实时 token 用量、
缓存命中率与费用（按高峰·低谷分桶计价）。

## 开发与数据说明

- **完全由 DeepSeek Harness 开发**：本插件是 dsh（DeepSeek Harness）生态的
  Cordis 插件，宿主半（`lib/index.js`）+ 浏览器半（`lib/client.js`）双面结构，
  通过 harness 的 `credentials` / `webServer` / `sessionPersistence` 等原生服务工作，
  不依赖任何第三方运行时包。
- **查询的是安装者自己的账户**：插件不内置任何 API Key，运行时从当前 harness
  配置的 `DEEPSEEK_API_KEY` 解析——谁装在这台 harness 上，就查询谁的账户余额。
- **价目表按官方价目策展**：`lib/pricing.js` 的价格表策展自 DeepSeek 官方公告
  （https://api-docs.deepseek.com/zh-cn/quick_start/pricing/），内置官方政策时间表
  （含 2026-08-17 起峰谷定价：高峰 09:00–12:00 / 14:00–18:00，空闲时段半价），
  按每条消息的时刻自动选择生效政策。如官方调整价目，需同步更新该文件。
- **计费为本地估算**：token 数据来自 harness 会话记录（实时 `session/event` +
  回放持久化日志），费用按内置价目表本地计算，非 DeepSeek 平台权威账单。

## 功能

- **余额卡片**（`shell.overlay` 右下角浮窗）：余额字体按档位着色
  （≥¥50 绿、¥10–50 橙、<¥10 红）、可用状态、手动刷新、头部箭头可收起/展开
  （收起只显示余额）。
- **当前对话统计**（余额下方小字，实时更新）：
  - 当前对话 Tokens（含回放完整历史，覆盖重启前消息）
  - 缓存命中状态与命中率（问号悬浮解释含义）
  - 当前对话费用（问号悬浮显示按**高峰·低谷拆分**的分桶明细：
    输入(未命中)/输入(命中)/输出 × 高峰·低谷，tok × ¥/M = cost）
  - 当前时段（高峰/低谷，感叹号悬浮解释高峰时段 9:00–12:00 / 14:00–18:00）
- **官网链接**：充值/赠送行下方附 Deepseek 开放平台官网入口。
- **友好错误**：抓取失败显示友好提示（不暴露原始错误码）。

## 安装（一键，推荐）

```sh
dsh plugin --profile web add @javierni/balance-show
```

- 插件为**零依赖、无构建步骤**的纯 JS 包，`dsh plugin add` 即可完成安装；
  其 import 的 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-credentials`、`react`
  均来自 dsh 自带闭包，无需额外安装。

### 其他 harness 识别（必读）

装完后**必须**确认 profile 的 `pnpm-workspace.yaml` 包含以下两项，否则
插件不会被正确挂载、或点击更新无法生效：

```yaml
# 1. 让 bundle 的 ESM 依赖（@deepseek-ai/*、react）能从 flat 目录解析
nodeLinker: hoisted

# 2. 排除 release-age 门禁：否则 pnpm 会静默拒绝刚发布的新版本，
#    导致点击"更新"升不到最新版
minimumReleaseAgeExclude:
  - '@javierni/*'
```

> 如果之前用旧版本安装导致 `^0.2.x` 之类范围残留在 profile 的
> package.json，需执行 `dsh plugin --profile web update @javierni/balance-show`
> 让依赖范围重写为最新（插件内点击更新也会自动用 `add @latest` 重写范围）。

然后重启 `dsh web`（新增 bundle 需要启动时扫描），刷新浏览器页面即可看到
右下角卡片。

## 更新

插件**自动检查** npm 线上版本（启动时 + 每 12 小时），右下角卡片底部常驻显示：

```
更新于 21:00:00        本地版本 v0.3.4  npm v0.3.4
```

- 版本一致时显示**灰色**；线上有新版时变**橙色**，且 `npm vX.Y.Z` 变为可点击。
- 点击 `npm vX.Y.Z` 即通过本机 pnpm（PATH → corepack → npx 自动探测）执行
  `pnpm add @javierni/balance-show@latest` 完成更新，成功后提示重启 `dsh web`。
- 更新需要本机可调用 pnpm 或 corepack（Windows 上 Node 自带 corepack，一般无需额外安装）。
- **不会自动执行更新**——只检查并提示，更新始终由你手动点击触发。
- 各版本改动见 `CHANGELOG.md`。

## 安装（本地开发方式）

1. 把本包拷贝到 profile 依赖树（必须**拷贝**而非 junction/symlink：插件自身的
   ESM 依赖需从 `profiles\node_modules` 向上解析）：

   ```powershell
   Copy-Item -Path "<你的插件源码目录>" -Destination "$env:USERPROFILE\.dsh\profiles\node_modules\@javierni\balance-show" -Recurse -Force
   ```

2. 在 `$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml`（CLI 版；桌面版为
   `%APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml`）的 patch 数组里追加
   （新行必须放在 `- insert:` 列表里）：

   ```yaml
   - insert:
       - id: balance-show
         name: '@javierni/balance-show'
   ```

3. 重启 harness（`dsh web`），刷新页面。**修改源码后需重新拷贝并再次重启。**

## 卸载

删除上述 patch 行与 `@javierni` 目录（或 `dsh plugin --profile web remove @javierni/balance-show`），重启。

## 验证

```powershell
node plugins/balance-show/scripts/test-balance.mjs   # 宿主取数逻辑冒烟测试
curl http://127.0.0.1:3080/balance                  # 余额路由
curl "http://127.0.0.1:3080/api/session-stats?sessionId=x"  # 会话统计路由
```

## License

MIT
