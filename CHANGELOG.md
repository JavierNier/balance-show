# Changelog

本插件为**基于 DeepSeek Harness（dsh）开发的余额卡片插件**，与 DeepSeek 平台无隶属关系。

## 0.4.0 (2026-09-16)

- **新增：遮挡检测与贴边避让**——面板类插件（如 dsh-better-sidebar 的右侧栏，其面板宿主
  `[data-dsh-panel-host]` 挂在 `document.body`、z-index 25）打开时，卡片不再被压住看不见。
  - 检测口径：在「用户偏好位置」矩形内采样 `document.elementFromPoint`，命中元素若
    **绘制层级高于本卡片所在的 `shell.overlay` 层（z-index 20）** 且与矩形相交，即判定为
    遮挡物；再在左/右/上/下四个方向里选**位移最小且放得下**的方向，把卡片挪到遮挡物
    边缘外侧 8px。不写死插件名，任何 body 级高层浮层都适用。
  - 为何必须主动检测：侧栏推挤布局靠给 frame 加 `padding-right`，而 overlay 层是
    `inset:0` 绝对定位、以 **padding box** 为基准——加 padding 不改变其宽度，因此
    `resize` / `ResizeObserver` 完全感知不到面板开合。卡片自身 z-index 也越不过祖先的
    20（层叠上下文封顶），故不做层级对抗，只做贴边避让。
  - 避让位移**只用于渲染、不写入 localStorage**：侧栏关闭后卡片自动回到原偏好位置。
  - 触发源：`resize` + `ResizeObserver`（沿用）+ html/body 属性变化（面板开合、拖宽）
    + 400ms 兜底轮询（覆盖面板滑动动画与浮动抽屉 narrow 模式）；`requestAnimationFrame`
    去抖，页面隐藏与拖拽期间跳过。
  - 拖拽联动修复：避让生效期间禁止把卡片拖进面板；松手时把避让位移并入偏好位置并清零
    避让，**视觉位置不跳动**；单击（未移动）不再落盘，避免把自动避让位置误存成用户偏好。

## 0.3.9 (2026-08-20)

- **修复：卡片内"更新"按钮在 DSH Desktop 上失败（`ERR_PNPM_UNEXPECTED_STORE`）**。
  - 根因：DSH Desktop 每次启动会把捆绑的 pnpm 10.x（`.desktop-bin`）放进 PATH
    最前；而 profile 的 node_modules 由 pnpm 11 的 store v11 链接。更新按钮用
    PATH 里第一个 pnpm（10.x）执行 `pnpm add` 时，pnpm 10 读 v11 store 直接报
    `ERR_PNPM_UNEXPECTED_STORE` 退出，表现为"点击更新失败"。
  - 修复：执行更新前读取 `node_modules/.modules.yaml` 的 `storeDir` 解析 store
    主版本（`store/v<N>`）；探测 pnpm 启动器时解析其 `--version` 主版本，
    **跳过与 store 大版本不匹配的 pnpm**；并把 local `dsh-pnpm-bin`（独立安装的
    pnpm 11.x）的探测顺序提前到 corepack / npx 之前。
  - 实测：PATH pnpm 10.34.5 被正确跳过，选中 local dsh-pnpm-bin 11.21.0。
  - 无法解析 store 版本时（读不到 `.modules.yaml`）保持原行为不过滤。
- 新增 `CHANGELOG.md`（本文件，首次随包发布）。

## 0.3.5 – 0.3.8 (2026-08-19)

- 卡片位置记忆：切换会话时加载该会话自己的位置（不同对话框位置互相独立）。
- 防止卡片被侧边面板遮挡或缩小后消失在视口外；窗口放大/缩小时按比例跟随并钳制在容器内。

## 0.3.4 (2026-08-17)

- 定位说明：明确本插件是基于 DeepSeek Harness 开发的余额卡片插件，不是
  DeepSeek 官方余额卡片（同步更新 package.json 描述、README 与源码注释）。
- 更新检查间隔：由每小时一次调整为**每 12 小时一次**（Host 缓存与客户端轮询同步调整）。
- 余额同步间隔：由 45 秒调整为 **3 分钟**一次（Host TTL 与客户端轮询同步调整）。

## 0.3.3 (2026-08-16)

- 内置 DeepSeek 官方峰谷定价时间表（2026-08-17 起：高峰 09:00–22:00 / 14:00–18:00，
  空闲时段半价），按消息时刻自动选择生效价格。
- 会话统计支持持久化回收（覆盖重启前消息），费用按高峰/低谷分桶明细展示。
- 插件内点击更新：自动探测 pnpm（PATH → corepack → npx），`add @latest` 重写依赖范围。
