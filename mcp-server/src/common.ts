import pg from "pg";
import * as Minio from "minio";
import { extname, join, relative } from "node:path";
import { readdir, stat } from "node:fs/promises";

const { Pool } = pg;

// ── PG 连接 ──
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("Environment variable DATABASE_URL is required");
}
export const pool = new Pool({ connectionString: DATABASE_URL });

// ── MinIO 连接 ──
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "127.0.0.1";
const MINIO_PORT = parseInt(process.env.MINIO_PORT ?? "9000", 10);
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY;
if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
  throw new Error("Environment variables MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required");
}

export const minioClient = new Minio.Client({
  endPoint: MINIO_ENDPOINT,
  port: MINIO_PORT,
  useSSL: process.env.MINIO_USE_SSL === "true",
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
  region: process.env.MINIO_REGION ?? "us-east-1",
});
export const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "knowledgemap";

// ── 确保表和 bucket 存在 ──
export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS PKM.knowledge_docs (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL DEFAULT 0,
      title         TEXT,
      summary_md    TEXT NOT NULL,
      source_files  JSONB DEFAULT '[]',
      tags          TEXT,
      created_at    TIMESTAMPTZ DEFAULT now()
    );
  `);
  try {
    await pool.query(`ALTER TABLE PKM.knowledge_docs ADD COLUMN IF NOT EXISTS tags TEXT`);
  } catch {
    // ignore
  }
  try {
    await pool.query(`ALTER TABLE PKM.knowledge_docs ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // ignore
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS PKM.attachments (
      id            SERIAL PRIMARY KEY,
      doc_id        INTEGER NOT NULL REFERENCES PKM.knowledge_docs(id) ON DELETE CASCADE,
      file_name     TEXT NOT NULL,
      minio_key     TEXT NOT NULL,
      content_type  TEXT,
      file_size     BIGINT,
      created_at    TIMESTAMPTZ DEFAULT now()
    );
  `);
  const exists = await minioClient.bucketExists(MINIO_BUCKET);
  if (!exists) {
    await minioClient.makeBucket(MINIO_BUCKET);
  }
}

// ── 判断文件是否为文本文件 ──
export const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".csv", ".json", ".yaml", ".yml", ".toml",
  ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp",
  ".rb", ".php", ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".html", ".htm", ".css", ".scss", ".less",
  ".xml", ".svg", ".env", ".gitignore", ".dockerfile",
  ".makefile", ".cmake", ".gradle", ".properties",
  ".ini", ".cfg", ".conf", ".log",
]);

export function isTextFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const name = filePath.toLowerCase().split(/[/\\]/).pop() ?? "";
  if (
    name === "dockerfile" ||
    name === "makefile" ||
    name === "readme" ||
    name === "license" ||
    name === "changelog"
  )
    return true;
  return false;
}

// ── 递归扫描目录 ──
export interface ScannedFile {
  path: string;
  relativePath: string;
  ext: string;
  isText: boolean;
  size: number;
}

export async function scanDir(
  dir: string,
  baseDir: string,
  maxDepth = 5,
  depth = 0,
): Promise<ScannedFile[]> {
  if (depth > maxDepth) return [];
  const results: ScannedFile[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await scanDir(fullPath, baseDir, maxDepth, depth + 1);
      results.push(...sub);
    } else if (entry.isFile()) {
      const s = await stat(fullPath);
      const ext = extname(entry.name).toLowerCase();
      results.push({
        path: fullPath,
        relativePath: relative(baseDir, fullPath).replace(/\\/g, "/"),
        ext,
        isText: isTextFile(fullPath),
        size: s.size,
      });
    }
  }
  return results;
}

// ── 从扫描结果生成 markdown 摘要 ──
export function generateSummaryMarkdown(
  directory: string,
  textFiles: ScannedFile[],
  binaryFiles: ScannedFile[],
): string {
  const lines: string[] = [];
  lines.push(`# 知识点摘要: ${directory}`);
  lines.push("");
  lines.push(`扫描时间: ${new Date().toISOString()}`);
  lines.push(`文本文件: ${textFiles.length} | 二进制文件: ${binaryFiles.length}`);
  lines.push("");

  const byExt = new Map<string, ScannedFile[]>();
  for (const f of textFiles) {
    const key = f.ext || "(no ext)";
    if (!byExt.has(key)) byExt.set(key, []);
    byExt.get(key)!.push(f);
  }

  lines.push("## 目录结构");
  lines.push("");
  for (const [ext, files] of byExt) {
    lines.push(`### ${ext || "无扩展名"} (${files.length} 个文件)`);
    lines.push("");
    for (const f of files) {
      lines.push(`- \`${f.relativePath}\` (${(f.size / 1024).toFixed(1)} KB)`);
    }
    lines.push("");
  }

  if (binaryFiles.length > 0) {
    lines.push("## 附件文件");
    lines.push("");
    for (const f of binaryFiles) {
      lines.push(
        `- \`${f.relativePath}\` (${f.ext || "unknown"}) — ${(f.size / 1024).toFixed(1)} KB`,
      );
    }
    lines.push("");
  }

  lines.push("## 知识点");
  lines.push("");
  lines.push("> 以下为自动扫描生成的目录索引，详细内容需进一步提取。");
  lines.push("");

  return lines.join("\n");
}

// ── MIME 类型推断 ──
export function guessMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".db": "application/x-sqlite3",
    ".sqlite": "application/x-sqlite3",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".yaml": "application/yaml; charset=utf-8",
    ".yml": "application/yaml; charset=utf-8",
    ".toml": "application/toml; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".cjs": "text/javascript; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".tsx": "text/plain; charset=utf-8",
    ".jsx": "text/plain; charset=utf-8",
    ".py": "text/plain; charset=utf-8",
    ".go": "text/plain; charset=utf-8",
    ".rs": "text/plain; charset=utf-8",
    ".java": "text/plain; charset=utf-8",
    ".sh": "text/plain; charset=utf-8",
    ".bash": "text/plain; charset=utf-8",
    ".zsh": "text/plain; charset=utf-8",
  };
  return mimeMap[ext] ?? "application/octet-stream";
}

export function slugifyFileName(input: string): string {
  const base = (input ?? "").trim() || "untitled";
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "untitled";
}

export function safeJoinUnder(baseDir: string, userPath: string): string {
  const normalized = (userPath ?? "").replace(/\\/g, "/");
  const parts = normalized
    .split("/")
    .filter((p) => p && p !== "." && p !== "..");
  return join(baseDir, ...parts);
}
