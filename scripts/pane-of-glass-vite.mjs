// Probe the real development graph and native build per call, preserving the original module specifiers.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build, createServer, normalizePath } from 'vite';
import { probeEntry } from './pane-of-glass-globs.mjs';
import { writeSnapshot } from './pane-of-glass-snapshot.mjs';

async function servedModules(config, file) {
  const server = await createServer({
    ...config, optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, watch: null, ws: false, preTransformRequests: false, fs: { allow: [config.root] } },
  });
  try {
    const client = server.environments.client;
    await client.transformRequest('/' + file);
    const source = await client.moduleGraph.getModuleByUrl('/' + file);
    return [...source.importedModules].map((module) => module.id);
  } finally {
    await server.close();
  }
}

async function builtModules(config, file) {
  const entry = normalizePath(path.join(config.root, file));
  const modules = [];
  await build({
    ...config, build: { write: false, lib: { entry, formats: ['es'] } },
    plugins: [{
      name: 'read-glob-imports', enforce: 'pre',
      load(id) {
        if (path.isAbsolute(id) && !normalizePath(id).startsWith(normalizePath(config.root) + '/')) {
          return 'export default null';
        }
      },
      generateBundle() {
        for (const id of this.getModuleIds()) {
          const source = this.getModuleInfo(id);
          if (source.isEntry) modules.push(...source.importedIds, ...source.dynamicallyImportedIds);
        }
      },
    }],
  });
  return modules;
}

async function selectedModules(config, file) {
  // Vite reads NODE_ENV independently when its dev server and build are launched from the CLI.
  const originalMode = process.env.NODE_ENV;
  const graphs = [];
  let error;
  try {
    for (const [mode, transform] of [['development', servedModules], ['production', builtModules]]) {
      process.env.NODE_ENV = mode;
      try {
        graphs.push(await transform(config, file));
      } catch (failure) {
        error ??= failure;
      }
    }
  } finally {
    if (originalMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalMode;
  }
  if (!graphs.length) throw error;
  return graphs.flat();
}

function forbiddenModuleIds(root, files, forbidden) {
  const foldCase = existsSync(path.join(root, 'SRC'));
  const spelling = (id) => foldCase ? id.toLowerCase() : id;
  const targets = files.filter(forbidden).map((file) => spelling(normalizePath(path.join(root, file))));
  return (id) => {
    if (!id) return false;
    const name = spelling(id);
    return targets.some((target) => name === target || name.startsWith(target + '?'));
  };
}

export async function forbiddenGlobs(file, globs, inventory, forbidden) {
  if (!globs.length) return [];
  const cwd = process.cwd();
  const scratch = mkdtempSync(path.join(cwd, '.pane-of-glass-'));
  const project = '/' + path.relative(path.parse(cwd).root, cwd).split(path.sep).join('/');
  const root = path.join(scratch, project);
  try {
    writeSnapshot(root, scratch, file, inventory, globs);
    writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    const config = { root, configFile: false, envDir: false, publicDir: false, logLevel: 'silent',
      cacheDir: path.join(root, '.cache') };
    const forbiddenId = forbiddenModuleIds(root, inventory.files, forbidden);
    const matches = [];
    for (const [index, glob] of globs.entries()) {
      const code = probeEntry(glob, project, file);
      if (!code) continue;
      writeFileSync(path.join(root, file), code);
      if ((await selectedModules(config, file)).some(forbiddenId)) matches.push(index);
    }
    return matches;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
