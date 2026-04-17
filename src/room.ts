import type {
	AnnouncementReader,
	BroadcastPath,
	Session,
	TrackHandler,
	TrackName,
	TrackReader,
} from "@okdaichi/moq";
import { Client, validateBroadcastPath } from "@okdaichi/moq";
import type { Catalog } from "@okdaichi/moq/msf";
import { background, type CancelCauseFunc, type Context, withCancelCause } from "golikejs/context";
import { BroadcastSubscriber } from "./broadcast.ts";
import type { JoinedMember, LeftMember, RemoteBroadcast } from "./member.ts";

const HANG_EXTENSION = ".hang";

export interface LocalBroadcast extends TrackHandler {
	readonly name: string;
	close?(cause?: Error): Promise<void> | void;
}

export type RoomState =
	| "idle"
	| "connecting"
	| "connected"
	| "disconnecting"
	| "disconnected"
	| "error";

export const RoomEvents = {
	StateChange: "statechange",
	MemberJoin: "memberjoin",
	MemberLeave: "memberleave",
	Error: "error",
} as const;

export type RoomEventType = (typeof RoomEvents)[keyof typeof RoomEvents];

export interface RoomSubscribeOptions {
	memberName: string;
	trackName?: TrackName;
	role?: string;
}

export interface RoomConnectInit extends RoomInit {
	url: string | URL;
	local: LocalBroadcast;
	client?: Client;
	closeClientOnDisconnect?: boolean;
}

export interface RoomConnectOptions {
	url: string | URL;
	local: LocalBroadcast;
	client?: Client;
	closeClientOnDisconnect?: boolean;
}

export interface RoomAttachOptions {
	session: Session;
	local: LocalBroadcast;
}

const noopMemberHandler: MemberHandler = {
	onJoin: () => {},
	onLeave: () => {},
};

export class Room extends EventTarget {
	static readonly Events = RoomEvents;

	readonly roomID: string;

	#local?: LocalBroadcast;
	#hasLocalMember = false;
	#remotes: Map<string, RemoteBroadcast> = new Map();
	#cancel?: CancelCauseFunc;
	#state: RoomState = "idle";
	#session?: Session;
	#client?: Client;
	#closeClientOnDisconnect = false;

	#onmember: MemberHandler;

	#wg: Promise<void>[] = [];

	constructor(init: RoomInit) {
		super();
		this.roomID = init.roomID;
		this.#onmember = init.onmember ?? noopMemberHandler;
	}

	static async connect(init: RoomConnectInit): Promise<Room> {
		const room = new Room(init);
		await room.connect({
			url: init.url,
			local: init.local,
			client: init.client,
			closeClientOnDisconnect: init.closeClientOnDisconnect,
		});
		return room;
	}

	on(
		type: RoomEventType,
		listener: EventListenerOrEventListenerObject,
		options?: AddEventListenerOptions,
	): () => void {
		this.addEventListener(type, listener, options);
		return () => this.removeEventListener(type, listener, options);
	}

	off(
		type: RoomEventType,
		listener: EventListenerOrEventListenerObject,
		options?: EventListenerOptions,
	): void {
		this.removeEventListener(type, listener, options);
	}

	once(
		type: RoomEventType,
		listener: EventListenerOrEventListenerObject,
		options?: AddEventListenerOptions,
	): () => void {
		return this.on(type, listener, { ...options, once: true });
	}

	get state(): RoomState {
		return this.#state;
	}

	get isConnected(): boolean {
		return this.#state === "connected";
	}

	members(): JoinedMember[] {
		const members: JoinedMember[] = [];
		if (this.#local) {
			members.push({
				remote: false,
				name: this.#local.name,
			});
		}

		for (const remote of this.#remotes.values()) {
			members.push({
				remote: true,
				name: remote.name,
				broadcast: remote,
			});
		}

		return members;
	}

	remote(memberName: string): RemoteBroadcast | undefined {
		return this.#remotes.get(memberName);
	}

	async catalog(memberName: string): Promise<Catalog | Error> {
		const remote = this.remote(memberName);
		if (!remote) {
			return new Error(`room: remote member not found: ${memberName}`);
		}

		return await remote.catalog();
	}

