# STEP P1-01A — 仓库与工具链 Bootstrap

**Gate/决策**：P1_01A_CODING_CONTRACT；D-029（版本对齐——registry 探测证明 v0.3 pin 基本真实，偏差仅 pnpm 12.4.1 / effect rc.115 / 本机 Node 26）。

**实现地图**：
- `package.json`（ESM 单包、五脚本、exact pin）/ `tsconfig.json`（§2 全严格项 + skipLibCheck 见偏差）/ `biome.json`（linter preset + formatter + assist）/ `.gitignore`（§12）
- 五层 src 骨架 + 三级 tests + migrations/（.gitkeep）
- `src/entrypoints/{version,main}.ts` 最小编译入口

**不变式**：`start` 只跑 dist 产物（隔离检查：rm dist → exit 1）；无 tsx；无 strictness 削弱。

**验收**：install --frozen-lockfile / typecheck / lint / test / build / start 六条全过；1 smoke test。

**偏差**：① tsc 对空 src 报 TS18003——typecheck 顺延至源文件存在（计划预期错误，tsconfig 未动）；② biome 2.5 键名迁移（recommended→preset、assists→assist，语义不变）；③ skipLibCheck 因 effect 包 d.ts 的 TextDecoderOptions（需要 DOM lib）；④ start 无参数自 P1-01B 起为 usage + exit 2（入口即 CLI）。

**教训（版本事实只能探测）**：opencode 依赖快照 ≠ npm registry 状态；D-029 初版"pin 虚构"判断被 registry 探测证伪并勘误。
