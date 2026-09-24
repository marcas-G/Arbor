# P13 — 04 Design Token System

**Owns:** `apps/web` 的 design token 词汇表与使用规则（视觉语言的唯一冻结源）
**Does not own:** 组件实现细节、布局像素值（从 tokens 派生，不入库冻结）
**Successor:** DID v1.17 TR-WPU-A supersedes only the former P13 visual styling baseline.

## 1. 原则

采用已确认设计稿的 **modern minimal light** 产品视觉：白色/暖中性 surface、
Arbor Green 为主品牌与确认强调、sans-serif 用于 UI/body、mono 仅用于 ID/revision/
timestamp/technical metadata。serif 不再是全局 UI requirement，只可作为有限的品牌或
display treatment；参考图中的蓝色不是主品牌色要求。

不复制旧 CSS 架构：以 CSS custom properties + TS token 模块为单一来源，组件一律引用
token，禁止字面量色值/字号/间距散落。此 supersession **只**改变 presentation contract；
不改变 API、Command、Event、auth、WS invalidation、server-state ownership、authority
或 P13/P14 backend boundary。

## 2. Token 词汇表（frozen）

### 2.1 Color — surfaces（现代浅色）

| Token | 语义 |
|---|---|
| `--arbor-paper` | 页面浅色/暖中性底面（历史 token 名可在实现中迁移，语义不变） |
| `--arbor-paper-2` | 卡片、elevated 与次级 surface |
| `--arbor-ink` | 主文字 |
| `--arbor-ink-soft` | 次级文字 |
| `--arbor-line` | 分隔线/描边 |

### 2.2 Color — brand（Arbor Green）

| Token | 语义 |
|---|---|
| `--arbor-leaf` | Arbor Green 主品牌/确认/正常 |
| `--arbor-leaf-bright` | Arbor Green 强调/active/focus |
| `--arbor-leaf-pale` | Arbor Green 浅强调/selected surface |
| `--arbor-branch` | 导航/链接的辅助 brand tone（不要求蓝色） |

### 2.3 Color — status

| Token | 语义 |
|---|---|
| `--arbor-attention` | Attention（黄褐/amber 系） |
| `--arbor-danger` | ActionRequired / failure（锈红/rust 系） |
| `--arbor-muted` | 未知枚举值/空位/de-emphasized |
| `--arbor-sky` | 信息/外部引用的辅助色；实现不得将其升级为主品牌蓝 |

### 2.4 Typography

| Token | 值域 |
|---|---|
| `--arbor-font-sans` | UI/body 主字体（sans-serif 栈） |
| `--arbor-font-serif` | 可选有限品牌/display treatment；不是 UI/body 默认 |
| `--arbor-font-mono` | ID/时间戳/事件类型/数据（ui-monospace 栈） |
| `--arbor-text-*` | 阶梯：display / title / body / small / caption |

### 2.5 Spacing & shape

| Token | 说明 |
|---|---|
| `--arbor-space-*` | approved product design system 的 spacing scale（不继承旧 4px/console density 限制） |
| `--arbor-radius` / `--arbor-radius-small` | approved product design system 的 radius scale；不继承 3px 限制 |
| `--arbor-shadow` | modern minimal elevation，避免重拟物/厚重 console shadow |

## 3. 使用规则

1. **组件只引用 token**：源码中出现颜色/字号/间距字面量 = 违规（lint/test
   检查；`06` EC-10）。允许的例外：token 定义文件本身。
2. **状态→token 映射表**（冻结）：
   - `WorkspaceStatusLabel` / lifecycle 徽章：正常系 → Arbor Green；阻断/失败系 →
     danger；等待/注意系 → attention；未知值 → muted（`03` §1.2）；
   - `AttentionSeverity`：`ActionRequired` → danger，`Attention` → attention；
   - verdict 徽章：通过系 → leaf，拒绝/失败系 → danger，未定/中间系 →
     attention，未知 → muted。
   具体标签名映射的补充遵循 `03` §1.2"原样呈现"优先。
3. **暗色模式**：v1 不做（token 层预留：custom properties 可整体换值，
   不改组件）。
4. **图标**：不引入图标库；用现有排版符号 + token 色（克制、modern minimal）。

## 4. Must Not Decide

- 不决定品牌视觉之外的语义色新增（新增 status token = 合同修订）；
- 不决定组件粒度/文件组织（implementation 自由）。

## 5. Verification

`06` EC-10：token 单一来源 + 组件无字面量（自动化检查）；visual implementation
授权后，token tests 的 expected family/spacing/radius/density 必须更新为本 TR，而不是
重新锁定 paper/leaf/serif 或 3px。render tests 继续断言关键状态使用 semantic token
class/var。
