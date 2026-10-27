import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const icons = {};
const collections = new Map();
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await visit(filename);
    else if (/\.(svelte|ts)$/.test(filename)) {
      const source = await readFile(filename, 'utf8');
      for (const [, prefix, name] of source.matchAll(/['"](mdi|mingcute|codex):([a-z0-9-]+)['"]/g)) {
        if (!collections.has(prefix)) collections.set(prefix, require(`@iconify-json/${prefix}/icons.json`));
        const collection = collections.get(prefix);
        const icon = collection.icons[name];
        if (!icon) throw new Error(`Missing bundled icon ${prefix}:${name}`);
        icons[`${prefix}:${name}`] = { width: collection.width ?? 16, height: collection.height ?? 16, ...icon };
      }
    }
  }
}
await visit('src');
await writeFile('src/lib/icons.generated.json', JSON.stringify(icons));
console.log(`Bundled ${Object.keys(icons).length} local icons; no runtime icon API`);
