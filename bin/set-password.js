#!/usr/bin/env node
// Sets the desk's one password: asks for it twice without echo and stores only its scrypt hash, with an optional
// hint which the sign-in page shows to anyone who opens it. Any length is fine.
// Run it yourself in a terminal (not through Claude): node bin/set-password.js
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");

const AUTH = path.join(__dirname, "..", "data", "auth.json");

function ask(prompt, echo = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!echo) {
      rl._writeToOutput = (s) => {
        if (s.includes(prompt)) process.stdout.write(prompt);
      };
    }
    rl.question(prompt, (answer) => {
      rl.close();
      if (!echo) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

(async () => {
  if (!process.stdin.isTTY) {
    console.error("Run it in a terminal: the password is typed, never passed in.");
    process.exit(1);
  }
  const first = await ask("New password: ");
  if (first.length === 0) {
    console.error("Empty; nothing changed.");
    process.exit(1);
  }
  const second = await ask("Again: ");
  if (first !== second) {
    console.error("They differ; nothing changed.");
    process.exit(1);
  }
  console.log("The hint is shown on the sign-in page to anyone who opens it, so it must not give the password away.");
  const hint = (await ask("Hint (Enter for none): ", true)).trim();
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(first, salt, 64).toString("hex");
  fs.mkdirSync(path.dirname(AUTH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(AUTH, JSON.stringify({ salt: salt.toString("hex"), hash, ...(hint ? { hint } : {}) }) + "\n", { mode: 0o600 });
  console.log("Set. Every session signed in before still works until it expires.");
})();
