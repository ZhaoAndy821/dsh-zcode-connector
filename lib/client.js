/**
 * Client half for dsh-zcode-connect — registers the panel as a **right-sidebar tab**.
 *
 * The harness has two sidebar systems and they are not the same thing:
 *   · the left rail / main area (`sidebar.panellist` + keyed `main`) — where this plugin first
 *     appeared ("ZCode" among the left-hand entries)
 *   · the right sidebar's tab system, next to Subagents / Tasks:
 *       ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })   the tab *type*
 *       slot "sidebar.right.pane.tab"        keyed by that id  → the body
 *       slot "sidebar.right.pane.tab.title"  keyed by that id  → the chip title
 *     (contract read from @deepseek-ai/dsh-client-ui-sidebar-right and the official
 *      @deepseek-ai/dsh-client-ui-sidebar-files, which registers its Files tab exactly this way)
 *
 * The body frames the host route that already renders the whole panel, so the view has exactly one
 * implementation. The switch in Settings → Plugins decides whether the tab type is registered at
 * all; it is a per-browser preference (localStorage), because "do I want this tab" is a UI choice
 * of this browser rather than harness configuration.
 *
 * Built by hand (no bundler): this file is already in the `__ModuleLoader__.load` envelope.
 */
window.__ModuleLoader__.load({
	id: "dsh-zcode-connect",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		//#region constants
		const NS = "dsh-zcode-connect";
		/** This implementation's identity in the tab system; also the key its body registers under. */
		const TAB_ID = "dsh-zcode-connect";
		/** The tab kind this plugin owns. A kind of our own cannot collide with Files/Tasks/…. */
		const TAB_KIND = "zcode";
		const PREF_KEY = NS + ":sidebar";
		const PANEL_ROUTE = "/plugins/dsh-zcode-connect/panel";
		//#endregion

		//#region preference (per browser, with a manual override for scripting)
		const listeners = new Set();
		function readPref() {
			try {
				return window.localStorage.getItem(PREF_KEY) !== "off";
			} catch (e) {
				return true; // no storage (private mode): show the tab rather than hide it silently
			}
		}
		function writePref(on) {
			try {
				window.localStorage.setItem(PREF_KEY, on ? "on" : "off");
			} catch (e) { /* preference is best-effort */ }
			for (const listener of listeners) {
				try { listener(on); } catch (e) { /* one bad listener must not stop the rest */ }
			}
		}
		//#endregion

		//#region components
		/** The tab's glyph, drawn at whatever size the caller asks for and in currentColor. */
		function Glyph(props) {
			const size = (props && props.size) || 16;
			return React.createElement(
				"svg",
				{ width: size, height: size, viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true", style: { flex: "none" } },
				React.createElement("rect", {
					x: 3.25, y: 4.25, width: 17.5, height: 15.5, rx: 3,
					stroke: "currentColor", strokeWidth: 1.5, opacity: 0.75,
				}),
				React.createElement("path", {
					d: "M7.5 9.5h7M7.5 12.5h9M7.5 15.5h5",
					stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round",
				}),
			);
		}

		/** The tab body: the host-rendered panel, framed. */
		function PanelBody() {
			return React.createElement("iframe", {
				src: PANEL_ROUTE,
				title: "ZCode 连接器",
				style: { border: "0", width: "100%", height: "100%", display: "block", background: "transparent" },
			});
		}

		/** The tab chip: glyph + the tab's own title (the frame hands the title in through useTabInfo). */
		function PanelTitle(props) {
			const info = props && typeof props.useTabInfo === "function" ? props.useTabInfo() : null;
			const title = (info && info.tab && info.tab.title) || "ZCode";
			return React.createElement(
				"span",
				{ style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
				React.createElement(Glyph, { size: 16 }),
				title,
			);
		}

		/** Settings → Plugins → this plugin: the switch that owns the tab registration. */
		function Card() {
			const [on, setOn] = React.useState(readPref());
			React.useEffect(() => {
				listeners.add(setOn);
				return () => listeners.delete(setOn);
			}, []);
			return React.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "8px" } },
				React.createElement("div", { style: { fontWeight: 600 } }, "ZCode 连接器"),
				React.createElement(
					"label",
					{ style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" } },
					React.createElement("input", {
						type: "checkbox",
						checked: on,
						onChange: (event) => writePref(event.target.checked),
					}),
					React.createElement("span", null, "在右侧栏注册 ZCode 标签页"),
				),
				React.createElement(
					"div",
					{ style: { opacity: 0.65, fontSize: "12px", lineHeight: 1.6 } },
					"开启后右侧栏的标签列表里会多一个 ZCode（与 Subagents、Tasks 并列），点开就是面板：套餐额度、后台任务与 subagent 运行状况。",
					"该开关存在本浏览器；关掉只是移走标签页，插件本身仍在运行。",
				),
			);
		}
		//#endregion

		//#region plugin body
		/** Services this client half needs: the slot registry and the right sidebar's tab registry. */
		const inject = ["slots", "sidebarRightTabs"];

		function apply(ctx) {
			/** Everything registered for the tab; disposed as a unit when the tab is switched off. */
			let registered = null;

			function registerTab() {
				const disposers = [];
				// 1) the tab type itself
				disposers.push(ctx.sidebarRightTabs.register({
					id: TAB_ID,
					kind: TAB_KIND,
					priority: "extension",
					title: () => "ZCode",
					guide: [{
						order: 80,
						title: () => "ZCode 面板",
						description: () => "套餐额度、后台任务与 subagent 运行状况",
						icon: Glyph,
					}],
				}));
				// 2) its body, keyed by the same id
				disposers.push(ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register(
					{ name: "sidebar.right.pane.tab", key: TAB_ID },
					PanelBody,
				)));
				// 3) its chip title
				disposers.push(ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register(
					{ name: "sidebar.right.pane.tab.title", key: TAB_ID },
					PanelTitle,
				)));
				return () => {
					for (const dispose of disposers.reverse()) {
						try {
							if (typeof dispose === "function") dispose();
						} catch (e) {
							console.warn("[zcode-connect] tab dispose failed", e);
						}
					}
				};
			}

			function sync() {
				const wanted = readPref();
				if (wanted && registered === null) {
					registered = registerTab();
					console.log("[zcode-connect] right-sidebar tab registered");
				} else if (!wanted && registered !== null) {
					registered();
					registered = null;
					console.log("[zcode-connect] right-sidebar tab removed");
				}
			}

			sync();
			listeners.add(() => sync());

			// The card is registered regardless of the preference, otherwise the switch could not be
			// found again once the tab is hidden.
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register(
				{ name: "settings.plugin.item", key: NS },
				Card,
			));

			// Another tab flipping the switch should move this tab too.
			const onStorage = (event) => {
				if (event.key === PREF_KEY) sync();
			};
			window.addEventListener("storage", onStorage);

			// Manual control, for a console or a script.
			window.__zcodeConnectSidebar = {
				get enabled() { return readPref(); },
				enable: () => writePref(true),
				disable: () => writePref(false),
				toggle: () => writePref(!readPref()),
				tabId: TAB_ID,
			};

			ctx.effect(() => () => {
				window.removeEventListener("storage", onStorage);
				listeners.clear();
				if (registered !== null) registered();
				delete window.__zcodeConnectSidebar;
			}, "zcode-connect client: cleanup");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
