import { VideoNode } from "./video_node.ts";

export class FakeVideoNode extends VideoNode {
	processedFrames: VideoFrame[] = [];

	process(input?: VideoFrame): void {
		if (input) {
			this.processedFrames.push(input);
		}
	}
}
