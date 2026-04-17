import type {
	BroadcastPath,
	Session,
	TrackHandler,
	TrackName,
	TrackReader,
	TrackWriter,
} from "@okdaichi/moq";
import { SubscribeErrorCode } from "@okdaichi/moq";
import {
	Broadcast,
	type Catalog,
	DefaultCatalogTrackName,
	parseCatalog,
	type Track,
} from "@okdaichi/moq/msf";
import type { CancelCauseFunc, Context } from "golikejs/context";
import { background, withCancelCause } from "golikejs/context";
import { participantName } from "./room.ts";

export class BroadcastPublisher implements TrackHandler {
	readonly name: string;
	#broadcast: Broadcast;

	constructor(name: string) {
		this.name = name;
		this.#broadcast = new Broadcast({ version: 1, isComplete: true, tracks: [] });
	}

	async addTrack(track: Track, serve: (writer: TrackWriter) => Promise<void>): Promise<void> {
		await this.#broadcast.registerTrack(track, { serveTrack: serve });
	}

	catalog(): Catalog {
		return this.#broadcast.catalog();
	}

	async serveTrack(writer: TrackWriter): Promise<void> {
		await this.#broadcast.serveTrack(writer);
	}

	close(): void {
		this.#broadcast.close();
	}
}

export class BroadcastSubscriber {
	#path: BroadcastPath;
	readonly roomID: string;
	readonly session: Session;
	#catalogPromise?: Promise<Catalog | Error>;

	#ctx: Context;
	#cancelCtx: CancelCauseFunc;

	constructor(path: BroadcastPath, roomID: string, session: Session) {
		this.#path = path;
		this.roomID = roomID;
		this.session = session;
		const [ctx, cancelCtx] = withCancelCause(background());
		this.#ctx = ctx;
		this.#cancelCtx = (cause?: Error) => {
			cancelCtx(cause);
		};
	}

	async catalog(): Promise<Catalog | Error> {
		if (this.#catalogPromise) {
			return await this.#catalogPromise;
		}

		this.#catalogPromise = this.#readCatalog();
		return await this.#catalogPromise;
	}

	get name(): string {
		return participantName(this.roomID, this.#path);
	}

	async subscribeTrack(name: TrackName): Promise<[TrackReader, undefined] | [undefined, Error]> {
		return await this.session.subscribe(this.#path, name);
	}

	async close(cause?: Error): Promise<void> {
		this.#cancelCtx(cause);
	}

	async #readCatalog(): Promise<Catalog | Error> {
		const [track, err] = await this.session.subscribe(this.#path, DefaultCatalogTrackName);
		if (err) {
			return err;
		}

		try {
			const [group, groupErr] = await track.acceptGroup(this.#ctx.done());
			if (groupErr || !group) {
				return groupErr ?? new Error("catalog group unavailable");
			}

			let payload: Uint8Array | undefined;
			const frameErr = await group.readFrame((bytes) => {
				payload = bytes.slice();
			});
			if (frameErr) {
				return frameErr;
			}
			if (!payload) {
				return new Error("catalog payload missing");
			}

			return parseCatalog(payload);
		} catch (caught) {
			return caught instanceof Error ? caught : new Error(String(caught));
		} finally {
			await track.closeWithError(SubscribeErrorCode.InternalError);
		}
	}
}
