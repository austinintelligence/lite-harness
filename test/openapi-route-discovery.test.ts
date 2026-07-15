import { describe, expect, it } from "vitest";
import { discoverPublicRoutes } from "../scripts/openapi-route-discovery.js";

describe("OpenAPI route discovery", () => {
  it("discovers multiline, constant, and app.route registrations", () => {
    const inventory = discoverPublicRoutes(`
      const runs = "/v1/runs/:runId";
      app.get(runs, handler);
      app.post("/v1/runs", handler);
      app.route({ method: ["GET", "POST"], url: "/v1/agents" , handler });
      app.get("/internal/health", handler);
    `);
    expect([...inventory.operations].sort()).toEqual([
      "GET /v1/agents",
      "GET /v1/runs/{runId}",
      "POST /v1/agents",
      "POST /v1/runs",
    ]);
    expect([...inventory.routes].sort()).toEqual(["/v1/agents", "/v1/runs", "/v1/runs/{runId}"]);
  });

  it("fails closed for a dynamic public path", () => {
    expect(() => discoverPublicRoutes("app.get(routeFromConfig, handler);")).toThrow(/static path/);
  });
});
