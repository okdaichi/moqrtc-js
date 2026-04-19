/// <reference path="../test_globals.d.ts" />

/**
 * Assigns a value to a globalThis property, bypassing strict DOM type checks.
 * Returns a restore function that resets the previous value.
 */
export function stubGlobal(key: string, value: unknown): () => void {
	const g = globalThis as unknown as Record<string, unknown>;
	const hasKey = Object.prototype.hasOwnProperty.call(g, key);
	const original = g[key];
	g[key] = value;
	return () => {
		if (hasKey) {
			g[key] = original;
		} else {
			delete g[key];
		}
	};
}

/**
 * Deletes a globalThis property, bypassing strict DOM type checks.
 */
export function deleteGlobal(key: string): void {
	delete (globalThis as unknown as Record<string, unknown>)[key];
}
