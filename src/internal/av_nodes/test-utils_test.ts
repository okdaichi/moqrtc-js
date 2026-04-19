// Per-package test utilities for internal/av_nodes
export function stubGlobal(key: string, value: unknown): () => void {
    const g = globalThis as unknown as Record<string, unknown>;
    const had = Object.prototype.hasOwnProperty.call(g, key);
    const original = g[key];
    g[key] = value;
    return () => {
        if (had) g[key] = original;
        else delete g[key];
    };
}

export function deleteGlobal(key: string): void {
    delete (globalThis as unknown as Record<string, unknown>)[key];
}
