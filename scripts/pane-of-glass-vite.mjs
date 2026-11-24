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

function writeSnapshot(root, project, files, forbidden) {
  for (const file of files.filter(Boolean)) {
    const stub = path.join(root, project, file);
    mkdirSync(path.dirname(stub), { recursive: true });
    writeFileSync(stub, forbidden(file) ? 'forbidden' : '');
  }
}

export async function forbiddenGlobs(file, globs, keysOnly, files, forbidden) {
  if (!globs.length) return [];
  // Use the checkout's filesystem so that differently cased directory names resolve as they do in the app.
  const cwd = process.cwd();
  const root = mkdtempSync(path.join(cwd, '.pane-of-glass-'));
  const project = '/' + path.relative(path.parse(cwd).root, cwd).split(path.sep).join('/');
  const entry = path.posix.join(project, file);
  try {
    writeSnapshot(root, project, files, forbidden);
    writeFileSync(path.join(root, entry), probeEntry(globs, project, file, keysOnly));
    writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    const config = { root, configFile: false, envDir: false, publicDir: false, logLevel: 'silent',
      cacheDir: path.join(root, '.cache') };
    const development = await developmentImports(config, entry);
    const production = await productionImports(config, path.join(root, entry));
    const matches = new Set();
    for (const id of [...development, ...production]) {
      const [filename, query] = (id ?? '').split('?');
      const index = new URLSearchParams(query).get('glob');
      if (index !== null && readFileSync(filename, 'utf8') === 'forbidden') matches.add(Number(index));
    }
    return [...matches];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
