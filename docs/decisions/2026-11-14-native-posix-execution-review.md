# Native POSIX 执行候选复核与修复

日期：2026-11-14。范围：Linux 执行器候选；不是 production Supported 资格。

## 实际发现

1. 执行器只检查 Supported、profile 和 network mode，没有逐项比对策略绑定的
   provider ID/version、capability revision、boundary、规则摘要和资格证据。
   新增八个不匹配反例，修复前全部进入执行回调；修复后均在启动前拒绝。
2. 正式 shell executor 传入 `bash`，原 Native 测试只使用绝对路径。原实现将
   `bash` 拒绝为越界程序。现在只在固定系统工具链目录解析裸程序名，忽略
   ambient PATH；项目中同名 `bash` 不会取代系统 shell。真实进程正例也改为
   与正式工具一致的裸程序名。
3. `execFile` 输出溢出只杀掉 systemd-run 客户端，未停止其独立 user unit，
   且字符串错误码被错误转换成 exitCode 0。临时项目实际复现：返回 Completed /
   exitCode 0 后约一秒，原 shell 仍创建了文件。这会使未完成的命令被报为成功。
   现在输出溢出后等待 `systemctl --user stop` 完成整个 control group 的停止，
   再返回非零结果。短命令已经被 `--collect` 移除时，必须核对明确的 not-found /
   inactive 状态，不能把任意 stop 错误当成已停止。

## 验证

```bash
ARBOR_RUN_NATIVE_POSIX=1 pnpm exec vitest run adapters/sandbox-native-posix/test/native-posix-policy.test.ts
pnpm typecheck
pnpm architecture
```

本机结果：Native 27/27、根与测试 TypeScript、架构 38 文件 / 198 项通过。
输出溢出反例检查非零返回值，并在返回后继续观察延迟文件没有产生。
真实进程用例显式注入资格夹具以进入候选执行器；这不是受信资格材料，不能
提升为 production Supported，也不能替代安装包中的真实模型构建/测试验收。

修改只细化既有精确绑定、固定工具链和进程组边界，没有改动 `docs/design/**`、
生产模式、权限、审批或数据库。生产仍无可用 Linux Supported tuple。
