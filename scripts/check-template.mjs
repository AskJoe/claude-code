import { access } from "node:fs/promises";
import { resolve } from "node:path";

const required = [
  "templates/static-site/index.html",
  "templates/static-site/styles.css",
  "templates/static-site/script.js",
];

for (const path of required) {
  await access(resolve(path));
}

console.log("Static starter template files are present.");
