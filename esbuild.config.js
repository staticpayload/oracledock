// esbuild configuration for VS Code extension
// Uses CommonJS format because VS Code extensions run in Node.js context
// External dependencies: vscode (provided by VS Code runtime), node-pty (native module)

const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['./src/extension.ts'],
  bundle: true,
  outfile: './dist/extension.js',
  external: [
    'vscode',      // Provided by VS Code at runtime
    'node-pty'     // Native module - must remain external to preserve binary
  ],
  format: 'cjs',   // VS Code extensions use CommonJS
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: false,   // Keep readable for debugging during development
};

async function build() {
  try {
    if (isWatch) {
      const ctx = await esbuild.context(buildOptions);
      await ctx.watch();
      console.log('Watching for changes...');
    } else {
      await esbuild.build(buildOptions);
      console.log('Build complete.');
    }
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}

build();
