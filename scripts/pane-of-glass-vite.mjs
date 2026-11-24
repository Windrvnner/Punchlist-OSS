// Resolve against the checkout's real packages and links, without loading any dependency's contents.
import path from 'node:path';
import { build, createServer, normalizePath } from 'vite';

async function servedIds(config, file) {
  const server = await createServer({
    ...config, optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, watch: null, ws: false, preTransformRequests: false },
  });
  try {
    const client = server.environments.client;
    const url = '/' + file;
    await client.transformRequest(url);
    const module = await client.moduleGraph.getModuleByUrl(url);
    return [...module.importedModules].map((dependency) => dependency.id);
  } finally {
    await server.close();
  }
}

async function builtIds(config, entry) {
  const ids = [];
  await build({
    ...config,
    build: { write: false, lib: { entry, formats: ['es'], fileName: 'entry' } },
    plugins: [...config.plugins, {
      name: 'glob-dependencies', enforce: 'pre',
      async resolveId(id, importer, options) {
        if (!importer) return;
        const resolved = await this.resolve(id, importer, options);
        if (resolved) return { id: resolved.id, external: true };
      },
      generateBundle() {
        const module = this.getModuleInfo(entry);
        ids.push(...module.importedIds, ...module.dynamicallyImportedIds);
      },
    }],
  });
  return ids;
}

export async function globImports(file, code) {
  const entry = normalizePath(path.resolve(file));
  const config = {
    configFile: false, envDir: false, publicDir: false, logLevel: 'silent',
    // Keep authored CommonJS imports out of the glob's dependency graph as well.
    define: { require: 'globalThis.__paneRequire' },
    plugins: [{
      name: 'glob-entry', enforce: 'pre',
      load(id) { return id === entry ? code : 'export default null'; },
    }],
  };
  // The normal CLI starts development and production in separate processes.
  const previous = process.env.NODE_ENV;
  try {
    const graphs = [];
    let error;
    for (const [mode, inspect, input] of [['development', servedIds, file], ['production', builtIds, entry]]) {
      process.env.NODE_ENV = mode;
      try {
        graphs.push(await inspect(config, input));
      } catch (failure) {
        error ??= failure;
      }
    }
    if (!graphs.length) throw error;
    return graphs.flat().filter((id) => id && path.isAbsolute(id))
      .map((id) => normalizePath(path.relative('.', id)));
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}
