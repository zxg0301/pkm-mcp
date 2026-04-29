#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createServer } from "node:http";
import {
  pool,
  minioClient,
  MINIO_BUCKET,
  ensureSchema,
  isTextFile,
  scanDir,
  type ScannedFile,
  guessMimeType,
  slugifyFileName,
  safeJoinUnder,
} from "./common.js";

// ── OAH Sandbox Files API 客户端 ──
const OAH_BASE_URL = process.env.OAH_BASE_URL ?? "";

async function oahRequest(path: string, options: RequestInit = {}): Promise<Response> {
  if (!OAH_BASE_URL) {
    throw new Error("OAH_BASE_URL is not configured");
  }
  const url = `${OAH_BASE_URL}/api/v1${path}`;
  const resp = await fetch(url, options);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OAH API error ${resp.status}: ${body}`);
  }
  return resp;
}

async function resolveSandboxId(workspaceId: string): Promise<string> {
  const resp = await oahRequest("/sandboxes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  const data = (await resp.json()) as { id: string };
  return data.id;
}

async function getSandboxRoot(sandboxId: string): Promise<string> {
  const resp = await oahRequest(`/sandboxes/${sandboxId}`);
  const data = (await resp.json()) as { rootPath: string };
  return data.rootPath || "/workspace";
}

async function oahListAllFiles(sandboxId: string, dirPath: string): Promise<{ path: string; name: string; size: number; type: string }[]> {
  const results: { path: string; name: string; size: number; type: string }[] = [];
  try {
    const resp = await oahRequest(
      `/sandboxes/${sandboxId}/files/entries?path=${encodeURIComponent(dirPath)}`,
    );
    const data = (await resp.json()) as { items: { path: string; name: string; size?: number; type?: string; isDirectory?: boolean }[] };
    for (const item of data.items ?? []) {
      if (item.isDirectory || item.type === "directory") {
        const subFiles = await oahListAllFiles(sandboxId, item.path);
        results.push(...subFiles);
      } else {
        results.push({ path: item.path, name: item.name, size: item.size ?? 0, type: item.type ?? "file" });
      }
    }
  } catch {
    // 目录不存在或不可读
  }
  return results;
}

async function oahReadFileContent(sandboxId: string, filePath: string): Promise<string> {
  const resp = await oahRequest(
    `/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(filePath)}`,
  );
  const data = (await resp.json()) as { content: string; encoding?: string };
  if (data.encoding === "base64") {
    return Buffer.from(data.content, "base64").toString("utf-8");
  }
  return data.content;
}

async function oahDownloadFileBuffer(sandboxId: string, filePath: string): Promise<Buffer> {
  const resp = await oahRequest(
    `/sandboxes/${sandboxId}/files/download?path=${encodeURIComponent(filePath)}`,
  );
  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

async function oahWriteFile(sandboxId: string, sandboxPath: string, content: string): Promise<void> {
  await oahRequest(
    `/sandboxes/${sandboxId}/files/content?path=${encodeURIComponent(sandboxPath)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
}

async function oahUploadFile(sandboxId: string, sandboxPath: string, content: Buffer, contentType: string): Promise<void> {
  await oahRequest(
    `/sandboxes/${sandboxId}/files/upload?path=${encodeURIComponent(sandboxPath)}`,
    {
      method: "PUT",
      headers: { "content-type": contentType },
      body: content as any,
    },
  );
}

