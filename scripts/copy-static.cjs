const fs = require('node:fs');
const path = require('node:path');

const source = path.join(__dirname, '..', 'src', 'renderer');
const compiled = path.join(__dirname, '..', 'dist', 'renderer');
const target = path.join(__dirname, '..', 'dist', 'renderer');

fs.mkdirSync(target, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  fs.copyFileSync(path.join(source, file), path.join(target, file));
}

// The renderer loads as a classic <script> (no bundler). tsc emits one module
// per file, so the small shared-schema dependency is inlined here:
// schema code first, then the renderer with its import/export stripped.
// The guard below fails the build if the dependency graph ever grows past
// this one edge — at that point a real bundler should be introduced.
const schemaJs = fs.readFileSync(path.join(compiled, 'shared', 'settings-schema.js'), 'utf8');
const rendererJs = fs.readFileSync(path.join(compiled, 'renderer', 'renderer.js'), 'utf8');

function stripModuleSyntax(code, file) {
  const withoutImports = code.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '');
  const withoutExports = withoutImports.replace(/^export\s+(?=(const|let|var|function|class|async))/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  if (/\bimport\s[\s\S]*?from\s+['"]/.test(withoutExports) || /^export\s/m.test(withoutExports)) {
    throw new Error(`${file}: unexpected module syntax after stripping — the classic-script inline step needs updating`);
  }
  return withoutExports;
}

const bundle = `${stripModuleSyntax(schemaJs, 'settings-schema.js')}\n${stripModuleSyntax(rendererJs, 'renderer.js')}`;
fs.writeFileSync(path.join(target, 'renderer.js'), bundle);
