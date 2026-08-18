import { Hono } from "hono";
import type { Env } from "../types";
import { invokeRpc } from "./router";
import { ConnectError } from "./connect";

// REST 兼容层：把 grpc-gateway 风格的 /api/v1/* 路径翻译成本项目已经实现的
// Connect 风格 handler 调用（/memos.api.v1.<Service>/<Method>）。
//
// 背景：第三方客户端 MoeMemos（以及其它基于官方 memos OpenAPI 规范生成客户端的
// App）不使用 Connect 协议，而是请求形如 `GET /api/v1/instance/profile`、
// `PATCH /api/v1/memos/{id}` 这样的 REST 路径。这些路径在本项目里完全没有注册，
// 会被 index.ts 的 SPA fallback 接管、返回 index.html，导致客户端报
// "Unexpected content type, expected application/json, received text/html"。
//
// 这里只翻译 MoeMemos 实际会调用的那一部分接口（instance profile / 当前用户 /
// 用户设置与统计 / memo 增删查改 / 附件增删查），复用已有的业务逻辑（鉴权、
// D1 读写、字段校验等都在原 handler 里，本文件不重复实现）。

async function restCall(
  c: any,
  key: string,
  body: Record<string, unknown>,
  transform?: (result: Record<string, unknown>) => unknown,
) {
  try {
    const result = await invokeRpc(c, key, body);
    const out = transform ? transform(result) : result;
    return c.json(out ?? {}, 200);
  } catch (err) {
    if (err instanceof ConnectError) {
      return c.json(err.toBody(), err.httpStatus as any);
    }
    console.error(`REST compat layer error (${key}):`, err);
    return c.json({ message: "Internal Server Error" }, 500);
  }
}