async function fetchWorkspaceOwnerId(workspaceId: string): Promise<number | undefined> {
  const resp = await oahRequest(`/workspaces/${encodeURIComponent(workspaceId)}`);
  const data = (await resp.json()) as { id: string; ownerId?: string };
  if (!data.ownerId || data.ownerId.trim() === "") return undefined;
  const parsed = Number.parseInt(data.ownerId, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ── MCP Server ──
const server = new McpServer({
  name: "mcp-filestore",
  version: "0.2.0",
});

// ── Tool: 加入知识库 ──
server.tool(
  "add_to_knowledge_base",
  "Add knowledge content to the personal knowledge base.",
  {
    title: z.string().describe("Title for the knowledge document"),
    summary_md: z.string().describe("Markdown content summarizing the knowledge points"),
    tags: z.string().optional().describe("Optional comma-separated tags"),
    file_paths: z.array(z.string()).optional().describe("Files to attach"),
    workspace_id: z.string().optional().describe("OAH workspace ID to resolve ownerId as userId"),
  },
  async ({ title, summary_md, tags, file_paths, workspace_id }) => {
    let userId = 0;
    if (workspace_id) {
      try {
        const ownerId = await fetchWorkspaceOwnerId(workspace_id);
        if (ownerId !== undefined) userId = ownerId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to resolve ownerId for workspace ${workspace_id}:`, msg);
      }
    }

    const metaLines: string[] = [];
    metaLines.push(`# ${title}`);
    metaLines.push("");
    if (tags) metaLines.push(`- Tags: ${tags}`);
    metaLines.push(`- Created: ${new Date().toISOString()}`);
    if (file_paths && file_paths.length > 0) {
      metaLines.push(`- Attachments: ${file_paths.join(", ")}`);
    }
    metaLines.push("");
    metaLines.push("---");
    metaLines.push("");
    const fullMd = metaLines.join("\n") + summary_md;

    const { rows } = await pool.query(
      `INSERT INTO PKM.knowledge_docs (user_id, title, summary_md, source_files, tags)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id, title, created_at`,
      [userId, title, fullMd, "[]", tags ?? null],
    );
    const docId = rows[0].id;

    const sourceFiles: { path: string; ext: string; isText: boolean; size: number }[] = [];
    const attachmentResults: { file_name: string; minio_key: string; content_type: string; file_size: number }[] = [];
    const fileNameCount = new Map<string, number>();

    if (file_paths && file_paths.length > 0) {
      for (const filePath of file_paths) {
        try {
          const fileStat = await stat(filePath);
          if (!fileStat.isFile()) continue;
          if (fileStat.size > 100 * 1024 * 1024) continue;

          const fileBuf = await readFile(filePath);
          const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
          const ext = extname(filePath).toLowerCase();
          const contentType = guessMimeType(filePath);

          const count = fileNameCount.get(fileName) ?? 0;
          fileNameCount.set(fileName, count + 1);
          const uniqueName = count > 0
            ? `${fileName.replace(/(\.[^.]+)$/, `_${count + 1}$1`)}`
            : fileName;
          const minioKey = `${docId}/${uniqueName}`;

          await minioClient.putObject(MINIO_BUCKET, minioKey, fileBuf, fileBuf.length, { "Content-Type": contentType });
          await pool.query(
            `INSERT INTO PKM.attachments (doc_id, file_name, minio_key, content_type, file_size) VALUES ($1,$2,$3,$4,$5)`,
            [docId, uniqueName, minioKey, contentType, fileBuf.length],
          );

          sourceFiles.push({ path: uniqueName, ext, isText: isTextFile(filePath), size: fileBuf.length });
          attachmentResults.push({ file_name: uniqueName, minio_key: minioKey, content_type: contentType, file_size: fileBuf.length });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Upload failed for ${filePath}:`, msg);
        }
      }
      await pool.query(`UPDATE PKM.knowledge_docs SET source_files = $1::jsonb WHERE id = $2`, [JSON.stringify(sourceFiles), docId]);
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ doc_id: docId, title, tags: tags ?? null, attachments: attachmentResults }, null, 2) }],
    };
  },
);

// ── Tool: 从 OAH sandbox 导入 ──
server.tool(
  "import_from_oah",
  "Import documents from an OAH sandbox into the knowledge base.",
  {
    workspace_id: z.string().describe("OAH workspace ID"),
    dir_path: z.string().optional(),
    title: z.string().optional(),
    tags: z.string().optional(),
  },
  async ({ workspace_id, dir_path, title, tags }) => {
    if (!OAH_BASE_URL) {
      return { content: [{ type: "text" as const, text: "OAH_BASE_URL not configured" }], isError: true };
    }
    let userId = 0;
    try {
      const ownerId = await fetchWorkspaceOwnerId(workspace_id);
      if (ownerId !== undefined) userId = ownerId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to resolve ownerId for workspace ${workspace_id}:`, msg);
    }

    const sandboxId = await resolveSandboxId(workspace_id);
    const sandboxRoot = await getSandboxRoot(sandboxId);
    const scanPath = dir_path?.trim() || sandboxRoot;

    const allFiles = await oahListAllFiles(sandboxId, scanPath);
    const textFiles = allFiles.filter((f) => isTextFile(f.name));
    const binaryFiles = allFiles.filter((f) => !isTextFile(f.name));

    const docTitle = title ?? `OAH Import ${new Date().toISOString().slice(0, 19)}`;
    const lines: string[] = [`# ${docTitle}`, "", `- Source: OAH sandbox (${workspace_id})`, `- Path: ${scanPath}`, `- Imported: ${new Date().toISOString()}`];
    if (tags) lines.push(`- Tags: ${tags}`);
    lines.push("", "---", "", "## Files", "");
    for (const f of textFiles) lines.push(`- [TEXT] ${f.name} (${(f.size / 1024).toFixed(1)} KB)`);
    for (const f of binaryFiles) lines.push(`- [BINARY] ${f.name} (${(f.size / 1024).toFixed(1)} KB)`);

    const summaryMd = lines.join("\n");
    const { rows } = await pool.query(
      `INSERT INTO PKM.knowledge_docs (user_id, title, summary_md, source_files, tags) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING id`,
      [userId, docTitle, summaryMd, JSON.stringify(allFiles.map((f) => ({ path: f.name, ext: extname(f.name).toLowerCase(), isText: isTextFile(f.name), size: f.size }))), tags ?? null],
    );
    const docId = rows[0].id;

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ doc_id: docId, title: docTitle, text_files: textFiles.length, binary_files: binaryFiles.length }, null, 2) }],
    };
  },
);

