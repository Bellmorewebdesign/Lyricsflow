import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
await mkdir("dist/server", { recursive: true });
await mkdir("dist/display", { recursive: true });
await mkdir("dist/extension", { recursive: true });
await build({
  entryPoints: ["server/src/index.ts"],
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/server/index.js",
});
await build({
  entryPoints: ["display/src/app.ts"],
  bundle: true,
  target: "chrome55",
  outfile: "dist/display/app.js",
});
await build({
  entryPoints: ["display/src/simulator.ts"],
  bundle: true,
  target: "chrome55",
  outfile: "dist/display/simulator.js",
});
await build({
  entryPoints: [
    "extension/src/worker.ts",
    "extension/src/content.ts",
    "extension/src/options.ts",
  ],
  bundle: true,
  target: "chrome110",
  define: {
    __DEBUG_VOLUME__: JSON.stringify(process.env.DEBUG_VOLUME === "true"),
  },
  outdir: "dist/extension",
});
await cp("display/public", "dist/display", { recursive: true });
await cp("extension/public", "dist/extension", { recursive: true });
