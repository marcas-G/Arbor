# P13 — 05 Transport & Build Binding

**Owns:** 开发态/生产态构建与托管、WS invalidation 协议（TR-W1/W2）、前端依赖基线
**Does not own:** transport 语义（P12 `10`，除 TR-W1/W2 外不变）、view 语义

## 1. 开发态（frozen）

```text
apps/web (Vite dev server, 默认 5173)
  /views/*  /commands  → proxy → single-workspace daemon (HTTP)
  /ws                    → proxy (WS upgrade) → daemon WS shell
```

- Vite 配置只含 proxy 与路径别名；不引入 dev 期 mock 后端（数据一律真实
  daemon），保证"dev 所见 = 合同行为"。
- daemon 以既有生产 composition 启动（`P12 10` §5）；前端 token 走真实
  authenticator。

## 2. 生产态（frozen，TR-W2）

```text
vite build → apps/web/dist（static，无 server 代码）
single-workspace production daemon:
  GET /            → index.html
  GET /assets/*    → 静态资源（immutable cache 头）
  （API/WS 端点不变，同源，无需 CORS）
```

- 静态服务只做文件服务 + fallback 到 `index.html`（客户端路由）；
  **不携带任何 API/view 语义**（TR-W2 边界）。
- dist 构建产物进 CI 校验（build 成功 + 引用检查），不进 git。

## 3. WS invalidation 协议（TR-W1）

现有 WS shell（P12 `10` §2）为单发请求-响应；P13 扩展为**服务端可推送
invalidation 帧**：

```ts
// server → client push（唯一新增的 server→client 帧）
interface InvalidationFrame {
  readonly kind: "invalidate";
  readonly view: ViewId;        // 失效提示的目标视图
  readonly watermark: number;   // projection watermark 提示
}
```

规则：

1. 帧内**无 DTO payload、无 event 正文、无 view 语义**——只是 staleness
   提示；transport 不因此获得 view 解释权（P12 `10` §1 不变）。
2. 触发源：daemon 订阅 projection 更新通知（P10 freshness/watermark
   机制既有输出），按 viewId 扇出到已连接 WS 客户端；节流/合并策略属
   transport 实现自由，但**不得**把 payload 一并推给客户端。
3. client 行为（`01` §3.2）：对当前展示中且 viewId 匹配的视图 refetch；
   未展示的帧丢弃；**禁止**用帧内容更新 render cache（`01` I4）。
4. client→server 帧不变（`view` / `command` 两种，P12 `10` §2 原样）；
   HTTP `POST /views/:view` / `POST /commands` 不变。

## 4. 前端构建基线与依赖（frozen，DID §14.1 v1.15）

| 项 | 规则 |
|---|---|
| 构建 | Vite（exact pin；版本进 lockfile，升级单独变更） |
| UI | react + react-dom（exact pin；React 19 线） |
| 语言 | TypeScript（同 monorepo 版本；`apps/web` 独立 tsconfig，`verbatimModuleSyntax`/strict 对齐根） |
| 路由/状态 | 最小化：路由用 React 19 + 自维护轻方案或 react-router（exact pin，二选一在 planning 定）；**禁止**引入 redux/mobx 等全局状态库（状态纪律 `01` §3 已冻结，不需要） |
| 数据获取 | 自研 fetch 封装（合同行为小）；**禁止** react-query/swr 等 cache 库（避免第二套缓存语义） |
| 样式 | CSS custom properties + CSS Modules 或 vanilla CSS（`04` tokens）；**禁止** tailwind/styled-components 等 |
| 测试 | Vitest + @testing-library/react（或等价 DOM 测试，exact pin）；render tests 走 jsdom/happy-dom |
| lint/format | Biome（同 monorepo，不引入 ESLint/Prettier） |

**exact pin 集合**（进 `apps/web/package.json`，锁死）：vite、react、
react-dom、@types/react、@types/react-dom、路由选定项、测试选定项。
其余 frontend 依赖原则上不引入；引入新依赖 = 合同修订（`06` EC-12 校验
依赖清单与 pin 策略）。

## 5. 脚本与 CI 接线

```text
pnpm --filter @arbor/web dev      # Vite dev server
pnpm --filter @arbor/web build    # vite build → dist
pnpm --filter @arbor/web test     # Vitest（render/单元）
pnpm build / pnpm check           # 纳入根编排：web build + web test 并入全量门
```

`pnpm check`（root）保持"全绿才过 phase"的既有语义，P13 完成后包含 web
build + web tests。

## 6. Must Not Decide

- 不决定 daemon 进程模型/端口策略变更（P12 `10` §5 既有）；
- 不决定 projection 更新通知的实现细节（projection-runtime 既有机制）；
- 不决定未来 P14 chat 的传输形态。

## 7. Verification

`06` EC-5（invalidation → refetch，无本地 replay）、EC-11（dev proxy /
prod 同源托管 e2e：daemon 起服务后浏览器侧冒烟）、EC-12（依赖 exact pin）。
