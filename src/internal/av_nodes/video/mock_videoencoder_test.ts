export class MockVideoEncoder {
	static async isConfigSupported(config: any) {
		// Simulate supported config for certain codecs
		const supportedCodecs = ["avc1.640028", "vp8", "vp09"];
		const isSupported = supportedCodecs.some((codec) => config.codec.startsWith(codec));

		return {
			supported: isSupported,
			config: isSupported ? config : null,
		};
	}
}
