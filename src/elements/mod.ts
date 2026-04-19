export * from "./room.ts";

import { defineRoom } from "./room.ts";

export function defineAll(): void {
	defineRoom();

	// Add more element definitions here as needed
}
