/**
 * Bundles the agent (src/agent) into one CommonJS file with rspack:
 * dist/nc-agent.cjs, which the compute images copy in and start at boot.
 *
 * Run after any change under src/: `pnpm --filter=nc-compute-agent build`,
 * then rebuild the images that ship it.
 */
const { createHash } = require('crypto');
const { readFileSync, renameSync } = require('fs');
const path = require('path');
const { rspack } = require('@rspack/core');

const dist = path.join(__dirname, 'dist');

function bundle(version) {
  const compiler = rspack({
    mode: 'production',
    target: 'node20',
    entry: path.join(__dirname, 'src/agent/main.ts'),
    output: { path: dist, filename: 'agent.js', clean: true },
    resolve: { extensions: ['.ts', '.js'] },
    module: {
      rules: [
        {
          test: /\.ts$/,
          loader: 'builtin:swc-loader',
          options: { jsc: { parser: { syntax: 'typescript' } } },
          type: 'javascript/auto',
        },
      ],
    },
    // ws loads these when present and falls back to plain JS when not.
    externals: {
      bufferutil: 'commonjs bufferutil',
      'utf-8-validate': 'commonjs utf-8-validate',
    },
    plugins: [
      new rspack.DefinePlugin({
        __NC_AGENT_VERSION__: JSON.stringify(version),
      }),
    ],
    devtool: false,
    performance: false,
    stats: 'errors-warnings',
  });

  return new Promise((resolve, reject) => {
    compiler.run((err, stats) => {
      compiler.close(() => undefined);
      if (err) return reject(err);
      if (stats.hasErrors()) return reject(new Error(stats.toString('errors-only')));
      resolve(readFileSync(path.join(dist, 'agent.js')));
    });
  });
}

async function main() {
  // The version is the hash of the bundle built without one, so it changes
  // exactly when the code does.
  const version = createHash('sha256')
    .update(await bundle('dev'))
    .digest('hex')
    .slice(0, 12);
  const code = await bundle(version);

  renameSync(path.join(dist, 'agent.js'), path.join(dist, 'nc-agent.cjs'));

  console.log(
    `nc-agent ${version}: dist/nc-agent.cjs, ${(code.byteLength / 1024).toFixed(0)} KB`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
