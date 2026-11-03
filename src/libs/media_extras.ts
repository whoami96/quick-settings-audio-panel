import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import type Gvc from "gi://Gvc";
import St from "gi://St";

import type { MprisPlayer } from "resource:///org/gnome/shell/ui/mpris.js";
import { Slider } from "resource:///org/gnome/shell/ui/slider.js";
import * as Volume from "resource:///org/gnome/shell/ui/status/volume.js";

const MPRIS_PATH = "/org/mpris/MediaPlayer2";
const MPRIS_PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";
const POSITION_POLL_MS = 1000;

// Fields of MprisPlayer used here that are missing from the type definitions
type MprisPlayerInternals = MprisPlayer & {
	_busName: string;
	_app?: { get_name(): string; get_id(): string } | null;
	_mprisProxy?: { Identity?: string; DesktopEntry?: string } | null;
	_playerProxy?: { Metadata?: Record<string, GLib.Variant> } | null;
};

function normalize(value: string | null | undefined): string {
	return (value ?? "")
		.toLowerCase()
		.replace(/\.desktop$/, "")
		.replace(/[^a-z0-9]/g, "");
}

function format_time(us: number): string {
	const total = Math.max(0, Math.floor(us / GLib.USEC_PER_SEC));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = String(total % 60).padStart(2, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
		: `${minutes}:${seconds}`;
}

/**
 * Names under which a player can be identified.
 *
 * When the player declares a desktop entry, only that entry (and the matching application) is
 * used: the MPRIS identity is not reliable, e.g. GSConnect mirrors the phone's Spotify with the
 * identity "Spotify" but the desktop entry "org.gnome.Shell.Extensions.GSConnect", and must
 * not get the volume of a local Spotify. Otherwise (e.g. Chrome doesn't set it), fall back to
 * the identity ("Chrome") and the player part of the bus name
 * ("org.mpris.MediaPlayer2.chromium.instance1234" => "chromium").
 */
function player_keys(player: MprisPlayerInternals): string[] {
	const desktop_entry = player._mprisProxy?.DesktopEntry;
	const keys = desktop_entry
		? [desktop_entry, player._app?.get_name(), player._app?.get_id()]
		: [
				player._mprisProxy?.Identity,
				player._busName?.replace(/^org\.mpris\.MediaPlayer2\./, "").replace(/\.instance.*$/, ""),
			];
	return keys.map(normalize).filter(key => key.length >= 3);
}

function stream_matches(stream: Gvc.MixerStream, keys: string[]): boolean {
	const stream_keys = [stream.name, stream.application_id, stream.icon_name]
		.map(normalize)
		.filter(key => key.length >= 3);
	return keys.some(key =>
		stream_keys.some(
			stream_key => stream_key === key || stream_key.includes(key) || key.includes(stream_key),
		),
	);
}

// A slider that ignores scroll events, so that scrolling over the card still switches players
const NoScrollSlider = GObject.registerClass(
	class NoScrollSlider extends Slider {
		constructor(value: number) {
			super(value);
			for (const action of this.get_actions()) {
				if (action instanceof Clutter.ScrollController) this.remove_action(action);
			}
		}
	},
);

/**
 * Volume slider controlling the audio streams (sink inputs) of the application behind an MPRIS
 * player. Hidden when no matching stream exists (e.g. players mirrored from a phone).
 */
const PlayerVolume = GObject.registerClass(
	class PlayerVolume extends St.BoxLayout {
		private _player: MprisPlayerInternals;
		private _control: Gvc.MixerControl;
		private _streams: Gvc.MixerStream[];
		private _mute_button: St.Button;
		private _slider: InstanceType<typeof Slider>;
		private _slider_changed_id: number;
		private _in_drag: boolean;

		constructor(player: MprisPlayer) {
			super({
				style_class: "QSAP-media-volume",
				x_expand: true,
				visible: false,
			});
			this._player = player as MprisPlayerInternals;
			this._control = Volume.getMixerControl();
			this._streams = [];
			this._in_drag = false;

			this._mute_button = new St.Button({
				style_class: "QSAP-media-volume-icon",
				can_focus: true,
				child: new St.Icon({ icon_name: "audio-volume-high-symbolic", icon_size: 16 }),
			});
			this._mute_button.connect("clicked", () => this._toggle_mute());
			this.add_child(this._mute_button);

			this._slider = new Slider(0);
			this._slider.accessible_name = "Volume";
			this._slider_changed_id = this._slider.connect("notify::value", () => this._on_slider());
			this._slider.connect("drag-begin", () => (this._in_drag = true));
			this._slider.connect("drag-end", () => {
				this._in_drag = false;
				this._sync();
			});
			this.add_child(this._slider);

			this._control.connect_object(
				"stream-added",
				() => this._find_streams(),
				"stream-removed",
				() => this._find_streams(),
				this,
			);
			this._player.connect_object("changed", () => this._find_streams(), this);
			this._find_streams();
		}

		private _find_streams() {
			const keys = player_keys(this._player);
			const streams = this._control
				.get_sink_inputs()
				.filter(stream => !stream.is_event_stream && stream_matches(stream, keys));

			const same =
				streams.length === this._streams.length &&
				streams.every(stream => this._streams.includes(stream));
			if (same) return;

			for (const stream of this._streams) stream.disconnect_object(this);
			this._streams = streams;
			for (const stream of this._streams) {
				stream.connect_object(
					"notify::volume",
					() => this._sync(),
					"notify::is-muted",
					() => this._sync(),
					this,
				);
			}
			this.visible = this._streams.length > 0;
			this._sync();
		}

		private _sync() {
			if (this._streams.length === 0 || this._in_drag) return;

			const max = this._control.get_vol_max_norm();
			const muted = this._streams.every(stream => stream.is_muted);
			const volume = Math.max(...this._streams.map(stream => stream.volume)) / max;

			this._slider.block_signal_handler(this._slider_changed_id);
			this._slider.value = muted ? 0 : Math.min(volume, 1);
			this._slider.unblock_signal_handler(this._slider_changed_id);
			this._update_icon(muted ? 0 : volume);
		}

		private _update_icon(volume: number) {
			let icon_name = "audio-volume-muted-symbolic";
			if (volume > 0.66) icon_name = "audio-volume-high-symbolic";
			else if (volume > 0.33) icon_name = "audio-volume-medium-symbolic";
			else if (volume > 0) icon_name = "audio-volume-low-symbolic";
			(this._mute_button.child as St.Icon).icon_name = icon_name;
		}

		private _on_slider() {
			const volume = this._slider.value * this._control.get_vol_max_norm();
			for (const stream of this._streams) {
				if (stream.is_muted && volume > 0) stream.change_is_muted(false);
				stream.volume = volume;
				stream.push_volume();
			}
			this._update_icon(this._slider.value);
		}

		private _toggle_mute() {
			const muted = this._streams.every(stream => stream.is_muted);
			for (const stream of this._streams) stream.change_is_muted(!muted);
		}
	},
);

/**
 * Progress bar of the current track, with seeking. MPRIS doesn't signal position changes
 * (except jumps, through `Seeked`), so the position is polled while the card is on screen and
 * the player is playing. Hidden when the player doesn't report a track length.
 */
const PlayerProgress = GObject.registerClass(
	class PlayerProgress extends St.BoxLayout {
		private _player: MprisPlayerInternals;
		private _bus_name: string;
		private _elapsed: St.Label;
		private _total: St.Label;
		private _slider: InstanceType<typeof NoScrollSlider>;
		private _slider_changed_id: number;
		private _in_drag: boolean;
		private _length: number;
		private _position: number;
		private _track_id: string | null;
		private _can_seek: boolean | null;
		private _poll_id: number;
		private _seeked_id: number;
		private _cancellable: Gio.Cancellable;

		constructor(player: MprisPlayer) {
			super({
				style_class: "QSAP-media-progress",
				x_expand: true,
				visible: false,
			});
			this._player = player as MprisPlayerInternals;
			this._bus_name = this._player._busName;
			this._in_drag = false;
			this._length = 0;
			this._position = 0;
			this._track_id = null;
			this._can_seek = null;
			this._poll_id = 0;
			this._cancellable = new Gio.Cancellable();

			this._elapsed = new St.Label({
				style_class: "QSAP-media-time",
				y_align: Clutter.ActorAlign.CENTER,
			});
			this._slider = new NoScrollSlider(0);
			this._slider.accessible_name = "Track position";
			this._slider_changed_id = this._slider.connect("notify::value", () => {
				if (this._in_drag) this._show_position(this._slider.value * this._length);
			});
			this._slider.connect("drag-begin", () => (this._in_drag = true));
			this._slider.connect("drag-end", () => {
				this._in_drag = false;
				this._seek(this._slider.value * this._length);
			});
			this._total = new St.Label({
				style_class: "QSAP-media-time",
				y_align: Clutter.ActorAlign.CENTER,
			});
			this.add_child(this._elapsed);
			this.add_child(this._slider);
			this.add_child(this._total);

			this._seeked_id = Gio.DBus.session.signal_subscribe(
				this._bus_name,
				MPRIS_PLAYER_IFACE,
				"Seeked",
				MPRIS_PATH,
				null,
				Gio.DBusSignalFlags.NONE,
				(_connection, _sender, _path, _iface, _signal, params) => {
					const [position] = params.deepUnpack() as [number];
					this._set_position(position);
				},
			);

			this._player.connect_object("changed", () => this._on_player_changed(), this);
			this.connect("notify::mapped", () => this._update_polling());
			this.connect("destroy", () => {
				this._cancellable.cancel();
				this._stop_polling();
				Gio.DBus.session.signal_unsubscribe(this._seeked_id);
			});
			this._on_player_changed();
		}

		private _on_player_changed() {
			const metadata = this._player._playerProxy?.Metadata ?? {};
			const length = metadata["mpris:length"]?.deepUnpack() as number | undefined;
			const track_id = metadata["mpris:trackid"]?.deepUnpack() as string | undefined;

			this._length = typeof length === "number" && length > 0 ? length : 0;
			if (track_id !== this._track_id) {
				this._track_id = track_id ?? null;
				this._position = 0;
			}
			// `CanSeek` can change with the track (e.g. live streams), check it again
			this._can_seek = null;
			this.visible = this._length > 0;
			this._total.text = format_time(this._length);

			this._refresh();
			this._update_polling();
		}

		private _update_polling() {
			const should_poll = this.mapped && this.visible && this._player.status === "Playing";
			if (should_poll && !this._poll_id) {
				this._poll_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POSITION_POLL_MS, () => {
					this._refresh();
					return GLib.SOURCE_CONTINUE;
				});
			} else if (!should_poll) {
				this._stop_polling();
			}
		}

		private _stop_polling() {
			if (this._poll_id) {
				GLib.source_remove(this._poll_id);
				this._poll_id = 0;
			}
		}

		private async _get_property(name: string): Promise<unknown> {
			const reply = await Gio.DBus.session.call(
				this._bus_name,
				MPRIS_PATH,
				"org.freedesktop.DBus.Properties",
				"Get",
				new GLib.Variant("(ss)", [MPRIS_PLAYER_IFACE, name]),
				new GLib.VariantType("(v)"),
				Gio.DBusCallFlags.NONE,
				500,
				this._cancellable,
			);
			const [value] = reply.deepUnpack() as [GLib.Variant];
			return value.deepUnpack();
		}

		private async _refresh() {
			if (!this.visible || !this.mapped) return;
			try {
				if (this._can_seek === null) {
					this._can_seek = (await this._get_property("CanSeek")) === true;
					this._slider.reactive = this._can_seek;
				}
				const position = await this._get_property("Position");
				if (typeof position === "number") this._set_position(position);
			} catch (_e) {
				// Some players don't implement `Position` (it's optional), keep the bar static
			}
		}

		private _set_position(position: number) {
			this._position = position;
			if (this._in_drag) return;

			this._slider.block_signal_handler(this._slider_changed_id);
			this._slider.value = this._length > 0 ? Math.min(position / this._length, 1) : 0;
			this._slider.unblock_signal_handler(this._slider_changed_id);
			this._show_position(position);
		}

		private _show_position(position: number) {
			this._elapsed.text = format_time(position);
		}

		private async _seek(position: number) {
			if (!this._can_seek || this._track_id === null) {
				this._set_position(this._position);
				return;
			}
			try {
				await Gio.DBus.session.call(
					this._bus_name,
					MPRIS_PATH,
					MPRIS_PLAYER_IFACE,
					"SetPosition",
					new GLib.Variant("(ox)", [this._track_id, Math.round(position)]),
					null,
					Gio.DBusCallFlags.NONE,
					1000,
					this._cancellable,
				);
				this._set_position(position);
			} catch (e) {
				console.warn(`[QSAP] Failed to seek ${this._bus_name}: ${e}`);
				this._set_position(this._position);
			}
		}
	},
);

/**
 * Extra rows added at the bottom of a media card: track progress and application volume.
 */
export const MediaCardExtras = GObject.registerClass(
	class MediaCardExtras extends St.BoxLayout {
		constructor(player: MprisPlayer, show_progress: boolean, show_volume: boolean) {
			super({
				style_class: "QSAP-media-extras",
				orientation: Clutter.Orientation.VERTICAL,
				x_expand: true,
			});

			if (show_progress) this.add_child(new PlayerProgress(player));
			if (show_volume) this.add_child(new PlayerVolume(player));
		}
	},
);
