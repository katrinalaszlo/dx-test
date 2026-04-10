import * as fs from "node:fs";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import chalk from "chalk";

interface GenerateOptions {
  output: string;
}

function isRouteDirectory(name: string): boolean {
  return (
    /^routes?$/i.test(name) ||
    /^controllers?$/i.test(name) ||
    /^api$/i.test(name)
  );
}

function findFiles(
  dir: string,
  patterns: string[],
  includeRouteDir = false,
): string[] {
  const results: string[] = [];

  function scan(current: string, inRouteDir: boolean) {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name === ".next"
      )
        continue;

      if (entry.isDirectory()) {
        scan(fullPath, inRouteDir || isRouteDirectory(entry.name));
      } else if (
        patterns.some((p) => entry.name.match(new RegExp(p, "i"))) ||
        (includeRouteDir &&
          inRouteDir &&
          /\.(ts|js|java|go|py)$/.test(entry.name))
      ) {
        results.push(fullPath);
      }
    }
  }

  scan(dir, false);
  return results;
}

function collectContext(productPath: string): string {
  const chunks: string[] = [];

  // README
  const readmePaths = ["README.md", "readme.md", "README"];
  for (const name of readmePaths) {
    const p = path.join(productPath, name);
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, "utf-8");
      chunks.push(`## README\n\n${content.slice(0, 4000)}`);
      break;
    }
  }

  // Package.json / build config
  const pkgPath = path.join(productPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    chunks.push(
      `## package.json\n\nName: ${pkg.name}\nDescription: ${pkg.description || "none"}\nDependencies: ${Object.keys(pkg.dependencies || {}).join(", ")}\nScripts: ${Object.keys(pkg.scripts || {}).join(", ")}`,
    );
  }

  // .env.example
  const envPaths = [".env.example", ".env.sample", ".env.template"];
  for (const name of envPaths) {
    const p = path.join(productPath, name);
    if (fs.existsSync(p)) {
      chunks.push(`## ${name}\n\n${fs.readFileSync(p, "utf-8")}`);
      break;
    }
  }

  // Route files (first 3000 chars each, max 10 files)
  const routeFiles = findFiles(
    productPath,
    [
      "routes?\\.ts$",
      "routes?\\.js$",
      "controller\\.ts$",
      "controller\\.js$",
      "Controller\\.java$",
      "router\\.go$",
    ],
    true,
  ).slice(0, 10);

  for (const file of routeFiles) {
    const rel = path.relative(productPath, file);
    const content = fs.readFileSync(file, "utf-8").slice(0, 3000);
    chunks.push(`## ${rel}\n\n\`\`\`\n${content}\n\`\`\``);
  }

  // SDK / client files
  const sdkFiles = findFiles(productPath, [
    "sdk\\.ts$",
    "client\\.ts$",
    "api\\.ts$",
    "sdk\\.js$",
    "client\\.js$",
  ]).slice(0, 3);

  for (const file of sdkFiles) {
    const rel = path.relative(productPath, file);
    const content = fs.readFileSync(file, "utf-8").slice(0, 3000);
    chunks.push(`## ${rel} (SDK/Client)\n\n\`\`\`\n${content}\n\`\`\``);
  }

  // Docs
  const docFiles = findFiles(productPath, [
    "GUIDE\\.md$",
    "docs?.*\\.md$",
    "INTEGRATION\\.md$",
    "QUICKSTART\\.md$",
    "openapi\\.ya?ml$",
    "swagger\\.ya?ml$",
  ]).slice(0, 5);

  for (const file of docFiles) {
    const rel = path.relative(productPath, file);
    const content = fs.readFileSync(file, "utf-8").slice(0, 2000);
    chunks.push(`## ${rel} (docs)\n\n${content}`);
  }

  return chunks.join("\n\n---\n\n");
}

