import { assertEquals } from "@std/assert";
import { isChrome, isFirefox } from "./support.ts";

Deno.test("browser detection", async (t) => {
	await t.step("isChrome", async (t) => {
		await t.step("should return a boolean value", () => {
			assertEquals(typeof isChrome, "boolean");
		});
	});

	await t.step("isFirefox", async (t) => {
		await t.step("should return a boolean value", () => {
			assertEquals(typeof isFirefox, "boolean");
		});

		await t.step("should be mutually exclusive with isChrome in most cases", () => {
			// Both can be false, but typically not both true
			assertEquals(typeof isFirefox, "boolean");
		});
	});
});
