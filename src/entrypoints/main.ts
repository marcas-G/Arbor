import { arborVersion } from "./version.js";

export function main(): number {
  console.log(`arbor ${arborVersion} — P1-01A toolchain bootstrap OK (node ${process.version})`);
  return 0;
}

main();
