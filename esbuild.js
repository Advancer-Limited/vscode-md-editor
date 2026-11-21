const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const testBundle = process.argv.includes('--test-bundle');

/** @type {import('esbuild').Plugin} */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`> ${location.file}:${location.line}:${location.column}: error: ${text}`);
      });
      console.log('[watch] build finished');
    });
  },
};

/**
 * Test-only bundle of the Office core (src/office/core must not import `vscode`).
 * Built by `npm test` via `--test-bundle`; never by compile / package / watch.
 */
async function buildOfficeCoreTestBundle() {
  const ctx = await esbuild.context({
    entryPoints: ['src/office/core/index.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    sourcemap: true,
    minify: false,
    outfile: 'tests/.build/office-core.cjs',
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
  });
  await ctx.rebuild();
  await ctx.dispose();
}

/**
 * Test-only bundle of the PDF core (src/pdf/core must not import `vscode`).
 */
async function buildPdfCoreTestBundle() {
  const ctx = await esbuild.context({
    entryPoints: ['src/pdf/core/index.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    sourcemap: true,
    minify: false,
    outfile: 'tests/.build/pdf-core.cjs',
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
  });
  await ctx.rebuild();
  await ctx.dispose();
}

async function main() {
  if (testBundle) {
    await buildOfficeCoreTestBundle();
    await buildPdfCoreTestBundle();
    return;
  }

  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
  });

  // Separate, parallel context for the glTF editor's three.js vendor bundle.
  // three.js ships ESM-only (no UMD build to copy the way mermaid.min.js /
  // force-graph.min.js are in scripts/copy-vendor.js), so it's bundled here
  // into a single IIFE global (`ThreeBundle`) that media/gltfEditor.js reads
  // from. Deliberately a distinct esbuild.context() from the extension-host
  // build above — a mistake in this config can't affect dist/extension.js.
  const webviewCtx = await esbuild.context({
    entryPoints: ['scripts/three-vendor-entry.js'],
    bundle: true,
    format: 'iife',
    globalName: 'ThreeBundle',
    platform: 'browser',
    minify: true,
    sourcemap: false,
    outfile: 'media/three-bundle.js',
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
  });

  // pdf.js (legacy display build + viewer components) as one IIFE global
  // (`PdfjsBundle`) for the PDF viewer webview. Also a distinct context, so it
  // cannot affect dist/extension.js. The worker and data files are not bundled;
  // scripts/copy-vendor.js copies them to media/pdfjs/.
  const pdfjsCtx = await esbuild.context({
    entryPoints: ['scripts/pdfjs-vendor-entry.js'],
    bundle: true,
    format: 'iife',
    globalName: 'PdfjsBundle',
    platform: 'browser',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    outfile: 'media/pdfjs-bundle.js',
    logLevel: 'silent',
    plugins: [esbuildProblemMatcherPlugin],
  });

  if (watch) {
    await ctx.watch();
    await webviewCtx.watch();
    await pdfjsCtx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    await webviewCtx.rebuild();
    await webviewCtx.dispose();
    await pdfjsCtx.rebuild();
    await pdfjsCtx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
