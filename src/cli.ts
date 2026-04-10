#!/usr/bin/env node
import { Command } from "commander";
import { generate } from "./generate.js";
import { walk } from "./walk.js";
import { run } from "./run.js";

const program = new Command();

program
  .name("dx-test")
  .description(
    "Inspector-level scrutiny of the end-user experience, automated.",
  )
  .version("0.1.0");

program
  .command("run")
  .description(
    "Full loop: generate example app → install → start → walk → fix → repeat until clean",
  )
  .argument("<path>", "Path to your product folder")
  .option(
    "-o, --output <dir>",
    "Output directory for generated app",
    "./dx-test-app",
  )
  .option("-m, --max-iterations <n>", "Max fix iterations", "3")
  .action(run);

program
  .command("generate")
  .description("Generate a client-facing example app from your product")
  .argument("<path>", "Path to your product folder")
  .option(
    "-o, --output <dir>",
    "Output directory for generated app",
    "./dx-test-app",
  )
  .action(generate);

program
  .command("walk")
  .description("Walk an app and test every flow")
  .option(
    "-u, --url <url>",
    "Base URL of the app to walk",
    "http://localhost:3000",
  )
  .option(
    "-r, --report <dir>",
    "Output directory for reports",
    "./dx-test-reports",
  )
  .action(walk);

program.parse();
