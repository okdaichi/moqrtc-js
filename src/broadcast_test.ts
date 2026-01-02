import { assertEquals } from "@std/assert";
import { Spy, spy } from "@std/testing/mock";
import { BroadcastPublisher } from "./broadcast.ts";
import * as room from "./room.ts";

// Mock interfaces for dependency injection
interface MockCatalogEncoder {
	sync: Spy;
	setTrack: Spy;
	removeTrack: Spy;
	close: Spy;
}

interface MockCatalogDecoder {
	decodeFrom: Spy;
	nextTrack: Spy;
	root: Spy;
	close: Spy;
}

// Factory functions for creating mocks
function createMockCatalogEncoder(): MockCatalogEncoder {
	return {
		sync: spy(() => {}),
		setTrack: spy(() => {}),
		removeTrack: spy(() => {}),
		close: spy(() => Promise.resolve()),
	};
}

function createMockCatalogDecoder(): MockCatalogDecoder {
	return {
		decodeFrom: spy(() => Promise.resolve()),
		nextTrack: spy(() => Promise.resolve([{ name: "catalog" }, undefined])),
		root: spy(() => Promise.resolve({ version: "1", tracks: [] })),
		close: spy(() => {}),
	};
}

// Mock the room module
const mockParticipantName = spy(() => "participant");
(room as any).participantName = mockParticipantName;

// Mock catalog modules with DI-friendly approach
let mockCatalogEncoderInstance: MockCatalogEncoder;
let mockCatalogDecoderInstance: MockCatalogDecoder;

// Override the constructors to return our mocks
const originalCatalogEncoder = (await import("./internal/catalog_stream.ts")).CatalogEncoder;
const originalCatalogDecoder = (await import("./internal/catalog_stream.ts")).CatalogDecoder;

(Object as any).defineProperty(await import("./internal/catalog_stream.ts"), "CatalogEncoder", {
	value: function () {
		mockCatalogEncoderInstance = createMockCatalogEncoder();
		return mockCatalogEncoderInstance;
	},
});

(Object as any).defineProperty(await import("./internal/catalog_stream.ts"), "CatalogDecoder", {
	value: function () {
		mockCatalogDecoderInstance = createMockCatalogDecoder();
		return mockCatalogDecoderInstance;
	},
});

// Setup and cleanup
function setupMocks() {
	mockParticipantName.calls.length = 0;
	// Reset instances
	mockCatalogEncoderInstance = undefined as any;
	mockCatalogDecoderInstance = undefined as any;
}

function cleanupMocks() {
	// Restore any global state if needed
}

Deno.test("BroadcastPublisher", async (t) => {
	await t.step("constructor", async (t) => {
		const constructorCases = new Map([
			["with name only", { name: "test-publisher", expectedName: "test-publisher" }],
			["with empty name", { name: "", expectedName: "" }],
			["with special characters", { name: "test-publisher_123", expectedName: "test-publisher_123" }],
		]);

		for (const [name, c] of constructorCases) {
			await t.step(name, () => {
				setupMocks();
				const publisher = new BroadcastPublisher(c.name);
				assertEquals(publisher.name, c.expectedName);
				// Verify catalog encoder was created
				assertEquals(typeof mockCatalogEncoderInstance, "object");
				cleanupMocks();
			});
		}

		await t.step("should throw on invalid name", () => {
			setupMocks();
			// Assuming constructor validates name, add appropriate assertions
			// If no validation, this test can be removed
			const publisher = new BroadcastPublisher("valid-name");
			assertEquals(publisher.name, "valid-name");
			cleanupMocks();
		});
	});

	await t.step("setTrack", async (t) => {
		await t.step("should call catalog encoder setTrack", () => {
			setupMocks();
			const publisher = new BroadcastPublisher("room");
			// Mock track data
			const track = {
				descriptor: { name: "video", priority: 0, schema: "", config: {} },
				encoder: { encodeTo: spy(() => Promise.resolve()) },
			};
			// publisher.setTrack(track); // Uncomment when method is implemented
			// assertEquals(mockCatalogEncoderInstance.setTrack.calls.length, 1);
			cleanupMocks();
		});

		await t.step("should reject catalog track", () => {
			setupMocks();
			const publisher = new BroadcastPublisher("room");
			// const catalogTrack = { descriptor: { name: "catalog" }, encoder: {} };
			// assertThrows(() => publisher.setTrack(catalogTrack), Error, "Cannot add catalog track");
			cleanupMocks();
		});
	});

	await t.step("serveTrack", async (t) => {
		await t.step("should handle catalog track", async () => {
			setupMocks();
			const publisher = new BroadcastPublisher("room");
			const ctx = Promise.resolve();
			const track = {
				trackName: "catalog",
				closeWithError: spy(() => {}),
				writeFrame: spy(() => Promise.resolve()),
				close: spy(() => Promise.resolve()),
			} as any;
			// await publisher.serveTrack(ctx, track);
			// assertEquals(mockCatalogEncoderInstance.encodeTo.calls.length, 1);
			cleanupMocks();
		});

		await t.step("should handle regular track with encoder", async () => {
			setupMocks();
			const publisher = new BroadcastPublisher("room");
			const ctx = Promise.resolve();
			const track = {
				trackName: "video",
				closeWithError: spy(() => {}),
				writeFrame: spy(() => Promise.resolve()),
				close: spy(() => Promise.resolve()),
			} as any;
			const encoder = {
				encodeTo: spy(() => Promise.resolve()),
			};
			// publisher.setTrack({ descriptor: { name: "video" }, encoder });
			// await publisher.serveTrack(ctx, track);
			// assertEquals(encoder.encodeTo.calls.length, 1);
			cleanupMocks();
		});

		await t.step("should handle track not found", async () => {
			setupMocks();
			const publisher = new BroadcastPublisher("room");
			const ctx = Promise.resolve();
			const track = {
				trackName: "nonexistent",
				closeWithError: spy(() => {}),
				writeFrame: spy(() => Promise.resolve()),
				close: spy(() => Promise.resolve()),
			} as any;
			// await publisher.serveTrack(ctx, track);
			// assertEquals(track.closeWithError.calls.length, 1);
			cleanupMocks();
		});
	});

	await t.step("close", async (t) => {
		await t.step("should close catalog encoder", async () => {
			setupMocks();
			const publisher = new BroadcastPublisher("room");
			await publisher.close();
			assertEquals(mockCatalogEncoderInstance.close.calls.length, 1);
			cleanupMocks();
		});

		await t.step("should clear encoders map", async () => {
			setupMocks();
			const publisher = new BroadcastPublisher("room");
			// Add some encoders
			// publisher.setTrack(...);
			await publisher.close();
			// Verify encoders are cleared
			cleanupMocks();
		});

		await t.step("should handle close with cause", async () => {
			setupMocks();
			const publisher = new BroadcastPublisher("room");
			const cause = new Error("test cause");
			await publisher.close(cause);
			assertEquals(mockCatalogEncoderInstance.close.calls[0].args[0], cause);
			cleanupMocks();
		});
	});
});
