# P13 — 04 Design Token System

**Owns:** `apps/web` 的 design token 词汇表与使用规则（视觉语言的唯一冻结源）
**Does not own:** 组件实现细节、布局像素值（从 tokens 派生，不入库冻结）

## 1. 原则

继承旧 console 的**植物学纸面**视觉语言（paper/leaf/serif），**不复制旧 CSS
架构**：旧架构为单文件内联 CSS；P13 以 CSS custom properties + TS token
模块为单一来源，组件一律引用 token，禁止字面量色值/字号散落。

## 2. Token 词汇表（frozen）

### 2.1 Color — ground（纸面）

| Token | 语义 |
|---|---|
| `--arbor-paper` | 页面底色（暖纸） |
| `--arbor-paper-2` | 卡片/次级面 |
| `--arbor-ink` | 主文字 |
| `--arbor-ink-soft` | 次级文字 |
| `--arbor-line` | 分隔线/描边 |

### 2.2 Color — brand（枝叶）

| Token | 语义 |
|---|---|
| `--arbor-leaf` | 主品牌/确认/正常 |
| `--arbor-leaf-bright` | 强调/active |
| `--arbor-leaf-pale` | 选中底/浅强调 |
| `--arbor-branch` | 链接/下钻/导航 |

### 2.3 Color — status

| Token | 语义 |
|---|---|
| `--arbor-attention` | Attention（黄褐/amber 系） |
| `--arbor-danger` | ActionRequired / failure（锈红/rust 系） |
| `--arbor-muted` | 未知枚举值/空位/de-emphasized |
| `--arbor-sky` | 信息/外部引用（次要信息蓝灰） |

### 2.4 Typography

| Token | 值域 |
|---|---|
| `--arbor-font-serif` | 面文字/UI 主字体（Palatino/Georgia 系 serif 栈） |
| `--arbor-font-mono` | ID/时间戳/事件类型/数据（ui-monospace 栈） |
| `--arbor-text-*` | 阶梯：display / title / body / small / caption |

### 2.5 Spacing & shape

| Token | 说明 |
|---|---|
| `--arbor-space-1..6` | 4px 基比例阶梯 |
| `--arbor-radius` / `--arbor-radius-small` | 纸面圆角（小值，克制） |
| `--arbor-shadow` | 单一卡片阴影等级 |

## 3. 使用规则

1. **组件只引用 token**：源码中出现颜色/字号/间距字面量 = 违规（lint/test
   检查；`06` EC-10）。允许的例外：token 定义文件本身。
2. **状态→token 映射表**（冻结）：
   - `WorkspaceStatusLabel` / lifecycle 徽章：正常系 → leaf；阻断/失败系 →
     danger；等待/注意系 → attention；未知值 → muted（`03` §1.2）；
   - `AttentionSeverity`：`ActionRequired` → danger，`Attention` → attention；
   - verdict 徽章：通过系 → leaf，拒绝/失败系 → danger，未定/中间系 →
     attention，未知 → muted。
   具体标签名映射的补充遵循 `03` §1.2"原样呈现"优先。
3. **暗色模式**：v1 不做（token 层预留：custom properties 可整体换值，
   不改组件）。
4. **图标**：不引入图标库；用排版符号 + token 色（克制，纸面感）。

## 4. Must Not Decide

- 不决定品牌视觉之外的语义色新增（新增 status token = 合同修订）；
- 不决定组件粒度/文件组织（implementation 自由）。

## 5. Verification

`06` EC-10：token 单一来源 + 组件无字面量（自动化检查）；render tests
断言关键状态使用预期 token class/var。
