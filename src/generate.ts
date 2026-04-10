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

  // Classify the product to inject category-specific guidance
  const routePaths = uniqueRoutes.map((r) => r.path.toLowerCase()).join(" ");
  const categories: string[] = [];
  if (
    routePaths.match(
      /billing|subscription|plan|checkout|invoice|payment|stripe/,
    )
  )
    categories.push("billing");
  if (routePaths.match(/analytics|metrics|events|track|usage|cost|revenue/))
    categories.push("analytics");
  if (routePaths.match(/auth|login|signup|user|session|token/))
    categories.push("auth");
  if (routePaths.match(/chat|completion|model|inference|llm|embed|prompt/))
    categories.push("ai");
  if (routePaths.match(/customer|cohort|segment|user/)) categories.push("crm");
  if (routePaths.match(/alert|notification|webhook/)) categories.push("alerts");
  if (routePaths.match(/gateway|proxy|route|config/))
    categories.push("gateway");
  if (routePaths.match(/team|invite|role|member/)) categories.push("team");

  console.log(
    chalk.dim(`Product categories: ${categories.join(", ") || "general"}`),
  );

  const categoryGuidance: Record<string, string> = {
    billing: `BILLING PRODUCT: The example app MUST include:
- A pricing page showing available plans with prices, fetched from the API
- A subscribe/checkout flow that calls the subscription creation endpoint
- A billing dashboard showing current plan, usage, and invoices
- Plan change flow (upgrade/downgrade) if endpoints exist
- Cancellation flow with confirmation`,

    analytics: `ANALYTICS PRODUCT: The example app MUST include:
- A dashboard with charts/tables showing key metrics (revenue, costs, usage, margins)
- An events table showing recent tracked events with filters
- A way to send/ingest test events to verify tracking works
- Customer-level detail view showing per-customer data
- Use real data from the API, display as tables with proper formatting`,

    auth: `AUTH PRODUCT: The example app MUST include:
- Signup page with email/password form
- Login page with email/password form
- Protected dashboard that requires authentication
- Logout functionality
- Session handling (store token in cookie or localStorage)
- Show current user info when logged in`,

    ai: `AI PRODUCT: The example app MUST include:
- A chat/prompt interface where users can type a query
- Display AI responses with proper formatting
- Model selection if multiple models are available
- Show cost/token usage per request if available
- History of previous interactions`,

    crm: `CRM/CUSTOMER DATA: The example app MUST include:
- Customer list with search/filter
- Customer detail view showing all data for one customer
- Cohort/segment views if endpoints exist`,

    alerts: `ALERTS: The example app MUST include:
- Alert list showing current alerts
- Create alert form
- Alert detail/edit view`,

    gateway: `API GATEWAY: The example app MUST include:
- Configuration list showing current routing configs
- Create/edit configuration form
- Provider status display
- Test endpoint to verify routing works`,

    team: `TEAM MANAGEMENT: The example app MUST include:
- Team member list
- Invite member form
- Role display`,
  };

  const specificGuidance = categories
    .map((cat) => categoryGuidance[cat])
    .filter(Boolean)
    .join("\n\n");

  const prompt = `You are generating a working example app that integrates with a product called "${productName}".

This example app simulates what a REAL customer would build using this product. It serves two purposes:
1. Test that the product's API actually works end-to-end from a client's perspective
2. Become a polished reference implementation the company can open source for their customers

CRITICAL RULES:
- Do NOT invent SDK packages that don't exist. Use the built-in fetch() (Node 18+) to call the product's API.
- Do NOT use require('node-fetch') — use native fetch.
- The product runs at PRODUCT_API_URL (default http://localhost:3001). Your Express backend proxies calls to it.
- Use ONLY real API endpoints from the route list below. Do not make up endpoints.
- The app must actually work when pointed at the running product.
- Use "type": "module" in package.json and ES module imports (import/export), OR use CommonJS consistently. Do not mix.

Here are the product's actual API endpoints (${uniqueRoutes.length} total):

<api-routes>
${routeList}
</api-routes>

${specificGuidance ? `\nBased on the endpoints, this product covers: ${categories.join(", ")}.\n\n${specificGuidance}\n` : ""}

Here is additional context about the product (README, env vars, code):

<product-context>
${context}
</product-context>

Generate a COMPLETE, production-quality example app:

BACKEND (server.js):
- Express.js, reads PORT from env
- Proxy routes for every major feature area (not just 2 endpoints — cover the key user flows)
- Forward cookies/auth headers to the product API
- Proper error handling that returns the upstream error message

FRONTEND (multiple HTML files):
- Shared layout with navigation sidebar or header
- Separate pages for each feature area (at least 5-7 pages)
- Dashboard/home page as the landing page
- Each page fetches real data and displays it in tables, cards, or lists
- Forms for creating/submitting data
- Loading states and error states
- Clean, modern styling — system font stack, CSS variables for colors, card layouts, proper spacing
- Responsive (looks good on desktop)

FILES TO GENERATE:
- package.json (express + dotenv only, no other deps)
- server.js
- public/index.html (dashboard/home)
- public/styles.css (shared styles)
- public/app.js (shared JS — navigation, fetch helpers, layout rendering)
- Additional HTML files for each feature page
- .env.example

The app should have AT LEAST 5 pages with real functionality. Think: what would a developer evaluating this product want to see working?

Respond with files in this exact format — one block per file:

===FILE: path/to/file===
raw file contents here (NO markdown code fences)
===END===

CRITICAL: Do NOT wrap file contents in markdown code fences. No \`\`\`json, no \`\`\`javascript. Raw content only between the markers.`;

  let responseText: string;

  if (provider === "anthropic") {
    console.log(chalk.dim("Generating app with Claude..."));
    const client = new Anthropic();
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 32000,
      messages: [{ role: "user", content: prompt }],
    });
    responseText =
      message.content[0].type === "text" ? message.content[0].text : "";
  } else {
    console.log(chalk.dim("Generating app with GPT-4o..."));
    const client = new OpenAI();
    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 16384,
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
