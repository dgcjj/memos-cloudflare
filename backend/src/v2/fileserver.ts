import { Hono } from "hono";
import type { Env } from "../types";
import { authenticate, extractRefreshToken, resolveUserFromRefreshToken } from "./auth";

// 对齐上游 server/router/fileserver：GET /file/attachments/{uid}/{filename}
// - PUBLIC 可见性的附件无需认证
// - 其余需要身份，且校验归属/可见性
//
// 关于 <img>：图片标签无法携带 Authorization 头，所以这里接受两条鉴权通道——
// 优先 Bearer access token（第三方客户端如 MoeMemos 走这条），
// 回退到 HttpOnly 的 memos_refresh cookie（浏览器 <img> 会自动携带）。
// 不能像早前那样直接删掉校验：uid 会经 Referer、日志、分享链接外泄，
// 一旦泄露即永久有效且无法吊销，等于 PRIVATE 名存实亡。
//
// ?thumbnail=true 暂回退为原图（缩略图生成列入 roadmap）
export function mountFileServer(app: Hono<{ Bindings: Env }>) {
  app.get("/file/attachments/:uid/:filename", async (c) => {
    const uid = c.req.param("uid");

    const row = await c.env.DB.prepare(
      `SELECT a.id, a.uid, a.filename, a.type, a.size, a.storage_type, a.reference, a.creator_id, m.visibility
       FROM attachment a LEFT JOIN memo m ON a.memo_id = m.id
       WHERE a.uid = ?`,
    )
      .bind(uid)
      .first<{
        id: number;
        uid: string;
        filename: string;
        type: string;
        size: number;
        storage_type: string;
        reference: string;
        creator_id: number;
        visibility: string | null;
      }>();

    if (!row) return c.text("attachment not found", 404);

    // visibility 为 null 表示附件尚未绑定到任何 memo（刚上传、编辑器预览中），
    // 此时按最严处理：只有上传者本人可读。
    if (row.visibility !== "PUBLIC") {
      let auth = await authenticate(c.req.raw, c.env);
      if (!auth) {
        const cookieToken = extractRefreshToken(c.req.raw);
        if (cookieToken) auth = await resolveUserFromRefreshToken(c.env, cookieToken);
      }
      if (!auth) return c.text("unauthenticated", 401);
      if (auth.userId !== row.creator_id && row.visibility !== "PROTECTED") {
        return c.text("permission denied", 403);
      }
    }

    if (row.storage_type === "EXTERNAL" && row.reference) {
      return c.redirect(row.reference, 302);
    }
    if (!row.reference || !c.env.R2) return c.text("file blob not available", 404);
    const object = await c.env.R2.get(row.reference);
    if (!object) return c.text("file blob not found", 404);

    return new Response(object.body, {
      headers: {
        "Content-Type": row.type || "application/octet-stream",
        "Content-Length": String(row.size || object.size),
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": `inline; filename="${encodeURIComponent(row.filename)}"`,
      },
    });
  });
}
