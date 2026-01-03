export class MockVideoEncoder {
	output: (chunk: EncodedVideoChunk) => void;
	error: (error: any) => void;
	state: "unconfigured" | "configured" | "closed";
	configureCalled = false;
	configureCalls: any[] = [];
	encodeCalled = false;
	encodeCalls: any[] = [];
	closeCalled = false;
	constructor(init: VideoEncoderInit) {
		this.output = init.output;
		this.error = init.error;
		this.state = "unconfigured";
	}

	configure(config: any) {
		this.configureCalled = true;
		this.configureCalls.push([config]);
		this.state = "configured";
	}

	encode(frame: any, options?: any) {
		this.encodeCalled = true;
		this.encodeCalls.push([frame, options]);
	}

	async flush() {
		// Mock flush method
	}

	close() {
		this.closeCalled = true;
		this.state = "closed";
	}

	static isConfigSupported(config: any) {
		// Simulate supported config for certain codecs
		const supportedCodecs = ["avc1.640028", "vp8", "vp09"];
		const isSupported = supportedCodecs.some((codec) => config.codec.startsWith(codec));

		return {
			supported: isSupported,
			config: isSupported ? config : null,
		};
	}
}
