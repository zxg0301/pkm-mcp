# MCP Filestore Server

一个基于 Model Context Protocol (MCP) 的知识库文件存储服务。

## 功能

- 通过 MCP Tools 管理知识文档（增删改查）
- 支持从本地目录扫描并入库
- 支持 OAH (Open Agent Harness) sandbox 导入/导出
- 附件存储于 MinIO，元数据存储于 PostgreSQL

## Tools

| Tool | 说明 |
|------|------|
| `add_to_knowledge_base` | 添加知识文档 |
| `scan_directory` | 扫描本地目录入库 |
| `import_from_oah` | 从 OAH sandbox 导入 |
| `export_to_oah` | 导出到 OAH sandbox |
| `list_knowledge_docs` | 列出知识文档 |
| `get_knowledge_doc` | 获取文档详情 |
| `search_knowledge_files` | 关键词搜索 |
| `search_and_download_files` | 搜索并下载附件 |
| `export_knowledge_doc_to_cwd` | 导出 Markdown 到当前目录 |
| `delete_knowledge_doc` | 删除文档 |
| `list_attachments` | 列出附件 |
| `get_attachment` | 下载附件 (base64) |
| `delete_attachment` | 删除附件 |

## 环境变量

复制 `.env.example` 为 `.env` 并填写：

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | PostgreSQL 连接字符串 |
| `MINIO_ENDPOINT` | MinIO 地址 |
| `MINIO_PORT` | MinIO 端口 |
| `MINIO_ACCESS_KEY` | MinIO 访问密钥 |
| `MINIO_SECRET_KEY` | MinIO 秘密密钥 |
| `MINIO_BUCKET` | MinIO Bucket 名称 |
| `OAH_BASE_URL` | OAH 服务地址（可选） |
| `MCP_TRANSPORT` | `stdio` 或 `http` |
| `MCP_PORT` | HTTP 模式端口 |

## 安装与运行

```bash
cd mcp-server
npm install
cp .env.example .env
# 编辑 .env 填写配置
npm run build
npm start
```

## 开发模式

```bash
npx tsx src/index.ts
```
