import { DefaultCatalogTrackName } from "@okdaichi/moq/msf";
import { assertEquals, assertRejects } from "@std/assert";
import { Room, RoomEvents, broadcastPath, participantName } from "./room.ts";

Deno.test("room utils generate and parse participant paths", () => {
	assertEquals(broadcastPath("myroom", "alice"), "/myroom/alice.hang");
	assertEquals(participantName("myroom", "/myroom/alice.hang"), "alice");
	assertEquals(participantName("room-x", "/room-x/john.doe.hang"), "john.doe");
});

Deno.test("Room.attach publishes local broadcast and acknowledges local announce", async () => {
	const published: Array<{ path: string; localName: string }> = [];
	const joined: string[] = [];
	const local = { name: "alice" };
	const localPath = "/test-room/alice.hang";
	let received = false;

	const room = new Room({
		roomID: "test-room",
		onmember: {
			onJoin: (member) => joined.push(`${member.remote}:${member.name}`),
			onLeave: () => {},
		},
	});

	const session = {
		mux: {
			publish: (_done: Promise<void>, path: string, publisher: { name: string }) => {
				published.push({ path, localName: publisher.name });
			},
		},
		acceptAnnounce: async () => [
			{
				receive: async () => {
					if (!received) {
						received = true;
						return [
							{
								broadcastPath: localPath,
								ended: () => new Promise<void>(() => {}),
							},
							undefined,
						] as const;
					}

					return [undefined, new Error("done")] as const;
				},
				close: async () => {},
			},
			undefined,
		],
	};

	await room.attach({ session: session as any, local: local as any });

	assertEquals(published, [{ path: localPath, localName: "alice" }]);
	assertEquals(joined, ["false:alice"]);
	assertEquals(room.state, "connected");
	assertEquals(room.members(), [{ remote: false, name: "alice" }]);
});

Deno.test("Room exposes remote catalogs and role-based subscribe helpers", async () => {
	const localPath = "/test-room/alice.hang";
	let keepRemoteOpen = true;
	const subscribeCalls: string[] = [];
	const catalogPayload = new TextEncoder().encode(JSON.stringify({
		version: 1,
		isComplete: true,
		tracks: [
			{ name: "camera", role: "video", packaging: "loc" },
			{ name: "microphone", role: "audio", packaging: "loc" },
		],
	}));

	let announceCount = 0;
	const room = new Room({ roomID: "test-room" });

	const session = {
		mux: {
			publish: () => {},
		},
		subscribe: async (broadcastPath: string, trackName: string) => {
			if (broadcastPath === "/test-room/bob.hang" && trackName === DefaultCatalogTrackName) {
				return [
					{
						acceptGroup: async () => [
							{
								readFrame: async (sink: (bytes: Uint8Array) => void) => {
									sink(catalogPayload);
									return undefined;
								},
							},
							undefined,
						],
						closeWithError: async () => {},
					},
					undefined,
				] as const;
			}

			if (broadcastPath === "/test-room/bob.hang" && trackName === "camera") {
				subscribeCalls.push(trackName);
				return [{ trackName }, undefined] as const;
			}

			return [undefined, new Error(`unexpected subscribe: ${broadcastPath}/${trackName}`)] as const;
		},
		acceptAnnounce: async () => [
			{
				receive: async () => {
					announceCount += 1;
					if (announceCount === 1) {
						return [{ broadcastPath: localPath, ended: () => new Promise<void>(() => {}) }, undefined];
					}
					if (announceCount === 2) {
						return [{
							broadcastPath: "/test-room/bob.hang",
							ended: () => keepRemoteOpen ? new Promise<void>(() => {}) : Promise.resolve(),
						}, undefined];
					}
					return [undefined, new Error("done")];
				},
				close: async () => {},
			},
			undefined,
		],
	};

	await room.attach({ session: session as any, local: { name: "alice" } as any });
	await Promise.resolve();

	const catalog = await room.catalog("bob");
	if (catalog instanceof Error) {
		throw catalog;
	}

	assertEquals(room.remote("bob")?.name, "bob");
	assertEquals(catalog.tracks[0]?.name, "camera");

	const [reader, err] = await room.subscribe({ memberName: "bob", role: "video" });
	assertEquals(err, undefined);
	assertEquals((reader as any).trackName, "camera");
	assertEquals(subscribeCalls, ["camera"]);
	assertEquals(room.members().map((member) => member.name), ["alice", "bob"]);

	keepRemoteOpen = false;
});

Deno.test("Room.attach propagates acceptAnnounce failures", async () => {
	const room = new Room({
		roomID: "test-room",
		onmember: {
			onJoin: () => {},
			onLeave: () => {},
		},
	});
	const errors: string[] = [];
	room.on(RoomEvents.Error, (event) => {
		const detail = (event as CustomEvent<{ error: Error; context: string }>).detail;
		errors.push(`${detail.context}:${detail.error.message}`);
	});

	const session = {
		mux: { publish: () => {} },
		acceptAnnounce: async () => [undefined, new Error("boom")],
	};

	await assertRejects(
		() => room.attach({ session: session as any, local: { name: "alice" } as any }),
		Error,
		"boom",
	);
	assertEquals(room.state, "error");
	assertEquals(errors, ["acceptAnnounce:boom"]);
});

Deno.test("Room.connect uses URL + dial and exposes on/once helpers", async () => {
	const stateTransitions: string[] = [];
	const localPath = "/test-room/alice.hang";
	let received = false;

	const room = new Room({ roomID: "test-room" });
	room.on(RoomEvents.StateChange, (event) => {
		const detail = (event as CustomEvent<{ previous: string; current: string }>).detail;
		stateTransitions.push(`${detail.previous}->${detail.current}`);
	});

	let onceCalled = 0;
	room.once(RoomEvents.MemberJoin, () => {
		onceCalled += 1;
	});

	const session = {
		mux: {
			publish: () => {},
		},
		acceptAnnounce: async () => [
			{
				receive: async () => {
					if (!received) {
						received = true;
						return [{ broadcastPath: localPath, ended: () => Promise.resolve() }, undefined] as const;
					}
					return [undefined, new Error("done")] as const;
				},
				close: async () => {},
			},
			undefined,
		],
	};

	const dialCalls: string[] = [];
	const client = {
		dial: async (url: string | URL) => {
			dialCalls.push(String(url));
			return session as any;
		},
		close: async () => {},
	};

	await room.connect({
		url: "https://example.com/moq",
		local: { name: "alice" } as any,
		client: client as any,
	});
	assertEquals(room.isConnected, true);
	assertEquals(onceCalled, 1);
	assertEquals(dialCalls, ["https://example.com/moq"]);

	await room.disconnect();
	assertEquals(room.state, "disconnected");
	assertEquals(stateTransitions.includes("connecting->connected"), true);
});
