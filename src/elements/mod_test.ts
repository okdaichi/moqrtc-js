import { assertEquals, assertExists } from "@std/assert";

function overrideHTMLElement(value: unknown): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasHTMLElement = Object.prototype.hasOwnProperty.call(g, "HTMLElement");
	const originalHTMLElement = g.HTMLElement;
	g.HTMLElement = value;
	return () => {
		if (hasHTMLElement) {
			g.HTMLElement = originalHTMLElement;
		} else {
			delete g.HTMLElement;
		}
	};
}

class FakeElement extends EventTarget {
	readonly tagName: string;
	constructor(tagName: string = "div") {
		super();
		this.tagName = tagName.toUpperCase();
	}
}

function overrideCustomElements(value: unknown): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasCustomElements = Object.prototype.hasOwnProperty.call(g, "customElements");
	const originalCustomElements = g.customElements;
	g.customElements = value;
	return () => {
		if (hasCustomElements) {
			g.customElements = originalCustomElements;
		} else {
			delete g.customElements;
		}
	};
}

class FakeCustomElementsRegistry {
	#map = new Map<string, unknown>();

	define(name: string, ctor: unknown): void {
		this.#map.set(name, ctor);
	}

	get(name: string): unknown {
		return this.#map.get(name);
	}
}

Deno.test("defineAll registers RoomElement with hang-room tag", async () => {
	const restoreHTMLElement = overrideHTMLElement(FakeElement);
	const registry = new FakeCustomElementsRegistry();
	const restoreCustomElements = overrideCustomElements(registry);

	try {
		// Dynamic import so HTMLElement is faked before room.ts is evaluated
		const { defineAll } = await import("./mod.ts");
		const { RoomElement } = await import("./room.ts");

		defineAll();
		const registeredConstructor = registry.get("hang-room");
		assertExists(
			registeredConstructor,
			"Expected 'hang-room' to be registered in customElements",
		);
		assertEquals(
			registeredConstructor,
			RoomElement,
			"Expected registered element to be RoomElement",
		);
	} finally {
		restoreCustomElements();
		restoreHTMLElement();
	}
});
