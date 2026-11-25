# Web 前端 UI 基础层

日期：2026-11-14  
状态：用户已决定使用 Tailwind、shadcn/ui 和 Radix Primitives 作为前端基础层。

## 接受的范围

1. Tailwind 只提供可组合的 utility layer；现有 Arbor reset 和 design tokens 继续作为全局基础，不启用 Tailwind preflight。
2. shadcn/ui 采用“组件源码进入项目”的方式，组件放在 `apps/web/src/components/ui/**`，可以继续使用 Arbor 的 tokens 和页面语义。
3. Radix Primitives 用于 Dialog、Dropdown 等需要焦点管理、键盘行为和可访问性语义的交互原语。
4. 现有 CSS Modules、vanilla CSS、页面 class 和后端 API 在渐进迁移期间继续有效；本决定不要求一次重写所有页面。
5. 新增依赖必须 exact pin，并由 Web 依赖契约测试覆盖。

## 完成的迁移范围

- 全部既有页面、命令表单、read-model 视图和错误/连接提示使用 Tailwind utilities。较长页面样式集中为静态 `*.styles.ts` utility recipe，构建时扫描。
- `components/ui/**` 保存 Button、Input、Textarea、Card、Badge、Dialog、DropdownMenu、Tabs；`components.json` 和 `@/` 别名支持继续维护项目内组件源码。这里不是额外安装一个 shadcn 运行时组件包。
- `Sheet` 使用 Radix Dialog；移动端“更多”的既有操作使用 Radix DropdownMenu；分工页面使用 Radix Tabs，选中值仍由 URL 控制，方向键移动焦点、Enter 选择。
- 图标统一通过 Lucide，沿用 Icon 的名称/尺寸接口。
- Tailwind 不导入 Preflight；reset 明确初始化边框宽度/样式，避免只声明底边框时出现浏览器默认的其他边框。token 字号/间距/阴影别名同时登记给 class merge，避免字体大小与颜色互相覆盖。
- 旧 CSS Modules、五份组件/页面全局样式和旧手写 modal focus hook 已移除。全局保留 reset、tokens、utility layer 和 reduced-motion 规则；`arbor-*` 稳定 DOM hooks 仍可用于诊断和既有测试。
- AppRouter 以页面为边界 lazy load，加载反馈限定在内容区域；没有提高 Vite 警告阈值。
- `@radix-ui/react-tabs@1.2.1` 与其他 UI 依赖一样 exact pin，纳入 P13 构建合同和依赖清单检查。

## 验证记录

本次改动使用可丢弃数据库和隔离的脚本 Provider 检查界面/后端组合，不能据此宣称完成了新一轮真实模型发布资格。详见 `2026-11-14-frontend-ui-migration-result.md`。

## 合同归属

本决定对应 `docs/design/implementation/P13/05-transport-build.md` 的前端构建基线增补。它只改变 Web UI 的实现工具边界，不改变 HTTP/WS 协议、view DTO、Command Gateway、权限、安全边界或产品流程。
