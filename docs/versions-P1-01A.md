# P1-01A 版本对齐记录 (2026-09-14)

探测方式：`npm view <pkg> version` / `dist-tags`，本机 `node --version`。

| 包 | 文档 v0.3 pin | npm 实际采用 | 偏差 |
|---|---|---|---|
| typescript | 7.0.2 | 7.0.2 | 无 |
| effect | 4.0.0-rc.113 | 4.0.0-rc.115 (dist-tags.rc；未安装，P1-02 引入) | 有：rc 通道当前为 .115，取最新 |
| vitest | 5.0.0 | 5.0.0 | 无 |
| @biomejs/biome | 2.5.13 | 2.5.13 | 无 |
| better-sqlite3 | 13.0.3 | 13.0.3 (未安装，首个 runtime bootstrap STEP 引入) | 无 |
| pnpm | 12.3.4 | 12.4.1 (dist-tags.latest；本机原未安装，全局安装此版) | 有：.113→.114→.115 通道递进，取 latest |
| node | 24.21.0 LTS | v26.0.0 (本机) | 有：engines `>=24` 兼容；不使用 26 专属特性 |

## 勘误

P1-01A 计划起草时曾依据 opencode 仓库依赖快照（effect 4.0.0-beta.83 / typescript 5.8.2）推断
"v0.3 pin 多为虚构版本"。实际 registry 探测证明 v0.3 pin 基本全部真实。
opencode 的依赖选择 ≠ npm registry 全局状态。教训：版本事实只能以 registry 探测为准。

## 本机工具链

- node v26.0.0
- git 2.49.0
- pnpm 12.4.1（探测时本机未装，全局安装）