	async subscribe(
		options: RoomSubscribeOptions,
	): Promise<[TrackReader, undefined] | [undefined, Error]> {
		const remote = this.remote(options.memberName);
		if (!remote) {
			return [undefined, new Error(`room: remote member not found: ${options.memberName}`)];
		}

		if (options.trackName) {
			return await remote.subscribeTrack(options.trackName);
		}

		if (!options.role) {
			return [undefined, new Error("room: trackName or role is required")];
		}

		const catalog = await remote.catalog();
		if (catalog instanceof Error) {
			return [undefined, catalog];
		}

		const track = catalog.tracks.find((candidate) => candidate.role === options.role);
		if (!track?.name) {
			return [
				undefined,
				new Error(
					`room: track role not found for member ${options.memberName}: ${options.role}`,
				),
			];
		}

		return await remote.subscribeTrack(track.name);
	}

	async connect(options: RoomConnectOptions): Promise<void> {
		const client = options.client ?? new Client();
		const ownsClient = options.client === undefined;

		let session: Session;
		try {
			session = await client.dial(options.url);
		} catch (err) {
			this.#emitError(err, "dial");
			this.#setState("error");
			if (ownsClient) {
				await client.close();
			}
			throw err;
		}

		this.#client = client;
		this.#closeClientOnDisconnect = options.closeClientOnDisconnect ?? ownsClient;
		await this.attach({ session, local: options.local });
	}

	async attach(options: RoomAttachOptions): Promise<void> { // TODO: use session interface from moqt when available
		const { session, local } = options;
		this.#setState("connecting");
		this.#local = local;
		this.#hasLocalMember = false;
		this.#session = session;

		if (this.#cancel) {
			// If already joined, leave first
			await this.disconnect();
			this.#setState("connecting");
			this.#local = local;
			this.#session = session;
		}

		let ctx: Context;
		[ctx, this.#cancel] = withCancelCause(background());

		const path = broadcastPath(this.roomID, local.name);

		// Publish the local broadcast to the track mux and make it available to others
		// This broadcast will end when the local broadcast is closed
		session.mux.publish(ctx.done(), path, local);

		const [announcements, err] = await session.acceptAnnounce(`/${this.roomID}/`);
		if (err) {
			console.warn(`[Room] failed to accept announcements for room: ${this.roomID}: ${err}`);
			this.#emitError(err, "acceptAnnounce");
			this.#setState("error");
			throw err;
		}

		let resolveAck: () => void;
		const ack = new Promise<void>((resolve) => {
			resolveAck = resolve;
		});

		this.#wg.push(
			this.#handleAnnouncements(ctx.done(), announcements!, session, local, resolveAck!),
		);

		await ack;
		this.#setState("connected");

		return;
	}

