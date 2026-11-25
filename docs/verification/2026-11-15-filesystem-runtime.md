# 文件工具的工作区边界与恢复核对

日期：2026-11-15。范围：当前未提交源码；不是发行物或真实模型用户验收。
产品优先级沿用 `docs/decisions/2026-11-15-workspace-isolation-priority.md`：
先避免工作区互相干扰，正常联网开发仍须交付。

## 改动及发现

- `write` 为非幂等效果：相同内容的两次直接调用可能不产生变化，但不能因此在
  中断后自动覆盖文件。保留现有脚本的普通权限位，原子替换前后分别处理故障。
- 写入或新建目录之后发生 flush/cleanup 故障，返回 OutcomeUnknown；效果前失败
  返回 ExpectedFailure。保留文件实际效果，避免给模型错误的“没有变化”结论。
- grep 使用固定的 `re2js@2.10.0` 线性正则引擎；有界遍历、累计读取预算、严格
  UTF-8、符号链接拒绝和完整 JSON 输出边界均保留。该依赖的架构例外只属于
  `packages/tool-runtime/package.json`，不向其他包或 adapter 扩散。
- 新增三个文件工具依赖 Linux descriptor 路径；其他平台模型目录不显示它们，
  精确定义仍保留。平台测试只验证可见性逻辑，不冒充其他平台执行资格。
- 当前 schema 的非幂等恢复发现真实缺陷：旧分支用 `ToolInvocationStore.settle`
  直接结算 OutcomeUnknown，缺少 P40 canonical observation，触发数据库约束。
  现改用既有 `ToolObservationEvidenceStore.settleOrReadWinner`，旧低层夹具仍保留
  没有 evidence 服务时的既有回退；未修改数据库约束或迁移。
- 部分 ownership 已修复：write/glob/grep 按请求目标解析资源范围；父区排除的子区
  仍拒绝，父区保留范围可继续写入。新建父目录的副作用仍由集成测试持续覆盖。

## 实际验证范围

`tests/p12-filesystem-runtime.test.ts` 使用当前 schema 工厂、真实 SQLite、真实
环境 resolver、ownership repository/admission、实际挂载目录、Blob/Artifact 与
恢复绑定、observation evidence 服务。authority 和执行租约为测试输入；没有经过
浏览器、真实 Provider、用户授权界面或完整生产 composition。

六个场景覆盖：两个工作区同名路径分别写入和搜索；无 ownership 不创建目录；
父区不能写入子区独占范围；成功写入回放不覆盖用户新编辑；效果准入后、效果
发生后结算前两个边界中断，重建同一组服务后不再次执行写入。后两项通过运行时
probe 抛错模拟中断，仍保留真实数据库和文件，**没有杀 daemon 或做双进程资格**。

初轮测试夹具未装配当前 evidence/recovery 服务，触发旧路径约束；补齐当前服务
后，仍复现上述 OutcomeUnknown 旧分支缺陷。修复后，两边界通过。最终用例的
中断前后都装配相同的恢复绑定和 evidence 服务，未通过移除服务让测试变绿。

验证记录：

- 文件工具/故障/边界/目录 + 当前数据库集成定向：5 文件、34/34。
- tool-runtime 完整包内测试：19 文件、182/182。
- 最新恢复服务完整装配的集成 + P4 harness：2 文件、10/10。
- 架构完整套件：38 文件、198/198；新依赖例外限制在 tool-runtime。
- 根 typecheck、lint、`git diff --check` 通过。
- Web typecheck、生产构建、39 文件/294 项测试通过。

全仓 `pnpm check` 首次在核心第 35/50 批发现 P4 harness 的旧依赖断言；修正后续跑
又在第 40 批发现旧工具清单断言。失败记录不改写成一次零失败的完整 check。
后续分段结果见 `docs/RELEASE_PROGRESS.md`。本轮没有运行完整 release functional、
真实模型浏览器任务或安装包验收，生产联网和进程执行限制保持。

源码身份：`.test-results/filesystem-runtime-20261115/source-identity.json`。
继承工作区未提交修改较多，不能只用 HEAD 代表本轮运行源码。
