# Web 前端 UI 基础层：落地一致性复核

日期：2026-11-14（Asia/Shanghai）  
依据：用户明确要求“用这些做前端”，其中“这些”指 Tailwind、shadcn/ui 和 Radix Primitives。

## 首次落地快照的可审计指纹

| 项目 | SHA-256 |
| --- | --- |
| 接受的产品决定 `2026-11-14-frontend-ui-stack.md` | `0e6e348212a2b8a908c8cee281b68e337f34129fe3f45c418d808f184df25f8b` |
| 落地后的拥有文档 `docs/design/implementation/P13/05-transport-build.md` | `25ef79a76e64a40f3b6da19609de5dee2f50307c5351655039638da235805752` |
| 当前状态同步 `docs/CURRENT_STATE.md` | `b90d6a28aa4f10af40e6e95bd240cd1263094211670ba64ba06346725ce20444` |

## 落地核对

| 接受内容 | 当前实现 | 结果 |
| --- | --- | --- |
| Tailwind utility layer，关闭 preflight | `@tailwindcss/vite`、`styles/tailwind.css` 只导入 theme/utilities | PASS |
| shadcn 风格项目内组件 | `components/ui/button.tsx`、`lib/utils.ts` | PASS |
| Radix 复杂交互原语 | `components/ui/dialog.tsx`，`Sheet` 已切换到 Radix Dialog | PASS |
| 保留现有页面行为 | Web 36 个测试文件 / 289 个测试通过 | PASS |
| exact pin | Web dependency pin test、类型检查和 build 通过 | PASS |

以上指纹和核对表保留首次落地快照，不代表后续文件的当前 hash。当时其他页面仍使用 CSS Modules 和 vanilla CSS；后续整页迁移及 Radix Tabs 增补见 `2026-11-14-frontend-ui-migration-result.md`。UI 基础层不改变 HTTP/WS、view DTO、Command Gateway、权限或安全边界。