// ── Tool: 导出到 OAH sandbox ──
server.tool(
  "export_to_oah",
  "Export knowledge docs to an OAH workspace sandbox.",
  {
    workspace_id: z.string(),
    doc_ids: z.array(z.number().int()).optional(),
    query: z.string().optional(),
    subdir: z.string().optional(),
  },
  async ({ workspace_id, doc_ids, query, subdir }) => {
    if (!OAH_BASE_URL) {
      return { content: [{ type: "text" as const, text: "OAH_BASE_URL not configured" }], isError: true };
    }
    const sandboxId = await resolveSandboxId(workspace_id);
    const sandboxRoot = await getSandboxRoot(sandboxId);
    const baseDir = subdir?.trim() ? `${sandboxRoot}/${subdir.trim().replace(/^\/+/, "")}` : sandboxRoot;

    let docs: any[];
    if (doc_ids && doc_ids.length > 0) {
      const { rows } = await pool.query(`SELECT id, title, summary_md FROM PKM.knowledge_docs WHERE id = ANY($1) ORDER BY created_at DESC`, [doc_ids]);
      docs = rows;
    } else if (query?.trim()) {
      const q = `%${query.trim()}%`;
      const { rows } = await pool.query(`SELECT id, title, summary_md FROM PKM.knowledge_docs WHERE title ILIKE $1 OR summary_md ILIKE $1 ORDER BY created_at DESC`, [q]);
      docs = rows;
    } else {
      const { rows } = await pool.query(`SELECT id, title, summary_md FROM PKM.knowledge_docs ORDER BY created_at DESC`);
      docs = rows;
    }

    if (docs.length === 0) return { content: [{ type: "text" as const, text: "No matching documents found." }] };

    const results: { doc_id: number; title: string | null; exported: boolean }[] = [];
    for (const doc of docs) {
      const docDirName = slugifyFileName(doc.title ?? `doc-${doc.id}`);
      try {
        const summaryPath = `${baseDir}/${docDirName}/README.md`;
        await oahWriteFile(sandboxId, summaryPath, doc.summary_md ?? "");
        results.push({ doc_id: doc.id, title: doc.title, exported: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ doc_id: doc.id, title: doc.title, exported: false });
        console.error(`Export failed for doc ${doc.id}:`, msg);
      }
    }

    return { content: [{ type: "text" as const, text: JSON.stringify({ exported: results.filter((r) => r.exported).length, results }, null, 2) }] };
  },
);