	async #handleAnnouncements(
		signal: Promise<void>,
		announcements: AnnouncementReader,
		session: Session,
		local: LocalBroadcast,
		resolveAck: () => void,
	): Promise<void> {
		const localPath = broadcastPath(this.roomID, local.name);
		// Listen for further announcements until the context is done
		while (true) {
			const [announcement, err] = await announcements.receive(signal);
			if (err) {
				// If the announcements reader returned an error, treat it as
				// a signal to stop listening and ack the join so callers don't
				// wait forever. The announcements reader will be closed below.
				try {
					resolveAck();
				} catch (e) {
					// ignore if ack already resolved
				}
				break;
			}

			// Handle announcement for ourselves (e.g. re-announcement) as ACK
			if (announcement!.broadcastPath === localPath) {
				resolveAck();

				if (this.#local !== local) {
					this.#local = local;
				}

				if (!this.#hasLocalMember) {
					this.#addLocal(local);
					this.#hasLocalMember = true;

					this.#wg.push(
						announcement!.ended().then(() => {
							this.#removeLocal(local);
						}),
					);
				}

				continue;
			}

			// Try to subscribe to the announced broadcast
			try {
				const broadcast = new BroadcastSubscriber(
					announcement!.broadcastPath,
					this.roomID,
					session,
				);
				this.#addRemote(broadcast);
				// Clean up the remote when the announcement ends
				announcement!.ended().then(() => {
					this.#removeRemote(broadcast);
				});
			} catch (e) {
				console.warn(`[Room] failed to subscribe to ${announcement}: ${e}`);
				this.#emitError(e, "createRemoteBroadcast");
			}
		}

		// Ensure announcements reader is closed
		await announcements?.close();
	}

	async disconnect(): Promise<void> {
		this.#setState("disconnecting");

		if (this.#cancel) {
			this.#cancel(new Error("hang: room left"));
		}

		for (const [path, remote] of this.#remotes) {
			try {
				this.#removeRemote(remote);
			} catch (e) {
				console.warn(`hang: Error removing remote broadcast for path ${path}: ${e}`);
			}
		}
		this.#remotes.clear();

		await Promise.all(this.#wg);
		this.#wg = [];
		this.#local = undefined;
		this.#hasLocalMember = false;
		this.#cancel = undefined;

		if (this.#session) {
			try {
				await this.#session.close();
			} catch {
				// ignore session close errors on disconnect
			}
			this.#session = undefined;
		}

		if (this.#client && this.#closeClientOnDisconnect) {
			try {
				await this.#client.close();
			} catch {
				// ignore client close errors on disconnect
			}
		}
		this.#client = undefined;
		this.#closeClientOnDisconnect = false;

		this.#setState("disconnected");
	}

	async destroy(): Promise<void> {
		await this.disconnect();
	}

	#addLocal(local: LocalBroadcast): void {
		const member: JoinedMember = {
			remote: false,
			name: local.name,
		};

		this.#onmember.onJoin(member);
		this.dispatchEvent(
			new CustomEvent<{ member: JoinedMember | LeftMember }>("memberjoin", {
				detail: { member },
			}),
		);
	}

	#removeLocal(local: LocalBroadcast): void {
		const member: LeftMember = {
			remote: false,
			name: local.name,
		};

		if (this.#local === local) {
			this.#local = undefined;
		}
		this.#hasLocalMember = false;

		this.#onmember.onLeave(member);
		this.dispatchEvent(
			new CustomEvent<{ member: JoinedMember | LeftMember }>("memberleave", {
				detail: { member },
			}),
		);
	}

	#removeRemote(remote: RemoteBroadcast): void {
		const got = this.#remotes.get(remote.name);

		if (!got) {
			return;
		}

		// Close the broadcast to clean up resources
		remote.close();

		if (got !== remote) {
			return;
		}

		// Remove from map first to prevent re-entrancy issues
		this.#remotes.delete(remote.name);

		// Notify about remote member leaving
		const member: LeftMember = {
			remote: true,
			name: remote.name,
		};

		this.#onmember.onLeave(member);
		this.dispatchEvent(
			new CustomEvent<{ member: JoinedMember | LeftMember }>("memberleave", {
				detail: { member },
			}),
		);
	}

	#addRemote(remote: RemoteBroadcast): void {
		// If the remote is the same as the existing one, do nothing
		const got = this.#remotes.get(remote.name);

		// Ignore if already have this exact remote
		if (remote === got) {
			return;
		}

		// If there is an existing remote with the same path, properly remove it first
		if (got) {
			// Properly remove the existing remote using #removeRemote
			// This ensures onLeave notification is sent and cleanup is done correctly
			this.#removeRemote(got);
		}

		this.#remotes.set(remote.name, remote);

		// Notify about new remote member joining
		const member: JoinedMember = {
			remote: true,
			name: remote.name,
			broadcast: remote,
		};

		this.#onmember.onJoin(member);
		this.dispatchEvent(
			new CustomEvent<{ member: JoinedMember | LeftMember }>("memberjoin", {
				detail: { member },
			}),
		);
	}

	#setState(next: RoomState): void {
		if (this.#state === next) {
			return;
		}

		const previous = this.#state;
		this.#state = next;
		this.dispatchEvent(
			new CustomEvent<{ previous: RoomState; current: RoomState }>(RoomEvents.StateChange, {
				detail: { previous, current: next },
			}),
		);
	}

	#emitError(cause: unknown, context: string): void {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		this.dispatchEvent(
			new CustomEvent<{ error: Error; context: string }>(RoomEvents.Error, {
				detail: { error, context },
			}),
		);
	}

	// get isJoined(): boolean {
	//     return this.#local !== undefined;
	// }
}

export interface RoomInit {
	roomID: string;
	description?: string;

	onmember?: MemberHandler;

	// Optional token for authentication
	// token?: string; // TODO: Implement token-based authentication
}

export interface MemberHandler {
	onJoin: (member: JoinedMember) => void;
	onLeave: (member: LeftMember) => void;
}

export function participantName(roomID: string, broadcastPath: BroadcastPath): string {
	// Extract the participant name from the broadcast path
	// Assumes the path format is "/<roomID>/<name>.hang"
	const name = broadcastPath.substring(roomID.length + 2).replace(HANG_EXTENSION, "");
	return name;
}

export function broadcastPath(roomID: string, name: string): BroadcastPath {
	return validateBroadcastPath(`/${roomID}/${name}${HANG_EXTENSION}`);
}
