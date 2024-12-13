# Vercel Edge Proxy for httpbin.org

这是一个使用 Vercel Edge Functions 实现的代理服务器，用于转发请求到 httpbin.org。它提供了低延迟的全球访问能力，可用于测试、开发和调试。

## 功能特点

- 基于 Vercel Edge Functions 的全球边缘网络代理
- 支持所有标准 HTTP 方法（GET, POST, PUT, DELETE, PATCH, OPTIONS 等）
- 完整保留并转发请求头、请求体、查询参数
- 内置 CORS 支持，允许跨域请求
- 智能错误处理和状态码转发
- 零配置部署，开箱即用
