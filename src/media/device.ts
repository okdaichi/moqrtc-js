/**
 * MediaDeviceContext manages shared state for all media devices.
 * Context pattern allows explicit dependency injection and clear boundaries.
 * 
 * @example
 * ```typescript
 * // Create a context for managing media devices
 * const deviceContext = new MediaDeviceContext();
 * 
 * // Use it with Camera and Microphone
 * const camera = new Camera(deviceContext, { enabled: true });
 * const microphone = new Microphone(deviceContext, { enabled: true });
 * 
 * // Subscribe to device changes
 * const unsubscribe = deviceContext.subscribe((devices) => {
 *   console.log('Available devices:', devices);
 * });
 * 
 * // Cleanup when done
 * deviceContext.close();
 * ```
 */
export class MediaDeviceContext {
	#devices: MediaDeviceInfo[] = [];
	#permissions: Map<"audio" | "video", boolean> = new Map();
	#permissionRequests: Map<"audio" | "video", Promise<boolean>> = new Map();
	#listeners: Set<(devices: MediaDeviceInfo[]) => void> = new Set();
	#onchange: (() => void) | undefined;
	#debounceTimer: number | undefined;
	#updateInProgress: Promise<void> | undefined;
	
	static GET_USER_MEDIA_TIMEOUT = 8000; // 8s
	
	/** Get all available devices (readonly) */
	get devices(): readonly MediaDeviceInfo[] {
		return this.#devices;
	}
	
	constructor() {
		// Initial device enumeration
		void this.updateDevices();
		
		// Set up devicechange listener once for all Device instances
		this.#onchange = () => {
			// Debounce rapid devicechange events
			if (typeof this.#debounceTimer !== "undefined") {
				clearTimeout(this.#debounceTimer);
			}
			// Schedule update slightly later to aggregate rapid changes
			this.#debounceTimer = globalThis.setTimeout(() => {
				this.#debounceTimer = undefined;
				void this.updateDevices();
			}, 200);
		};
		
		// Only set up event listeners if mediaDevices is available
		if (navigator && navigator.mediaDevices) {
			try {
				navigator.mediaDevices.addEventListener(
					"devicechange",
					this.#onchange as EventListener,
				);
			} catch (e) {
				// Some environments may not support addEventListener on mediaDevices
				// Fall back to assigning onchange if available
				if (typeof navigator.mediaDevices.ondevicechange !== "undefined") {
					navigator.mediaDevices.ondevicechange = this.#onchange;
				}
			}
		}
	}
	
	async updateDevices(): Promise<void> {
		// Prevent duplicate concurrent updates
		if (this.#updateInProgress) {
			return this.#updateInProgress;
		}
		
		if (!navigator || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
			this.#devices = [];
			return;
		}
		
		this.#updateInProgress = (async () => {
			try {
				const devices = await navigator.mediaDevices.enumerateDevices();
				this.#devices = devices;
				
				// Check if we have permission by looking for devices with IDs
				const hasAudioPermission = devices.some(d => 
					d.kind === "audioinput" && d.deviceId !== ""
				);
				const hasVideoPermission = devices.some(d => 
					d.kind === "videoinput" && d.deviceId !== ""
				);
				
				if (hasAudioPermission) this.#permissions.set("audio", true);
				if (hasVideoPermission) this.#permissions.set("video", true);
				
				// Notify all listeners
				this.#listeners.forEach(fn => fn(devices));
			} catch (error) {
				console.warn("Failed to update devices:", error);
			}
		})();
		
		await this.#updateInProgress;
		this.#updateInProgress = undefined;
	}
	
	getDevices(kind: "audio" | "video"): MediaDeviceInfo[] {
		return this.#devices.filter(d => d.kind === `${kind}input`);
	}
	
	hasPermission(kind: "audio" | "video"): boolean {
		return this.#permissions.get(kind) ?? false;
	}
	
	async requestPermission(kind: "audio" | "video"): Promise<boolean> {
		// Return cached permission state if already granted
		if (this.hasPermission(kind)) {
			return true;
		}
		
		// Return in-flight request if one exists (prevents duplicate getUserMedia calls)
		const existingRequest = this.#permissionRequests.get(kind);
		if (existingRequest) {
			return existingRequest;
		}
		
		if (!navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
			console.warn("getUserMedia is not available in this environment");
			return false;
		}
		
		// Create new permission request
		const request = (async () => {
			const controller = new AbortController();
			const timeoutId = globalThis.setTimeout(
				() => controller.abort(),
				MediaDeviceContext.GET_USER_MEDIA_TIMEOUT,
			);
			
			try {
				const stream = await navigator.mediaDevices.getUserMedia(
					{ [kind]: true } as MediaStreamConstraints,
				);
				this.#permissions.set(kind, true);
				
				// Clean up the temporary stream
				stream.getTracks().forEach((track) => track.stop());
				
				// Update device list to get fresh data with labels
				await this.updateDevices();
				
				return true;
			} catch (error) {
				console.warn(`Failed to request ${kind} permission:`, error);
				return false;
			} finally {
				clearTimeout(timeoutId);
				controller.abort();
				this.#permissionRequests.delete(kind);
			}
		})();
		
		this.#permissionRequests.set(kind, request);
		return request;
	}
	
	subscribe(listener: (devices: MediaDeviceInfo[]) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	
	close(): void {
		if (this.#onchange && navigator && navigator.mediaDevices) {
			try {
				if (typeof navigator.mediaDevices.removeEventListener === "function") {
					navigator.mediaDevices.removeEventListener("devicechange", this.#onchange);
				} else if (typeof navigator.mediaDevices.ondevicechange !== "undefined") {
					navigator.mediaDevices.ondevicechange = null;
				}
			} catch (e) {
				// Ignore
			}
			this.#onchange = undefined;
		}
		
		if (typeof this.#debounceTimer !== "undefined") {
			clearTimeout(this.#debounceTimer);
			this.#debounceTimer = undefined;
		}
		
		this.#listeners.clear();
		this.#permissions.clear();
		this.#permissionRequests.clear();
	}
}
