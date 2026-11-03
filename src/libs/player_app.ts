import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Shell from "gi://Shell";

import type { MprisPlayer } from "resource:///org/gnome/shell/ui/mpris.js";

// Fields of MprisPlayer used here that are missing from the type definitions
type MprisPlayerInternals = MprisPlayer & {
	_busName: string;
	_mprisProxy?: { Identity?: string; DesktopEntry?: string } | null;
};

// systemd units created for applications:
// - app-com.google.Chrome-15336.scope (launched by GNOME)
// - app-flatpak-com.spotify.Client-2226710649.scope (Flatpak)
// - app-gnome-org.gnome.Lollypop-1234.scope (older GNOME versions)
// - dbus-:1.2-org.gnome.Shell.Extensions.GSConnect@0.service (D-Bus activated)
const UNIT_PATTERNS = [
	/\/app-(?:flatpak-|gnome-)?([^/]+?)(?:-[0-9]+)?\.scope$/,
	/\/dbus-:[0-9.]+-([^/@]+)@[0-9]+\.service$/,
	/\/app-(?:flatpak-|gnome-)?([^/@]+?)(?:@[^/]*)?\.service$/,
];

function lookup(app_system: Shell.AppSystem, id: string | null | undefined): Shell.App | null {
	if (!id) return null;
	const desktop_id = id.endsWith(".desktop") ? id : `${id}.desktop`;
	return app_system.lookup_app(desktop_id) ?? app_system.lookup_heuristic_basename(desktop_id);
}

function search(app_system: Shell.AppSystem, query: string | null | undefined): Shell.App | null {
	if (!query) return null;
	for (const group of Shell.AppSystem.search(query)) {
		for (const id of group) {
			const app = app_system.lookup_app(id);
			if (app) return app;
		}
	}
	return null;
}

async function get_owner_pid(bus_name: string): Promise<number | null> {
	try {
		const reply = await Gio.DBus.session.call(
			"org.freedesktop.DBus",
			"/org/freedesktop/DBus",
			"org.freedesktop.DBus",
			"GetConnectionUnixProcessID",
			new GLib.Variant("(s)", [bus_name]),
			new GLib.VariantType("(u)"),
			Gio.DBusCallFlags.NONE,
			1000,
			null,
		);
		const [pid] = reply.deepUnpack() as [number];
		return pid;
	} catch (_e) {
		return null;
	}
}

function app_from_cgroup(app_system: Shell.AppSystem, pid: number): Shell.App | null {
	try {
		const [, contents] = GLib.file_get_contents(`/proc/${pid}/cgroup`);
		const cgroup = new TextDecoder().decode(contents).trim().split("\n").pop() ?? "";
		for (const pattern of UNIT_PATTERNS) {
			const app = lookup(app_system, cgroup.match(pattern)?.[1]);
			if (app) return app;
		}
	} catch (_e) {
		// the process may already be gone
	}
	return null;
}

/**
 * Finds the application behind an MPRIS player, for players that GNOME can't resolve by
 * itself: GNOME only uses `DesktopEntry`, which Chromium doesn't set and which Flatpak apps
 * often set to a name that isn't their application id (Spotify says "spotify" but is
 * installed as "com.spotify.Client").
 *
 * In order: the systemd unit of the process owning the player's bus name (it contains the
 * application id), the application owning windows of that process, the desktop entry and
 * the identity used as search terms.
 */
export async function resolve_player_app(player: MprisPlayer): Promise<Shell.App | null> {
	const internals = player as MprisPlayerInternals;
	const app_system = Shell.AppSystem.get_default();

	const pid = await get_owner_pid(internals._busName);
	if (pid !== null && pid > 0) {
		const app =
			app_from_cgroup(app_system, pid) ?? Shell.WindowTracker.get_default().get_app_from_pid(pid);
		if (app) return app;
	}

	return (
		lookup(app_system, internals._mprisProxy?.DesktopEntry) ??
		search(app_system, internals._mprisProxy?.DesktopEntry) ??
		search(app_system, internals._mprisProxy?.Identity)
	);
}
