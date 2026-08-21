// Precompiles templates/*.handlebars into templates/*.precompiled.js,
// replacing the manual "run the handlebars CLI yourself" step.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const templatesDir = path.join(rootDir, "templates");
const outDir = path.join(rootDir, "public", "templates");
const handlebarsBin = path.join(rootDir, "node_modules", ".bin", "handlebars");

const templateFiles = readdirSync(templatesDir).filter((file) =>
  file.endsWith(".handlebars"),
);

for (const file of templateFiles) {
  const name = path.basename(file, ".handlebars");
  const src = path.join(templatesDir, file);
  const dest = path.join(outDir, `${name}.precompiled.js`);
  execFileSync(handlebarsBin, [src, "-f", dest], { stdio: "inherit" });
  console.log(`compiled ${file} -> public/templates/${name}.precompiled.js`);
}
