const { spawnSync } = require("child_process");

const target = process.argv.includes("--target")
  ? process.argv[process.argv.indexOf("--target") + 1]
  : process.platform === "darwin"
    ? "mac"
    : process.platform === "win32"
      ? "win"
      : "";

const dryRun = process.argv.includes("--dry-run");
const args = [];

if (target === "win") {
  args.push("--win");
} else if (target === "mac") {
  args.push("--mac");
} else if (target === "linux") {
  args.push("--linux", "tar.xz");
} else if (target === "pi") {
  args.push("--linux", "tar.xz", "--arm64");
} else if (target === "all") {
  args.push("--win", "--mac", "--linux", "tar.xz");
} else {
  console.error("Usage: node scripts/build-release.js --target win|mac|linux|pi|all [--dry-run]");
  console.error("Current platform:", process.platform);
  process.exit(1);
}

if (dryRun) {
  console.log("Would run:", command, args.join(" "));
  process.exit(0);
}

const electronBuilderCli = require.resolve("electron-builder/cli.js");

console.log(`Building ${target} release...`);
const result = spawnSync(process.execPath, [electronBuilderCli, ...args], {
  stdio: "inherit"
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status || 0);
