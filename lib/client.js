/**
 * @javierni/balance-show — browser half.
 *
 * A client-plugin bundle (the wire format dsh-client-modules expects: a
 * `window.__ModuleLoader__.load({ id, factory })` wrapper, CJS-style `require`
 * inside). Renders a compact floating card pinned to the bottom-right corner
 * of the Web GUI (the frame-wide `shell.overlay` slot — additive, above every
 * column).
 *
 * This plugin is a balance & usage card built on the DeepSeek Harness — it is
 * NOT affiliated with the DeepSeek platform and is not a "DeepSeek 余额卡片".
 * The card shows the balance of the harness-configured DEEPSEEK_API_KEY with a
 * color-coded amount (green ≥¥50, orange ¥10–50, red <¥10), the availability
 * chip, a manual refresh button, and — in smaller text under the balance — the
 * current conversation's live token usage: total tokens, cache-hit status and
 * rate, and the priced cost (CNY). The session stats are not collapsed: they
 * render inline whenever a current session exists. Styling uses only
 * `--dsw-*` theme tokens.
 */
window.__ModuleLoader__.load({
	id: "@javierni/balance-show",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");
		const { useState, useEffect, useCallback, useRef } = react;
		const { jsx, jsxs, Fragment } = jsxRuntime;

		/** Poll intervals (ms). Balance sync every 3 min. */
		const BALANCE_POLL_MS = 180000;
		const SESSION_POLL_MS = 3000;

		/** Amount font color by remaining balance (¥). */
		function amountColor(total) {
			if (total >= 50) return "var(--dsw-alias-state-success-primary)";
			if (total >= 10) return "var(--dsw-alias-state-warn-primary)";
			return "var(--dsw-alias-state-error-primary)";
		}

		function currencySymbol(code) {
			switch (code) {
				case "CNY": return "¥";
				case "USD": return "$";
				case "EUR": return "€";
				case "JPY": return "¥";
				case "HKD": return "HK$";
				default: return code ? `${code} ` : "";
			}
		}

		function formatAmount(value, currency) {
			return `${currencySymbol(currency)}${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
		}

		function formatTokens(value) {
			return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}

		/** Cost display by magnitude: avoids long fractional tails. */
		function formatCost(value) {
			if (!Number.isFinite(value) || value <= 0) return "¥0";
			if (value >= 100) return `¥${value.toFixed(0)}`;
			if (value >= 1) return `¥${value.toFixed(2)}`;
			if (value >= 0.01) return `¥${value.toFixed(3)}`;
			return `¥${value.toPrecision(2)}`;
		}

		function formatTime(date) {
			const hh = String(date.getHours()).padStart(2, "0");
			const mm = String(date.getMinutes()).padStart(2, "0");
			const ss = String(date.getSeconds()).padStart(2, "0");
			return `${hh}:${mm}:${ss}`;
		}

		/**
		 * 圆圈里的字号随金额字符串长度自适应：
		 * 字符越多字号越小，保证 56px 圆内单行放得下。
		 * 基准：8 字符(如 ¥9999.99) → 11px；每多 1 字符减 1px，下限 7px。
		 * 6 字符(如 ¥99.99) → 13px，10 字符(如 ¥999999.99) → 9px。
		 */
		function orbFontSize(amountText) {
			const len = amountText.length;
			return Math.max(7, Math.round((13 - (len - 6) * 1) * 10) / 10);
		}

		// ---- inline styles (dsw theme tokens only) ------------------------
		const card = {
			position: "absolute",
			right: 16,
			bottom: 16,
			zIndex: 30,
			pointerEvents: "auto",
			boxSizing: "border-box",
			width: 280,
			borderRadius: 12,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-overlay)",
			boxShadow: "0 4px 16px rgba(0, 0, 0, 0.16)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px",
			padding: "10px 12px",
			display: "flex",
			flexDirection: "column",
			gap: 6
		};

		const headerRow = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			height: 20
		};

		const title = {
			flex: 1,
			minWidth: 0,
			display: "flex",
			alignItems: "center",
			gap: 6,
			fontWeight: 600,
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};

		const refreshButton = {
			flex: "none",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 20,
			height: 20,
			border: 0,
			borderRadius: 6,
			padding: 0,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer"
		};

		const amountRow = {
			display: "flex",
			alignItems: "baseline",
			gap: 8
		};

		const amountValue = {
			fontSize: 24,
			lineHeight: "30px",
			fontWeight: 700,
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap"
		};

		const statusChip = {
			flex: "none",
			borderRadius: 999,
			padding: "0 6px",
			fontSize: 10,
			lineHeight: "16px"
		};

		const sessionRow = {
			display: "flex",
			alignItems: "baseline",
			justifyContent: "space-between",
			gap: 8,
			fontSize: 11,
			lineHeight: "16px",
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap"
		};

		const sessionLabel = {
			color: "var(--dsw-alias-label-secondary)",
			flex: "none"
		};

		const sessionValue = {
			color: "var(--dsw-alias-label-primary)",
			textAlign: "right",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};

		const hitLabel = {
			color: "var(--dsw-alias-label-secondary)",
			flex: "none"
		};

		const hitValue = {
			flex: "none",
			fontWeight: 600,
			textAlign: "right"
		};

		const costRow = {
			display: "flex",
			alignItems: "baseline",
			justifyContent: "space-between",
			gap: 8,
			fontSize: 11,
			lineHeight: "16px",
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap"
		};

		const costLabel = {
			color: "var(--dsw-alias-label-secondary)",
			flex: "none"
		};

		const costValue = {
			color: "var(--dsw-alias-label-primary)",
			fontWeight: 600,
			textAlign: "right"
		};

		const metaRow = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 11,
			lineHeight: "16px",
			whiteSpace: "nowrap",
			overflow: "hidden"
		};

		const metaItem = {
			display: "flex",
			alignItems: "center",
			gap: 4,
			fontVariantNumeric: "tabular-nums",
			minWidth: 0,
			overflow: "hidden",
			textOverflow: "ellipsis"
		};

		const updatedRow = {
			color: "var(--dsw-alias-label-caption)",
			fontSize: 10,
			lineHeight: "14px",
			display: "flex",
			alignItems: "center",
			gap: 4,
			fontVariantNumeric: "tabular-nums"
		};

		const errorText = {
			color: "var(--dsw-alias-state-error-primary)",
			fontSize: 11,
			lineHeight: "16px",
			wordBreak: "break-all"
		};

		const loadingText = {
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			lineHeight: "18px"
		};

		const divider = {
			height: 1,
			background: "var(--dsw-alias-border-l1)",
			margin: "2px 0"
		};

		const infoIcon = {
			flex: "none",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 14,
			height: 14,
			borderRadius: "50%",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "help",
			verticalAlign: "middle"
		};

		const tipBox = {
			position: "absolute",
			bottom: "calc(100% + 8px)",
			right: 0,
			zIndex: 40,
			boxSizing: "border-box",
			width: 300,
			borderRadius: 10,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-overlay)",
			boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)",
			padding: "8px 10px",
			fontSize: 11,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-primary)",
			display: "flex",
			flexDirection: "column",
			gap: 2
		};

		const tipTitle = {
			fontWeight: 600,
			fontSize: 12,
			lineHeight: "18px",
			marginBottom: 2,
			fontVariantNumeric: "tabular-nums"
		};

		const tipRow = {
			display: "flex",
			alignItems: "baseline",
			justifyContent: "space-between",
			gap: 8,
			fontVariantNumeric: "tabular-nums"
		};

		const tipLabel = {
			color: "var(--dsw-alias-label-secondary)",
			flex: "none",
			whiteSpace: "nowrap"
		};

		const tipFormula = {
			color: "var(--dsw-alias-label-primary)",
			textAlign: "right",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};

		const tipFooter = {
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 10,
			lineHeight: "16px",
			marginTop: 2,
			borderTop: "1px solid var(--dsw-alias-border-l1)",
			paddingTop: 4,
			fontVariantNumeric: "tabular-nums"
		};

		// ---- the widget ---------------------------------------------------
		function BalanceShowCard(props) {
			const useSessions = props.useSessions;
			const [snapshot, setSnapshot] = useState(null);
			const [phase, setPhase] = useState("loading"); // loading | ready | error
			const [message, setMessage] = useState("");
			const [updatedAt, setUpdatedAt] = useState(null);
			const [spinning, setSpinning] = useState(false);
			const [sessionStats, setSessionStats] = useState(null);
			const [updateInfo, setUpdateInfo] = useState(null);
			const [costTipOpen, setCostTipOpen] = useState(false);
			const [hitTipOpen, setHitTipOpen] = useState(false);
			const [peakTipOpen, setPeakTipOpen] = useState(false);
			const [collapsed, setCollapsed] = useState(false);
			const [dragging, setDragging] = useState(false);
			// 当前会话 id（标准 props：SessionListState.current）。
			const currentSessionId = typeof useSessions === "function" ? useSessions((s) => s.current) : void 0;
			// 位置按会话分区存储：不同对话区各自记住不同位置（localStorage key 带会话 id）。
			const posKey = "balance-show-pos:" + (currentSessionId || "default");
			const loadStoredPos = (key) => {
				try {
					const saved = localStorage.getItem(key);
					if (saved) {
						const parsed = JSON.parse(saved);
						if (
							parsed !== null && typeof parsed === "object" &&
							typeof parsed.right === "number" && Number.isFinite(parsed.right) &&
							typeof parsed.bottom === "number" && Number.isFinite(parsed.bottom) &&
							parsed.right >= 0 && parsed.bottom >= 0
						) {
							// 旧数据无 vw/vh：以当前窗口尺寸补全，比例从当前起算。
							if (typeof parsed.vw !== "number" || typeof parsed.vh !== "number") {
								return { right: parsed.right, bottom: parsed.bottom, vw: window.innerWidth, vh: window.innerHeight };
							}
							return parsed;
						}
						localStorage.removeItem(key);
					}
				} catch {}
				return null;
			};
			// 拖拽位置（右下角原点偏移）+ 当时容器尺寸（用于窗口 resize 按比例跟随），
			// 持久化到 localStorage（按当前会话分区）。校验合法性，脏数据回退默认。
			const [pos, setPos] = useState(() => loadStoredPos(posKey));
			const dragRef = useRef(null);
			const suppressClickRef = useRef(false);
			const mounted = useRef(true);

			// 切换会话时加载该会话自己的位置（不同对话区位置互相独立）。
			useEffect(() => {
				setPos(loadStoredPos(posKey));
			}, [posKey]);

			// ---- balance load ----
			const load = useCallback(async () => {
				setSpinning(true);
				try {
					const res = await fetch("/balance", { headers: { accept: "application/json" }, cache: "no-store" });
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const data = await res.json();
					if (!mounted.current) return;
					setSnapshot(data);
					setPhase("ready");
					setMessage("");
					setUpdatedAt(new Date());
				} catch (error) {
					if (!mounted.current) return;
					setPhase("error");
					setMessage(error instanceof Error ? error.message : String(error));
				} finally {
					if (mounted.current) setSpinning(false);
				}
			}, []);

			useEffect(() => {
				mounted.current = true;
				load();
				const timer = setInterval(load, BALANCE_POLL_MS);
				const onFocus = () => { load(); };
				window.addEventListener("focus", onFocus);
				return () => {
					mounted.current = false;
					clearInterval(timer);
					window.removeEventListener("focus", onFocus);
				};
			}, [load]);

			// ---- update check (startup + every 12 h) ----
			useEffect(() => {
				let cancelled = false;
				const check = async () => {
					try {
						const res = await fetch("/api/update-check", { cache: "no-store" });
						const body = await res.json();
						if (cancelled || body === null || typeof body !== "object" || body.ok !== true) return;
						setUpdateInfo(body);
					} catch {}
				};
				check();
				const timer = setInterval(check, 12 * 60 * 60 * 1000);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, []);

			// ---- run update (click npm version when an update exists) ----
			const runUpdate = useCallback(async () => {
				try {
					const res = await fetch("/api/update-run", { method: "POST", cache: "no-store" });
					const body = await res.json();
					// 更新后提示重启；成功后清掉 updateInfo 让下次检查重新对比。
					if (body && body.ok === true) {
						setUpdateInfo(null);
						window.alert("更新成功，请重启 dsh web 以加载新版本。");
					} else {
						window.alert((body && body.message) || "更新失败。");
					}
				} catch {
					window.alert("更新请求失败。");
				}
			}, []);

			// ---- drag to reposition (B) ----
			const onDragStart = useCallback((e) => {
				if (e.button !== 0 && e.pointerType === "mouse") return;
				// 定位父级：取卡片（data-balance-show）的 offsetParent，
				// 即 shell.overlay 的容器层。用其宽高做边界，确保卡片不超出；
				// 兜底用视口客户区。同时测量卡片自身尺寸用于左/上边界限制。
				let parentW = window.innerWidth;
				let parentH = window.innerHeight;
				let cardW = 280;
				let cardH = 200;
				const cardEl = e.currentTarget.closest("[data-balance-show]");
				const container = cardEl ? cardEl.offsetParent : null;
				if (container) {
					parentW = container.clientWidth || parentW;
					parentH = container.clientHeight || parentH;
				}
				if (cardEl) {
					cardW = cardEl.offsetWidth || cardW;
					cardH = cardEl.offsetHeight || cardH;
				}
				// 记录当前 right/bottom 样式值（相对容器右/下边缘）。
				const currentRight = pos?.right ?? 16;
				const currentBottom = pos?.bottom ?? 16;
				dragRef.current = {
					startX: e.clientX,
					startY: e.clientY,
					startRight: currentRight,
					startBottom: currentBottom,
					parentW,
					parentH,
					cardW,
					cardH,
					moved: false
				};
				const move = (ev) => {
					const d = dragRef.current;
					if (!d) return;
					const dx = ev.clientX - d.startX;
					const dy = ev.clientY - d.startY;
					if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
					d.moved = true;
					if (!d.draggingVisual) {
						d.draggingVisual = true;
						setDragging(true);
					}
					// right/bottom 相对容器右/下边缘：往右拖 dx>0 → right 减小。
					// 四边都不出容器：
					//  - 右/下边界：right/bottom ≥ 0（卡片右/下缘不越过容器右/下缘）
					//  - 左/上边界：right ≤ 容器宽 - 卡片宽（右缘不越过容器左缘），
					//               bottom ≤ 容器高 - 卡片高（下缘不越过容器上缘）
					const pw = d.parentW || window.innerWidth;
					const ph = d.parentH || window.innerHeight;
					const maxRight = Math.max(0, pw - d.cardW);
					const maxBottom = Math.max(0, ph - d.cardH);
					const newRight = Math.min(Math.max(0, d.startRight - dx), maxRight);
					const newBottom = Math.min(Math.max(0, d.startBottom - dy), maxBottom);
					d.lastPos = { right: newRight, bottom: newBottom };
					setPos(d.lastPos);
				};
				const up = () => {
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", up);
					setDragging(false);
					try {
						const last = dragRef.current?.lastPos;
						const d = dragRef.current;
						const pw = d?.parentW || window.innerWidth;
						const ph = d?.parentH || window.innerHeight;
						const base = last ?? pos;
						localStorage.setItem(posKey, JSON.stringify({ ...base, vw: pw, vh: ph }));
					} catch {}
					// 若发生过拖动，标记抑制紧随其后的 click。
					if (dragRef.current?.moved) {
						suppressClickRef.current = true;
						setTimeout(() => { suppressClickRef.current = false; }, 100);
					}
					dragRef.current = null;
				};
				window.addEventListener("pointermove", move);
				window.addEventListener("pointerup", up);
			}, [pos, posKey]);

			// ---- expand automatically when balance fetch fails (C) ----
			useEffect(() => {
				if (phase === "error") setCollapsed(false);
			}, [phase]);

			// ---- position safety: proportional follow, then clamp when clipped ----
			// 窗体/容器尺寸变化时按比例跟随，让卡片保持在新窗体中的相对位置
			// （如原在最左侧中间，缩放后仍是最左侧中间）；同时钳制在容器与视口内，
			// 防止被侧栏/面板遮挡或缩小后消失在视口外。
			useEffect(() => {
				const followResize = () => {
					if (pos === null) return;
					const cardEl = document.querySelector("[data-balance-show]");
					const container = cardEl ? cardEl.offsetParent : null;
					const pw = (container ? container.clientWidth : window.innerWidth) || window.innerWidth;
					const ph = (container ? container.clientHeight : window.innerHeight) || window.innerHeight;
					// 保持相对位置：按「最近边缘」的比例换算，而非简单等比放大偏移。
					// 靠左→保左距比例（最左侧放大后仍最左侧）；靠右→保右距比例；
					// 垂直居中→保持居中（最左侧中间放大后仍最左侧中间）；靠上/靠下同理。
					// 旧尺寸缺失（旧数据）时按当前尺寸起算（比例=1）。
					const cardW = cardEl ? cardEl.offsetWidth : 280;
					const cardH = cardEl ? cardEl.offsetHeight : 56;
					const oldW = typeof pos.vw === "number" && pos.vw > 0 ? pos.vw : pw;
					const oldH = typeof pos.vh === "number" && pos.vh > 0 ? pos.vh : ph;
					const leftOld = oldW - pos.right - cardW;
					const topOld = oldH - pos.bottom - cardH;
					const rightOld = pos.right;
					const bottomOld = pos.bottom;
					let newRight;
					let newBottom;
					// 水平：靠左保左比例，靠右保右比例。
					if (leftOld <= rightOld) {
						const f = oldW > 0 ? leftOld / oldW : 0;
						newRight = pw - f * pw - cardW;
					} else {
						const f = oldW > 0 ? rightOld / oldW : 0;
						newRight = f * pw;
					}
					// 垂直：仅当真正居中（误差 ≤4px）时保持居中，避免"磁吸带"；
					// 否则靠上保上比例、靠下保下比例。
					if (Math.abs(topOld - bottomOld) <= 4) {
						newBottom = Math.max(0, (ph - cardH) / 2);
					} else if (topOld <= bottomOld) {
						const f = oldH > 0 ? topOld / oldH : 0;
						newBottom = ph - f * ph - cardH;
					} else {
						const f = oldH > 0 ? bottomOld / oldH : 0;
						newBottom = f * ph;
					}
					// 钳制：卡片不超出容器四边，且不超出视口（防被侧栏/面板遮挡）。
					const winW = window.innerWidth;
					const winH = window.innerHeight;
					const maxRight = Math.min(Math.max(0, pw - cardW), Math.max(0, winW - cardW));
					const maxBottom = Math.min(Math.max(0, ph - cardH), Math.max(0, winH - cardH));
					newRight = Math.min(Math.max(0, newRight), maxRight);
					newBottom = Math.min(Math.max(0, newBottom), maxBottom);
					// 四舍五入避免亚像素抖动。
					newRight = Math.round(newRight);
					newBottom = Math.round(newBottom);
					if (newRight !== pos.right || newBottom !== pos.bottom) {
						const next = { right: newRight, bottom: newBottom, vw: pw, vh: ph };
						setPos(next);
						try {
							localStorage.setItem(posKey, JSON.stringify(next));
						} catch {}
					}
				};
				// 初始检查 + 窗口变化 + 容器尺寸变化（侧栏/面板开合）时检查。
				followResize();
				window.addEventListener("resize", followResize);
				let ro = null;
				const cardRoot = document.querySelector("[data-balance-show]");
				const container = cardRoot ? cardRoot.offsetParent : null;
				if (container && typeof ResizeObserver === "function") {
					ro = new ResizeObserver(followResize);
					ro.observe(container);
					if (cardRoot) ro.observe(cardRoot);
				}
				return () => {
					window.removeEventListener("resize", followResize);
					if (ro) ro.disconnect();
				};
			}, [pos, collapsed, posKey]);

			// ---- session usage/cost load (inline, not collapsed) ----
			useEffect(() => {
				if (currentSessionId === void 0) {
					setSessionStats(null);
					return;
				}
				// 切换会话时先清空旧数据，避免短暂显示上个会话的统计。
				setSessionStats(null);
				let cancelled = false;
				const loadStats = async () => {
					try {
						const res = await fetch(`/api/session-stats?sessionId=${encodeURIComponent(currentSessionId)}`, { cache: "no-store" });
						const body = await res.json();
						if (cancelled || body === null || typeof body !== "object" || body.ok !== true) return;
						setSessionStats(body);
					} catch {}
				};
				loadStats();
				const timer = setInterval(loadStats, SESSION_POLL_MS);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [currentSessionId]);

			const total = Number(snapshot?.total ?? 0);
			const color = amountColor(total);
			const currency = snapshot?.currency ?? "CNY";
			const available = snapshot?.isAvailable !== false;
			const staleNote = snapshot?.ok === false && snapshot?.stale === true;

			const stateColor =
				phase === "error"
					? "var(--dsw-alias-state-error-primary)"
					: available === false
						? "var(--dsw-alias-state-error-primary)"
						: "var(--dsw-alias-state-success-primary)";

			let chip = null;
			if (phase === "ready") {
				chip = jsx("span", {
					style: {
						...statusChip,
						color: stateColor,
						background: "var(--dsw-alias-interactive-bg-hover)"
					},
					children: available === false ? "不可用" : "可用"
				});
			} else if (phase === "error") {
				chip = jsx("span", {
					style: { ...statusChip, color: stateColor },
					children: "错误"
				});
			}

			const dot = jsx("span", {
				style: {
					flex: "none",
					width: 8,
					height: 8,
					borderRadius: "50%",
					background: phase === "loading" ? "var(--dsw-alias-label-secondary)" : stateColor
				},
				"aria-hidden": true
			});

			const refreshIcon = jsx("svg", {
				width: 13,
				height: 13,
				viewBox: "0 0 16 16",
				fill: "none",
				style: spinning ? { animation: "dsh-balance-spin 0.8s linear infinite" } : void 0,
				children: jsx("path", {
					d: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3",
					stroke: "currentColor",
					strokeWidth: 1.5,
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			});

			// 命中状态：只要发生过输入（input+cacheRead>0）就判定命中与否。
			const hasInput = Number(sessionStats?.inputTokens ?? 0) + Number(sessionStats?.cacheReadTokens ?? 0) > 0;
			const hit = hasInput && Number(sessionStats?.cacheReadTokens ?? 0) > 0;
			const hitRate = Number(sessionStats?.cacheHitRate ?? 0);
			const hitColor = hit
				? "var(--dsw-alias-state-success-primary)"
				: hasInput
					? "var(--dsw-alias-state-warn-primary)"
					: "var(--dsw-alias-label-caption)";

			// 小圆圈最小化（C）：只显示 ¥金额，单击展开。
			if (collapsed && phase !== "error") {
				const orbSize = 56;
				const orbStyle = {
					position: "absolute",
					right: pos?.right ?? 16,
					bottom: pos?.bottom ?? 16,
					zIndex: 30,
					boxSizing: "border-box",
					width: orbSize,
					height: orbSize,
					borderRadius: "50%",
					border: "2px solid var(--dsw-alias-border-l2)",
					background: "var(--dsw-alias-bg-overlay)",
					boxShadow: "0 4px 16px rgba(0, 0, 0, 0.16)",
					color,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					flexDirection: "column",
					gap: 0,
					cursor: dragging ? "grabbing" : "grab",
					pointerEvents: "auto",
					userSelect: "none",
					fontSize: orbFontSize(phase === "loading" ? "…" : formatAmount(total, currency)),
					lineHeight: 1,
					fontWeight: 700,
					fontVariantNumeric: "tabular-nums",
					textAlign: "center",
					padding: 2
				};
				return jsx("button", {
					type: "button",
					"data-balance-show": true,
					role: "status",
					"aria-live": "polite",
					style: orbStyle,
					onClick: () => {
						if (suppressClickRef.current) return;
						setCollapsed(false);
					},
					onPointerDown: onDragStart,
					children: phase === "loading" ? "…" : formatAmount(total, currency)
				});
			}

			return jsx("div", {
				role: "status",
				"aria-live": "polite",
				"data-balance-show": true,
				style: {
					...card,
					position: "absolute",
					right: pos?.right ?? 16,
					bottom: pos?.bottom ?? 16
				},
				children: jsxs(Fragment, {
					children: [
						jsxs("div", {
							style: { ...headerRow, position: "relative" },
							children: [
								// 拖动把手：绝对定位覆盖整个顶部区域（含卡片左/右 padding 与
								// 顶 padding，延伸到按钮下方），按钮容器 z-index 在其上层。
								jsx("div", {
									style: {
										position: "absolute",
										left: -12,
										right: -12,
										top: -10,
										bottom: -10,
										cursor: dragging ? "grabbing" : "grab",
										userSelect: "none",
										zIndex: 0
									},
									onPointerDown: onDragStart,
									children: null
								}),
								// 状态点 + 标题（视觉层，不拦截拖拽）。
								jsx("span", {
									style: { flex: "none", zIndex: 1, position: "relative", pointerEvents: "none", display: "inline-flex", alignItems: "center" },
									children: dot
								}),
								jsx("span", { style: { ...title, zIndex: 1, position: "relative", pointerEvents: "none" }, children: "DeepSeek 余额" }),
								// 两个按钮容器：z-index 高于把手层，按钮可正常点击。
								jsxs("div", {
									style: {
										display: "flex",
										alignItems: "center",
										gap: 2,
										flex: "none",
										marginRight: -8,
										paddingRight: 8,
										boxSizing: "border-box",
										position: "relative",
										zIndex: 2
									},
									children: [
										jsx("button", {
											type: "button",
											style: refreshButton,
											"aria-label": collapsed ? "展开卡片" : "收起卡片",
											title: collapsed ? "展开" : "收起",
											onClick: () => { setCollapsed((value) => !value); },
											children: jsx("svg", {
												width: 12,
												height: 12,
												viewBox: "0 0 16 16",
												fill: "none",
												children: jsx("path", {
													d: collapsed ? "M8 3l5 6H3l5-6z" : "M8 13L3 7h10l-5 6z",
													fill: "currentColor"
												})
											})
										}),
										jsx("button", {
											type: "button",
											style: refreshButton,
											"aria-label": "刷新余额",
											title: "刷新",
											disabled: spinning,
											onClick: () => { load(); },
											children: refreshIcon
										})
									]
								})
							]
						}),
						phase === "loading"
							? jsx("div", { style: loadingText, children: "加载中…" })
							: phase === "error"
								? jsxs("div", {
									style: {
										display: "flex",
										flexDirection: "column",
										gap: 8,
										alignItems: "stretch"
									},
									children: [
										jsx("div", {
											style: {
												...errorText,
												fontSize: 24,
												lineHeight: "30px",
												fontWeight: 700,
												fontVariantNumeric: "tabular-nums"
											},
											title: "余额获取失败，请检查网络或 API Key 配置",
											children: "余额获取失败"
										}),
										jsx("button", {
											type: "button",
											style: {
												...refreshButton,
												width: "100%",
												height: 26,
												border: "1px solid #ffffff",
												borderRadius: 6,
												background: "transparent",
												color: "#ffffff",
												fontSize: 12
											},
											onClick: () => { load(); },
											children: "重试"
										})
									]
								})
								: jsxs(Fragment, {
									children: [
										jsxs("div", {
											style: amountRow,
											children: [
												jsx("span", { style: { ...amountValue, color }, children: formatAmount(total, currency) }),
												chip
											]
										}),
										staleNote && jsx("div", { style: { color: "var(--dsw-alias-label-caption)", fontSize: 11 }, children: "（缓存数据）" }),
										!collapsed && currentSessionId !== void 0 && jsx("div", {
											style: divider
										}),
										// 当前对话 Tokens（小字，不折叠）
										!collapsed && currentSessionId !== void 0 && jsxs("div", {
											style: sessionRow,
											children: [
												jsx("span", { style: sessionLabel, children: "当前对话 Tokens" }),
												jsx("span", { style: sessionValue, children: sessionStats ? formatTokens(sessionStats.totalTokens) : "…" })
											]
										}),
										// 缓存命中状态 + 命中率（小字，不折叠）+ 含义问号
										!collapsed && currentSessionId !== void 0 && jsxs("div", {
											style: { ...sessionRow, alignItems: "center" },
											children: [
												jsx("span", { style: { ...hitLabel, display: "inline-flex", alignItems: "center", gap: 4 }, children: "缓存命中" }),
												jsx("span", {
													role: "button",
													tabIndex: 0,
													"aria-label": "查看缓存命中说明",
													title: "查看缓存命中说明",
													style: infoIcon,
													onMouseEnter: () => { setHitTipOpen(true); },
													onMouseLeave: () => { setHitTipOpen(false); },
													onFocus: () => { setHitTipOpen(true); },
													onBlur: () => { setHitTipOpen(false); },
													children: jsx("svg", {
														width: 13,
														height: 13,
														viewBox: "0 0 16 16",
														fill: "none",
														children: jsxs(Fragment, {
															children: [
																jsx("circle", { cx: 8, cy: 8, r: 6.5, stroke: "currentColor", strokeWidth: 1.3 }),
																jsx("path", { d: "M8 5v3.6", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
																jsx("circle", { cx: 8, cy: 11.2, r: 0.9, fill: "currentColor" })
															]
														})
													})
												}),
												jsx("span", {
													style: { ...hitValue, color: hitColor, marginLeft: "auto" },
													children: sessionStats
														? `${hit ? "命中" : hasInput ? "未命中" : "—"}${hasInput ? ` · ${hitRate}%` : ""}`
														: "…"
												})
											]
										}),
										// 缓存命中含义悬浮窗
										!collapsed && hitTipOpen && currentSessionId !== void 0 && jsx("div", {
											role: "tooltip",
											style: tipBox,
											children: jsxs(Fragment, {
												children: [
													jsx("div", { style: tipTitle, children: "缓存命中（Cache Hit）" }),
													jsx("div", {
														style: { color: "var(--dsw-alias-label-secondary)", fontSize: 11, lineHeight: "16px" },
														children: "指请求中可直接复用上一次上下文的输入 token 比例。命中率越高，越多的输入按缓存价计费（远低于未命中输入价），费用越低。命中率 = 缓存命中输入 ÷ (未命中输入 + 缓存命中输入)。"
													})
												]
											})
										}),
										// 费用行 + 问号（悬浮显示分桶计费明细）
										!collapsed && currentSessionId !== void 0 && jsxs("div", {
											style: { ...costRow, alignItems: "center", position: "relative" },
											children: [
												jsx("span", { style: costLabel, children: "当前对话费用" }),
												jsx("span", {
													role: "button",
													tabIndex: 0,
													"aria-label": "查看当前对话费用计费明细",
													title: "查看计费明细",
													style: infoIcon,
													onMouseEnter: () => { setCostTipOpen(true); },
													onMouseLeave: () => { setCostTipOpen(false); },
													onFocus: () => { setCostTipOpen(true); },
													onBlur: () => { setCostTipOpen(false); },
													children: jsx("svg", {
														width: 13,
														height: 13,
														viewBox: "0 0 16 16",
														fill: "none",
														children: jsxs(Fragment, {
															children: [
																jsx("circle", { cx: 8, cy: 8, r: 6.5, stroke: "currentColor", strokeWidth: 1.3 }),
																jsx("path", { d: "M8 5v3.6", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
																jsx("circle", { cx: 8, cy: 11.2, r: 0.9, fill: "currentColor" })
															]
														})
													})
												}),
												jsx("span", { style: { ...costValue, marginLeft: "auto" }, children: sessionStats ? formatCost(sessionStats.cost) : "…" })
											]
										}),
										// 费用计费明细悬浮窗（原卡片上的三条分桶明细移入此处）
										!collapsed && costTipOpen && currentSessionId !== void 0 && sessionStats !== null && Array.isArray(sessionStats.breakdown)
											? jsx("div", {
												role: "tooltip",
												style: tipBox,
												children: jsxs(Fragment, {
													children: [
														...sessionStats.breakdown.filter((b) => b !== null && typeof b === "object").map((b) => jsxs("div", {
															style: tipRow,
															children: [
																jsx("span", { style: tipLabel, children: b.label }),
																jsx("span", {
																	style: tipFormula,
																	children: `${formatTokens(b.tokens)} tok × ¥${b.rate.toLocaleString("zh-CN", { maximumFractionDigits: 3 })}/M = ${formatCost(b.subtotal)}`
																})
															]
														}, b.label)),
														jsx("div", {
															style: tipFooter,
															children: "合计 " + formatCost(sessionStats.cost) + " · 按消息时刻官方价格表计价（含峰谷）"
														})
													]
												})
											})
											: null,
										// 当前时段状态（高峰/低谷）单独一行 + 说明感叹号
										!collapsed && currentSessionId !== void 0 && jsxs("div", {
											style: { ...sessionRow, alignItems: "center", position: "relative" },
											children: [
												jsx("span", { style: { ...sessionLabel, display: "inline-flex", alignItems: "center", gap: 4 }, children: "当前时段" }),
												jsx("span", {
													role: "button",
													tabIndex: 0,
													"aria-label": "查看高峰时段说明",
													title: "查看高峰时段说明",
													style: infoIcon,
													onMouseEnter: () => { setPeakTipOpen(true); },
													onMouseLeave: () => { setPeakTipOpen(false); },
													onFocus: () => { setPeakTipOpen(true); },
													onBlur: () => { setPeakTipOpen(false); },
													children: jsx("svg", {
														width: 13,
														height: 13,
														viewBox: "0 0 16 16",
														fill: "none",
														children: jsxs(Fragment, {
															children: [
																jsx("circle", { cx: 8, cy: 8, r: 6.5, stroke: "currentColor", strokeWidth: 1.3 }),
																jsx("path", { d: "M8 4.6v4", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
																jsx("circle", { cx: 8, cy: 11, r: 0.9, fill: "currentColor" })
															]
														})
													})
												}),
												jsx("span", {
													style: {
														...hitValue,
														marginLeft: "auto",
														color: sessionStats?.peak === true
															? "var(--dsw-alias-state-warn-primary)"
															: sessionStats?.peak === false
																? "var(--dsw-alias-state-success-primary)"
																: "var(--dsw-alias-label-caption)"
													},
													children: sessionStats
														? sessionStats.peak === true ? "高峰" : sessionStats.peak === false ? "低谷" : "—"
														: "…"
												})
											]
										}),
										// 高峰时段说明悬浮窗
										!collapsed && peakTipOpen && currentSessionId !== void 0 && jsx("div", {
											role: "tooltip",
											style: tipBox,
											children: jsxs(Fragment, {
												children: [
													jsx("div", { style: tipTitle, children: "高峰时段" }),
													jsx("div", {
														style: { color: "var(--dsw-alias-label-secondary)", fontSize: 11, lineHeight: "16px" },
														children: "高峰时段为北京时间 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。高峰时段输入/输出单价更高，低谷（空闲）时段按较低价格计费。"
													})
												]
											})
										}),
										// DeepSeek 开放平台官网链接
										!collapsed && jsx("div", {
											style: { ...metaRow, marginTop: 2 },
											children: jsx("a", {
												href: "https://platform.deepseek.com/usage",
												target: "_blank",
												rel: "noreferrer",
												style: {
													color: "var(--dsw-alias-state-business-primary)",
													textDecoration: "none",
													fontWeight: 600,
													fontSize: 11,
													lineHeight: "16px",
													whiteSpace: "nowrap"
												},
												children: "Deepseek开放平台官网 ↗"
											})
										})
									]
								}),
						jsx("div", {
							style: { ...updatedRow, justifyContent: "space-between", gap: 8 },
							children: jsxs(Fragment, {
								children: [
									updatedAt
										? jsx("span", { children: `更新于 ${formatTime(updatedAt)}` })
										: null,
									// 版本信息：常驻显示当前版本 + npm 版本，灰色；
									// 有更新时橙色，且 npm 版本号可点击执行更新。
									updateInfo !== null && jsx("span", {
										style: {
											flex: "none",
											marginLeft: "auto",
											display: "inline-flex",
											alignItems: "center",
											gap: 4,
											color: updateInfo.hasUpdate === true
												? "var(--dsw-alias-state-warn-primary)"
												: "var(--dsw-alias-label-caption)"
										},
										children: jsxs(Fragment, {
											children: [
												jsx("span", { children: `本地版本 v${updateInfo.current}` }),
												jsx("span", { style: { opacity: 0.7 }, children: "线上版本" }),
												updateInfo.hasUpdate === true
													? jsx("button", {
														type: "button",
														title: "点击更新到 v" + updateInfo.latest,
														style: {
															border: 0,
															background: "transparent",
															padding: 0,
															margin: 0,
															cursor: "pointer",
															color: "inherit",
															fontSize: 10,
															fontWeight: 700,
															fontVariantNumeric: "tabular-nums",
															textDecoration: "underline"
														},
														onClick: () => { runUpdate(); },
														children: `v${updateInfo.latest}`
													})
													: jsx("span", { children: `v${updateInfo.latest}` })
											]
										})
									})
								]
							})
						})
					]
				})
			});
		}

		/** Services this plugin's ctx needs. */
		const inject = ["slots"];

		/**
		 * Client plugin body: declare the floating card once the frame-wide
		 * overlay slot exists (ui-layout owns the declaration).
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "balance",
				order: 100,
				label: "DeepSeek 余额"
			}, BalanceShowCard));
		}

		exports.BalanceShowCard = BalanceShowCard;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
