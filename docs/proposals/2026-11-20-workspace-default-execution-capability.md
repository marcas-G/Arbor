# Workspace 默认执行能力提案

日期：2026-11-20  
状态：ACCEPTED（负责人已在 2026-11-20 明确接受）  
范围：Linux 本机单用户首发；Workspace 初始化、默认沙箱能力与普通 coding Work

## 1. 负责人接受的产品决定

当前 Workspace 在初始化并完成本机 Linux 隔离环境检查后，默认具备其自身
ResourceBoundary 内的基础 coding 能力：读取项目、修改项目文件、执行本地
构建/测试/开发命令，以及通过受控隔离网络访问公网。普通 Work 不应先创建、
再因为缺少这组基础能力而等待用户重复授权。

该默认能力只覆盖当前 Workspace 已经被准入的资源边界。它不允许访问其他
Workspace、宿主机任意文件、Arbor 控制数据、主机账号、sudo、任意内网或
未登记的本机服务，也不等同于 FullAccess 或 TrustedLocal。

## 2. 初始化合同

1. 项目/根 Workspace 初始化时，系统在同一初始化事务中建立当前 Workspace 的
   默认执行能力记录；记录绑定 Project、Workspace、ResourceBoundary、当前
   boundary/policy revision、精确 Linux provider、`WorkspaceWrite` profile 和
   `Enabled` 受控网络模式。
2. 这条记录使用明确的 `SystemInitialization` 来源标记，并以实际的项目/Workspace
   初始化 CommandId 作为原因和审计关联；它不是伪造的人类 Grant，不创建第二个
   用户身份，不要求隐藏 token 或用户重复点击授权。当前本机用户仍可作为真实
   请求 actor 被审计，但不被拆成第二个授权主体。它跨普通 Work、Execution、
   daemon 重启持续有效。
3. 默认能力只有在安装器/启动器确认精确的 Linux 隔离 provider 和
   `WorkspaceWrite × Enabled` 资格后才可建立。环境未安装、资格过期或主机
   不匹配时，初始化或进入可执行工作台必须明确显示修复/安装状态；不得静默
   回退到宿主命令、TrustedLocal、fake Provider 或“只对话但宣称可 coding”。
   对合格的 Linux 发行物，启动快照默认使用 `NativeOsSupportedOnly`；
   `Disabled` 仅作为用户明确停用、回滚或环境不可用时的安全状态，不是合格
   Linux coding 安装的普通默认值。
4. 默认能力建立后，运行时仍为每个 Execution 生成并校验精确的策略绑定，重新
   检查 Workspace、资源边界、provider、版本、资格和撤权状态。持久默认能力
   不替代 per-Execution 的安全快照，也不允许旧快照越过新边界。

5. `AuthorizeWorkspaceSandbox` 保留给用户显式恢复撤权、改变 profile/network
   选择或其他需要人类决定的能力变化；它不是普通初始化的必经步骤。初始化
   不能通过伪造 `Human` 或 `Parent` origin 来复用该命令的语义。

## 3. 需要人工确认的范围

下列情况仍需要明确的人类决定或一次性动作审批：

- 扩大当前 Workspace 的 ResourceBoundary、访问其他 Workspace 或宿主资源；
- 创建/分配 Child 的资源、越过 Parent 当前能力上限或改变 ownership；
- 选择 FullAccess、TrustedLocal 或其他弱化隔离的明确路径（若产品允许展示）；
- 具有明显外部副作用、不可逆破坏、发布、部署或权限改变的敏感动作；
- 用户主动撤销后重新恢复默认执行能力。

普通 Workspace 内的读、写、shell、构建、测试和受控联网不再因为每个新 Work
或每次重启而重复申请 Workspace 执行授权。具体敏感动作审批仍然独立存在，
并且审批不能扩大 ResourceBoundary 或默认沙箱 profile。

## 4. 撤权、Child 与恢复

- 用户撤销后，默认能力记录进入持久 Revoked 状态；Parent 或模型不能自动恢复，
  只有用户明确恢复。
- Child 不继承 Parent 的目录访问或所有权。Child 只有在自己的资源准入完成、
  且不超过 Parent 当前能力上限时，才能建立其自身边界内的默认/分配能力；
  S3 的形成、通信、ownership、Deliverable 和 Acceptance 语义不变。
- 已因缺少默认能力而阻塞的 Work，在默认能力成功建立后必须显示明确的“重新执行”
  或等价恢复入口；恢复创建新的 Execution，但保留原 Work、目标、审计和阻塞证据，
  不伪造原 Execution 已经完成。

## 5. 不改变的内容

本提案不改变：

- Workspace 是权限和资源边界；
- Linux bwrap/user/mount/PID/network 隔离及 broker 网络合同；
- `ReadOnly`、`WorkspaceWrite`、`FullAccess` profile 的含义；
- 独立验证器使用临时副本、独立绑定、不能修改原项目的合同；
- 具体敏感动作审批、Verification、Acceptance、停止和重启恢复语义；
- preserved user database 不自动升级的发布限制。

## 6. 实现与验收要求

实现必须覆盖初始化、普通 Work、重启、撤权/恢复、Child 边界和同一发行物的
真实文件/命令/联网旅程。单元测试、旧数据库夹具、fake Provider 或内部命令
调用不能单独证明发布完成。
