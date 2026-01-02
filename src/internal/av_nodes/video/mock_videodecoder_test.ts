export class MockVideoDecoder {
	state: "unconfigured" | "configured" | "closed" = "unconfigured";
	configureCalled = false;
	configureCalls: any[][] = [];
	decodeCalled = false;
	decodeCalls: any[][] = [];
	resetCalled = false;
	resetCalls: any[][] = [];
	flushCalled = false;
	flushCalls: any[][] = [];
	closeCalled = false;
	closeCalls: any[][] = [];

	constructor(_config: VideoDecoderInit) {
		// Mock constructor
	}

	configure(config: any) {
		this.configureCalled = true;
		this.configureCalls.push([config]);
		this.state = "configured";
	}

	decode(chunk: any) {
		this.decodeCalled = true;
		this.decodeCalls.push([chunk]);
	}

	reset() {
		this.resetCalled = true;
		this.resetCalls.push([]);
	}

	flush() {
		this.flushCalled = true;
		this.flushCalls.push([]);
		return Promise.resolve();
	}

	close() {
		this.closeCalled = true;
		this.closeCalls.push([]);
	}
}
