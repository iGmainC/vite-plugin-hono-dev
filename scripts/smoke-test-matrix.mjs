import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const viteVersions = ["6.4.2", "7.3.3", "8.0.14"];

/** 执行命令并把 stdout/stderr 透传给当前进程，便于 CI 定位失败版本 */
const runCommand = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
    });
  });

/** 为指定 Vite 版本创建隔离依赖目录，避免反复改写主项目 node_modules */
const createMatrixWorkspace = async (viteVersion) => {
  const workspace = await mkdtemp(path.join(tmpdir(), `hono-dev-vite-${viteVersion}-`));
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          "@hono/node-server": "^1.19.11",
          "@hono/node-ws": "^1.3.1",
          hono: "^4.12.2",
          vite: viteVersion,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return workspace;
};

for (const viteVersion of viteVersions) {
  const workspace = await createMatrixWorkspace(viteVersion);
  try {
    console.log(`\n[smoke:matrix] installing vite@${viteVersion}`);
    await runCommand("bun", ["install", "--silent"], { cwd: workspace });

    console.log(`[smoke:matrix] running smoke with vite@${viteVersion}`);
    await runCommand("node", ["./scripts/smoke-test.mjs"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        VITE_IMPORT_TARGET: pathToFileURL(path.join(workspace, "node_modules", "vite", "dist", "node", "index.js")).href,
      },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

console.log("\nsmoke-test matrix passed");
