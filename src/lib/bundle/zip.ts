const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function zipFiles(files: { path: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const encoder = new TextEncoder();

  for (const file of files) {
    const name = file.path.replaceAll("\\", "/").replace(/^\/+/, "");
    const nameBytes = encoder.encode(name);
    const crc = crc32(file.data);
    const size = file.data.byteLength;
    // Local header and payload are pushed as separate parts; the payload is
    // referenced rather than copied, so the only full-size allocation is the
    // final concat (peak ~2x library size instead of ~3x at 10k files).
    parts.push(
      concat([
        u32(0x04034b50),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(size),
        u32(size),
        u16(nameBytes.byteLength),
        u16(0),
        nameBytes,
      ]),
      file.data,
    );
    centrals.push(
      concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(size),
        u32(size),
        u16(nameBytes.byteLength),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ]),
    );
    offset += 30 + nameBytes.byteLength + size;
  }

  const central = concat(centrals);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.byteLength),
    u32(offset),
    u16(0),
  ]);
  return concat([...parts, central, end]);
}

export function listZipEntryNames(data: Uint8Array): string[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const names: string[] = [];
  let i = 0;
  while (i + 30 <= data.byteLength) {
    if (view.getUint32(i, true) !== 0x04034b50) {
      break;
    }
    const nameLen = view.getUint16(i + 26, true);
    const extraLen = view.getUint16(i + 28, true);
    const compressed = view.getUint32(i + 18, true);
    const start = i + 30;
    names.push(new TextDecoder().decode(data.subarray(start, start + nameLen)));
    i = start + nameLen + extraLen + compressed;
  }
  return names;
}

export type ZipEntry = {
  path: string;
  data: Uint8Array;
};

/** Caps to keep untrusted zips from exhausting memory (zip-bomb protection). */
const MAX_UNZIP_ENTRIES = 10_000;
const MAX_UNZIP_SINGLE = 256 * 1024 * 1024; // 256 MiB uncompressed per entry
const MAX_UNZIP_TOTAL = 512 * 1024 * 1024; // 512 MiB uncompressed per archive

/** Inflate a ZIP DEFLATE payload (raw, no zlib header), capping output size. */
async function inflateRaw(payload: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    throw new Error("This zip uses DEFLATE; unpack it first, then merge the folder");
  }
  const stream = new Blob([new Uint8Array(payload)])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("Zip entry inflates beyond the size limit");
    }
    chunks.push(value);
  }
  return concat(chunks);
}

/**
 * Read file entries from a zip. Supports store (method 0) and DEFLATE (method 8).
 * Rejects encryption, data descriptors, and `..` paths.
 */
export async function unzipFiles(data: Uint8Array): Promise<ZipEntry[]> {
  if (data.byteLength < 22 || new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) !== 0x04034b50) {
    if (data.byteLength >= 4 && new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) === 0x06054b50) {
      return [];
    }
    throw new Error("Not a zip file");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let totalUncompressed = 0;
  let i = 0;
  while (i + 30 <= data.byteLength) {
    const signature = view.getUint32(i, true);
    if (signature === 0x02014b50 || signature === 0x06054b50 || signature === 0x07064b50) {
      break;
    }
    if (signature !== 0x04034b50) {
      throw new Error("Not a zip file (truncated or unknown extra data)");
    }
    const flags = view.getUint16(i + 6, true);
    const method = view.getUint16(i + 8, true);
    const compressed = view.getUint32(i + 18, true);
    const declaredUncompressed = view.getUint32(i + 22, true);
    const nameLen = view.getUint16(i + 26, true);
    const extraLen = view.getUint16(i + 28, true);
    const nameStart = i + 30;
    const name = decoder.decode(data.subarray(nameStart, nameStart + nameLen)).replaceAll("\\", "/");
    const dataStart = nameStart + nameLen + extraLen;
    if ((flags & 1) !== 0) {
      throw new Error(`Encrypted zip entry: ${name}`);
    }
    if ((flags & 8) !== 0 && compressed === 0) {
      throw new Error(`Zip entry uses a data descriptor (${name}); re-export the pack from this app`);
    }
    if (dataStart + compressed > data.byteLength) {
      throw new Error(`Zip entry truncated: ${name}`);
    }
    if (entries.length >= MAX_UNZIP_ENTRIES) {
      throw new Error(`Zip has too many entries (limit ${MAX_UNZIP_ENTRIES})`);
    }
    if (declaredUncompressed > MAX_UNZIP_SINGLE) {
      throw new Error(`Zip entry exceeds the ${MAX_UNZIP_SINGLE} byte size limit: ${name}`);
    }
    const payload = data.subarray(dataStart, dataStart + compressed);
    i = dataStart + compressed;
    if (name.endsWith("/") || name === "") {
      continue;
    }
    if (name.split("/").includes("..")) {
      throw new Error(`Zip entry path escapes pack: ${name}`);
    }
    let bytes: Uint8Array;
    if (method === 0) {
      bytes = payload.slice();
    } else if (method === 8) {
      bytes = await inflateRaw(payload, MAX_UNZIP_SINGLE);
    } else {
      throw new Error(
        `Zip compression ${method} is not supported (${name}). Use the zip exported from this app, or unpack it first.`,
      );
    }
    totalUncompressed += bytes.byteLength;
    if (totalUncompressed > MAX_UNZIP_TOTAL) {
      throw new Error(`Zip inflates beyond the total ${MAX_UNZIP_TOTAL} byte size limit`);
    }
    entries.push({ path: name.replace(/^\/+/, ""), data: bytes });
  }
  return entries;
}
