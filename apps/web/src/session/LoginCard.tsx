/**
 * P13-007 login card: token + actor are explicit user inputs (frozen `01` §4
 * — memory-only session; there is no principal lookup endpoint). Connecting
 * performs NO server validation: authentication feedback arrives later as a
 * 401 `unauthenticated` problem from real requests (EC-4). The remembered
 * actor survives a disconnect (optional memory per contract) and pre-fills
 * this card.
 */
import type { FormEvent } from "react";
import { useState } from "react";
import { Button } from "../components/Button.js";
import { Card } from "../components/Card.js";
import { Field } from "../components/Field.js";
import { useSession } from "./SessionContext.js";

export function LoginCard() {
  const { actor: rememberedActor, setSession } = useSession();
  const [token, setToken] = useState("");
  const [actor, setActor] = useState(rememberedActor ?? "");
  const connect = (event: FormEvent): void => {
    event.preventDefault();
    const trimmedToken = token.trim();
    const trimmedActor = actor.trim();
    if (trimmedToken === "" || trimmedActor === "") {
      return;
    }
    setSession(trimmedToken, trimmedActor);
  };
  return (
    <div className="arbor-session-login">
      <Card title="连接 Arbor">
        <form className="arbor-command-form" onSubmit={connect}>
          <Field
            control="input"
            label="访问令牌（token）"
            placeholder="仅保存在内存，刷新页面即失效"
            value={token}
            onChange={setToken}
          />
          <Field
            control="input"
            label="执行者（actor）"
            placeholder="例如：human:root"
            value={actor}
            onChange={setActor}
          />
          <Button
            variant="primary"
            type="submit"
            disabled={token.trim() === "" || actor.trim() === ""}
          >
            连接
          </Button>
        </form>
      </Card>
    </div>
  );
}
