import { SubscribeErrorCode } from "@okdaichi/moq";
import { assertEquals } from "@std/assert";
import { BroadcastPublisher, BroadcastSubscriber } from "./broadcast.ts";

Deno.test("BroadcastPublisher builds an MSF catalog from track descriptors", async () => {
	const publisher = new BroadcastPublisher("alice");
	await publisher.addTrack(
		{
			name: "camera",
			packaging: "legacy",
			label: "Main camera",
			depends: ["audio"],
			extraFields: {
				schema: "video/h264",
				config: { profile: "main" },
			},
		},
		async (_writer) => {},
	);

	const catalog = publisher.catalog();
	assertEquals(catalog.version, 1);
	assertEquals(catalog.isComplete, true);
	assertEquals(catalog.tracks.length, 1);
	assertEquals(catalog.tracks[0]?.name, "camera");
	assertEquals(catalog.tracks[0]?.packaging, "legacy");
	assertEquals(catalog.tracks[0]?.label, "Main camera");
	assertEquals(catalog.tracks[0]?.depends, ["audio"]);
	assertEquals(catalog.tracks[0]?.extraFields?.schema, "video/h264");
	assertEquals(catalog.tracks[0]?.extraFields?.config, { profile: "main" });
});

Deno.test("BroadcastPublisher closes missing tracks with TrackNotFound", async () => {
	const publisher = new BroadcastPublisher("alice");
	const closeCodes: number[] = [];

	await publisher.serveTrack({
		trackName: "missing",
		closeWithError: async (code: number) => {
			closeCodes.push(code);
		},
	} as any);

	assertEquals(closeCodes, [SubscribeErrorCode.TrackNotFound]);
});

Deno.test("BroadcastSubscriber.catalog parses MSF catalog payload", async () => {
	const payload = new TextEncoder().encode(
		JSON.stringify({
			version: 1,
			isComplete: true,
			tracks: [{ name: "camera", packaging: "legacy" }],
		}),
	);
	const closeCodes: number[] = [];

	const session = {
		subscribe: async () => [
			{
				acceptGroup: async () => [
					{
						readFrame: async (sink: (bytes: Uint8Array) => void) => {
							sink(payload);
							return undefined;
						},
					},
					undefined,
				],
				closeWithError: async (code: number) => {
					closeCodes.push(code);
				},
			},
			undefined,
		],
	} as any;

	const subscriber = new BroadcastSubscriber("/room/alice.hang", "room", session);
	const catalog = await subscriber.catalog();

	if (catalog instanceof Error) {
		throw catalog;
	}
	assertEquals(catalog.tracks[0]?.name, "camera");
	assertEquals(catalog.tracks[0]?.packaging, "legacy");
	assertEquals(closeCodes, [SubscribeErrorCode.InternalError]);
});

Deno.test("BroadcastSubscriber.subscribeTrack returns TrackReader directly", async () => {
	const calls: string[] = [];
	const session = {
		subscribe: async () => [
			{
				trackName: "camera",
			},
			undefined,
		],
	} as any;

	const subscriber = new BroadcastSubscriber("/room/alice.hang", "room", session);
	const [reader, err] = await subscriber.subscribeTrack("camera");
	assertEquals(err, undefined);
	assertEquals((reader as any).trackName, "camera");
	assertEquals(calls, []);
});
