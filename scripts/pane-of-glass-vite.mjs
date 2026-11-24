// Development and production use different Vite glob implementations. Read both import graphs.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build, createServer } from 'vite';
import { probeEntry } from './pane-of-glass-globs.mjs';

async function developmentImports(config, entry) {
  const server = await createServer({
    ...config, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, watch: null, ws: false },
  });
  try {
    const client = server.environments.client;
    await client.transformRequest(entry);
    const module = await client.moduleGraph.getModuleByUrl(entry);
    return [...module.importedModules].map((dependency) => dependency.id);
  } finally {
    await server.close();
  }
}

async function productionImports(config, entry) {
  const modules = [];
  await build({
    ...config, build: { write: false, lib: { entry, formats: ['es'] } },
    plugins: [{
      name: 'record-glob-imports',
      generateBundle() { modules.push(...this.getModuleIds()); },
    }],
  });
  return modules;
}

function writeSnapshot(root, files, forbidden) {
  for (const file of files.filter(Boolean)) {
    const stub = path.join(root, file);
    mkdirSync(path.dirname(stub), { recursive: true });
    writeFileSync(stub, forbidden(file) ? 'forbidden' : '');
  }
}

function forbiddenImport(id, root) {
  const [filename, query] = (id ?? '').split('?');
  const index = new URLSearchParams(query).get('glob');
  if (index === null) return;
  const relative = path.relative(root, filename);
  if (path.isAbsolute(relative) || relative.split(path.sep)[0] === '..') return;
  if (readFileSync(filename, 'utf8') === 'forbidden') return Number(index);
}

export async function forbiddenGlobs(file, globs, keysOnly, files, forbidden) {
  if (!globs.length) return [];
  // Use the checkout's filesystem so that differently cased directory names resolve as they do in the app.
  const cwd = process.cwd();
  const scratch = mkdtempSync(path.join(cwd, '.pane-of-glass-'));
  const project = path.relative(path.parse(cwd).root, cwd).split(path.sep).filter(Boolean);
  const parentSteps = Math.max(...globs.map((glob) => glob.parentSteps));
  // Leave enough ancestors inside the snapshot even for options that concatenate parent paths.
  const padding = Math.max(0, parentSteps - project.length);
  const root = path.join(scratch, 'p/'.repeat(padding), ...project);
  const volume = '/' + '../'.repeat(project.length);
  try {
    writeSnapshot(root, files, forbidden);
    writeFileSync(path.join(root, file), probeEntry(globs, volume, keysOnly));
    writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    const config = { root, configFile: false, envDir: false, publicDir: false, logLevel: 'silent',
      cacheDir: path.join(root, '.cache') };
    const development = await developmentImports(config, '/' + file);
    const production = await productionImports(config, path.join(root, file));
    const matches = new Set();
    for (const id of [...development, ...production]) {
      const index = forbiddenImport(id, root);
      if (index !== undefined) matches.add(index);
    }
    return [...matches];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
