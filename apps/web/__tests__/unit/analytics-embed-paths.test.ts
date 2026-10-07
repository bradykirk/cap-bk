import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/web-backend", () => ({ Tinybird: {} }));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));

import { buildPathnameFilter } from "@/app/(org)/dashboard/analytics/data";

describe("buildPathnameFilter", () => {
	it("returns no filter without video IDs", () => {
		expect(buildPathnameFilter()).toBe("");
		expect(buildPathnameFilter([])).toBe("");
	});

	it("includes the share and embed path for each video", () => {
		expect(buildPathnameFilter(["abc", "def"] as never)).toBe(
			"AND pathname IN ('/s/abc', '/embed/abc', '/s/def', '/embed/def')",
		);
	});

	it("escapes quotes and backslashes in IDs", () => {
		expect(buildPathnameFilter(["a'b\\"] as never)).toBe(
			"AND pathname IN ('/s/a''b\\\\', '/embed/a''b\\\\')",
		);
	});
});
