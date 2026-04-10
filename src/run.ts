import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import chalk from "chalk";
import { generate } from "./generate.js";

interface RunOptions {
  output: string;
  maxIterations: string;
}

function waitForServer(url: string, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = async () => {
      try {
        const res = await fetch(url);
        if (res.ok || res.status < 500) {
          resolve(true);
          return;
        }
      } catch {}

      if (Date.now() - start > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

interface AppProcess {
  proc: ChildProcess;
  getOutput: () => string;
}

function startApp(appDir: string, port: number): AppProcess {
  const proc = spawn("node", ["server.js"], {
    cwd: appDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  proc.stdout?.on("data", (d) => (output += d.toString()));
  proc.stderr?.on("data", (d) => (output += d.toString()));

  return { proc, getOutput: () => output };
}

async function walkApp(
  url: string,
  reportDir: string,
): Promise<{ bugs: any[]; report: any }> {
  // Inline a simplified walk — hit API routes and check pages
  const analysisPath = path.resolve("dx-test-app/analysis.json");
  const routes: Array<{ method: string; path: string }> = [];

  if (fs.existsSync(analysisPath)) {
    const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf-8"));
    routes.push(...(analysis.routes || []));
  }

  const bugs: any[] = [];

  // Phase 1: API routes
  for (const route of routes) {
    if (route.path.includes(":") || route.path.includes("{")) continue;

    try {
      const res = await fetch(`${url}/api${route.path}`, {
        method: route.method,
        headers: { "Content-Type": "application/json" },
        body: ["POST", "PUT", "PATCH"].includes(route.method)
          ? "{}"
          : undefined,
        signal: AbortSignal.timeout(10000),
      });

      if (res.status >= 500) {
        let body = "";
        try {
          body = await res.text();
        } catch {}
        bugs.push({
          type: "api",
          endpoint: `${route.method} ${route.path}`,
          status: res.status,
          body: body.slice(0, 500),
        });
      }
    } catch (err) {
      bugs.push({
        type: "api",
        endpoint: `${route.method} ${route.path}`,
        error: String(err),
      });
    }
  }

  // Phase 2: Check all pages for real content
  const appDir = path.resolve("dx-test-app/public");
  const htmlFiles = fs.existsSync(appDir)
    ? fs.readdirSync(appDir).filter((f) => f.endsWith(".html"))
    : ["index.html"];

  for (const htmlFile of htmlFiles) {
    const pagePath = htmlFile === "index.html" ? "/" : `/${htmlFile}`;
    try {
      const res = await fetch(`${url}${pagePath}`, {
        signal: AbortSignal.timeout(10000),
      });
      const html = await res.text();

      if (res.status >= 400) {
        bugs.push({ type: "ui", page: pagePath, status: res.status });
        continue;
      }
      if (html.includes("Cannot GET") || html.includes("ECONNREFUSED")) {
        bugs.push({ type: "ui", page: pagePath, error: "Page not found" });
        continue;
      }
      // Check for raw JSON dumped on page (sign of unformatted data)
      if (
        html.includes("JSON.stringify") &&
        !html.includes("table") &&
        !html.includes("card")
      ) {
        bugs.push({
          type: "ui-quality",
          page: pagePath,
          error:
            "Page dumps raw JSON instead of rendering data in tables/cards. Data should be formatted as proper UI elements.",
        });
      }
      // Check for empty content divs with no rendering logic
      const hasRenderLogic =
        html.includes("innerHTML") ||
        html.includes("appendChild") ||
        html.includes("createElement") ||
        html.includes("template");
      if (
        !hasRenderLogic &&
        html.includes('id="') &&
        !html.includes("<script")
      ) {
        bugs.push({
          type: "ui-quality",
          page: pagePath,
          error:
            "Page has content containers but no JavaScript to render data into them.",
        });
      }
    } catch (err) {
      bugs.push({ type: "ui", page: pagePath, error: String(err) });
    }
  }

  // Phase 3: Check that app.js actually renders data, not just JSON.stringify
  const appJsPath = path.resolve("dx-test-app/public/app.js");
  if (fs.existsSync(appJsPath)) {
    const appJs = fs.readFileSync(appJsPath, "utf-8");
    const jsonStringifyCount = (appJs.match(/JSON\.stringify/g) || []).length;
    // Look for actual HTML data rendering — table rows, list items, or data-specific elements
    const dataRenderCount = (
      appJs.match(/<tr|<td|<th|<thead|<tbody|<li>.*\$\{|\.map\s*\(/gi) || []
    ).length;

    if (jsonStringifyCount > 0 && dataRenderCount === 0) {
      bugs.push({
        type: "ui-quality",
        page: "app.js",
        error: `app.js uses JSON.stringify ${jsonStringifyCount} times but has no table/card rendering. Data must be displayed as formatted HTML — tables for lists, cards for details, not raw JSON.`,
      });
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    url,
    totalBugs: bugs.length,
    bugs,
  };

  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, `report-${Date.now()}.json`),
    JSON.stringify(report, null, 2),
  );

  return { bugs, report };
}

async function fixWithLLM(
  appDir: string,
  bugs: any[],
  iteration: number,
): Promise<boolean> {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;

  if (!hasAnthropic && !hasOpenAI) return false;

  // Read current app files
  const files: Record<string, string> = {};
  const appFiles = ["server.js", "public/index.html", "package.json"];
  for (const f of appFiles) {
    const p = path.join(appDir, f);
    if (fs.existsSync(p)) {
      files[f] = fs.readFileSync(p, "utf-8");
    }
  }

  const bugSummary = bugs
    .map((b) => {
      if (b.type === "api")
        return `API ${b.endpoint} → ${b.status || "ERR"}: ${b.body || b.error || ""}`;
      return `UI ${b.page} → ${b.status || "ERR"}: ${b.error || ""}`;
    })
    .join("\n");

  const prompt = `You generated an example app. It has bugs. Fix them.

This is iteration ${iteration} of the fix loop. Fix the bugs and return the corrected files.

BUGS FOUND:
${bugSummary}

CURRENT FILES:

${Object.entries(files)
  .map(([name, content]) => `===FILE: ${name}===\n${content}\n===END===`)
  .join("\n\n")}

Fix the bugs. Return ONLY the files that changed, in the same format:

===FILE: path/to/file===
fixed contents
===END===

Rules:
- Do NOT invent npm packages that don't exist
- Use fetch() to call APIs, not fictional SDKs
- If an API endpoint returns an error, handle it gracefully in the UI
- If the server won't start, fix the syntax/import errors first
- Keep it simple — Express + vanilla HTML
- CRITICAL: Do NOT wrap file contents in markdown code fences. Write raw file contents between ===FILE: and ===END=== markers.`;

  let responseText: string;

  if (hasAnthropic) {
    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    });
    responseText =
      message.content[0].type === "text" ? message.content[0].text : "";
  } else {
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    });
    responseText = completion.choices[0]?.message?.content || "";
  }

  // Parse and write fixed files
  const filePattern = /===FILE:\s*(.+?)===\n([\s\S]*?)===END===/g;
  let match;
  let fixCount = 0;

  while ((match = filePattern.exec(responseText)) !== null) {
    let content = match[2].trim();
    content = content.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
    const filePath = path.join(appDir, match[1].trim());
    const fileDir = path.dirname(filePath);
    if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(filePath, content);
    fixCount++;
  }

  return fixCount > 0;
}

export async function run(productPath: string, options: RunOptions) {
  const resolvedPath = path.resolve(productPath);
  const outputDir = path.resolve(options.output);
  const maxIterations = parseInt(options.maxIterations) || 3;
  const port = 4000;
  const url = `http://localhost:${port}`;

  console.log(chalk.bold(`\ndx-test — Full run\n`));
  console.log(chalk.dim(`Product: ${resolvedPath}`));
  console.log(chalk.dim(`Output: ${outputDir}`));
  console.log(chalk.dim(`Max iterations: ${maxIterations}\n`));

  // Step 1: Generate
  console.log(chalk.bold("Step 1: Generate example app\n"));
  await generate(productPath, { output: options.output });

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    console.log(
      chalk.bold(`\n--- Iteration ${iteration}/${maxIterations} ---\n`),
    );

    // Step 2: Install
    console.log(chalk.dim("Installing dependencies..."));
    try {
      execSync("npm install", {
        cwd: outputDir,
        stdio: "pipe",
        timeout: 60000,
      });
      console.log(chalk.green("  Dependencies installed"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`  Install failed: ${msg.slice(0, 200)}`));

      if (iteration < maxIterations) {
        console.log(chalk.dim("  Sending error to LLM for fix..."));
        await fixWithLLM(
          outputDir,
          [{ type: "build", error: msg.slice(0, 1000) }],
          iteration,
        );
        continue;
      }
      break;
    }

    // Step 3: Start
    console.log(chalk.dim("Starting app..."));
    const app = startApp(outputDir, port);

    const serverUp = await waitForServer(url);
    if (!serverUp) {
      const startupOutput = app.getOutput();
      console.log(chalk.red("  App failed to start within 30s"));
      if (startupOutput) {
        console.log(chalk.dim(`  Output: ${startupOutput.slice(0, 300)}`));
      }
      app.proc.kill();

      if (iteration < maxIterations) {
        console.log(chalk.dim("  Sending error to LLM for fix..."));
        await fixWithLLM(
          outputDir,
          [
            {
              type: "startup",
              error: `Server did not respond. Output:\n${startupOutput.slice(0, 1500)}`,
            },
          ],
          iteration,
        );
        continue;
      }
      break;
    }
    console.log(chalk.green(`  App running at ${url}`));

    // Step 4: Walk
    console.log(chalk.dim("Walking app..."));
    const { bugs } = await walkApp(url, "./dx-test-reports");

    // Kill the app
    app.proc.kill();

    if (bugs.length === 0) {
      console.log(
        chalk.green(
          chalk.bold(`\nClean! No bugs found on iteration ${iteration}.`),
        ),
      );
      console.log(chalk.dim(`\nYour example app is ready at ${outputDir}`));
      console.log(chalk.dim(`  cd ${options.output} && npm start\n`));
      return;
    }

    console.log(chalk.yellow(`  ${bugs.length} bugs found`));
    for (const bug of bugs.slice(0, 10)) {
      if (bug.type === "api") {
        console.log(chalk.red(`    ${bug.endpoint} → ${bug.status || "ERR"}`));
      } else {
        console.log(chalk.red(`    ${bug.page} → ${bug.error || bug.status}`));
      }
    }

    // Step 5: Fix
    if (iteration < maxIterations) {
      console.log(chalk.dim("\n  Sending bugs to LLM for fix..."));
      const fixed = await fixWithLLM(outputDir, bugs, iteration);
      if (!fixed) {
        console.log(chalk.yellow("  LLM couldn't produce fixes. Stopping."));
        break;
      }
      console.log(chalk.green("  Fixes applied. Re-running..."));
    }
  }

  console.log(chalk.bold(`\nRun complete.`));
  console.log(chalk.dim(`App: ${outputDir}`));
  console.log(chalk.dim(`Reports: ./dx-test-reports\n`));
}
