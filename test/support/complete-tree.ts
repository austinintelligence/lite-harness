import { createHash } from "node:crypto";

export interface CompleteTreeEntry {
  path: string;
  type: "0" | "5";
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: number;
  contentSha256?: string;
}

export interface CompleteTreeContract {
  hash: string;
  entries: CompleteTreeEntry[];
}

export function completeTreeContract(archive: Buffer): CompleteTreeContract {
  const entries: CompleteTreeEntry[] = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156] ?? 0);
    if (type !== "0" && type !== "5") throw new Error(`Unexpected tree entry type: ${type}`);
    const size = tarOctal(header.subarray(124, 136));
    const content = archive.subarray(offset, offset + size);
    const path = rawPath === "." || rawPath === "./"
      ? "."
      : rawPath.replace(/^\.\//, "").replace(/\/$/, "");
    if (path) {
      entries.push({
        path,
        type,
        mode: tarOctal(header.subarray(100, 108)),
        uid: tarOctal(header.subarray(108, 116)),
        gid: tarOctal(header.subarray(116, 124)),
        size,
        mtime: tarOctal(header.subarray(136, 148)),
        ...(type === "0" ? { contentSha256: createHash("sha256").update(content).digest("hex") } : {}),
      });
    }
    offset += Math.ceil(size / 512) * 512;
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { hash: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), entries };
}

function tarOctal(field: Buffer): number {
  const value = field.toString("ascii").replaceAll("\0", "").trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar numeric field");
  return Number.parseInt(value, 8);
}

function tarString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("utf8");
}
