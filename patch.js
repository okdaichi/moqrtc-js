const fs = require('fs');
let code = fs.readFileSync('src/media/fake_media_devices.ts', 'utf8');
code = code.replace(
    'constructor(kind: string, label: string, deviceId: string) {',
    'constructor(kind: string, label: string, deviceId: string, constraints?: MediaTrackConstraints) {\n\t\tthis.#constraints = constraints || {};'
);
code = code.replace(
    'new FakeMediaStreamTrack("audio", device.label, device.deviceId)',
    'new FakeMediaStreamTrack("audio", device.label, device.deviceId, typeof constraints?.audio === "object" ? constraints.audio : undefined)'
);
code = code.replace(
    'new FakeMediaStreamTrack("video", device.label, device.deviceId)',
    'new FakeMediaStreamTrack("video", device.label, device.deviceId, typeof constraints?.video === "object" ? constraints.video : undefined)'
);
fs.writeFileSync('src/media/fake_media_devices.ts', code);