// ── Tool: 扫描目录 ──
server.tool(
  "scan_directory",
  "Scan a local directory and store its summary in the knowledge base.",
  {
    directory: z.string().describe("Absolute directory path to scan"),
    title: z.string().optional(),
  },
  async ({ directory, title }) => {
    const files = await scanDir(directory, directory);
    const textFiles = files.filter((f) => f.isText);
    const binaryFiles = files.filter((f) => !f.isText);

    const docTitle = title ?? directory.split(/[/\\]/).pop() ?? directory;
    const lines: string[] = [`# ${docTitle}`, "", `Scanned: ${directory}`, `Text files: ${textFiles.length} | Binary files: ${binaryFiles.length}`, "", "## Files"];
    for (const f of textFiles) lines.push(`- [TEXT] ${f.relativePath} (${(f.size / 1024).toFixed(1)} KB)`);
    for (const f of binaryFiles) lines.push(`- [BINARY] ${f.relativePath} (${(f.size / 1024).toFixed(1)} KB)`);

    const summaryMd = lines.join("\n");
    const { rows } = await pool.query(
      `INSERT INTO PKM.knowledge_docs (user_id, title, summary_md, source_files) VALUES (0,$1,$2,$3::jsonb) RETURNING id`,
      [docTitle, summaryMd, JSON.stringify(files.map((f) => ({ path: f.relativePath, ext: f.ext, isText: f.isText, size: f.size })))],
    );
    const docId = rows[0].id;

    const attachmentResults: { file_name: string; minio_key: string; content_type: string; file_size: number }[] = [];
    for (const f of files) {
      if (f.size > 100 * 1024 * 1024) continue;
      try {
        const minioKey = `${docId}/${f.relativePath}`;
        const fileBuf = await readFile(f.path);
        const contentType = guessMimeType(f.path);
        await minioClient.putObject(MINIO_BUCKET, minioKey, fileBuf, f.size, { "Content-Type": contentType });
        await pool.query(
          `INSERT INTO PKM.attachments (doc_id, file_name, minio_key, content_type, file_size) VALUES ($1,$2,$3,$4,$5)`,
          [docId, f.relativePath, minioKey, contentType, f.size],
        );
        attachmentResults.push({ file_name: f.relativePath, minio_key: minioKey, content_type: contentType, file_size: f.size });
      } catch (err) {
        console.error(`Upload failed for ${f.path}:`, err);
      }
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ doc_id: docId, title: docTitle, files_scanned: files.length, attachments: attachmentResults.length }, null, 2) }],
    };
  },
);

// ── Tool: 导出知识文档到当前目录 ──
server.tool(
  "export_knowledge_doc_to_cwd",
  "Export a knowledge doc markdown to the current working directory.",
  {
    id: z.number().int(),
    file_name: z.string().optional(),
    subdir: z.string().optional(),
  },
  async ({ id, file_name, subdir }) => {
    const { rows } = await pool.query(`SELECT id, title, summary_md FROM PKM.knowledge_docs WHERE id = $1`, [id]);
    if (rows.length === 0) return { content: [{ type: "text" as const, text: `Doc id=${id} not found` }], isError: true };

    const doc = rows[0];
    const baseName = (file_name?.trim() || `${doc.title ?? "untitled"}.md`).replace(/\.md$/i, "") + ".md";
    const targetDir = subdir?.trim() ? join(process.cwd(), subdir.trim()) : process.cwd();
    await mkdir(targetDir, { recursive: true });
    const outPath = join(targetDir, baseName);
    await writeFile(outPath, doc.summary_md, "utf-8");

    return { content: [{ type: "text" as const, text: JSON.stringify({ doc_id: doc.id, title: doc.title, path: outPath }, null, 2) }] };
  },
);

