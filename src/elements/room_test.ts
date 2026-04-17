import { assert, assertEquals, assertExists } from "@std/assert";

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

if (!("HTMLElement" in globalThis)) {
	(globalThis as any).HTMLElement = FakeElement;
}
if (!("document" in globalThis)) {
	(globalThis as any).document = new FakeDocument();
}
if (!("customElements" in globalThis)) {
	(globalThis as any).customElements = new FakeCustomElementsRegistry();
}

const roomElementModule = await import("./room.ts");
const defineRoom = roomElementModule.defineRoom;
const RoomElement = roomElementModule.RoomElement;

function createSession(
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

Deno.test("RoomElement", async (t) => {
	await t.step("setup", () => {
		defineRoom();
	});

	let element: InstanceType<typeof RoomElement>;

	await t.step("before each test setup", () => {
		element = new RoomElement();
	});

	await t.step("after each test cleanup", () => {
		document.body.innerHTML = "";
	});

	await t.step("constructor", async (t2) => {
		await t2.step("should create an instance", () => {
			assert(element instanceof RoomElement);
			assert(element instanceof HTMLElement);
		});
	});

	await t.step("observedAttributes", async (t2) => {
		await t2.step("should return correct attributes", () => {
			assertEquals(RoomElement.observedAttributes, ["room-id", "description"]);
		});
	});

	await t.step("render", async (t2) => {
		await t2.step("should render the DOM structure", () => {
			element.render();
			assertExists(element.querySelector(".room-status-display"));
			assertExists(element.querySelector(".local-participant"));
			assertExists(element.querySelector(".remote-participants"));
		});
	});

	await t.step("join", async (t2) => {
		await t2.step("should join room successfully", async () => {
			element.setAttribute("room-id", "test-room");
			await element.join(
				createSession("test-room", "test-publisher") as any,
				{ name: "test-publisher" } as any,
			);

			assertExists(element.room);
			assertEquals(element.room?.roomID, "test-room");
		});

		await t2.step("should set error status when room-id is missing", async () => {
			const missingRoomElement = new RoomElement();

			let statusCalled = false;
			let statusArg: any;
			missingRoomElement.onstatus = (status) => {
				statusCalled = true;
				statusArg = status;
			};

			await missingRoomElement.join(
				createSession("x", "test-publisher") as any,
				{ name: "test-publisher" } as any,
			);

			assert(statusCalled);
			assertEquals(statusArg.type, "error");
			assertEquals(statusArg.message, "room-id is missing");
		});

		await t2.step("should handle join error", async () => {
			element.setAttribute("room-id", "test-room");

			let statusCalled = false;
			let statusArg: any;
			element.onstatus = (status) => {
				statusCalled = true;
				statusArg = status;
			};

			await element.join(
				createSession("test-room", "test-publisher", { failAccept: true }) as any,
				{ name: "test-publisher" } as any,
			);

			assert(statusCalled);
			assertEquals(statusArg.type, "error");
			assert(statusArg.message.includes("Failed to join: accept failed"));
		});

		await t2.step("should call onjoin callback when member joins", async () => {
			element.setAttribute("room-id", "test-room");

			let onjoinCalled = false;
			let onjoinArg: any;
			element.onjoin = (member) => {
				onjoinCalled = true;
				onjoinArg = member;
			};

			await element.join(
				createSession("test-room", "test-publisher", { includeRemote: true }) as any,
				{ name: "test-publisher" } as any,
			);
			await Promise.resolve();

			assert(onjoinCalled);
			assertEquals(onjoinArg.name, "test-member");
			assertEquals(onjoinArg.remote, true);
		});

		await t2.step("should call onleave callback when member leaves", async () => {
			element.setAttribute("room-id", "test-room");

			let onleaveCalled = false;
			let onleaveArg: any;
			element.onleave = (member) => {
				onleaveCalled = true;
				onleaveArg = member;
			};

			await element.join(
				createSession("test-room", "test-publisher", { includeRemote: true }) as any,
				{ name: "test-publisher" } as any,
			);
			await Promise.resolve();
			element.room?.disconnect();

			assert(onleaveCalled);
			assertEquals(onleaveArg.name, "test-member");
			assertEquals(onleaveArg.remote, true);
		});
	});

	await t.step("leave", async (t2) => {
		await t2.step("should leave room and clear state", () => {
			element.room = {
				roomID: "test-room",
				disconnect: () => {},
			} as any;

			element.leave();
			assertEquals(element.room, undefined);
		});

		await t2.step("should dispatch statuschange event", () => {
			element.room = {
				roomID: "test-room",
				disconnect: () => {},
			} as any;

			let statusChangeEvent: any;
			element.addEventListener("statuschange", (event) => {
				statusChangeEvent = event;
			});

			element.leave();

			assertExists(statusChangeEvent);
			assertEquals(statusChangeEvent.detail.type, "left");
			assertEquals(statusChangeEvent.detail.message, "Left room test-room");
		});
	});
});