export function mountRestApi(app: Hono<{ Bindings: Env }>) {
  // ---------- Instance ----------
  app.get("/api/v1/instance/profile", (c) =>
    restCall(c, "memos.api.v1.InstanceService/GetInstanceProfile", {}),
  );

  // ---------- Auth ----------
  app.get("/api/v1/auth/me", (c) => restCall(c, "memos.api.v1.AuthService/GetCurrentUser", {}));

  // ---------- Users：GetUser / GetUserSetting / GetUserStats 共用一个前缀 ----------
  // 用通配符自己解析剩余路径，避开 Hono 对 "冒号自定义方法"(:getStats) 和多段路径的路由写法限制。
  app.get("/api/v1/users/*", async (c) => {
    const rest = decodeURIComponent(c.req.path.replace(/^\/api\/v1\/users\//, ""));

    // GET /api/v1/users/{user}:getStats
    const statsMatch = rest.match(/^([^/:]+):getStats$/);
    if (statsMatch) {
      const username = statsMatch[1];
      return restCall(c, "memos.api.v1.UserService/GetUserStats", { name: `users/${username}` }, (result) => ({
        ...result,
        // MoeMemos 的 openapi.yaml 用的字段名是 memoDisplayTimestamps，
        // 本项目内部拆成了 memoCreatedTimestamps/memoUpdatedTimestamps，这里补一份别名保证兼容。
        memoDisplayTimestamps: (result as any).memoCreatedTimestamps ?? [],
      }));
    }

    // GET /api/v1/users/{user}/settings/{setting}
    const settingMatch = rest.match(/^([^/]+)\/settings\/([^/]+)$/);
    if (settingMatch) {
      const [, username, setting] = settingMatch;
      // 本项目只注册了 ListUserSettings（没有单条 Get），这里取列表后按 name 过滤出目标 setting。
      return restCall(
        c,
        "memos.api.v1.UserService/ListUserSettings",
        { parent: `users/${username}` },
        (result) => {
          const settings = Array.isArray((result as any).settings) ? (result as any).settings : [];
          const found = settings.find(
            (s: any) => typeof s.name === "string" && s.name.endsWith(`/settings/${setting}`),
          );
          if (found) return found;
          if (setting === "GENERAL") {
            return {
              name: `users/${username}/settings/GENERAL`,
              generalSetting: { locale: "en", memoVisibility: "PRIVATE", theme: "" },
            };
          }
          return { name: `users/${username}/settings/${setting}` };
        },
      );
    }

    // GET /api/v1/users/{user}
    if (/^[^/]+$/.test(rest)) {
      return restCall(c, "memos.api.v1.UserService/GetUser", { name: `users/${rest}` });
    }

    return c.json({ message: "Not Found" }, 404);
  });

  // ---------- Memos ----------
  app.get("/api/v1/memos", (c) => {
    const q = c.req.query();
    const body: Record<string, unknown> = {};
    if (q.pageSize) body.pageSize = Number(q.pageSize);
    if (q.pageToken) body.pageToken = q.pageToken;
    if (q.state) body.state = q.state;
    if (q.filter) body.filter = q.filter;
    if (q.orderBy) body.orderBy = q.orderBy;
    return restCall(c, "memos.api.v1.MemoService/ListMemos", body);
  });

  app.post("/api/v1/memos", async (c) => {
    const json = await c.req.json().catch(() => ({}));
    return restCall(c, "memos.api.v1.MemoService/CreateMemo", { memo: json });
  });

  // REST 请求体的字段名（camelCase）→ 后端 UpdateMemo handler 认识的 update_mask path（snake_case）。
  // MoeMemos 不会发 updateMask，只会在请求体里放它想改的字段——这里按“出现了哪些字段”反推 mask，
  // 和前端 Web 版自己拼 updateMask 是同一个思路。
  const MEMO_FIELD_TO_PATH: Record<string, string> = {
    content: "content",
    visibility: "visibility",
    pinned: "pinned",
    state: "state",
    createTime: "create_time",
    updateTime: "update_time",
    attachments: "attachments",
    relations: "relations",
    location: "location",
  };

  app.patch("/api/v1/memos/*", async (c) => {
    const memoId = decodeURIComponent(c.req.path.replace(/^\/api\/v1\/memos\//, ""));
    const json = await c.req.json().catch(() => ({}));
    const memo: Record<string, unknown> = { name: `memos/${memoId}` };
    const paths: string[] = [];
    for (const [jsonKey, pathName] of Object.entries(MEMO_FIELD_TO_PATH)) {
      if (jsonKey in json) {
        memo[jsonKey] = (json as any)[jsonKey];
        paths.push(pathName);
      }
    }
    return restCall(c, "memos.api.v1.MemoService/UpdateMemo", { memo, updateMask: { paths } });
  });

  app.delete("/api/v1/memos/*", (c) => {
    const memoId = decodeURIComponent(c.req.path.replace(/^\/api\/v1\/memos\//, ""));
    return restCall(c, "memos.api.v1.MemoService/DeleteMemo", { name: `memos/${memoId}` });
  });

  // MoeMemos 目前不调用单条 GetMemo，这里顺手加上，方便其它 REST 风格客户端。
  app.get("/api/v1/memos/*", (c) => {
    const memoId = decodeURIComponent(c.req.path.replace(/^\/api\/v1\/memos\//, ""));
    return restCall(c, "memos.api.v1.MemoService/GetMemo", { name: `memos/${memoId}` });
  });

  // ---------- Attachments ----------
  app.get("/api/v1/attachments", (c) => {
    const q = c.req.query();
    const body: Record<string, unknown> = {};
    if (q.pageSize) body.pageSize = Number(q.pageSize);
    if (q.pageToken) body.pageToken = q.pageToken;
    if (q.orderBy) body.orderBy = q.orderBy;
    return restCall(c, "memos.api.v1.AttachmentService/ListAttachments", body);
  });

  app.post("/api/v1/attachments", async (c) => {
    const json = await c.req.json().catch(() => ({}));
    return restCall(c, "memos.api.v1.AttachmentService/CreateAttachment", { attachment: json });
  });

  app.delete("/api/v1/attachments/*", (c) => {
    const attachmentId = decodeURIComponent(c.req.path.replace(/^\/api\/v1\/attachments\//, ""));
    return restCall(c, "memos.api.v1.AttachmentService/DeleteAttachment", {
      name: `attachments/${attachmentId}`,
    });
  });
}
