import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export type KvEntry = {
  value: string;
  content_type: string;
  updated_at: string;
};

type KvFile = {
  version: 1;
  entries: Record<string, KvEntry>;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function defaultKvPath(): string {
  const env = process.env.MCP_KV_PATH;
  if (env && env.trim()) return env;
  return path.join(process.cwd(), ".mcp-kv-store.json");
}

export async function loadKv(filePath: string): Promise<Map<string, KvEntry>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.entries)) return new Map();

    const m = new Map<string, KvEntry>();
    for (const [k, v] of Object.entries(parsed.entries)) {
      if (!isRecord(v)) continue;
      const value = typeof v.value === "string" ? v.value : undefined;
      const content_type = typeof v.content_type === "string" ? v.content_type : undefined;
      const updated_at = typeof v.updated_at === "string" ? v.updated_at : undefined;
      if (value === undefined || content_type === undefined || updated_at === undefined) continue;
      m.set(k, { value, content_type, updated_at });
    }
    return m;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") return new Map();
    return new Map();
  }
}

export async function persistKv(filePath: string, kv: Map<string, KvEntry>): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const obj: KvFile = { version: 1, entries: Object.fromEntries(kv.entries()) };
  const data = JSON.stringify(obj, null, 2);

  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, filePath);
}

