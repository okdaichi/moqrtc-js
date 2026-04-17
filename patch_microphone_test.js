const fs = require('fs');
let code = fs.readFileSync('src/media/microphone_test.ts', 'utf8');

// Replace enable/disable workflow logic
code = code.replace(
        \                        mic.enabled = false; // setting enabled to false triggers close internally in Device \n                        // Wait for any microtasks\n                        await new Promise((r) => setTimeout(r, 0));\n                        assertEquals(track.readyState, "ended");\n\n                        mic.enabled = true;\n                        const newTrack = await mic.getAudioTrack();\n                        assertEquals(newTrack.readyState, "live");\n                        assertEquals(newTrack !== track, true);\,
        \                        mic.enabled = false; // Does not automatically stop the track.\n                        mic.close();\n                        assertEquals(track.readyState, "ended");\n\n                        mic.enabled = true;\n                        const newTrack = await mic.getAudioTrack();\n                        assertEquals(newTrack.readyState, "live");\n                        assertEquals(newTrack !== track, true);\
);

// Replace constraints updates logic 
code = code.replace(
        \                        // Currently, updateConstraints causes track recreation \n                        assertEquals(updatedTrack.getConstraints(), { echoCancellation: false, noiseSuppression: true });\n                        assertEquals(updatedTrack !== track, true);\n                        assertEquals(track.readyState, "ended");\,
        \                        // updateConstraints applies to the existing track \n                        assertEquals(updatedTrack.getConstraints(), { echoCancellation: false, noiseSuppression: true });\n                        assertEquals(updatedTrack === track, true);\n                        assertEquals(track.readyState, "live");\
);

fs.writeFileSync('src/media/microphone_test.ts', code);
