import { crc32 } from 'node:zlib';

/** Small, deterministic ZIPs of explicitly selected package files; never scan a directory. */
export function packageZip(files: Readonly<Record<string, string>>): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Package entry must be a relative ASCII file path');
    }
    const name = Buffer.from(path);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12); // 1980-01-01, no build-time dependency.
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const count = Object.keys(files).length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.reduce((sum, part) => sum + part.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}
