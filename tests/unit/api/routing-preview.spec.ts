import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/api/requireManagementAuth", () => ({
  requireManagementAuth: vi.fn(),
}));

import { POST } from "@/app/api/omniroute/route/preview/route";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import type { RoutingCandidate } from "@/lib/routing/adaptiveRouting";

const responseSchema = z
  .object({
    request: z.object({ candidateCount: z.number().int().positive() }).strict(),
    selected: z.string().nullable(),
    liveRequestExecuted: z.literal(false),
    candidates: z.array(
      z
        .object({
          providerId: z.string(),
          modelId: z.string(),
          score: z.number().min(0).max(1),
          eligible: z.boolean(),
          reasons: z.array(z.string()),
          factors: z.record(z.string(), z.union([z.number(), z.string()])),
        })
        .strict()
    ),
  })
  .strict();

function candidate(overrides: Partial<RoutingCandidate> = {}): RoutingCandidate {
  return {
    providerId: "synthetic-eligible",
    modelId: "synthetic-model",
    capabilityScore: 1,
    allocation: "allow",
    healthScore: 1,
    circuit: "closed",
    quota: "healthy",
    modelPreference: 1,
    costPreference: 1,
    ...overrides,
  };
}

function request(body: unknown): Request {
  return new Request("http://127.0.0.1:20128/api/omniroute/route/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function preview(candidates: RoutingCandidate[]) {
  const response = await POST(request({ candidates }));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  return responseSchema.parse(await response.json());
}

describe("POST /api/omniroute/route/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireManagementAuth).mockResolvedValue(null);
    // A preview must never reach an upstream; fail immediately if it attempts fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Unexpected upstream inference during routing preview");
      })
    );
  });

  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("selects an eligible candidate and returns the validated HTTP response structure", async () => {
    const body = await preview([candidate()]);
    expect(body.request).toEqual({ candidateCount: 1 });
    expect(body.selected).toBe("synthetic-eligible");
    expect(body.liveRequestExecuted).toBe(false);
    expect(body.candidates[0]).toMatchObject({
      providerId: "synthetic-eligible",
      modelId: "synthetic-model",
      score: 1,
      eligible: true,
    });
  });

  it("keeps allocation-denied candidates ineligible even with otherwise higher scores", async () => {
    const body = await preview([
      candidate({ providerId: "synthetic-denied", allocation: "deny" }),
      candidate({ capabilityScore: 0.25 }),
    ]);
    expect(body.selected).toBe("synthetic-eligible");
    expect(body.request.candidateCount).toBe(2);
    const denied = body.candidates.find((entry) => entry.providerId === "synthetic-denied");
    expect(denied).toMatchObject({ eligible: false, score: 0 });
    expect(denied?.reasons).toContain("allocation denied");
  });

  it("returns no selection when every allocation is denied", async () => {
    const body = await preview([candidate({ allocation: "deny" })]);
    expect(body.selected).toBeNull();
    expect(body.candidates[0].eligible).toBe(false);
  });

  it("returns deterministic rankings for the same synthetic input without inference", async () => {
    const candidates = [
      candidate(),
      candidate({ providerId: "synthetic-backup", healthScore: 0.5 }),
    ];
    expect(await preview(candidates)).toEqual(await preview(candidates));
  });

  it.each([{}, { candidates: [] }, { candidates: [candidate({ capabilityScore: 2 })] }])(
    "rejects invalid candidate input with HTTP 400: %j",
    async (body) => {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      const error = await response.json();
      expect(typeof error.error).toBe("string");
      expect(error.error).not.toContain("at /");
    }
  );

  it("preserves the management authentication gate before reading candidates", async () => {
    const denied = Response.json({ error: "Authentication required" }, { status: 401 });
    vi.mocked(requireManagementAuth).mockResolvedValue(denied);
    const input = request({ candidates: [candidate()] });
    const readBody = vi.spyOn(input, "json");
    expect(await POST(input)).toBe(denied);
    expect(readBody).not.toHaveBeenCalled();
  });
});
