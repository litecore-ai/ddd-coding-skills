import { randomUUID } from 'node:crypto';
import * as fileSystem from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { RoadmapError } from './errors.mjs';
import { validateGraph } from './graph.mjs';
import { renderRoadmap } from './render.mjs';
import { parseRoadmap } from './schema.mjs';
import { expandScope } from './scope.mjs';
import { readJson } from './store.mjs';

async function writeTextAtomic(path, contents, fs = fileSystem) {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  await fs.mkdir(dirname(path), { recursive: true });
  let created = false;
  try {
    await fs.writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    created = true;
    await fs.rename(temporaryPath, path);
    created = false;
  } finally {
    if (created) await fs.rm(temporaryPath, { force: true });
  }
}

export class RoadmapController {
  static async open(root, options = {}) {
    const absoluteRoot = resolve(root ?? process.cwd());
    const fs = options.fs ?? fileSystem;
    const roadmapPath = options.roadmapPath ?? join(absoluteRoot, 'docs/roadmap/roadmap.json');
    let roadmap;
    try {
      roadmap = await readJson(roadmapPath, parseRoadmap, { fs });
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new RoadmapError('LEGACY_ROADMAP', `canonical roadmap JSON is missing: ${roadmapPath}`, { path: roadmapPath });
      }
      throw error;
    }
    return new RoadmapController(absoluteRoot, roadmap, { ...options, fs, roadmapPath });
  }

  constructor(root, roadmap, options = {}) {
    this.root = root;
    this.roadmap = roadmap;
    this.run = options.run ?? null;
    this.fs = options.fs ?? fileSystem;
    this.roadmapPath = options.roadmapPath ?? join(root, 'docs/roadmap/roadmap.json');
    this.markdownPath = options.markdownPath ?? join(root, 'docs/roadmap/roadmap.md');
  }

  validate() {
    validateGraph(this.roadmap);
    return { revision: this.roadmap.revision, valid: true };
  }

  scope(selector) {
    return { items: expandScope(this.roadmap, selector) };
  }

  async render() {
    const contents = renderRoadmap(this.roadmap, this.run);
    await writeTextAtomic(this.markdownPath, contents, this.fs);
    return {
      path: relative(this.root, this.markdownPath).split('\\').join('/'),
      revision: this.roadmap.revision
    };
  }
}
