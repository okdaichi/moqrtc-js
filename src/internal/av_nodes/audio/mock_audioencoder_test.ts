import { spy } from "@std/testing/mock";

export class MockAudioEncoder {
	isConfigSupported: any = spy((config: any) => Promise.resolve({ supported: true, config }));
}
