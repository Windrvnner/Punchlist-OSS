import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { expect } from 'vitest';

// Use the application configuration and both of its HTML entries when inspecting the browser build.
export function builtReaderSources(root: string): string[] {
  const script = 'import { readers } from "/src/ui/readers.ts"; console.log(readers)';
  writeFileSync(path.join(root, 'index.html'), `<script type="module">${script}</script>`);
  writeFileSync(path.join(root, 'desktop.html'), '<title>Desktop</title>');

  const cli = path.resolve('node_modules/vite/bin/vite.js');
  const config = path.resolve('vite.config.ts');
  const app = spawnSync(process.execPath, [cli, 'build', '--config', config], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' },
  });
  expect(app.status, app.stderr).toBe(0);
  const assets = path.join(root, 'dist/assets');
  return readdirSync(assets).filter((name) => name.endsWith('.js.map')).flatMap((name) =>
    JSON.parse(readFileSync(path.join(assets, name), 'utf8')).sources);
}

export async function servedReaderSources(root: string, file: string) {
  const server = await createServer({
    root, configFile: path.resolve('vite.config.ts'), envDir: false, logLevel: 'silent',
    optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, watch: null, ws: false },
  });
  try {
    const client = server.environments.client;
    await client.transformRequest('/' + file);
    const reader = await client.moduleGraph.getModuleByUrl('/' + file);
    return [...reader!.importedModules].flatMap((dependency) => dependency.id ? [dependency.id] : []);
  } finally {
    await server.close();
  }
}
