/// <reference path="./test_globals.d.ts" />
// Common test utilities for hang-web tests

/**
 * Assigns a value to a globalThis property, bypassing strict DOM type checks.
 * Used in tests to stub browser APIs with fake implementations.
 */
export function stubGlobal(key: string, value: unknown): void {
	(globalThis as unknown as Record<string, unknown>)[key] = value;
}

/**
 * Deletes a globalThis property, bypassing strict DOM type checks.
 */
export function deleteGlobal(key: string): void {
	delete (globalThis as unknown as Record<string, unknown>)[key];
}
