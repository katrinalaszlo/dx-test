import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";

interface ProductAnalysis {
  name: string;
  type: "api" | "sdk" | "unknown";
  language: string | null;
  routes: Route[];
  docs: string[];
  config: Record<string, string>;
  flows: GeneratedFlow[];
}

interface Route {
  method: string;
  path: string;
  description: string;
}

interface GeneratedFlow {
  name: string;
  type: "happy" | "error";
  steps: FlowStep[];
}

interface FlowStep {
  action: string;
  expect: string;
  selector?: string;
  url?: string;
  input?: Record<string, string>;
}

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
        entry.name === "build"
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

function extractRoutes(filePath: string): Route[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const routes: Route[] = [];

  // Express-style routes
  const expressPattern =
    /\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let match;
  while ((match = expressPattern.exec(content)) !== null) {
    routes.push({
      method: match[1].toUpperCase(),
      path: match[2],
      description: "",
    });
  }

  // Spring Boot @RequestMapping style
  const springPattern =
    /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?['"`]([^'"`]+)['"`]/gi;
  while ((match = springPattern.exec(content)) !== null) {
    routes.push({
      method: match[1].toUpperCase(),
      path: match[2],
      description: "",
    });
  }

  return routes;
}

function detectLanguage(productPath: string): string | null {
  if (fs.existsSync(path.join(productPath, "package.json")))
    return "typescript";
  if (fs.existsSync(path.join(productPath, "pom.xml"))) return "java";
  if (fs.existsSync(path.join(productPath, "go.mod"))) return "go";
  if (
    fs.existsSync(path.join(productPath, "requirements.txt")) ||
    fs.existsSync(path.join(productPath, "pyproject.toml"))
  )
    return "python";
  return null;
}

function generateFlows(routes: Route[]): GeneratedFlow[] {
  const flows: GeneratedFlow[] = [];

  // Group routes by resource
  const authRoutes = routes.filter(
    (r) =>
      r.path.includes("signup") ||
      r.path.includes("login") ||
      r.path.includes("auth"),
  );
  const crudRoutes = routes.filter(
    (r) =>
      !r.path.includes("signup") &&
      !r.path.includes("login") &&
      !r.path.includes("auth"),
  );

  // Auth happy path
  if (authRoutes.length > 0) {
    const signupRoute = authRoutes.find((r) => r.path.includes("signup"));
    const loginRoute = authRoutes.find((r) => r.path.includes("login"));

    const steps: FlowStep[] = [];
    if (signupRoute) {
      steps.push({
        action: "Navigate to signup page",
        expect: "Signup form is visible with all required fields",
        url: "/signup",
      });
      steps.push({
        action: "Fill in registration form with valid data",
        expect: "All fields accept input without error",
      });
      steps.push({
        action: "Submit registration",
        expect: "User is created and redirected to main app",
      });
    }
    if (loginRoute) {
      steps.push({
        action: "Navigate to login page",
        expect: "Login form is visible",
        url: "/login",
      });
      steps.push({
        action: "Log in with created credentials",
        expect: "User is authenticated and sees dashboard",
      });
    }

    if (steps.length > 0) {
      flows.push({ name: "auth", type: "happy", steps });
    }

    // Auth error path
    const errorSteps: FlowStep[] = [];
    if (signupRoute) {
      errorSteps.push({
        action: "Submit signup with empty fields",
        expect: "Validation errors shown for each required field",
      });
      errorSteps.push({
        action: "Submit signup with invalid email",
        expect: "Clear error about invalid email format",
      });
      errorSteps.push({
        action: "Submit signup with short password",
        expect: "Clear error about password requirements",
      });
    }
    if (loginRoute) {
      errorSteps.push({
        action: "Submit login with wrong password",
        expect: "Clear error message — not generic 'something went wrong'",
      });
      errorSteps.push({
        action: "Submit login with non-existent email",
        expect: "Clear error message — not a stack trace",
      });
    }

    if (errorSteps.length > 0) {
      flows.push({ name: "auth-errors", type: "error", steps: errorSteps });
    }
  }

  // Group CRUD routes by base path for resource flows
  const resourceMap = new Map<string, Route[]>();
  for (const route of crudRoutes) {
    const base = route.path.split("/").slice(0, 4).join("/");
    if (!resourceMap.has(base)) resourceMap.set(base, []);
    resourceMap.get(base)!.push(route);
  }

  for (const [resource, resourceRoutes] of resourceMap) {
    const name = resource.replace(/^\/api\//, "").replace(/\//g, "-") || "main";
    const steps: FlowStep[] = [];

    const getRoute = resourceRoutes.find((r) => r.method === "GET");
    const postRoute = resourceRoutes.find((r) => r.method === "POST");

    if (getRoute) {
      steps.push({
        action: `Fetch ${name} list`,
        expect: "Data loads without error, response is well-structured",
      });
    }
    if (postRoute) {
      steps.push({
        action: `Create a new ${name}`,
        expect: "Item created successfully, reflected in UI",
      });
    }
    if (getRoute && postRoute) {
      steps.push({
        action: `Verify created ${name} appears in list`,
        expect: "New item visible without page refresh",
      });
    }

    if (steps.length > 0) {
      flows.push({ name, type: "happy", steps });
    }
  }

  return flows;
}

export async function generate(productPath: string, options: GenerateOptions) {
  const resolvedPath = path.resolve(productPath);

  if (!fs.existsSync(resolvedPath)) {
    console.log(chalk.red(`Product path not found: ${resolvedPath}`));
    process.exit(1);
  }

  console.log(chalk.bold(`\ndx-test — Analyzing product\n`));
  console.log(chalk.dim(`Path: ${resolvedPath}`));

  // Detect language
  const language = detectLanguage(resolvedPath);
  console.log(chalk.dim(`Language: ${language || "unknown"}`));

  // Find route files
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
  );
  console.log(chalk.dim(`Route files found: ${routeFiles.length}`));

  // Extract routes
  const routes: Route[] = [];
  for (const file of routeFiles) {
    const fileRoutes = extractRoutes(file);
    routes.push(...fileRoutes);
  }
  console.log(chalk.dim(`API routes found: ${routes.length}`));

  // Find docs
  const docFiles = findFiles(resolvedPath, [
    "README\\.md$",
    "docs?.*\\.md$",
    "GUIDE\\.md$",
    "openapi\\.ya?ml$",
    "swagger\\.ya?ml$",
    "swagger\\.json$",
  ]);
  console.log(chalk.dim(`Doc files found: ${docFiles.length}`));

  // Generate flows
  const flows = generateFlows(routes);
  console.log(chalk.bold(`\nGenerated ${flows.length} test flows:\n`));

  for (const flow of flows) {
    const icon = flow.type === "happy" ? chalk.green("✓") : chalk.red("✗");
    console.log(`  ${icon} ${flow.name} (${flow.steps.length} steps)`);
    for (const step of flow.steps) {
      console.log(chalk.dim(`    → ${step.action}`));
      console.log(chalk.dim(`      expect: ${step.expect}`));
    }
  }

  // Build analysis output
  const analysis: ProductAnalysis = {
    name: path.basename(resolvedPath),
    type: routes.length > 0 ? "api" : "unknown",
    language,
    routes,
    docs: docFiles.map((f) => path.relative(resolvedPath, f)),
    config: {},
    flows,
  };

  // Write output
  const outputDir = path.resolve(options.output);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const analysisPath = path.join(outputDir, "analysis.json");
  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));

  const flowsPath = path.join(outputDir, "flows.json");
  fs.writeFileSync(flowsPath, JSON.stringify(flows, null, 2));

  console.log(chalk.bold(`\nOutput written to ${outputDir}`));
  console.log(chalk.dim(`  analysis.json — product analysis`));
  console.log(chalk.dim(`  flows.json — generated test flows`));
  console.log(
    chalk.dim(`\nNext: run ${chalk.bold("dx-test walk")} to test the flows\n`),
  );
}
