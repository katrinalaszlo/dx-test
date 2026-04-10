#!/usr/bin/env node
import { Command } from "commander";
import { generate } from "./generate.js";
import { walk } from "./walk.js";

const program = new Command();

program
  .name("dx-test")
  .description(
    "Inspector-level scrutiny of the end-user experience, automated.",
  )
  .version("0.1.0");

program
  .command("generate")
  .description(
    "Read your product and generate a client-facing example app + test flows",
  )
  .argument("<path>", "Path to your product folder")
  .option(
    "-o, --output <dir>",
    "Output directory for generated app",
    "./dx-test-app",
  )
  .action(generate);

program
  .command("walk")
  .description("Walk the generated app and test every flow")
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
