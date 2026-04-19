/**
 * FakeGainNode for Deno test environments.
 * Must be imported BEFORE any module that uses `class X extends GainNode`.
 *
 * Implements real gain scheduling behaviour:
 * - gain.setValueAtTime / exponentialRampToValueAtTime immediately apply the value
 *   (no timeline — adequate for unit-test purposes).
 * - connect() throws for external destinations (AudioEncodeNode is a terminal node).
 */
export class FakeGainNode extends EventTarget {
	context: AudioContext;
	channelCount = 2;
	channelCountMode: ChannelCountMode = "max";
	channelInterpretation: ChannelInterpretation = "speakers";
	numberOfInputs = 1;
	numberOfOutputs = 0;

	gain: GainNode["gain"];

	constructor(context?: AudioContext, options?: { gain?: number }) {
		super();
		this.context = context ?? ({} as AudioContext);
		const initialGain = options?.gain ?? 1.0;
		let _value = initialGain;
		const gainParam: AudioParam = {
			get value() {
				return _value;
			},
			set value(v: number) {
				_value = v;
			},
			cancelScheduledValues(_startTime: number): AudioParam {
				return gainParam;
			},
			setValueAtTime(value: number, _startTime: number): AudioParam {
				_value = value;
				return gainParam;
			},
			exponentialRampToValueAtTime(value: number, _endTime: number): AudioParam {
				_value = value;
				return gainParam;
			},
			linearRampToValueAtTime(value: number, _endTime: number): AudioParam {
				_value = value;
				return gainParam;
			},
			setTargetAtTime(target: number, _startTime: number, _timeConstant: number): AudioParam {
				_value = target;
				return gainParam;
			},
			setValueCurveAtTime(
				_values: Iterable<number>,
				_startTime: number,
				_duration: number,
			): AudioParam {
				return gainParam;
			},
			automationRate: "a-rate" as AutomationRate,
			defaultValue: 1,
			maxValue: 3.4028234663852886e+38,
			minValue: -3.4028234663852886e+38,
			addEventListener: this.addEventListener.bind(this),
			removeEventListener: this.removeEventListener.bind(this),
			dispatchEvent: this.dispatchEvent.bind(this),
		} as unknown as AudioParam;
		this.gain = gainParam;
	}

	connect(_destination: AudioNode | AudioParam): AudioNode | void {
		if (_destination && typeof _destination === "object" && "port" in _destination) {
			return _destination as AudioNode;
		}
		throw new Error("AudioEncodeNode does not support connections. Use encodeTo() instead.");
	}

	disconnect(): void {}
}
