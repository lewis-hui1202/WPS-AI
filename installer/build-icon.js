// Rebuild the Windows icon from the compact WPS logo PNG.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const source = path.resolve(__dirname, '../plugin/images/ai.png');
const target = path.resolve(__dirname, 'wenxiaozhou.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wenxiaozhou-icon-'));

try {
  const images = sizes.map((size) => {
    const file = path.join(temp, `${size}.png`);
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
      '-vf', `scale=${size}:${size}:flags=lanczos`, '-frames:v', '1',
      '-compression_level', '9', file
    ]);
    return fs.readFileSync(file);
  });
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const pos = 6 + index * 16;
    header.writeUInt8(sizes[index] === 256 ? 0 : sizes[index], pos);
    header.writeUInt8(sizes[index] === 256 ? 0 : sizes[index], pos + 1);
    header.writeUInt16LE(1, pos + 4);
    header.writeUInt16LE(32, pos + 6);
    header.writeUInt32LE(image.length, pos + 8);
    header.writeUInt32LE(offset, pos + 12);
    offset += image.length;
  });
  fs.writeFileSync(target, Buffer.concat([header, ...images]));
  console.log(`${target} (${fs.statSync(target).size} bytes)`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
