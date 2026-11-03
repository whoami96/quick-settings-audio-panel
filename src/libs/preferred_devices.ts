import type Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gvc from "gi://Gvc";

import * as Volume from "resource:///org/gnome/shell/ui/status/volume.js";

// Devices appear in bursts (a Bluetooth headset adds a sink and a source, profiles switch...),
// so wait for things to settle before choosing a device
const SETTLE_DELAY_MS = 1000;
// Right after login, the session (or WirePlumber) may change the default devices on its own.
// During this window, any change of the default device is corrected.
const STARTUP_WINDOW_US = 20 * GLib.USEC_PER_SEC;

type Direction = "output" | "input";

/**
 * Keeps the default output and input devices in line with user-defined priority lists.
 *
 * The preferred device is applied when the extension starts, when a device appears or
 * disappears, and when the priority list changes. A manual change of the default device is
 * respected until the next device change (except during the first seconds of the session,
 * see `STARTUP_WINDOW_US`).
 *
 * Devices are identified by their PulseAudio name (e.g. `alsa_output.usb-...` or
 * `bluez_output.XX_XX_XX_XX_XX_XX.1`), which is stable across reboots. The preferences window
 * can't use Gvc, so the extension saves every device it sees in `known-*-devices`.
 */
export class PreferredDevices {
	private _settings: Gio.Settings;
	private _control: Gvc.MixerControl;
	private _settle_id: number;
	private _started_at: number;
	private _signal_ids: number[];
	private _settings_ids: number[];

	constructor(settings: Gio.Settings) {
		this._settings = settings;
		this._control = Volume.getMixerControl();
		this._settle_id = 0;
		this._started_at = GLib.get_monotonic_time();

		const schedule = () => this._schedule();
		const on_default_changed = () => {
			if (GLib.get_monotonic_time() - this._started_at < STARTUP_WINDOW_US) this._schedule();
		};
		this._signal_ids = [
			this._control.connect("state-changed", schedule),
			this._control.connect("stream-added", schedule),
			this._control.connect("stream-removed", schedule),
			this._control.connect("default-sink-changed", on_default_changed),
			this._control.connect("default-source-changed", on_default_changed),
		];
		this._settings_ids = [
			settings.connect("changed::preferred-devices-enabled", schedule),
			settings.connect("changed::preferred-output-devices", schedule),
			settings.connect("changed::preferred-input-devices", schedule),
		];

		this._schedule();
	}

	destroy() {
		for (const id of this._signal_ids) this._control.disconnect(id);
		for (const id of this._settings_ids) this._settings.disconnect(id);
		this._signal_ids = [];
		this._settings_ids = [];

		if (this._settle_id) {
			GLib.source_remove(this._settle_id);
			this._settle_id = 0;
		}
	}

	private _schedule() {
		if (this._settle_id) GLib.source_remove(this._settle_id);
		this._settle_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_DELAY_MS, () => {
			this._settle_id = 0;
			this._apply();
			return GLib.SOURCE_REMOVE;
		});
	}

	private _apply() {
		if (this._control.get_state() !== Gvc.MixerControlState.READY) return;

		this._save_known_devices("output", this._get_streams("output"));
		this._save_known_devices("input", this._get_streams("input"));

		if (!this._settings.get_boolean("preferred-devices-enabled")) return;

		this._apply_direction("output");
		this._apply_direction("input");
	}

	private _get_streams(direction: Direction): Gvc.MixerStream[] {
		if (direction === "output") return this._control.get_sinks();

		// Monitors of output devices are listed as sources too, they are never a sensible default
		return this._control.get_sources().filter(source => !source.name?.endsWith(".monitor"));
	}

	private _apply_direction(direction: Direction) {
		const preferred = this._settings.get_strv(`preferred-${direction}-devices`);
		if (preferred.length === 0) return;

		const streams = this._get_streams(direction);
		let target: Gvc.MixerStream | undefined;
		for (const name of preferred) {
			target = streams.find(stream => stream.name === name);
			if (target) break;
		}
		if (!target) return;

		const current =
			direction === "output"
				? this._control.get_default_sink()
				: this._control.get_default_source();
		if (current?.name === target.name) return;

		console.log(
			`[QSAP] Switching default ${direction} to preferred device "${target.description}" (${target.name})`,
		);
		if (direction === "output") this._control.set_default_sink(target);
		else this._control.set_default_source(target);
	}

	private _save_known_devices(direction: Direction, streams: Gvc.MixerStream[]) {
		const key = `known-${direction}-devices`;
		const known = this._settings.get_value(key).recursiveUnpack() as Record<string, string>;

		let changed = false;
		for (const stream of streams) {
			if (!stream.name) continue;
			const description = stream.description || stream.name;
			if (known[stream.name] !== description) {
				known[stream.name] = description;
				changed = true;
			}
		}

		// Devices that are not connected anymore are kept on purpose, so that they can still be
		// added to the priority list (e.g. Bluetooth headphones that are turned off)
		if (changed) this._settings.set_value(key, new GLib.Variant("a{ss}", known));
	}
}
