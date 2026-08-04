/**
 * pi-compat tests for host-version-tolerant pi-ai helper loading.
 *
 * The consumer test files mock `@earendil-works/pi-ai/compat` to SUCCEED, so
 * the version-tolerance arms the shim exists for are exercised here instead:
 * /compat resolves (host >= 0.80.1), /compat unresolvable → root fallback
 * (host <= 0.79.x), a REAL /compat failure rethrows instead of masking, and a
 * host with neither export fails with a clear error.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

describe("loadStreamSimple", () => {
	afterEach(() => {
		vi.doUnmock("@earendil-works/pi-ai/compat");
		vi.doUnmock("@earendil-works/pi-ai");
		vi.resetModules();
	});

	async function load(): Promise<unknown> {
		const mod = await import("./pi-compat.js");
		return mod.loadStreamSimple();
	}

	it("resolves streamSimple from /compat when the host exposes it", async () => {
		vi.resetModules();
		const compatFn = vi.fn();
		vi.doMock("@earendil-works/pi-ai/compat", () => ({ streamSimple: compatFn }));
		await expect(load()).resolves.toBe(compatFn);
	});

	it("falls back to the package root when /compat is not exported", async () => {
		vi.resetModules();
		vi.doMock("@earendil-works/pi-ai/compat", () => {
			throw Object.assign(new Error("Package subpath './compat' is not defined"), {
				code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
			});
		});
		const rootFn = vi.fn();
		vi.doMock("@earendil-works/pi-ai", () => ({ streamSimple: rootFn }));
		await expect(load()).resolves.toBe(rootFn);
	});

	it("rethrows a non-resolution /compat failure", async () => {
		vi.resetModules();
		vi.doMock("@earendil-works/pi-ai/compat", () => {
			throw new Error("compat entrypoint exploded at module init");
		});
		vi.doMock("@earendil-works/pi-ai", () => ({ streamSimple: vi.fn() }));
		await expect(load()).rejects.toThrow();
	});

	it("fails clearly when neither entrypoint exposes streamSimple", async () => {
		vi.resetModules();
		vi.doMock("@earendil-works/pi-ai/compat", () => ({}));
		await expect(load()).rejects.toThrow(/streamSimple/);
	});
});

describe("loadIsContextOverflow", () => {
	afterEach(() => {
		vi.doUnmock("@earendil-works/pi-ai/compat");
		vi.doUnmock("@earendil-works/pi-ai");
		vi.resetModules();
	});

	/** Import the shim AFTER the per-test doMocks so its dynamic imports resolve
	 *  against them (vi.resetModules first drops any previously-cached copies). */
	async function load(): Promise<unknown> {
		const mod = await import("./pi-compat.js");
		return mod.loadIsContextOverflow();
	}

	it("resolves isContextOverflow from /compat when the host exposes it", async () => {
		vi.resetModules();
		const compatFn = vi.fn();
		vi.doMock("@earendil-works/pi-ai/compat", () => ({ isContextOverflow: compatFn }));
		await expect(load()).resolves.toBe(compatFn);
	});

	it("returns undefined (does not throw) when neither entrypoint exports isContextOverflow", async () => {
		vi.resetModules();
		// Provide the key explicitly as `undefined`: a real ESM namespace returns
		// `undefined` (not throws) for a non-present export, but Vitest's strict mock
		// throws on access of a key the factory omitted — providing the key as
		// undefined faithfully simulates the production condition the loader degrades on.
		vi.doMock("@earendil-works/pi-ai/compat", () => ({ isContextOverflow: undefined }));
		await expect(load()).resolves.toBeUndefined();
	});

	it("falls back to the package root then returns undefined when /compat is unresolvable and root lacks the export", async () => {
		vi.resetModules();
		vi.doMock("@earendil-works/pi-ai/compat", () => {
			// The code an installed-but-old pi-ai actually produces: the package
			// resolves, but "./compat" is missing from its exports map.
			throw Object.assign(new Error("Package subpath './compat' is not defined"), {
				code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
			});
		});
		vi.doMock("@earendil-works/pi-ai", () => ({ isContextOverflow: undefined }));
		await expect(load()).resolves.toBeUndefined();
	});

	it("rethrows a non-resolution /compat failure instead of masking it as undefined", async () => {
		vi.resetModules();
		vi.doMock("@earendil-works/pi-ai/compat", () => {
			throw new Error("compat entrypoint exploded at module init");
		});
		// A WORKING root export proves the rejection comes from the rethrow: the
		// graceful-degradation path would have resolved undefined here.
		vi.doMock("@earendil-works/pi-ai", () => ({ isContextOverflow: vi.fn() }));
		await expect(load()).rejects.toThrow();
	});
});
