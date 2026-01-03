# AV Nodes Scripts

This directory contains build and utility scripts for the AV nodes.

## Scripts

### `build_worklets.ts`

Builds AudioWorklet processors from TypeScript into inline JavaScript code strings.

**Usage:**

```bash
deno task build:worklets
```

**What it does:**

1. Bundles `audio/audio_hijack_worklet.ts` and `audio/audio_offload_worklet.ts`
2. Minifies the code
3. Generates `*_inline.ts` files in the audio directory with:
   - Worklet code as exported string constant
   - `createWorkletBlobUrl()` helper function

**When to run:**

- After modifying any AudioWorklet TypeScript files
- Before committing changes to worklet code

See [audio/WORKLET_BUILD.md](../audio/WORKLET_BUILD.md) for more details.
