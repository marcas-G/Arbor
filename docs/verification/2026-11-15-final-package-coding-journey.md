# 最终字体发行物的真实模型文件编程旅程

日期：2026-11-15（Asia/Shanghai）。

本记录验证的是同一个 source-free Linux x64 预览包，不继承旧发行物的行为结论：

- 包：`/home/lgao/.local/share/Arbor/release-preview-builds/final-font-20261115/arbor-0.0.0-preview-e16c418d47f7-7166d262-linux-x64.tar.gz`；
- SHA-256：`4aef65ab8ff7a9de13a7c5390928675f43620e020e6ca00e75fbecaae36d2a30`；
- buildId：`sha256:e16c418d47f7824468fff1a4d901e58fa77e9138967d07ac875ecdfb517dafde`；
- releaseQualified：`false`；
- 证据：`.test-results/real-final-font-coding-20261115/result.json`。

使用包内 Node，在 Linux 本机新数据目录启动；浏览器使用 Chromium；模型为外部真实
`gpt-6.1-sol`。业务操作通过浏览器和公开 HTTP/WS 边界完成，没有使用脚本 Provider、
内部数据库命令或预先代办文件权限。

## 通过的用户流程

1. 首次打开时模型未配置，页面要求填写接口地址、模型和凭据。
2. 通过真实连接检查后保存配置，daemon 自动重载并进入工作台；凭据不写入配置 JSON，
   私有凭据文件权限为 `0600`。
3. 浏览器选择一个真实的中文路径项目并打开。
4. 真实模型读取项目中的 `README.md` 并尝试追加一行。首次没有写权限时，系统显示
   可见阻断，文件保持未修改，且不重复尝试。
5. 停止并重启 daemon 后，阻断状态仍然可见。
6. 用户在当前工作入口授予限时文件修改权限，并提交新的指导；真实模型再次读取文件，
   只追加一次指定标记。
7. 页面显示独立验证通过，用户明确执行验收，工作进入完成状态。
8. 再次停止并重启后，完成状态、验收记录和文件内容仍然存在；浏览器无 page error。

## 不能从本次证据推出的结论

- Native shell、构建、测试、git、npm、curl 仍未进入普通 production Supported tuple；
- 多个正式 Workspace 并行运行及其服务生命周期仍未完成同一发行物验收；
- 该包仍标记为预览包，不能称为正式发布或 release candidate；
- 升级保留用户数据库、自动备份和完整发布资格仍未闭合。

