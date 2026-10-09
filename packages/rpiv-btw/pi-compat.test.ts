/** Host-version tolerance: runtime binding, legacy resolution and real init failures. */
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRuntimeStreamSimple } from "./pi-compat.js";

describe("getRuntimeStreamSimple", () => {
	it("binds the streaming method to its host runtime", () => {
		const stream = createAssistantMessageEventStream();
		const runtime = {
			streamSimple: vi.fn(function (this: unknown) {
				expect(this).toBe(runtime);
				return stream;
			}),
		};
		const streamSimple = getRuntimeStreamSimple({ runtime });
		expect(streamSimple).toBeTypeOf("function");
		expect(streamSimple?.(undefined as never, undefined as never)).toBe(stream);
	});

	it.each([undefined, null, {}, { runtime: null }, { runtime: { streamSimple: "not-a-function" } }])(
		"falls back for an absent or malformed runtime: %j",
		(registry) => expect(getRuntimeStreamSimple(registry)).toBeUndefined(),
	);

	it("falls back if a host rejects access to the private runtime slot", () => {
		expect(
			getRuntimeStreamSimple({
				get runtime(): never {
					throw new Error("private");
				},
			}),
		).toBeUndefined();
	});
});

describe("pi-ai loaders", () => {
	afterEach(() => {
		vi.doUnmock("@earendil-works/pi-ai/compat");
		vi.doUnmock("@earendil-works/pi-ai");
		vi.resetModules();
	});

	it("uses /compat for streaming and overflow detection when available", async () => {
		vi.resetModules();
		const streamSimple = vi.fn();
		const isContextOverflow = vi.fn();
		vi.doMock("@earendil-works/pi-ai/compat", () => ({ streamSimple, isContextOverflow }));
		const loaders = await import("./pi-compat.js");
		expect(await loaders.loadStreamSimple()).toBe(streamSimple);
		expect(await loaders.loadIsContextOverflow()).toBe(isContextOverflow);
	});

	it.each(["ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"])(
		"falls back to the root on a nested %s resolution error",
		async (code) => {
			vi.resetModules();
			vi.doMock("@earendil-works/pi-ai/compat", () => {
				throw new Error("wrapped resolution error", { cause: Object.assign(new Error("unavailable"), { code }) });
			});
			const streamSimple = vi.fn();
			const isContextOverflow = vi.fn();
			vi.doMock("@earendil-works/pi-ai", () => ({ streamSimple, isContextOverflow }));
			const loaders = await import("./pi-compat.js");
			expect(await loaders.loadStreamSimple()).toBe(streamSimple);
			expect(await loaders.loadIsContextOverflow()).toBe(isContextOverflow);
		},
	);

	it("does not hide a real /compat initialization error behind a working root export", async () => {
		vi.resetModules();
		vi.doMock("@earendil-works/pi-ai/compat", () => {
			throw new Error("initialization failed");
		});
		vi.doMock("@earendil-works/pi-ai", () => ({ streamSimple: vi.fn(), isContextOverflow: vi.fn() }));
		const loaders = await import("./pi-compat.js");
		await expect(loaders.loadStreamSimple()).rejects.toThrow();
		await expect(loaders.loadIsContextOverflow()).rejects.toThrow();
	});

	it("requires streaming but tolerates a host without an overflow detector", async () => {
		vi.resetModules();
		// Real module namespaces return undefined for absent exports. Explicit keys
		// reproduce that behavior under Vitest's otherwise-strict mock namespace.
		vi.doMock("@earendil-works/pi-ai/compat", () => ({ streamSimple: undefined, isContextOverflow: undefined }));
		const loaders = await import("./pi-compat.js");
		await expect(loaders.loadStreamSimple()).rejects.toThrow(/does not expose streamSimple/);
		await expect(loaders.loadIsContextOverflow()).resolves.toBeUndefined();
	});

	it("tolerates a legacy root without an overflow detector", async () => {
		vi.resetModules();
		vi.doMock("@earendil-works/pi-ai/compat", () => {
			throw Object.assign(new Error("no compat"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
		});
		vi.doMock("@earendil-works/pi-ai", () => ({ isContextOverflow: undefined }));
		await expect((await import("./pi-compat.js")).loadIsContextOverflow()).resolves.toBeUndefined();
	});
});
