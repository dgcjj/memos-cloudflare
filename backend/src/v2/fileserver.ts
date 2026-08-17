import { Hono } from "hono";
import type { Env } from "../types";

// 对齐上游 server/router/fileserver：GET /file/attachments/{uid}/{filename}
// 注意：<img> 标签发起的请求无法携带 Authorization 头，如果这里强制要求
// Bearer token 鉴权，笔记里除 PUBLIC 之外的所有图片都会显示成裂图。
// uid 是随机生成、足够长，这里放宽为"知道这个链接即可查看"（类似网盘的
// 分享链接），不再强制登录校验。
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
