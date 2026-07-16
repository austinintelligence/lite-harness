import { describe, expect, it } from "vitest";
import { dockerMaintenanceHardeningArgs, validateArchiveEntries } from "@lite-harness/runtime-docker";

describe("Docker workspace maintenance boundaries", () => {
  it("BD-018-REGRESSION validates bounded archives and applies the full maintenance hardening profile", () => {
    const archive = tar([
      { path: "safe/", body: Buffer.alloc(0), type: "5" },
      { path: "safe/file.txt", body: Buffer.from("safe") },
    ]);
    expect(validateArchiveEntries(archive, { maxBytes: 1024, maxFiles: 4 })).toEqual({ files: 2, payloadBytes: 4 });
    expect(() => validateArchiveEntries(tar([{ path: "../escape", body: Buffer.from("no") }]), {
      maxBytes: 1024,
    })).toThrow(/path.*unsafe/i);
    expect(() => validateArchiveEntries(tar([{ path: "link", body: Buffer.alloc(0), type: "2", link: "target" }]), {
      maxBytes: 1024,
    })).toThrow(/type.*denied/i);
    expect(() => validateArchiveEntries(archive, { maxBytes: 3 })).toThrow(/limits/i);
    expect(() => validateArchiveEntries(tar([{ path: "safe//", body: Buffer.alloc(0), type: "5" }]), {
      maxBytes: 1024,
    })).toThrow(/path.*unsafe/i);

    const hardening = dockerMaintenanceHardeningArgs({}, { capabilities: ["CHOWN"], user: "1000:1000" });
    expect(hardening).toEqual(expect.arrayContaining([
      "--network", "none", "--read-only", "--cap-drop", "ALL", "--cap-add", "CHOWN",
      "--security-opt", "no-new-privileges=true", "--pids-limit", "64", "--memory", "256m",
      "--cpus", "1", "--tmpfs", "--user", "1000:1000",
    ]));
  });
});

function tar(entries: Array<{ path: string; body: Buffer; type?: string; link?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    writeOctal(header, 100, 8, 0o600);
    writeOctal(header, 108, 8, 1000);
    writeOctal(header, 116, 8, 1000);
    writeOctal(header, 124, 12, entry.body.length);
    writeOctal(header, 136, 12, 1);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    if (entry.link) header.write(entry.link, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeOctal(header, 148, 8, checksum);
    blocks.push(header, entry.body, Buffer.alloc((512 - (entry.body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 2, "0");
  buffer.write(`${encoded}\0 `, offset, length, "ascii");
}
