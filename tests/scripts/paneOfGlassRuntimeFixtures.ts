// Each loader runs with the built-in module and with the sibling checklist module.
export const runtimeModuleCases = [
  ['an absent optional caption', [
    "const manifest: { target: string; caption?: string } = { target: 'CHOSEN' }",
    "export const caption = manifest.caption ?? 'Checklist'",
    'const { target } = manifest',
  ]],
  ['sibling reads through distinct local aliases', [
    "const manifest = { target: 'CHOSEN', caption: 'Checklist' }",
    'const heading = manifest',
    'const pages = manifest',
    'const reader = pages',
    'export const title = heading.caption',
    'const { target } = reader',
  ]],
  ['a nested sibling pattern before the target', [
    "const manifest = { meta: { caption: 'Checklist' }, target: 'CHOSEN' }",
    'const { meta: { caption }, target } = manifest',
  ]],
  ['a nested tuple sibling before the target', [
    "const manifest = { meta: [{ caption: 'Checklist' }], target: 'CHOSEN' }",
    'const { meta: [{ caption }], target } = manifest',
  ]],
  ['a separate object rest read', [
    "const manifest = { caption: 'Checklist', target: 'CHOSEN' }",
    'const { caption, ...display } = manifest',
    'const { target } = manifest',
  ]],
  ['a default after a literal array is truncated', [
    "const routes = ['OTHER', 'Checklist']",
    'routes.length = 0',
    "const [target = 'CHOSEN'] = routes",
  ]],
  ['a truncated array that is extended through an alias', [
    "const routes = ['./checklist.mjs', 'OTHER']",
    'const resize = routes',
    'resize.length = 1',
    'routes.length = 2',
    "const [, target = 'CHOSEN'] = routes",
  ]],
  ['the truth value of a literal object', [
    'const { config } = { config: { enabled: true } }',
    "const target = config ? 'CHOSEN' : 'OTHER'",
  ]],
  ['a capture beside a runtime caption', [
    "const caption = () => 'Checklist'",
    "const manifest = { target: 'CHOSEN', caption: caption() }",
    'const { target, caption: title } = manifest',
    "manifest.target = './checklist.mjs'",
  ]],
  ['a numeric object key on an array', [
    "const modules = ['CHOSEN'] as const",
    'const { 0: target } = modules',
  ]],
  ['an equality selecting a fixed branch', [
    "const mode = 'checklist'",
    "const target = mode === 'checklist' ? 'CHOSEN' : 'OTHER'",
  ]],
] as const;

export const runtimeMutationSource = [
  "const manifest = { target: 'node:path', meta: {",
  "  get caption() { manifest.target = './checklist.mjs'; return 'Checklist' }",
  '} }',
  'const { meta: { caption }, target } = manifest',
  "const routes = ['node:path']",
  'const cleared = () => 0',
  'routes.length = cleared()',
  "const [page = './checklist.mjs'] = routes",
  'export const open = () => Promise.all([import(target), import(page)])',
].join('\n');
