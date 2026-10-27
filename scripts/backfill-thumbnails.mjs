import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDatabase } from '../src/lib/server/database.ts';
import { generateAssetThumbnail } from '../src/lib/server/thumbnails.ts';
const database = await createDatabase();
let generated = 0, skipped = 0;
try {
  const rows = await database.prepare("SELECT id, stored_name, original_name, preview_kind, hash FROM assets WHERE thumbhash IS NULL").all();
  for (const row of rows) {
    if (!row.stored_name || row.stored_name !== path.basename(row.stored_name) || /[\\/\0]/.test(row.stored_name)) { skipped++; continue; }
    const filename = path.join(process.cwd(), 'data/uploads', row.stored_name);
    try {
      // Bound this maintenance tool as well as the rendering service.
      if ((await stat(filename)).size > 64 * 1024 * 1024) { skipped++; continue; }
      const result = await generateAssetThumbnail(await readFile(filename), row.preview_kind, row.original_name);
      if (!result) { skipped++; continue; }
      await writeFile(filename + '.thumbnail.webp', result.bytes);
      await database.prepare('UPDATE assets SET thumbhash = ? WHERE id = ? AND stored_name = ?').run(result.thumbhash, row.id, row.stored_name);
      generated++;
    } catch { skipped++; }
  }
  console.log(`Generated ${generated} thumbnails; skipped ${skipped} unsupported or unavailable assets.`);
} finally { await database.close(); }
