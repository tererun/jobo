// Build script for the Jobo extension.
// Produces two bundles:
//   - dist/extension.js : the extension host (CommonJS, Node platform)
//   - dist/renderer.js  : the notebook output renderer (ESM, browser platform)
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  // Keep these external:
  //  - vscode: provided by the host at runtime.
  //  - node-sqlite3-wasm: loads its .wasm via __dirname; must stay next to its
  //    own files in node_modules rather than being inlined.
  //  - cpu-features / *.node: ssh2's OPTIONAL native acceleration. ssh2 wraps
  //    these requires in try/catch and falls back to a pure-JS implementation,
  //    so leaving them unresolved at runtime is safe.
  external: ["vscode", "node-sqlite3-wasm", "cpu-features", "*.node"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const rendererConfig = {
  entryPoints: ["src/notebook/renderer/index.ts"],
  bundle: true,
  outfile: "dist/renderer.js",
  platform: "browser",
  format: "esm",
  target: "es2020",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function main() {
  if (watch) {
    const ctxExt = await esbuild.context(extensionConfig);
    const ctxRen = await esbuild.context(rendererConfig);
    await Promise.all([ctxExt.watch(), ctxRen.watch()]);
    console.log("[esbuild] watching...");
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(rendererConfig),
    ]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
