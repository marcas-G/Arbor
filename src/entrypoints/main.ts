import { run } from "./cli.js";

export function main(): void {
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}

main();
