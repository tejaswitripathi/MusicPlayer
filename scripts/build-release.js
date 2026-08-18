const { spawnSync } = require("child_process");

const target = process.argv.includes("--target")
  ? process.argv[process.argv.indexOf("--target") + 1]
  : process.platform === "darwin"
    ? "mac"
    : process.platform === "win32"
      ? "win"
      : "";

const dryRun = process.argv.includes("--dry-run");
const command = process.platform === "win32" ? "npx" : "npx";
const args = ["electron-builder"];

if (target === "win") {
  args.push("--win");
} else if (target === "mac") {
  args.push("--mac");
} else if (target === "all") {
  args.push("--win", "--mac");
} else {
  console.error("Usage: node scripts/build-release.js --target win|mac|all [--dry-run]");
  console.error("Current platform:", process.platform);
  process.exit(1);
}

if (dryRun) {
  console.log("Would run:", command, args.join(" "));
  process.exit(0);
}

console.log(`Building ${target} release...`);
const result = spawnSync(command, args, {
  stdio: "inherit",
  shell: true
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status || 0);
