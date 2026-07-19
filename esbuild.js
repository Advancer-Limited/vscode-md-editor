const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

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

async function main() {
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

  if (watch) {
    await ctx.watch();
    await webviewCtx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    await webviewCtx.rebuild();
    await webviewCtx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
