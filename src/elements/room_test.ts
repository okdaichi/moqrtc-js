import type { Session } from "@qumo/moq";
import { assert, assertEquals, assertExists } from "@std/assert";
import type { JoinedMember, LeftMember } from "../member.ts";
import type { Room } from "../room.ts";
import type { RoomLifecycleStatus } from "./room.ts";

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

function overrideDocument(value: unknown): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasDocument = Object.prototype.hasOwnProperty.call(g, "document");
	const originalDocument = g.document;
	g.document = value;
	return () => {
		if (hasDocument) {
			g.document = originalDocument;
		} else {
			delete g.document;
		}
	};
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

class FakeElement extends EventTarget {
	readonly tagName: string;
	className = "";
	textContent = "";
	parentElement?: FakeElement;
	#children: FakeElement[] = [];
	#attributes = new Map<string, string>();
	#innerHTML = "";

	constructor(tagName: string = "div") {
		super();
		this.tagName = tagName.toUpperCase();
	}

	set innerHTML(value: string) {
		this.#innerHTML = value;
		this.#children = [];

		const matches = value.matchAll(/<div class="([^"]*)"[^>]*>([^<]*)<\/div>/g);
		for (const [, className, text] of matches) {
			const child = new FakeElement("div");
			child.className = className ?? "";
			child.textContent = text ?? "";
			this.appendChild(child);
		}
	}

	get innerHTML(): string {
		return this.#innerHTML;
	}

	appendChild(child: FakeElement): FakeElement {
		child.parentElement = this;
		this.#children.push(child);
		return child;
	}

	remove(): void {
		if (!this.parentElement) {
			return;
		}
		const siblings = this.parentElement.#children;
		const index = siblings.indexOf(this);
		if (index >= 0) {
			siblings.splice(index, 1);
		}
		this.parentElement = undefined;
	}

	setAttribute(name: string, value: string): void {
		this.#attributes.set(name, value);
		if (name === "class") {
			this.className = value;
		}
	}

	getAttribute(name: string): string | null {
		return this.#attributes.get(name) ?? null;
	}

	querySelector(selector: string): FakeElement | null {
		for (const child of this.#children) {
			if (child.#matches(selector)) {
				return child;
			}
			const nested = child.querySelector(selector);
			if (nested) {
				return nested;
			}
		}
		return null;
	}

	#matches(selector: string): boolean {
		if (selector.startsWith(".")) {
			const cls = selector.slice(1);
			return this.className.split(/\s+/).filter(Boolean).includes(cls);
		}

		const attrPattern = /\[([^=\]]+)="([^"]*)"\]/g;
		const attrs = [...selector.matchAll(attrPattern)];
		if (attrs.length > 0) {
			return attrs.every((match) => {
				const key = match[1];
				const val = match[2] ?? "";
				if (!key) {
					return false;
				}
				return this.#attributes.get(key) === val;
			});
		}

		return false;
	}
}

class FakeDocument {
	body = new FakeElement("body");

