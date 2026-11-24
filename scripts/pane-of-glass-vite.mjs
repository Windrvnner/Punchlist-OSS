// Vite uses different glob implementations in development and production. Probe both on the same filenames.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build, createServer } from 'vite';
import { probeEntry } from './pane-of-glass-globs.mjs';

async function checkModes(config, entry, observe) {
  const server = await createServer({
    ...config, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, watch: null, ws: false },
  });
  try {
    const client = server.environments.client;
    await client.transformRequest(entry);
    const module = await client.moduleGraph.getModuleByUrl(entry);
    for (const dependency of module.importedModules) observe(dependency.id);
  } finally {
    await server.close();
  }
  await build({ ...config, build: { write: false, lib: { entry: path.join(config.root, entry), formats: ['es'] } } });
}

function writeSnapshot(root, files, forbidden) {
  for (const file of files.filter(Boolean)) {
    const stub = path.join(root, file);
    mkdirSync(path.dirname(stub), { recursive: true });
    writeFileSync(stub, forbidden(file) ? 'forbidden' : '');
  }
}

export async function forbiddenGlobs(file, globs, keysOnly, files, forbidden) {
  if (!globs.length) return [];
  // The snapshot shares the checkout's filesystem and its directory case rules.
  const cwd = process.cwd();
  const scratch = mkdtempSync(path.join(cwd, '.pane-of-glass-'));
  const project = '/' + path.relative(path.parse(cwd).root, cwd).split(path.sep).join('/');
  const root = path.join(scratch, project);
  const entry = '/' + file;
  const matches = new Set();
  function observe(id) {
    const [filename, query] = (id ?? '').split('?');
    const index = new URLSearchParams(query).get('glob');
    if (index === null) return;
    const relative = path.relative(root, filename);
    const inside = !path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..';
    if (inside && readFileSync(filename, 'utf8') === 'forbidden') matches.add(Number(index));
    return 'export default null';
  }
  try {
    writeSnapshot(root, files, forbidden);
    writeFileSync(path.join(root, entry), probeEntry(globs, project, file, keysOnly));
    writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    await checkModes({
      root, configFile: false, envDir: false, publicDir: false, logLevel: 'silent', cacheDir: path.join(root, '.cache'),
      plugins: [{ name: 'read-glob-filenames', enforce: 'pre', load: observe }],
    }, entry, observe);
    return [...matches];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