// ── Tool: 列出知识文档 ──
server.tool(
  "list_knowledge_docs",
  "List knowledge documents.",
  { limit: z.number().int().optional().default(50) },
  async ({ limit }) => {
    const { rows } = await pool.query(
      `SELECT id, title, tags, created_at, (SELECT count(*) FROM PKM.attachments WHERE doc_id = PKM.knowledge_docs.id) AS attachment_count FROM PKM.knowledge_docs ORDER BY created_at DESC LIMIT ${limit}`,
    );
    return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
  },
);

// ── Tool: 获取知识文档详情 ──
server.tool(
  "get_knowledge_doc",
  "Get a knowledge document by ID.",
  { id: z.number().int() },
  async ({ id }) => {
    const { rows } = await pool.query(`SELECT * FROM PKM.knowledge_docs WHERE id = $1`, [id]);
    if (rows.length === 0) return { content: [{ type: "text" as const, text: `Doc id=${id} not found` }], isError: true };
    const { rows: atts } = await pool.query(`SELECT * FROM PKM.attachments WHERE doc_id = $1 ORDER BY created_at`, [id]);
    return { content: [{ type: "text" as const, text: JSON.stringify({ ...rows[0], attachments: atts }, null, 2) }] };
  },
);

// ── Tool: 搜索知识库 ──
server.tool(
  "search_knowledge_files",
  "Search knowledge docs by keyword.",
  { query: z.string().min(1), limit: z.number().int().optional().default(20) },
  async ({ query, limit }) => {
    const q = `%${query}%`;
    const { rows } = await pool.query(
      `SELECT id, title, tags, created_at, summary_md, source_files FROM PKM.knowledge_docs WHERE title ILIKE $1 OR summary_md ILIKE $1 OR tags ILIKE $1 ORDER BY created_at DESC LIMIT $2`,
      [q, limit],
    );
    return { content: [{ type: "text" as const, text: JSON.stringify({ query, results: rows }, null, 2) }] };
  },
);

// ── Tool: 搜索并下载相关文件 ──
server.tool(
  "search_and_download_files",
  "Search docs and download attachments to current working directory.",
  { query: z.string().min(1), doc_limit: z.number().int().optional().default(10), max_files: z.number().int().optional().default(30), subdir: z.string().optional() },
  async ({ query, doc_limit, max_files, subdir }) => {
    const q = `%${query}%`;
    const { rows: docs } = await pool.query(
      `SELECT id, title FROM PKM.knowledge_docs WHERE title ILIKE $1 OR summary_md ILIKE $1 ORDER BY created_at DESC LIMIT $2`,
      [q, doc_limit],
    );
    const baseDir = subdir?.trim() ? safeJoinUnder(process.cwd(), subdir.trim()) : process.cwd();
    await mkdir(baseDir, { recursive: true });

    const downloads: any[] = [];
    let remaining = Math.max(0, max_files);
    for (const doc of docs as Array<{ id: number; title: string | null }>) {
      if (remaining <= 0) break;
      const { rows: atts } = await pool.query(`SELECT id, file_name, minio_key FROM PKM.attachments WHERE doc_id = $1`, [doc.id]);
      for (const att of atts as Array<{ id: number; file_name: string; minio_key: string }>) {
        if (remaining <= 0) break;
        const outPath = safeJoinUnder(safeJoinUnder(baseDir, doc.title ?? "untitled"), att.file_name);
        try {
          await mkdir(dirname(outPath), { recursive: true });
          const dataStream = await minioClient.getObject(MINIO_BUCKET, att.minio_key);
          await pipeline(dataStream as any, createWriteStream(outPath));
          downloads.push({ doc_id: doc.id, attachment_id: att.id, file_name: att.file_name, path: outPath });
          remaining--;
        } catch (err) {
          console.error(`Download failed for ${att.file_name}:`, err);
        }
      }
    }
    return { content: [{ type: "text" as const, text: JSON.stringify({ docs: docs.length, downloaded: downloads.length, downloads }, null, 2) }] };
  },
);

