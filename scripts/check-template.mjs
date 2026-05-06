import { access } from "node:fs/promises";
import { resolve } from "node:path";

const required = [
  "templates/astro-basics/package.json",
  "templates/astro-basics/package-lock.json",
  "templates/astro-basics/astro.config.mjs",
  "templates/astro-basics/src/pages/index.astro",
];

for (const path of required) {
  await access(resolve(path));
}

console.log("Astro starter template files are present.");
