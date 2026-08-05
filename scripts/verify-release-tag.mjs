import { appendFile, readFile } from "node:fs/promises";

const packageJsonUrl = new URL("../package.json", import.meta.url);
const packageJson = JSON.parse(await readFile(packageJsonUrl, "utf8"));
const releaseTag = process.env.GITHUB_REF_NAME ?? process.argv[2];

if (!releaseTag) {
  throw new Error("Release tag is required via GITHUB_REF_NAME or the first CLI argument.");
}

const expectedTag = `v${packageJson.version}`;
if (releaseTag !== expectedTag) {
  throw new Error(`Release tag "${releaseTag}" must match package.json version "${expectedTag}".`);
}

const releaseMetadata = {
  package_name: packageJson.name,
  package_version: packageJson.version,
  package_spec: `${packageJson.name}@${packageJson.version}`,
  prerelease: packageJson.version.includes("-") ? "true" : "false",
};

// GitHub Actions 中输出结构化元数据，供后续 npm 与 Release 步骤复用同一版本源。
if (process.env.GITHUB_OUTPUT) {
  const output = Object.entries(releaseMetadata)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  await appendFile(process.env.GITHUB_OUTPUT, `${output}\n`, "utf8");
}

console.log(`release metadata verified: ${releaseMetadata.package_spec} (${releaseTag})`);