// ── Tool: 删除知识文档 ──
server.tool(
  "delete_knowledge_doc",
  "Delete a knowledge document.",
  { id: z.number().int() },
  async ({ id }) => {
    const { rows: atts } = await pool.query(`SELECT minio_key FROM PKM.attachments WHERE doc_id = $1`, [id]);
    for (const att of atts) {
      try { await minioClient.removeObject(MINIO_BUCKET, att.minio_key); } catch {}
    }
    const { rowCount } = await pool.query(`DELETE FROM PKM.knowledge_docs WHERE id = $1`, [id]);
    if (rowCount === 0) return { content: [{ type: "text" as const, text: `Doc id=${id} not found` }], isError: true };
    return { content: [{ type: "text" as const, text: `Doc id=${id} deleted (${atts.length} attachments)` }] };
  },
);

// ── Tool: 下载附件 ──
server.tool(
  "get_attachment",
  "Download an attachment by ID (returns base64).",
  { id: z.number().int() },
  async ({ id }) => {
    const { rows } = await pool.query(`SELECT * FROM PKM.attachments WHERE id = $1`, [id]);
    if (rows.length === 0) return { content: [{ type: "text" as const, text: `Attachment id=${id} not found` }], isError: true };
    const att = rows[0];
    const dataStream = await minioClient.getObject(MINIO_BUCKET, att.minio_key);
    const chunks: Buffer[] = [];
    for await (const chunk of dataStream) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    return {
      content: [{
        type: "resource" as const,
        resource: { uri: `minio://${MINIO_BUCKET}/${att.minio_key}`, mimeType: att.content_type, text: buf.toString("base64") },
      }],
    };
  },
);

// ── Tool: 列出附件 ──
server.tool(
  "list_attachments",
  "List attachments for a document.",
  { doc_id: z.number().int() },
  async ({ doc_id }) => {
    const { rows } = await pool.query(`SELECT * FROM PKM.attachments WHERE doc_id = $1 ORDER BY created_at`, [doc_id]);
    return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
  },
);

// ── Tool: 删除附件 ──
server.tool(
  "delete_attachment",
  "Delete an attachment.",
  { id: z.number().int() },
  async ({ id }) => {
    const { rows } = await pool.query(`SELECT minio_key FROM PKM.attachments WHERE id = $1`, [id]);
    if (rows.length === 0) return { content: [{ type: "text" as const, text: `Attachment id=${id} not found` }], isError: true };
    try { await minioClient.removeObject(MINIO_BUCKET, rows[0].minio_key); } catch {}
    await pool.query(`DELETE FROM PKM.attachments WHERE id = $1`, [id]);
    return { content: [{ type: "text" as const, text: `Attachment id=${id} deleted` }] };
  },
);

// ── Resource: 知识文档列表 ──
server.resource("knowledge-docs", "pkm://knowledge-docs", async (uri: URL) => {
  const { rows } = await pool.query(`SELECT id, title, tags, created_at, (SELECT count(*) FROM PKM.attachments WHERE doc_id = PKM.knowledge_docs.id) AS attachment_count FROM PKM.knowledge_docs ORDER BY created_at DESC LIMIT 100`);
  return { contents: [{ uri: uri.href, text: JSON.stringify(rows, null, 2) }] };
});

// ── 启动 ──
const MCP_TRANSPORT = process.env.MCP_TRANSPORT ?? "stdio";
const MCP_PORT = parseInt(process.env.MCP_PORT ?? "3000", 10);

async function main() {
  await ensureSchema();

  if (MCP_TRANSPORT === "http") {
    const httpServer = createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    httpServer.listen(MCP_PORT, () => {
      console.log(`MCP server (HTTP) listening on http://0.0.0.0:${MCP_PORT}/mcp`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((err) => {
  console.error("MCP server failed:", err);
  process.exit(1);
});
