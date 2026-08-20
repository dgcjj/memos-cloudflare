import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';

import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/user';
import { memoRoutes } from './routes/memo';
import { tagRoutes } from './routes/tag';
import { resourceRoutes } from './routes/resource';
import { workspaceRoutes } from './routes/workspace';
import { webhookRoutes } from './routes/webhook';
import { authMiddleware } from './middleware/auth';
import { mountConnectRoutes } from './v2/router';
import { mountFileServer } from './v2/fileserver';
import { mountRestApi } from './v2/restapi';
import './v2/services';

// 导入环境类型
import { Env } from './types';

// 创建 Hono 应用实例
const app = new Hono<{ Bindings: Env }>();

// 全局中间件
// CORS：严格白名单。单 Worker 同源部署时浏览器不发 Origin 头，
// 走 `!origin` 分支，不需要配置 ALLOWED_ORIGINS。
// 注意：这里必须精确匹配、不中就返回 null（不下发 Access-Control-Allow-Origin），
// 否则配合 credentials: true 和 SameSite=None 的 refresh cookie，
// 任意网站都能代表已登录用户调用 RefreshToken 并读走 access token。
app.use('*', cors({
  origin: (origin, c) => {
    if (!origin) return null;
    const allowed = (c.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return allowed.includes(origin) ? origin : null;
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  // Connect-Protocol-Version / Connect-Timeout-Ms 为 @connectrpc/connect-web 必发头，
  // X-Retry 为前端 401 重试标记——缺一个都会导致浏览器 CORS 预检失败
  allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Connect-Protocol-Version', 'Connect-Timeout-Ms', 'X-Retry'],
  exposeHeaders: ['X-Request-Id'],
  credentials: true,
  maxAge: 86400
}));

app.use('*', logger());
app.use('/api/*', prettyJSON());

// 健康检查端点
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'memos-cloudflare',
    version: '0.2.0'
  });
});

// ===== v2: Connect JSON API（对齐上游 Memos v0.29，前端 v0.29.1 使用） =====
mountConnectRoutes(app);
mountFileServer(app);
mountRestApi(app);

// ===== v1 legacy REST 路由（对应旧版 v0.24 前端，过渡期保留） =====
// 先注册公开的路由
app.route('/api/auth', authRoutes);

// workspace 路由 - /profile 和 /setting GET 端点是公开的
app.route('/api/workspace', workspaceRoutes);

// 需要认证的路由
app.use('/api/user/*', authMiddleware);
app.use('/api/tag/*', authMiddleware);
app.use('/api/resource/*', authMiddleware);
app.use('/api/webhook/*', authMiddleware);

// memo 路由需要部分认证
app.use('/api/memo', authMiddleware);
app.post('/api/memo/*', authMiddleware);
app.patch('/api/memo/*', authMiddleware);
app.delete('/api/memo/*', authMiddleware);

app.route('/api/user', userRoutes);
app.route('/api/memo', memoRoutes);
app.route('/api/tag', tagRoutes);
app.route('/api/resource', resourceRoutes);
app.route('/api/webhook', webhookRoutes);

// 文件下载路由 (不在 /api 下)
app.get('/o/r/:uid/:filename', async (c) => {
  try {
    const { uid, filename } = c.req.param();
    
    // 查询资源信息
    const resource = await c.env.DB.prepare(
      'SELECT * FROM resource WHERE uid = ?'
    ).bind(uid).first();

    if (!resource) {
      return c.json({ message: 'Resource not found' }, 404);
    }

    // 检查 R2 绑定是否存在
    if (!c.env.R2) {
      return c.json({ message: 'R2 bucket not configured' }, 500);
    }

    // 从 R2 获取文件
    const r2Key = `${uid}/${filename}`;
    const object = await c.env.R2.get(r2Key);

    if (!object) {
      return c.json({ message: 'File not found in storage' }, 404);
    }

    // 返回文件内容
    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Length': object.size.toString(),
        'Cache-Control': 'public, max-age=31536000',
      },
    });
  } catch (error: any) {
    console.error('File download error:', error);
    return c.json({ message: 'Internal server error' }, 500);
  }
});

// 404 处理：单 Worker 同源部署时回退到静态前端（SPA 路由如 /explore 返回 index.html）。
// 注意：只对"页面导航"类路径做这个兜底，/api/ 开头的路径必须老实返回 404 JSON。
// 曾经的教训：前端 useLiveMemoRefresh.ts 会请求一个本项目从未实现过的 /api/v1/sse
// (SSE 长连接)。如果这里把它也兜底成 200 + index.html，前端会误判"连接成功"，
// 把重连退避间隔重置回 1 秒，读完这段"假流"后又立刻重连——变成每秒一次的死循环，
// 一个开着的网页标签页一天就能刷出 8 万+ 次请求，把 Workers 免费额度吃满。
app.notFound(async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/api/')) {
    return c.json({ message: 'Not Found' }, 404);
  }
  if (c.env.ASSETS && c.req.method === 'GET') {
    const res = await c.env.ASSETS.fetch(c.req.raw);
    if (res.status !== 404) return res;
    return c.env.ASSETS.fetch(new URL('/', c.req.url).toString());
  }
  return c.json({ message: 'Not Found' }, 404);
});

// 错误处理
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ 
    message: 'Internal Server Error',
    ...(c.env.LOG_LEVEL === 'debug' && { error: err.message })
  }, 500);
});



export default app;
