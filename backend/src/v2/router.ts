import { Hono } from "hono";
import type { Env } from "../types";
import { ConnectError, internal, unauthenticated, unimplemented } from "./connect";
import { authenticate, type AuthContext } from "./auth";

// 每个 RPC handler 收到解析后的请求 JSON 与上下文，返回响应 JSON。
export interface RpcContext {
  env: Env;
  req: Request;
  auth: AuthContext | null;
  /** 响应上的 Set-Cookie 等额外头，由 handler 按需写入 */
  responseHeaders: Headers;
}

export type RpcHandler = (request: any, ctx: RpcContext) => Promise<Record<string, unknown>>;

type AuthPolicy = "required" | "optional";

interface RpcRegistration {
  handler: RpcHandler;
  auth: AuthPolicy;
}

const registry = new Map<string, RpcRegistration>();

export function rpc(service: string, method: string, auth: AuthPolicy, handler: RpcHandler) {
  registry.set(`memos.api.v1.${service}/${method}`, { handler, auth });
}

// google.protobuf.FieldMask 的标准 JSON 编码是逗号分隔的驼峰字符串
// （例如 "content,updateTime"），但下面各个 handler 期望的是
// { paths: [...] } 形式且使用下划线命名。这里统一转换一次。
// 注意：如果调用方（例如 REST 兼容层）已经直接传入 { paths: [...] } 对象，
// 这里会原样跳过——REST 层负责自己生成下划线命名的 paths。
function normalizeUpdateMask(requestBody: any) {
  if (typeof requestBody.updateMask === "string") {
    const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const paths = requestBody.updateMask
      .split(",")
      .map((p: string) => p.trim())
      .filter(Boolean)
      .map(camelToSnake);
    requestBody.updateMask = { paths };
  }
}

/**
 * 执行一次 RPC 调用并返回响应 JSON（不封装 Response）。
 * 供 Connect 协议路由（本文件的 dispatch）和 REST 兼容层（restapi.ts）共用，
 * 这样两边的鉴权 / updateMask 归一化 / handler 调用逻辑完全一致，不会出现行为分叉。
 * 失败时抛出 ConnectError，调用方自行决定如何转换成 HTTP 响应。
 */
export async function invokeRpc(
  c: any,
  key: string,
  requestBody: any,
  responseHeaders: Headers = new Headers(),
): Promise<Record<string, unknown>> {
  const registration = registry.get(key);
  if (!registration) {
    throw unimplemented(key);
  }

  normalizeUpdateMask(requestBody);

  const auth = await authenticate(c.req.raw, c.env);
  if (registration.auth === "required" && !auth) {
    throw unauthenticated();
  }

  const result = await registration.handler(requestBody, {
    env: c.env,
    req: c.req.raw,
    auth,
    responseHeaders,
  });
  return result ?? {};
}

async function dispatch(c: any, key: string, requestBody: any) {
  const responseHeaders = new Headers();
  try {
    const result = await invokeRpc(c, key, requestBody, responseHeaders);
    responseHeaders.set("Content-Type", "application/json");
    responseHeaders.set("Cache-Control", "no-store");
    return new Response(JSON.stringify(result), { status: 200, headers: responseHeaders });
  } catch (err) {
    const connectErr =
      err instanceof ConnectError ? err : internal(err instanceof Error ? err.message : "unknown error");
    if (!(err instanceof ConnectError)) {
      console.error(`RPC ${key} failed:`, err);
    }
    return new Response(JSON.stringify(connectErr.toBody()), {
      status: connectErr.httpStatus,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
}

/** 挂载 Connect JSON 路由：POST 用于常规调用，GET 用于 Connect 协议里
 *  "无副作用方法" 的调用方式（参数放在 ?message= 查询参数里）。
 *  路径形如 /memos.api.v1.<Service>/<Method>。 */
export function mountConnectRoutes(app: Hono<{ Bindings: Env }>) {
  // "."不是段分隔符，Hono 段内不支持静态前缀混写，这里用段内正则参数匹配整个 service 全名。
  const PATH = "/:service{memos\\.api\\.v1\\.[A-Za-z]+}/:method";

  app.post(PATH, async (c) => {
    const key = `${c.req.param("service")}/${c.req.param("method")}`;
    let requestBody: any = {};
    const raw = await c.req.text();
    if (raw) {
      try {
        requestBody = JSON.parse(raw);
      } catch {
        return new Response(
          JSON.stringify(new ConnectError("invalid_argument", "malformed JSON request body").toBody()),
          { status: 400, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
        );
      }
    }
    return dispatch(c, key, requestBody);
  });

  // 一些第三方客户端（例如 MoeMemos）对 GetInstanceProfile 这类只读接口会
  // 默认走 GET 调用，如果这里不支持，请求会被静态资源兜底、返回 HTML，
  // 导致客户端报 "Unexpected content type" 错误。
  app.get(PATH, async (c) => {
    const key = `${c.req.param("service")}/${c.req.param("method")}`;
    let requestBody: any = {};
    const message = c.req.query("message");
    if (message) {
      try {
        const isBase64 = c.req.query("base64") === "1";
        const jsonText = isBase64 ? atob(message.replace(/-/g, "+").replace(/_/g, "/")) : message;
        requestBody = JSON.parse(jsonText);
      } catch {
        return new Response(
          JSON.stringify(new ConnectError("invalid_argument", "malformed 'message' query parameter").toBody()),
          { status: 400, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
        );
      }
    }
    return dispatch(c, key, requestBody);
  });
}
