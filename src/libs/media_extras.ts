import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";

import type { MprisPlayer } from "resource:///org/gnome/shell/ui/mpris.js";
import { Slider } from "resource:///org/gnome/shell/ui/slider.js";

const MPRIS_PATH = "/org/mpris/MediaPlayer2";
const MPRIS_PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";
const POSITION_POLL_MS = 1000;

// Fields of MprisPlayer used here that are missing from the type definitions
type MprisPlayerInternals = MprisPlayer & {
	_busName: string;
	_playerProxy?: { Metadata?: Record<string, GLib.Variant> } | null;
};

function format_time(us: number): string {
	const total = Math.max(0, Math.floor(us / GLib.USEC_PER_SEC));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = String(total % 60).padStart(2, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
		: `${minutes}:${seconds}`;
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
 * Extra rows added at the bottom of a media card (currently only the track progress).
 */
export const MediaCardExtras = GObject.registerClass(
	class MediaCardExtras extends St.BoxLayout {
		constructor(player: MprisPlayer) {
			super({
				style_class: "QSAP-media-extras",
				orientation: Clutter.Orientation.VERTICAL,
				x_expand: true,
			});

			this.add_child(new PlayerProgress(player));
		}
	},
);
