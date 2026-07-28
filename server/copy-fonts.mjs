import { cp } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = dirname(fileURLToPath(import.meta.url));
await cp(resolve(serverDir, "src/fonts"), resolve(serverDir, "dist/fonts"), {
  recursive: true,
  force: true,
});
