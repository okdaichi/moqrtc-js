import type { TrackName, TrackReader } from "@qumo/moq";
import type { Catalog } from "@qumo/moq/msf";

export interface RemoteBroadcast {
	readonly name: string;
	catalog(): Promise<Catalog | Error>;
	subscribeTrack(name: TrackName): Promise<[TrackReader, undefined] | [undefined, Error]>;
	close(cause?: Error): Promise<void> | void;
}

export interface JoinedLocalMember {
	remote: false;
	name: string;
}

export interface JoinedRemoteMember {
	remote: true;
	name: string;
	broadcast: RemoteBroadcast;
}

export type JoinedMember = JoinedLocalMember | JoinedRemoteMember;

export interface LeftMember {
	remote: boolean;
	name: string;
}
