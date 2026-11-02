"use strict";

const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { closeWorkfrontLogin, openWorkfrontLogin } = require("./workfront-dom");

async function main() {
  process.umask(0o077);
  await openWorkfrontLogin();
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log("Sign in to Workfront in the opened browser window. Do not paste credentials into the terminal.");
    console.log("After Workfront is signed in, return here and press Enter to save the local browser session.");
    await terminal.question("");
  } finally {
    terminal.close();
    await closeWorkfrontLogin();
  }
}

main().catch((error) => {
  console.error("Could not open the Workfront sign-in browser:", error.message);
  process.exitCode = 1;
});
