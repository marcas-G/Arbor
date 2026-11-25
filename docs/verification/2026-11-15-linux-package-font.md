# Linux 安装包中文字体与静态资源

独立浏览器截图在缺少中文系统字体的 Linux 环境发现产品文字为方框。检查确认：
Web 发布物的 `/fonts/noto-sans-sc/index.css` 被静态服务当成 SPA 路由返回
`index.html`，因此浏览器没有得到字体 CSS。

修复复用了已有静态资源解析器：`/assets/` 和 `/fonts/` 都按真实文件返回，内容类型
和不可变缓存由同一处逻辑决定，其他路径仍走 SPA fallback，路径穿越仍拒绝。字体
来源为 `@fontsource-variable/noto-sans-sc` 5.3.1，OFL-1.1；发布目录保存了 CSS、
字体文件、许可证和 `source.json` 摘要清单。

验证：

- `apps/single-workspace/test/p13-static-assets.test.ts`：6/6；
- Web typecheck、Vite build、Web 39 个测试文件 / 294 项通过；
- 重新生成 source-free Linux x64 包后，用包内 Node 启动新数据目录；浏览器确认
  字体 CSS 返回真实 CSS（111162 bytes），`document.fonts.check(15px Noto Sans SC
  Variable)` 为 true，计算字体栈包含 Noto Sans SC，状态接口 200，无 page error；
  浏览器实际请求的字体分片由 CSS 的 unicode-range 映射决定；
- 截图：`.test-results/real-response-resume-20261115/font-check.png`。

安装包：

- `/home/lgao/.local/share/Arbor/release-preview-builds/final-font-20261115/arbor-0.0.0-preview-e16c418d47f7-7166d262-linux-x64.tar.gz`；
- SHA-256：`4aef65ab8ff7a9de13a7c5390928675f43620e020e6ca00e75fbecaae36d2a30`；
- buildId：`sha256:e16c418d47f7824468fff1a4d901e58fa77e9138967d07ac875ecdfb517dafde`。

该修复只解决界面可读性和静态资源服务，不代表 Linux Native 命令执行、联网构建
测试或完整 coding agent 发布资格已经完成。
