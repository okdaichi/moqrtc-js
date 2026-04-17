const fs = require('fs');
let code = fs.readFileSync('src/media/fake_media_devices.ts', 'utf8');
code = code.replace(
        'getDisplayMedia(): Promise<MediaStream> {\r\n                throw new Error("Not implemented");\r\n        }',
        \sync getDisplayMedia(options?: DisplayMediaStreamOptions): Promise<MediaStream> {
                const tracks = [];
                tracks.push(new FakeMediaStreamTrack('video', 'Screen', 'screen-1', options?.video ? (typeof options.video === "object" ? options.video : {}) : undefined));
                if (options?.audio) {
                    tracks.push(new FakeMediaStreamTrack('audio', 'System Audio', 'sys-audio-1', typeof options.audio === "object" ? options.audio : undefined));
                }
                return new FakeMediaStream(tracks);
        }\
);
fs.writeFileSync('src/media/fake_media_devices.ts', code);
