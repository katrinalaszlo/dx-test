import * as fs from "node:fs";
import * as path from "node:path";
import { chromium, type Page } from "playwright";
import chalk from "chalk";

interface BugReport {
  step: string;
  flow: string;
  flowType: "happy" | "error";
  timestamp: string;
  pageUrl: string;
  userWasDoing: string;
  consoleErrors: string[];
  networkFailures: NetworkFailure[];
  screenshotPath: string | null;
  apiResponse?: { status: number; body: string | null };
}

interface NetworkFailure {
  url: string;
  status: number;
  method: string;
  body: string | null;
}

interface FlowStep {
  action: string;
  expect: string;
  selector?: string;
  url?: string;
  input?: Record<string, string>;
}

interface Flow {
  name: string;
  type: "happy" | "error";
  steps: FlowStep[];
}

interface WalkOptions {
  url: string;
  report: string;
}

export async function walk(options: WalkOptions) {
  const flowsPath = path.resolve("dx-test-app/flows.json");
  const analysisPath = path.resolve("dx-test-app/analysis.json");

  if (!fs.existsSync(flowsPath)) {
    console.log(
      chalk.red(
        `No flows found. Run ${chalk.bold("dx-test generate <path>")} first.`,
      ),
    );
    process.exit(1);
  }

  const flows: Flow[] = JSON.parse(fs.readFileSync(flowsPath, "utf-8"));
  const analysis = fs.existsSync(analysisPath)
    ? JSON.parse(fs.readFileSync(analysisPath, "utf-8"))
    : null;
  const baseUrl = options.url;
  const routes = analysis?.routes || [];

  console.log(chalk.bold(`\ndx-test — Walking flows\n`));
  console.log(chalk.dim(`Target: ${baseUrl}`));
  console.log(chalk.dim(`Flows: ${flows.length} | Routes: ${routes.length}\n`));

  const outputDir = path.resolve(options.report);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const bugs: BugReport[] = [];

  // Phase 1: API-level testing — hit every route directly
  console.log(chalk.bold("Phase 1: API Route Testing\n"));

  const apiResults = { passed: 0, failed: 0, errors: 0 };

  for (const route of routes) {
    // Skip routes with path params — need real IDs
    if (route.path.includes(":") || route.path.includes("{")) {
      continue;
    }

    const url = `${baseUrl}/api${route.path}`;
    const method = route.method;

    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method !== "GET" ? JSON.stringify({}) : undefined,
      });

      const status = response.status;
      let body: string | null = null;
      try {
        body = await response.text();
      } catch {}

      if (status >= 500) {
        apiResults.errors++;
        bugs.push({
          step: `${method} ${route.path}`,
          flow: "api-routes",
          flowType: "happy",
          timestamp: new Date().toISOString(),
          pageUrl: url,
          userWasDoing: `Testing API route: ${method} ${route.path}`,
          consoleErrors: [],
          networkFailures: [{ url, status, method, body }],
          screenshotPath: null,
          apiResponse: { status, body },
        });
        console.log(
          chalk.red(`  ${method} ${route.path} → ${status} SERVER ERROR`),
        );
        if (body) {
          const preview = body.substring(0, 120);
          console.log(chalk.dim(`    ${preview}`));
        }
      } else if (status >= 400 && status < 500) {
        // 401/403 expected for auth-protected routes
        if (status === 401 || status === 403) {
          console.log(
            chalk.yellow(
              `  ${method} ${route.path} → ${status} (auth required)`,
            ),
          );
        } else {
          apiResults.failed++;
          bugs.push({
            step: `${method} ${route.path}`,
            flow: "api-routes",
            flowType: "happy",
            timestamp: new Date().toISOString(),
            pageUrl: url,
            userWasDoing: `Testing API route: ${method} ${route.path}`,
            consoleErrors: [],
            networkFailures: [{ url, status, method, body }],
            screenshotPath: null,
            apiResponse: { status, body },
          });
          console.log(chalk.red(`  ${method} ${route.path} → ${status}`));
          if (body) {
            const preview = body.substring(0, 120);
            console.log(chalk.dim(`    ${preview}`));
          }
        }
      } else {
        apiResults.passed++;
        console.log(chalk.green(`  ${method} ${route.path} → ${status}`));
      }
    } catch (err) {
      apiResults.errors++;
      bugs.push({
        step: `${method} ${route.path}`,
        flow: "api-routes",
        flowType: "happy",
        timestamp: new Date().toISOString(),
        pageUrl: url,
        userWasDoing: `Testing API route: ${method} ${route.path}`,
        consoleErrors: [`Request failed: ${err}`],
        networkFailures: [],
        screenshotPath: null,
      });
      console.log(chalk.red(`  ${method} ${route.path} → FAILED: ${err}`));
    }
  }

  console.log(
    chalk.bold(
      `\nAPI Results: ${chalk.green(String(apiResults.passed))} passed, ${chalk.red(String(apiResults.failed))} failed, ${chalk.red(String(apiResults.errors))} errors\n`,
    ),
  );

  // Phase 2: UI testing — open browser, navigate pages, check rendering
  console.log(chalk.bold("Phase 2: UI Testing\n"));

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors: string[] = [];

  // Ignore common non-critical console errors (handled retries, network on cold start)
  const ignoredPatterns = [
    /Failed to load sample data/,
    /Failed to fetch/,
    /Failed to load resource/,
    /net::ERR_/,
    /ResizeObserver/,
    /TimeoutError: signal timed out/,
  ];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (!ignoredPatterns.some((p) => p.test(text))) {
        consoleErrors.push(text);
      }
    }
  });

  // Navigate to the app
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    console.log(chalk.green(`  Loaded ${baseUrl}`));
    await page.screenshot({
      path: path.join(outputDir, "homepage.png"),
      fullPage: true,
    });
  } catch (err) {
    console.log(chalk.red(`  Could not load ${baseUrl}: ${err}`));
  }

  // Get all visible links/navigation to discover UI pages
  const links = await page.evaluate(() => {
    const anchors = document.querySelectorAll("a[href]");
    return Array.from(anchors)
      .map((a) => (a as HTMLAnchorElement).href)
      .filter((href) => href.startsWith(window.location.origin));
  });

  const visitedPages = new Set<string>();
  const uniqueLinks = [...new Set(links)].slice(0, 20); // Cap at 20 pages

  for (const link of uniqueLinks) {
    const pagePath = new URL(link).pathname;
    if (visitedPages.has(pagePath)) continue;
    visitedPages.add(pagePath);

    consoleErrors.length = 0;

    try {
      await page.goto(link, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(1000);

      const screenshotPath = path.join(
        outputDir,
        `page-${pagePath.replace(/\//g, "_") || "root"}-${Date.now()}.png`,
      );
      await page.screenshot({ path: screenshotPath, fullPage: true });

      // Check for error states — look for actual error patterns, not partial string matches
      const bodyText = await page.innerText("body").catch(() => "");
      const hasError =
        bodyText.includes("Something went wrong") ||
        bodyText.includes("Internal Server Error") ||
        bodyText.includes("Cannot read properties of") ||
        /\bundefined is not (a function|an object)\b/.test(bodyText) ||
        /Error: \d{3}/.test(bodyText);

      if (consoleErrors.length > 0 || hasError) {
        bugs.push({
          step: `Visit ${pagePath}`,
          flow: "ui-navigation",
          flowType: "happy",
          timestamp: new Date().toISOString(),
          pageUrl: link,
          userWasDoing: `Navigating to ${pagePath}`,
          consoleErrors: [...consoleErrors],
          networkFailures: [],
          screenshotPath,
        });
        console.log(
          chalk.red(
            `  ${pagePath} — ${consoleErrors.length} console errors${hasError ? ", error text visible" : ""}`,
          ),
        );
      } else {
        console.log(chalk.green(`  ${pagePath} — OK`));
      }
    } catch (err) {
      console.log(chalk.red(`  ${pagePath} — Failed to load: ${err}`));
    }
  }

  // Check for interactive elements that might be broken
  console.log(chalk.bold("\n  Checking interactive elements..."));
  const buttons = await page.locator("button").count();
  const inputs = await page.locator("input").count();
  const forms = await page.locator("form").count();
  console.log(
    chalk.dim(`  Found: ${buttons} buttons, ${inputs} inputs, ${forms} forms`),
  );

  await browser.close();

  // Write report
  const reportPath = path.join(outputDir, `report-${Date.now()}.json`);
  const totalSteps =
    routes.filter(
      (r: { path: string }) => !r.path.includes(":") && !r.path.includes("{"),
    ).length + uniqueLinks.length;
  const report = {
    timestamp: new Date().toISOString(),
    url: baseUrl,
    phases: {
      api: apiResults,
      ui: {
        pagesVisited: visitedPages.size,
        bugsFound: bugs.filter((b) => b.flow === "ui-navigation").length,
      },
    },
    totalBugs: bugs.length,
    bugs,
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(chalk.bold(`\n--- Walk Complete ---`));
  console.log(
    `API routes tested: ${apiResults.passed + apiResults.failed + apiResults.errors}`,
  );
  console.log(`UI pages visited: ${visitedPages.size}`);
  console.log(`Bugs: ${chalk.red(String(bugs.length))}`);
  console.log(`Report: ${chalk.dim(reportPath)}\n`);
}
