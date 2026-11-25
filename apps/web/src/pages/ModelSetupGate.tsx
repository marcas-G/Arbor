import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";

const messages: Record<string, string> = {
  "model-setup/authentication-failed": "服务拒绝了 API Key，请检查后重试。",
  "model-setup/provider-rejected":
    "模型服务拒绝了请求，请检查接口地址、模型名称和账户额度。",
  "model-setup/connection-failed": "无法连接模型服务，请检查地址和网络后重试。",
  "model-setup/invalid-provider-response":
    "接口没有返回有效的模型回复，请确认它支持 OpenAI Chat Completions。",
  "model-setup/invalid-endpoint":
    "请输入 HTTPS 接口地址；本机模型也可使用 HTTP。",
  "model-setup/invalid-input": "请填写接口地址、模型名称和 API Key。",
};

/** Host-owned first-run configuration precedes all project/work interactions. */
export function ModelSetupGate({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<
    "loading" | "setup" | "ready" | "unavailable"
  >("loading");
  const [endpoint, setEndpoint] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const formId = useId();

  useEffect(() => {
    if (state !== "loading") return;
    const controller = new AbortController();
    void fetch("/model-setup", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        // Embedded/test compositions predating the host configuration service
        // retain their explicit startup configuration.
        if (response.status === 404) return "ready" as const;
        if (!response.ok) throw new Error("configuration unavailable");
        const body: unknown = await response.json();
        if (
          typeof body !== "object" ||
          body === null ||
          !("configured" in body) ||
          typeof body.configured !== "boolean"
        )
          throw new Error("invalid configuration status");
        return body.configured ? ("ready" as const) : ("setup" as const);
      })
      .then((next) => {
        if (!controller.signal.aborted) setState(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("unavailable");
      });
    return () => controller.abort();
  }, [state]);

  useEffect(() => {
    if (!restarting) return;
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > 45000) {
        clearInterval(timer);
        setProblem("配置已保存，但 Arbor 尚未重新连接。请刷新页面查看状态。");
        setRestarting(false);
        return;
      }
      void fetch("/model-setup", {
        signal: controller.signal,
        cache: "no-store",
      })
        .then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { configured?: boolean };
          if (!controller.signal.aborted && body.configured === true)
            window.location.reload();
        })
        .catch(() => {});
    }, 1000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [restarting]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch("/model-setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint, model, apiKey }),
        signal: AbortSignal.timeout(65000),
      });
      const body = (await response.json()) as { ok?: boolean; code?: string };
      if (!response.ok || body.ok !== true) {
        setProblem(
          messages[body.code ?? ""] ??
            "配置未能保存，请检查连接和本机配置目录后重试。",
        );
        return;
      }
      setApiKey("");
      setRestarting(true);
    } catch {
      setProblem("未能确认配置是否保存，请刷新页面检查状态后再尝试。");
    } finally {
      setBusy(false);
    }
  };

  if (state === "ready") return children;
  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <h1 className="mb-3 text-heading font-semibold">配置 Arbor 的模型</h1>
      {state === "loading" ? (
        <p role="status">正在读取模型配置…</p>
      ) : state === "unavailable" ? (
        <>
          <p role="alert">暂时无法读取模型配置，请确认 Arbor 服务已启动。</p>
          <Button onClick={() => setState("loading")}>重新连接</Button>
        </>
      ) : (
        <>
          <p className="mb-6 text-muted-foreground">
            先连接真实模型，再打开项目开始工作。目前此入口支持 OpenAI 兼容接口。
          </p>
          <form
            onSubmit={(event) => {
              void submit(event);
            }}
            className="flex flex-col gap-4"
          >
            <label
              htmlFor={`${formId}-endpoint`}
              className="flex flex-col gap-1"
            >
              接口地址
              <Input
                id={`${formId}-endpoint`}
                type="url"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="https://api.example.com/v1"
                required
                disabled={busy || restarting}
              />
            </label>
            <label htmlFor={`${formId}-model`} className="flex flex-col gap-1">
              模型名称
              <Input
                id={`${formId}-model`}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="服务商提供的模型名称"
                required
                disabled={busy || restarting}
              />
            </label>
            <label htmlFor={`${formId}-key`} className="flex flex-col gap-1">
              API Key
              <Input
                id={`${formId}-key`}
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                required
                disabled={busy || restarting}
              />
            </label>
            <p className="text-small text-muted-foreground">
              连接检查会向你填写的接口发送一次简短模型请求。凭据保存在本机私有文件中。
            </p>
            {problem !== null && <p role="alert">{problem}</p>}
            {restarting ? (
              <p role="status">连接成功，配置已保存，正在重新连接 Arbor…</p>
            ) : (
              <Button type="submit" variant="primary" loading={busy}>
                连接并保存
              </Button>
            )}
          </form>
        </>
      )}
    </main>
  );
}
