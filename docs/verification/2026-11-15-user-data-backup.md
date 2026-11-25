# Linux 本机数据手动联合备份与恢复

日期：2026-11-15（Asia/Shanghai）。结论限定为当前实现的手动维护入口；不是公开
发布资格，不是完整 coding 任务，也不建立保留用户数据库的升级承诺。

## 实现与依据

实现遵循 P12 `05-storage-scale-durability.md` §4/§4.2 已有备份恢复职责与租约重整
要求，未修改 `docs/design/**`。使用 Node 官方 SQLite `backup()`、现有 P39
跨进程维护许可和 `reconcileRestoredLeases`，没有自建数据库复制算法或锁协议。

- 启动器增加 `backup --to`、`verify-backup --from`、`restore --from --data-dir`。
- 停服备份的维护许可覆盖数据库、数据库旁 Blob 与目录登记；WAL 中已提交状态由
  SQLite API 复制。关闭的备份切换为 DELETE journal，不依赖外置 WAL/SHM。
- 整个持久内容目录按文件名及内容摘要核对；历史附件、Summary checkpoint、已保留的
  验证事件/回执等按字段和类型枚举。Provider continuation、普通摘要指纹和用户文本
  不按任意 64 位字符串收集。
- 只按实际引用读取仍在旧临时目录中的内容，不修改源库、不导入源目录、不扫入其他
  数据库的旧内容。缺失或损坏时不发布有效备份清单。
- 恢复只创建新目录；文件清单禁止路径穿越和重复条目，拒绝符号链接内容、覆盖、
  损坏与遗漏。文件摘要只检测完整性，不提供可信来源认证。
- 恢复后的 Worker incarnation 清空、租约代数前移且到期。未完成标记阻止普通启动；
  完成后由下一次普通启动运行原恢复链。没有在恢复命令中私自运行 Agent。

独立只读审查发现 `messages.body_ref` 的 Deliver 行实际保存内联摘要，恰好为 64 位
校验和时会被误认为内容地址。已按实际 Message kind 区分，并用校验和交付回归证明；
审查复核确认该问题已修复，在当前限定范围未发现剩余 P0/P1。

## 定向验证

`apps/single-workspace/test/user-data-backup.test.ts` 最终 8/8：真实 SQLite WAL、
实际内容字节及目录选择恢复、旧临时内容定向复制、历史回执/Summary 与 opaque
continuation 区分、缺失/损坏/部分备份、覆盖/符号链接/穿越、修改清单后遗漏真实引用、
旧租约失效/启动门禁，以及独立 OS 进程持有 P39 Runtime permit 时备份被拒绝。

根 lint（1496 files）、根 build/test TypeScript、启动器 4 项通过。完整架构
38 files / 198 项通过于最后一次纯引用筛选增量之前；该增量后 typecheck/lint、
8 项备份集成和下述独立安装实测通过。本轮没有重新运行全量核心、Web 浏览器或
完整 release 功能套件，不继承此前检查点为当前完整资格。

## 独立安装包与真实模型

- HEAD：`e7065a7cb06938a045a00d449b5b345f52cff8eb` 加现有工作树；不是干净提交。
- buildId：`sha256:1156e777545c95671605946f70e1cb9956eedb8218bb3e74115e7f4f3f8da651`。
- 本地文件：`/home/lgao/.local/share/Arbor/release-preview-builds/backup-restore-20261115/arbor-0.0.0-preview-1156e777545c-7166d262-linux-x64.tar.gz`。
- 文件 SHA-256：`c48a09f64af19b53bb0e9dc4157165ee42552baa5f7cbcc3336abdd624f67aa9`。
- 证据：`.test-results/backup-restore-20261115/acceptance.mjs`、`result.json`；初次失败
  保留于 `result.first-failed.json` 和原隔离目录。

包解压至新的中文安装目录，以 `PATH=/usr/bin:/bin`、包内 Node 和 production
依赖运行。全新数据库初始化，经公开 HTTP 接口登记真实目录、创建 Project、提交
消息，配置的外部真实 `gpt-6.1-sol` 返回回复。安装包 backup 在原实例运行时被拒绝；
停服后同一包执行 backup → verify-backup → restore 到新目录 → 普通 start。
新实例 databaseFingerprint 不同、buildId 相同；公开 transcript 条目完全一致，
重新选择目录返回同一 Project 和 selector，源项目文件不变。最后停止了测试实例。

该真实模型场景包含 2 条对话条目和 2 个备份文件（数据库、目录登记），**没有产生
Blob**。它证明安装包命令、真实对话历史和目录恢复；真实内容字节另由上方 SQLite
集成测试证明，不声称在该真实模型场景中恢复过 Artifact/验证附件。

初次安装实测使用 `/home/lgao/.config/arbor/arbor.config.json`，Provider 请求终止为
`TransportFailed`，没有回复；等待窗口到期后验收失败，测试实例被正常停止。
只读诊断见原库 Provider/Execution/ResponseJob 状态，未修改内部状态使它成功。
后续使用此前已通过真实模型验收的独立配置，在另一个全新目录重做并通过。
没有把失败覆盖、称为零重试成功或把模型配置检查等同于网络连接成功。

## 准确边界

仅 Linux 普通安装、当前格式、数据库旁默认内容目录。没有自动备份计划、设置页
入口、用户内容修复界面、完整历史搬迁或换机器路径重绑定；源码/Git/worktree、模型
配置/密钥、外置沙箱授权/高水位/审计需单独保存。恢复不会替换启动器默认数据路径。
符号环境快照只保留数据库标记并报告数量；已删除字节不能凭引用重建。

网络设计包仍为待接受状态，未将其补丁落入设计或启用 production 命令。正式交付
仍需普通安装中的联网 shell/构建/测试、多工作区和服务隔离、停止恢复、同基线浏览器
完整任务、升级与发布资格。目标继续保持 active。
