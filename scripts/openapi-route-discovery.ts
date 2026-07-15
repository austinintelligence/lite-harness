import ts from "typescript";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const PUBLIC_PREFIX = /^(?:\/healthz|\/readyz|\/hooks(?:\/|$)|\/v1(?:\/|$))/u;
const IGNORED_ROOTS = new Set(["/hooks/", "/v1/"]);

export type PublicRouteInventory = Readonly<{
  operations: ReadonlySet<string>;
  routes: ReadonlySet<string>;
}>;

/**
 * Discover Fastify routes from the Gateway AST instead of a formatting-sensitive
 * regular expression. Dynamic public paths fail closed so a new route cannot
 * silently evade the OpenAPI contract check.
 */
export function discoverPublicRoutes(source: string, fileName = "gateway.ts"): PublicRouteInventory {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const constants = collectStringConstants(file);
  const operations = new Set<string>();
  const routes = new Set<string>();

  const addRoute = (method: string, expression: ts.Expression): void => {
    const route = normalizeRoute(staticString(expression, constants));
    if (!route) throw new Error(`OpenAPI route parser requires a static path for app.${method.toLowerCase()}()`);
    if (!PUBLIC_PREFIX.test(route) || IGNORED_ROOTS.has(route)) return;
    operations.add(`${method} ${route}`);
    routes.add(route);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "app") {
      const member = node.expression.name.text.toLowerCase();
      if (METHODS.has(member.toUpperCase())) {
        const path = node.arguments[0];
        if (!path) throw new Error(`OpenAPI route parser requires a path for app.${member}()`);
        addRoute(member.toUpperCase(), path);
      } else if (member === "route") {
        discoverRouteObject(node.arguments[0], constants, addRoute);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return { operations, routes };
}

function discoverRouteObject(
  value: ts.Expression | undefined,
  constants: ReadonlyMap<string, string>,
  addRoute: (method: string, expression: ts.Expression) => void,
): void {
  if (!value || !ts.isObjectLiteralExpression(value)) {
    throw new Error("OpenAPI route parser requires a static app.route() object");
  }
  const url = property(value, "url") ?? property(value, "path");
  const method = property(value, "method");
  if (!url || !method) throw new Error("OpenAPI route parser requires static app.route() method and url");
  const methods = ts.isArrayLiteralExpression(method)
    ? method.elements.map((entry) => staticString(entry, constants))
    : [staticString(method, constants)];
  if (methods.some((entry) => !entry)) throw new Error("OpenAPI route parser requires static app.route() methods");
  for (const entry of methods) {
    const normalized = entry!.toUpperCase();
    if (!METHODS.has(normalized)) throw new Error(`OpenAPI route parser does not support app.route() method ${normalized}`);
    addRoute(normalized, url);
  }
}

function collectStringConstants(file: ts.SourceFile): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = staticString(node.initializer, constants);
      if (value !== undefined) constants.set(node.name.text, value);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return constants;
}

function staticString(node: ts.Node, constants: ReadonlyMap<string, string>): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return constants.get(node.text);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return staticString(node.expression, constants);
  }
  return undefined;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const member of object.properties) {
    if (!ts.isPropertyAssignment(member)) continue;
    const key = member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : undefined;
    if (key === name) return member.initializer;
  }
  return undefined;
}

function normalizeRoute(value: string | undefined): string | undefined {
  return value?.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}");
}
