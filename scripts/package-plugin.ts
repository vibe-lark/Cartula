import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildPluginPackage } from '../src/server/plugin.js';

const { values } = parseArgs({ options: {
  'public-url': { type: 'string' },
  out: { type: 'string', default: 'artifacts/plugins' },
  help: { type: 'boolean', short: 'h' },
} });

if (values.help || !values['public-url']) {
  console.log('Usage: npm run package:plugin -- --public-url https://cartula.solutionsuite.cn [--out artifacts/plugins]');
  if (!values.help) process.exitCode = 1;
} else {
  const pkg = buildPluginPackage(values['public-url']);
  const out = resolve(values.out!);
  const directory = join(out, pkg.filename.slice(0, -4), 'cartula');
  // A content-addressed export is repeatable, but never overwrites different bytes.
  const write = async (path: string, body: string | Buffer) => {
    await mkdir(dirname(path), { recursive: true });
    try { await writeFile(path, body, { flag: 'wx' }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await readFile(path)).equals(Buffer.from(body))) throw new Error(`Refusing to overwrite a different artifact: ${path}`);
    }
  };
  for (const [path, body] of Object.entries(pkg.files)) await write(join(directory, path), body);
  const archive = join(out, pkg.filename);
  await write(archive, pkg.archive);
  await write(`${archive}.sha256`, `${pkg.index.sha256}  ${pkg.filename}\n`);
  await write(join(dirname(directory), 'index.json'), JSON.stringify(pkg.index, null, 2) + '\n');
  console.log(JSON.stringify({ directory, archive, sha256: pkg.index.sha256, mcpUrl: pkg.index.mcpUrl }, null, 2));
}