export async function generate(productPath: string, options: GenerateOptions) {
  const resolvedPath = path.resolve(productPath);

  if (!fs.existsSync(resolvedPath)) {
    console.log(chalk.red(`Product path not found: ${resolvedPath}`));
    process.exit(1);
  }

  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;

  if (!hasAnthropic && !hasOpenAI) {
    console.log(
      chalk.red("Set ANTHROPIC_API_KEY or OPENAI_API_KEY to generate the app."),
    );
    console.log(chalk.dim("  export ANTHROPIC_API_KEY=sk-ant-..."));
    console.log(chalk.dim("  export OPENAI_API_KEY=sk-..."));
    process.exit(1);
  }

  const provider = hasAnthropic ? "anthropic" : "openai";

  console.log(chalk.bold(`\ndx-test — Generating test app\n`));
  console.log(chalk.dim(`Product: ${resolvedPath}`));

  // Collect product context
  console.log(chalk.dim("Reading product codebase..."));
  const context = collectContext(resolvedPath);
  console.log(
    chalk.dim(`Context: ${Math.round(context.length / 1000)}k chars`),
  );

  const productName = path.basename(resolvedPath);
  const outputDir = path.resolve(options.output);

  // Extract actual routes for the prompt
  const routeFiles = findFiles(
    resolvedPath,
    [
      "routes?\\.ts$",
      "routes?\\.js$",
      "controller\\.ts$",
      "controller\\.js$",
      "Controller\\.java$",
      "router\\.go$",
    ],
    true,
  ).slice(0, 10);

  interface ExtractedRoute {
    method: string;
    path: string;
  }
  const extractedRoutes: ExtractedRoute[] = [];
  for (const file of routeFiles) {
    const content = fs.readFileSync(file, "utf-8");
    const expressPattern =
      /\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
    let m;
    while ((m = expressPattern.exec(content)) !== null) {
      extractedRoutes.push({ method: m[1].toUpperCase(), path: m[2] });
    }
  }
  const seen = new Set<string>();
  const uniqueRoutes = extractedRoutes.filter((r) => {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const routeList = uniqueRoutes.map((r) => `${r.method} ${r.path}`).join("\n");

  const prompt = `You are generating a working example app that integrates with a product called "${productName}".

This example app simulates what a real customer would build using this product. It serves two purposes:
1. Test that the product's API actually works end-to-end from a client's perspective
2. Become a reference implementation the company can open source for their customers

CRITICAL RULES:
- Do NOT invent SDK packages that don't exist. Use fetch() to call the product's API directly.
- The product runs at a configurable base URL (default http://localhost:3001). Proxy or call its API from your Express backend.
- Use ONLY real API endpoints from the route list below. Do not make up endpoints.
- The app must actually work when pointed at the running product.

Here are the product's actual API endpoints:

<api-routes>
${routeList}
</api-routes>

Here is additional context about the product (README, env vars, code):

<product-context>
${context}
</product-context>

Generate a complete, runnable example app:

1. Express.js backend + vanilla HTML frontend (no React/Vue/build step)
2. Backend proxies API calls to the product at PRODUCT_API_URL
3. Frontend has real pages for key user flows:
   - If there are auth endpoints: signup and login pages
   - Dashboard/home page showing the main data the product provides
   - Pages for the 3-5 most important features (based on the routes)
   - Forms for creating/sending data to the product
   - Error states that show meaningful messages
4. Clean, styled UI (use a system font stack, simple CSS grid/flexbox)
5. .env.example with PRODUCT_API_URL and any API keys needed
6. package.json with only real npm packages (express, dotenv — that's probably it)

The app should feel like a real product, not a demo. Multiple pages, navigation, real data display. Think: what would a customer's customer actually see and do?

Respond with files in this exact format:

===FILE: path/to/file===
file contents here
===END===

CRITICAL: Do NOT wrap file contents in markdown code fences (\`\`\`). Write raw file contents between ===FILE: and ===END=== markers. No \`\`\`json, no \`\`\`javascript, no backticks of any kind inside the file blocks.

Generate at minimum:
- package.json
- server.js
- public/index.html
- .env.example`;

  let responseText: string;

  if (provider === "anthropic") {
    console.log(chalk.dim("Generating app with Claude..."));
    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    });
    responseText =
      message.content[0].type === "text" ? message.content[0].text : "";
  } else {
    console.log(chalk.dim("Generating app with GPT-4o..."));
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    });
    responseText = completion.choices[0]?.message?.content || "";
  }

  const filePattern = /===FILE:\s*(.+?)===\n([\s\S]*?)===END===/g;
  let match;
  const files: Array<{ path: string; content: string }> = [];

  while ((match = filePattern.exec(responseText)) !== null) {
    let content = match[2].trim();
    // Strip markdown code fences if the LLM wrapped them
    content = content.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
    files.push({
      path: match[1].trim(),
      content,
    });
  }

  if (files.length === 0) {
    console.log(chalk.red("Failed to parse generated app. Raw response:"));
    console.log(responseText.slice(0, 500));
    process.exit(1);
  }

  // Write files
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const file of files) {
    const filePath = path.join(outputDir, file.path);
    const fileDir = path.dirname(filePath);
    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir, { recursive: true });
    }
    fs.writeFileSync(filePath, file.content);
    console.log(chalk.dim(`  wrote ${file.path}`));
  }

  // Also save the context for the walk command
  fs.writeFileSync(
    path.join(outputDir, ".dx-test-context.json"),
    JSON.stringify(
      {
        productName,
        productPath: resolvedPath,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  console.log(chalk.bold(`\nGenerated ${files.length} files in ${outputDir}`));
  console.log(chalk.dim(`\nTo run:`));
  console.log(chalk.dim(`  cd ${options.output}`));
  console.log(chalk.dim(`  cp .env.example .env  # fill in your keys`));
  console.log(chalk.dim(`  npm install`));
  console.log(chalk.dim(`  npm start`));
  console.log(chalk.dim(`\nThen: dx-test walk --url http://localhost:4000\n`));
}
