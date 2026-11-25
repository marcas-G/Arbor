# Web 前端迁移结果与一致性复核

日期：2026-11-14（Asia/Shanghai）  
源码：`e7065a7cb06938a045a00d449b5b345f52cff8eb` 加当前工作树；没有提交或推送。  
依据：用户已要求使用 Tailwind、shadcn/ui、Radix Primitives；本次完成已授权的前端迁移。

## 最终范围

全部现有页面、命令表单、读模型视图和错误/连接提示已迁移到 Tailwind。
共享项目内组件覆盖 Button、Input、Textarea、Card、Badge、Dialog、DropdownMenu、Tabs；
Sheet、移动菜单和分工标签页使用 Radix，图标使用 Lucide。

运行时无 CSS Modules 和旧组件全局样式引用；全局只有 reset、tokens、Tailwind
utility/theme 和辅助功能规则。较长页面的静态 utility recipe 由相邻
`*.styles.ts` 持有。`components.json` 与 Vite/TypeScript 的 `@/` 别名可供后续
继续维护组件源码，不需要 shadcn 运行时包。

URL 仍决定分工标签选中状态，方向键只移动焦点，Enter 选择。弹窗的焦点初始位置、
Tab containment、Escape 关闭与 opener restore 已在真实浏览器确认。表单继续使用
既有 Command 和失败重试身份，服务端仍提供目录、权限、业务状态与持久化权威。

构建合同的本次新增只位于 P13 `05` 的样式/组件/依赖边界，包括 exact-pinned
`@radix-ui/react-tabs@1.2.1`；没有新增领域状态、Command、DTO 或数据迁移。

## 发现并修复的迁移问题

- 初始 Sheet 使用兄弟 overlay/content，却保留旧嵌套布局；content 现在显式 fixed 定位并高于 overlay。
- Button wrapper 未向原语传递 variant；现在正确传递 primary/quiet/danger。
- 关闭 Preflight 后只声明单边框可能留下其他边的浏览器默认宽度；reset 现在明确初始化边框。
- 默认 class merge 会把 `text-small` 识别为颜色并被 `text-foreground` 覆盖；已登记字号、间距、阴影主题别名，并增加复现回归。
- 工作台样式转换曾生成错误字符串；已修正并以浏览器真实 grid/visibility/resize 行为替代旧 CSS 源码正则断言。
- Web 单 chunk 警告通过路由 lazy load 解决；Suspense 保留导航外壳，只在内容区反馈加载。
- 后续使用性复核补齐了 Button 对原生 `aria-*`、`data-*` 和其他按钮属性的透传；中文输入法组合输入时不会被 Enter 快捷发送打断；对话初次载入滚动改为 Effect，避免在渲染阶段触发滚动副作用。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `pnpm lint` | PASS，1455 files（最终文档补记后另做增量检查） |
| `pnpm typecheck` 与 Web typecheck | PASS |
| `pnpm architecture` | PASS，38 files / 197 tests |
| `pnpm --filter @arbor/web test` | PASS，37 files / 289 tests |
| 相关 P17 runtime / commands / recovery | PASS，3 files / 6 tests |
| `pnpm build` 与 Web production build | PASS；入口 JS 487.09 kB、CSS 47.39 kB，无默认 chunk-size warning |
| 完整 Playwright UI suite | PASS，11/11，zero retry，约 2.8 分钟 |
| `git diff --check` | PASS |

Web 测试原有三项对旧 CSS 文件的源码断言被移至真实浏览器的布局检查，并新增
class-merge 与 Button 原生属性回归；当前 Web 测试为 37 files / 289 tests，未减少业务流程断言。

浏览器覆盖：

- 创建项目、对话、权威回复、重启后同一记录与无额外 Provider 请求；
- 1440/768/390 宽度的分栏、导航、手机面板切换和横向溢出；
- Sheet 可点击、焦点 containment / restore、Escape；
- Radix 菜单和 Tabs 的键盘与真实路由选择；
- 设置/用量/结构/待处理/关注事项的桌面和手机直接加载；
- 中文与空格路径、原目录文件保留、新目录创建、原项目直接重开与重启绑定；
- 文件读取、独立验证、人工审批/拒绝/过期恢复、结果验收、完成后详情和项目路由隔离。

环境：浏览器所需共享库和中文字体从发行版包解压到 `/tmp/arbor-browser-libs`，
通过该次运行的 `LD_LIBRARY_PATH` / `FONTCONFIG_FILE` 使用，没有要求 sudo 或改写系统库。
所有旅程使用可丢弃数据库和隔离脚本 Provider；没有修改用户数据库或调用真实模型。

首次完整 UI 运行 10/11，唯一失败是过期审批夹具在 daemon 写事务期间直接 UPDATE
触发 `database is locked`。夹具现在为该写连接设置 5 秒 busy timeout；到期状态和
无副作用断言保留。修后完整运行 11/11；没有启用 test retry 或放宽业务判断。

根门禁还发现上一轮恢复实现留下两处 Principal → Actor 双重强转和少量格式问题；
强转已改为既有 Actor schema 解码，相关 P17 6 项通过，其余仅 import/format 整理。
架构夹具扫描现在忽略工作树中已删除的 tracked 文件，防止移除旧 focus hook 后 ENOENT。

## 边界与后续

本次未运行完整 `pnpm check` 的核心全批次，也未运行完整 release/crash/真实 Provider
矩阵；不能把 UI 通过扩大成新的发布资格。入口单 chunk 低于 500 kB 不代表首屏总传输量
或真实设备加载耗时达标，共享 preload 与页面资源需另外计算。

原真实用户预览服务在本次核对时未运行于 18787；本次没有启动用户数据库。普通使用
入口仍为已安装的 `arbor`，或源码目录中的 `node scripts/start-user.mjs open`。

## 本次最终文档快照

这些 hash 对应本结果文件生成时的文档；首次落地快照单独保留在
`2026-11-14-frontend-ui-stack-landing-review.md`，不覆盖原指纹。

| 文件 | SHA-256 |
| --- | --- |
| `docs/decisions/2026-11-14-frontend-ui-stack.md` | `d64a26def1b28d951e4ae80b33cdbd67ed19bcf3a6f353ca4505bb91e65bc42f` |
| `docs/design/implementation/P13/05-transport-build.md` | `3e6d2a3c316c11107cd69a8065affb9ebcb99210fc8e8acf10787569fb3b8552` |
| `docs/CURRENT_STATE.md` | `b51cb5e20a204b74aa4493926f1dc48a9e6cad24bf932e67e24fc6aa637943c5` |
