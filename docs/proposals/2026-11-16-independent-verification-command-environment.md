# 独立验证的命令环境

日期：2026-11-16  
状态：固定提案，待负责人接受；尚未修改本提案涉及的冻结设计合同，尚未实现 native 验证命令。

## 用户可观察行为

执行 Agent 修改原项目后，验证 Agent 在独立隔离的临时副本中运行构建、测试和必要的
联网检查。副本包括本次实际修改，不仅限于 Git 已提交文件。验证命令产生的编译文件、
缓存和测试临时文件留在副本中，不回写原项目。验证结束或用户停止后清理临时运行区，
保留持久证据和可查看的结论。验证通过仍须用户或 Parent 验收。

网络不超过所属工作区当前已获准的范围；撤权或来源失效后不得开始新动作。已有工作区
授权足够时不要求用户理解或设置另一身份。具体敏感命令仍走既有精确动作审批。

副本不是长期 Child 工作区，不具有独立治理权限，不接收其他工作区的文件或会话。
验证器继续使用独立 Session 和现有两项结论/证据控制，不获得修复原成果的权限。

## 缺口证据

`c283c8709076` 真实安装任务中，主任务真实 npm/build/test/HTTPS 成功；独立验证执行
`exe_5ce48031-126b-74cc-8325-93e55534f8ed` 在尝试 shell 时因缺少 Workspace episode
策略绑定反复等待，最终 RuntimeSafetyStop，Verification 无结论。证据见
`docs/verification/2026-11-16-installed-workspace-command.md` 及其原始记录。

P8 `02` §2/`04` §4 要求验证器不能修改 Producer 正式成果；P4 `04` 现有闭合快照
只接受 Workspace ExecutionEpisodeBinding。不能用 Producer 的执行身份、可写挂载、
策略回执或虚构的 WorkEpisode 填补这个缺口。页面读取和旧等待修复不解决 native
执行绑定问题。本提案是 P8/P4 之间的 Design Gap，不是测试夹具缺口。

## 固定落地条款

以下条款接受后分别作为同日补充落到所属文档；历史字段、JSON 和证据不重写。

### P8 `02-verifier-execution.md` §2：验证环境

1. 每个独立 Verifier execution 使用自己的临时验证环境。原项目只能作为获准的
   只读取材来源；验证命令可写区域只属于当前验证 execution，不得写回 Producer
   正式资源、Sibling、Parent、其他验证副本或宿主用户目录。
2. 环境捕获精确 VerificationId、executionId、WorkId/targetWorkRevision、owner
   Workspace 快照、资源范围和实际输入摘要。必须包含允许读取的当前未提交改动；
   不得假定 Git HEAD 等于待验收内容。跨边界链接、socket、无法安全捕获的输入或
   创建期间源变化，必须有界失败/重新捕获，不能扩大取材范围或默默漏文件。
3. 复用已有隔离执行器和文件工具，不增加第二 Agent 循环、虚构人类角色或长期
   Workspace。可复用 bubblewrap 的临时 overlay 或现有快照工具；采用哪项实现
   必须以实际主机能力、输入一致性和停止清理验证为依据，缺少能力不得回退原地执行。
4. shell 的 cwd 和写入只在副本。读原成果的工具保持只读；验证证据标记真实输入和
   实际命令，不把 producer 的自述或其他验证环境的输出冒充本次独立观察。
5. 结论、异常退出、超时和用户停止均收敛临时运行区和进程；需要恢复的 active
   验证使用可证明的原绑定或明确中断，不从 Session 文字重建目录/授权。不可重建的
   临时态走已有孤儿验证路径，不能自动 Unknown、Pass 或 Acceptance。

### P4 `04-sandbox.md`：独立验证策略变体

1. 为上述环境引入明确版本化的独立验证策略/绑定变体，字段绑定精确 Verification、
   execution、目标 Work 修订、owner Workspace、只读取材范围、副本身份/输入摘要、
   当前工作区授权来源、provider 资格、挂载/资源限制、网络策略、有效期和策略修订。
   复用现有主机材料、摘要与精确快照校验；不能让旧 Workspace codec 接受新字面量。
2. source 和临时可写环境分别校验，不把 WorkspaceWrite 对原项目的授权直接赋给
   验证器。受信运行时创建的验证环境仅用于执行 P8 mission；临时写入不形成对原
   资源的新授权，不增加 fs:write/shell:exec/网络能力的上限。
3. provider/实际挂载组合必须经过真实资格检查。现有 WorkspaceWrite × Enabled
   Supported tuple 不能被推导成任意只读/overlay/临时副本组合均已 Supported。
4. P4 保持 intent、真实 InvocationAuthority、effect admission、审批、lease fencing、
   观察、持久输出、停止/恢复。不能绕开 P4 直接 spawn 验证进程，不能把缺失策略
   表达为不存在的 pending request。无法执行必须给出真实未执行结果/可恢复阻断。
5. 历史 Workspace 策略、receipt 和事件字节保持原编解码。新持久表示用独立版本、
   类型约束和可验证来源；迁移如有需要必须同步 upgrader/manifest/维护终态，仍不
   承诺升级保留用户数据库。新变体不得放宽旧版本字段检查。

### P12 `02-authority-resolver.md`：验证授权

1. 命令来源为精确绑定的 Verifier execution，真实调用 actor 继续审计。授权取自
   当前 owner Workspace 的有效授权及其完整 Parent 来源链；额外验证字段来自
   Verification/Execution/资源的受信记录，不由模型提交。
2. 准备与 Gateway/P4 实际执行前均复查当前来源、Verification 归属、Work 修订、
   捕获输入、副本身份、主机/provider 资格及撤权。旧策略/旧回执只能证明过去动作，
   不能恢复撤权或迁移到另一执行/工作区/副本。
3. 验证器无分配工作区权限、修改 Work/Dependency/Deliverable 或原成果的新增通道；
   原有 RecordVerificationEvidence/ConcludeVerification exact authority 保持不变。

### DID：执行接线与兼容

1. Native 独立验证遵循上述 P8/P4/P12 条款；AgentLoop、Provider、P4 及结论命令
   沿用现有装配。临时执行区不变成新的长期领域实体或用户配置项。
2. 独立验证策略准备/持久表示、执行前复查、资格材料、观察/恢复、Web 诊断和普通
   安装必须作为一个完整生产切片接入，不能只扩展模型工具目录或类型断言就算完成。
3. Work 修订前移后旧 Verification 保持原 mission 和 targetWorkRevision；旧自验证
   等待不得阻塞新版 Work；新版验证只能使用新版 canonical mission，不自动取消、
   覆盖或重用旧验证身份。现有 S2/P8 合同的修复不等待本提案。
4. 接受并落地本固定包后，授权实现这个生产切片及必要的内部版本/迁移；历史结果
   文件不可修改，保留产品决定、设计落地、源码实现与真实安装验收四类证据。

## 验收

同一 source-free 安装包、真实模型和公开浏览器：原项目修改→实际构建测试→提交
独立验证→验证副本实际运行命令→逐项证据/结论→人工验收→重启可读。另证明验证
可生成临时编译产物但原项目字节未变，含未提交改动的输入得到检查，撤权/停止不
误伤其他工作区且不残留进程，网络没有超过原工作区权限，未知/过时绑定拒绝执行。

不把仅文件验证、脚本 Provider、内部接口注入、标记式 Supported 或自动 Pass
扩大成此验收成功。完整发布目标在以上行为全部通过前保持未完成。
