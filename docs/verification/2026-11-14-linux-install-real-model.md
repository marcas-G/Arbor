# Linux 独立安装与真实模型复验

日期：2026-11-14。当前工作树基于 `e7065a7c`，含未提交修改。
这是本机 Linux x64 的分段验收记录，不能替代完整发布资格。

## 首次配置与对话

发行物：`arbor-0.0.0-preview-3ce57848cef8-3579c175-linux-x64.tar.gz`。
SHA-256：`f05550393d80d891f3a9b6b86055ac7256b0b1dc62a434dd5aa24d56251c0ee6`。

在独立安装目录使用包内 Node，用户目录、配置、数据库及项目均隔离，
`PATH=/usr/bin:/bin`。从浏览器填写经用户授权使用的外部模型
`gpt-6.1-sol`，连接返回 200；daemon 自动重载后进入工作台。
密钥未进入配置 JSON，配置仅引用私有密钥文件。选择中文、空格路径的已有
项目后，观察到真实助手回复，而不是把用户消息中的相同文字当作成功。
停止及重启后，助手历史仍可查看，浏览器没有 pageerror。

本机证据：`.test-results/real-install-fixed-20261114/result.json`、
`workbench-real-response.png`、`workbench-after-restart.png`。

## 真实文件任务暴露的缺陷

上述包中，真实模型读取 README 成功，patch 被文件权限拒绝。之后合法的
Blocked wait 仍失败，模型重复报告失败，文件未改变。诊断确认正式装配遗漏
阻塞存储、处理器依赖、Inbox sequence，以及调用记录未保存证据所需的工具
稳定身份。修复从 P4 已有 `(name, version, hash)` 定义保存新记录的身份；
没有降低证据校验，也没有猜测补写历史 manifest。

本机原始证据：`.test-results/real-install-fixed-20261114/coding-result.json`、
`coding-after-approval.json`。它们记录的是失败，不是完整编程任务通过。

## 新版安装包的可见阻塞

发行物：`arbor-0.0.0-preview-ddc0890a23f5-3579c175-linux-x64.tar.gz`。
SHA-256：`9383d25836b02f8c2f6a6094320f62a106cd7516c25454c2ea8bb1853c76e96b`。

新配置、外部真实模型、新项目，所有业务操作均从浏览器进行。人工批准工作后，
实际读取成功，写入被拒绝。用户从分工进入工作详情，可见“本轮执行已阻断”、
真实拒绝原因和模型请求；文件未改变。停止及重启后仍显示同一工作阻塞，
浏览器无 pageerror。

本机证据：`.test-results/real-blocked-install-20261114/result.json`、
`blocked-before-restart.png`、`blocked-after-restart.png`。首次浏览器脚本因导航
按钮的可访问名称包含空格而失败；修正选择器后复验通过，没有把它记作零重试。

## 文件授权与恢复

工作详情新增“文件权限”，只为当前分工在现有项目资源边界内授予有期限的
`fs:write`；用户选择 1、8 或 24 小时并明确提交。不会授予命令执行或扩大
资源目录，不会因授权本身自动重试。它复用既有 GrantPermission 命令与服务端
权限检查。后续继续操作使用现有“调整方向”。

第一版真实浏览器已成功授权，但继续工作超时；只读诊断确认 SteerWork 的
正式处理器仍缺阻塞存储依赖，未 supersede 旧阻塞或推进 Inbox sequence。
源码已补这处依赖。公开进程回归已验证：拒绝、持久阻塞、重启、不继续请求
模型、明确授权、新指导、真实文件修改及旧阻塞移除。
该回归使用脚本 Provider；后续真实模型恢复另记结果，不与其混用。

失败证据：`.test-results/real-permission-recovery-20261114/result.json`。

修复后的发行物为 `arbor-0.0.0-preview-5211ac38ba34-3579c175-linux-x64.tar.gz`，
SHA-256 `aa77ce6ca2904bb286917709f594ee346e05eaf8cd04aec80a0b8715bfb8727b`。
该包经全新首次配置及项目创建，使用同一外部真实模型完成：可见阻塞、重启、
浏览器限时文件授权、新指导、真实追加且仅一次、独立验证通过、单独记录人工
验收、工作完成、重启后成果文件与验收仍在。浏览器无 pageerror。
所有业务操作通过页面，没有内部命令或预授 grant。

成功证据：`.test-results/real-permission-resume-fixed-20261114/result.json`，
以及 `permission-granted.png`、`verified-before-acceptance.png`、`accepted-work.png`。
此结果只覆盖文件任务；没有执行 shell、构建或测试。

## 流式响应修复的证据边界

OpenAI-compatible SSE 在已经收到 `[DONE]` 而 HTTP 保持打开时，旧适配器仍
等待 EOF。新实现收到终止标记后释放 reader，继续要求合法 finish reason，
也验证了工具调用参数的完整保留。适配器两文件 32 项通过。

最早一次真实请求失败发生在响应 headers 之前，`responseStarted=false`；
实际外部原因未确定。不能把独立复现的 SSE EOF 缺陷写成那次请求失败的原因。

## 仍未完成

正式 Linux 命令执行仍 Disabled；没有通过普通安装包的构建、测试和进程
停止/恢复。尚未完成干净 VM、arm64、所有 Provider、升级、联合备份恢复、
完整同基线发布资格。负责人随后选择 MIT；项目许可证及新打包器已更新，
上述旧包不原地替换，也不把许可证变化当作新的整包验收。目标继续进行。