	createElement(tagName: string): FakeElement {
		return new FakeElement(tagName);
	}
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

function createFakeDOMFixture(): () => void {
	const restoreHTMLElement = typeof HTMLElement === "undefined"
		? overrideHTMLElement(FakeElement)
		: () => {};
	const restoreDocument = typeof document === "undefined"
		? overrideDocument(new FakeDocument())
		: () => {};
	const restoreCustomElements = typeof customElements === "undefined"
		? overrideCustomElements(new FakeCustomElementsRegistry())
		: () => {};

	return () => {
		restoreHTMLElement();
		restoreDocument();
		restoreCustomElements();
	};
}

async function createRoomModuleFixture() {
	const restoreDOM = createFakeDOMFixture();
	const roomModule = await import("./room.ts");
	roomModule.defineRoom();
	return { restoreDOM, roomModule };
}

async function createRoomElementFixture() {
	const { restoreDOM, roomModule } = await createRoomModuleFixture();
	const element = new roomModule.RoomElement();
	return { restoreDOM, roomModule, element };
}

function createFakeSession(
	roomID: string,
	localName: string,
	options?: { includeRemote?: boolean; failAccept?: boolean },
) {
	let callCount = 0;

	if (options?.failAccept) {
		return {
			mux: { publish: () => {} },
			acceptAnnounce: async () => [undefined, new Error("accept failed")],
		};
	}

	return {
		mux: {
			publish: () => {},
		},
		acceptAnnounce: async () => [
			{
				receive: async () => {
					callCount += 1;
					if (callCount === 1) {
						return [{
							broadcastPath: `/${roomID}/${localName}.hang`,
							ended: () => new Promise<void>(() => {}),
						}, undefined] as const;
					}
					if (options?.includeRemote && callCount === 2) {
						return [{
							broadcastPath: `/${roomID}/test-member.hang`,
							ended: () => new Promise<void>(() => {}),
						}, undefined] as const;
					}
					return [undefined, new Error("done")] as const;
				},
				close: async () => {},
			},
			undefined,
		],
	};
}

Deno.test("RoomElement - constructor", async () => {
	const { restoreDOM, roomModule, element } = await createRoomElementFixture();
	try {
		assert(element instanceof roomModule.RoomElement);
		assert(element instanceof HTMLElement);
	} finally {
		restoreDOM();
	}
});

Deno.test("RoomElement - observedAttributes", async () => {
	const { restoreDOM, roomModule } = await createRoomModuleFixture();
	try {
		assertEquals(roomModule.RoomElement.observedAttributes, ["room-id", "description"]);
	} finally {
		restoreDOM();
	}
});

Deno.test("RoomElement - render builds expected DOM", async () => {
	const { restoreDOM, element } = await createRoomElementFixture();
	try {
		element.render();
		assertExists(element.querySelector(".room-status-display"));
		assertExists(element.querySelector(".local-participant"));
		assertExists(element.querySelector(".remote-participants"));
	} finally {
		restoreDOM();
	}
});

Deno.test("RoomElement - join room successfully", async () => {
	const { restoreDOM, element } = await createRoomElementFixture();
	try {
		element.setAttribute("room-id", "test-room");
		await element.join(
			createFakeSession("test-room", "test-publisher") as unknown as Session,
			{ name: "test-publisher", serveTrack: () => {} },
		);

		assertExists(element.room);
		assertEquals(element.room?.roomID, "test-room");
	} finally {
		restoreDOM();
	}
});

Deno.test("RoomElement - join reports missing room-id", async () => {
	const { restoreDOM, element } = await createRoomElementFixture();
	try {
		let statusCalled = false;
		let statusArg: RoomLifecycleStatus | undefined;
		element.onstatus = (status) => {
			statusCalled = true;
			statusArg = status;
		};

		await element.join(
			createFakeSession("x", "test-publisher") as unknown as Session,
			{ name: "test-publisher", serveTrack: () => {} },
		);

		assert(statusCalled);
		assertExists(statusArg);
		assertEquals(statusArg.type, "error");
		assertEquals(statusArg.message, "room-id is missing");
	} finally {
		restoreDOM();
	}
});

Deno.test("RoomElement - join reports session errors", async () => {
	const { restoreDOM, element } = await createRoomElementFixture();
	try {
		element.setAttribute("room-id", "test-room");
		let statusCalled = false;
		let statusArg: RoomLifecycleStatus | undefined;
		element.onstatus = (status) => {
			statusCalled = true;
			statusArg = status;
		};

		await element.join(
			createFakeSession("test-room", "test-publisher", {
				failAccept: true,
			}) as unknown as Session,
			{ name: "test-publisher", serveTrack: () => {} },
		);

		assert(statusCalled);
		assertExists(statusArg);
		assertEquals(statusArg.type, "error");
		assert(statusArg.message.includes("Failed to join: accept failed"));
	} finally {
		restoreDOM();
	}
});

Deno.test("RoomElement - onjoin callback fires when member joins", async () => {
	const { restoreDOM, element } = await createRoomElementFixture();
	try {
		element.setAttribute("room-id", "test-room");
		let onjoinCalled = false;
		let onjoinArg: JoinedMember | undefined;
		element.onjoin = (member) => {
			onjoinCalled = true;
			onjoinArg = member;
		};

		await element.join(
			createFakeSession("test-room", "test-publisher", {
				includeRemote: true,
			}) as unknown as Session,
			{ name: "test-publisher", serveTrack: () => {} },
		);
		await Promise.resolve();

		assert(onjoinCalled);
		assertExists(onjoinArg);
		assertEquals(onjoinArg.name, "test-member");
		assertEquals(onjoinArg.remote, true);
	} finally {
		restoreDOM();
	}
});

Deno.test("RoomElement - onleave callback fires when member leaves", async () => {
	const { restoreDOM, element } = await createRoomElementFixture();
	try {
		element.setAttribute("room-id", "test-room");
		let onleaveCalled = false;
		let onleaveArg: LeftMember | undefined;
		element.onleave = (member) => {
			onleaveCalled = true;
			onleaveArg = member;
		};

		await element.join(
			createFakeSession("test-room", "test-publisher", {
				includeRemote: true,
			}) as unknown as Session,
			{ name: "test-publisher", serveTrack: () => {} },
		);
		await Promise.resolve();
		element.room?.disconnect();

		assert(onleaveCalled);
		assertExists(onleaveArg);
		assertEquals(onleaveArg.name, "test-member");
		assertEquals(onleaveArg.remote, true);
	} finally {
		restoreDOM();
	}
});

Deno.test("RoomElement - leave dispatches statuschange event", async () => {
	const { restoreDOM, roomModule } = await createRoomModuleFixture();
	try {
		const element = new roomModule.RoomElement();
		element.room = {
			roomID: "test-room",
			disconnect: () => {},
		} as unknown as Room;

		let statusChangeEvent: Event | undefined;
		element.addEventListener("statuschange", (event) => {
			statusChangeEvent = event;
		});

		element.leave();

		assertExists(statusChangeEvent);
		assertEquals(
			(statusChangeEvent as CustomEvent<{ type: string; message: string }>).detail.type,
			"left",
		);
		assertEquals(
			(statusChangeEvent as CustomEvent<{ type: string; message: string }>).detail.message,
			"Left room test-room",
		);
	} finally {
		restoreDOM();
	}
});
