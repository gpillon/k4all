import fs from 'fs';
import path from 'path';
import { ICONS } from './icons';

/** The plugin's non-test sources; tests run from the package folder. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sources(full));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !entry.name.includes('.test.') &&
      entry.name !== 'icons.ts'
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('offline icons', () => {
  it('registers every mdi icon the plugin uses', () => {
    const used = new Set<string>();
    for (const file of sources(path.resolve('src'))) {
      const text = fs.readFileSync(file, 'utf8');
      const re = /mdi:([a-z0-9-]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        used.add(m[1]);
      }
    }
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter(name => !ICONS[name])).toEqual([]);
  });

  it('carries real SVG bodies', () => {
    for (const icon of Object.values(ICONS)) {
      expect(icon.body).toMatch(/^<(path|g)/);
    }
  });
});
