/**
 * @javierni/balance-show — host half.
 *
 * A balance & usage card plugin built on the DeepSeek Harness for its Web GUI.
 * This plugin is NOT affiliated with the DeepSeek platform and is not a
 * "DeepSeek 余额卡片" — it is developed against the DeepSeek Harness and reads
 * the account balance of the DEEPSEEK_API_KEY configured in the harness.
 *
 * Two local JSON routes for the Web GUI's browser half:
 *
 *   GET /balance                  — DeepSeek account balance (progress colors,
 *                                   cached 3 min TTL).
 *   GET /api/session-stats?sessionId=<id> — live token usage + cost for one
 *                                   conversation, priced from the official
 *                                   DeepSeek rate table (lib/pricing.js).
 *
 * The API key is resolved through the harness `credentials` service on every
 * refresh and never leaves the process. Session usage is metered by
 * subscribing to `session/event` (assistant/message usage) and priced with
 * the official per-model rate policy at each message's timestamp.
 *
 * Mounted as a loader row named `@javierni/balance-show` (see the profile's
 * cordis.patch.yml). The browser half is the `./client` export of this same
 * package, picked up by dsh-client-modules and injected into
 * window.__DSH_BOOT__.
 */
import { Service } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { priceAt, costOf, isPeak } from "./pricing.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/** Route the browser half polls for the balance card. */
export const ROUTE_PATH = "/balance";
/** Session token/cost statistics route. */
export const SESSION_STATS_PATH = "/api/session-stats";
/** Update-check route: compares installed version with the npm registry. */
export const UPDATE_CHECK_PATH = "/api/update-check";
/** Update-run route (POST): actually runs pnpm update in the profile. */
export const UPDATE_RUN_PATH = "/api/update-run";
/** npm registry document for this package. */
export const NPM_REGISTRY_URL = "https://registry.npmjs.org/@javierni%2Fbalance-show";
/** The package spec pnpm updates. */
export const NPM_PACKAGE = "@javierni/balance-show";
/** DeepSeek official balance endpoint (https://api-docs.deepseek.com/api/get-user-balance/). */
export const BALANCE_URL = "https://api.deepseek.com/user/balance";
/** Serve cached balance instead of refetching within this window (3 min). */
export const TTL_MS = 3 * 60 * 1000;
/** Abort an upstream fetch after this long. */
export const FETCH_TIMEOUT_MS = 10_000;
/** The progress bar treats this amount as 100% (¥). */
export const BAR_MAX = 100;
/** The single credential key this plugin reads. */
export const CREDENTIAL_KEY = "DEEPSEEK_API_KEY";
/** Minimum interval between registry checks (12 h). */
export const UPDATE_CHECK_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Read this package's own version from its package.json (ESM-safe). */
function localVersion() {
	try {
		const require = createRequire(import.meta.url);
		const pkgPath = require.resolve("../package.json");
		const pkg = require(pkgPath);
		return typeof pkg.version === "string" ? pkg.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/**
 * Compare two dotted version strings numerically. Returns 1 when a > b,
 * -1 when a < b, 0 when equal.
 */
function compareVersions(a, b) {
	const pa = String(a).split(".").map((n) => Number(n) || 0);
	const pb = String(b).split(".").map((n) => Number(n) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da > db) return 1;
		if (da < db) return -1;
	}
	return 0;
}

/** Empty per-session usage/cost record. */
function emptyRecord() {
	return {
		calls: 0,
		cost: 0,
		inputTokens: 0,
		cacheReadTokens: 0,
		outputTokens: 0,
		updatedAt: 0,
		// Per-bucket cost accumulation, each split by peak/off-peak window so
		// the breakdown can show 高峰/低谷 pricing separately.
		buckets: {
			input: { peak: { tokens: 0, cost: 0 }, offPeak: { tokens: 0, cost: 0 } },
			cacheRead: { peak: { tokens: 0, cost: 0 }, offPeak: { tokens: 0, cost: 0 } },
			output: { peak: { tokens: 0, cost: 0 }, offPeak: { tokens: 0, cost: 0 } }
		}
	};
}

export default class BalanceShowHost extends Service {
	static inject = ["webServer", "credentials"];

	#snapshot = null;
	#lastFetch = 0;
	#inflight = null;

	/** Live per-session usage ledger (sessionId -> record). */
	#bySession = new Map();

	/** Replay cache: sessionId -> { revision, at, record }. */
	#replayCache = new Map();

	/** Update-check cache: { latest, checkedAt } to avoid hammering npm. */
	#updateCheck = null;

	/** Min interval between re-decoding the same session's log (avoids churn). */
	static #REPLAY_MIN_INTERVAL_MS = 2000;

	constructor(ctx) {
		super(ctx, "balanceShow");

		// Meter every assistant/message usage event into the session ledger,
		// priced at the official rate for that message's model and timestamp.
		ctx.on("session/event", (session, event) => {
			try {
				if (event?.type !== "assistant/message") return;
				const data = event.data;
				const usage = data?.usage;
				if (usage === void 0 || usage === null) return;
				if (typeof usage.outputTokens !== "number" && typeof usage.inputTokens !== "number") return;
				const source = data.message?.source;
				const model = typeof source?.model === "string" ? source.model : "unknown";
				const unit = priceAt(model, event.time ?? Date.now());
				const sample = costOf(usage, unit);
				let record = this.#bySession.get(session.id);
				if (record === void 0) {
					record = emptyRecord();
					this.#bySession.set(session.id, record);
				}
				record.calls += 1;
				record.cost += sample.cost;
				record.inputTokens += sample.inputTokens;
				record.cacheReadTokens += sample.cacheReadTokens;
				record.outputTokens += sample.outputTokens;
				record.updatedAt = event.time ?? Date.now();
				// Per-bucket × peak/off-peak: price each token group at its own
				// CNY rate, bucketed by whether the message landed in a peak window.
				const peak = isPeak(event.time ?? Date.now());
				const slot = peak ? "peak" : "offPeak";
				record.buckets.input[slot].tokens += sample.inputTokens;
				record.buckets.input[slot].cost += (sample.inputTokens * unit.cny.input) / 1e6;
				record.buckets.cacheRead[slot].tokens += sample.cacheReadTokens;
				record.buckets.cacheRead[slot].cost += (sample.cacheReadTokens * unit.cny.cacheRead) / 1e6;
				record.buckets.output[slot].tokens += sample.outputTokens;
				record.buckets.output[slot].cost += (sample.outputTokens * unit.cny.output) / 1e6;
			} catch (error) {
				ctx.logger?.warn("balance-show: failed to price an assistant/message event");
				ctx.logger?.warn(error);
			}
		});

		ctx.effect(() => ctx.webServer.register({
			kind: "prefix",
			path: ROUTE_PATH,
			handler: (req, res) => this.handle(req, res)
		}), "balance-show: route");

		ctx.effect(() => ctx.webServer.register({
			kind: "exact",
			path: SESSION_STATS_PATH,
			handler: (req, res) => this.handleSessionStats(req, res)
		}), "balance-show: session-stats route");

		ctx.effect(() => ctx.webServer.register({
			kind: "exact",
			path: UPDATE_CHECK_PATH,
			handler: (req, res) => this.handleUpdateCheck(req, res)
		}), "balance-show: update-check route");

		ctx.effect(() => ctx.webServer.register({
			kind: "exact",
			path: UPDATE_RUN_PATH,
			handler: (req, res) => this.handleUpdateRun(req, res)
		}), "balance-show: update-run route");
	}

	/**
	 * Price one assistant/message event into a record (shared by live and
	 * replay paths). Mirrors the ledger accumulation in the session/event
	 * listener.
	 * @param record - the record to fold into.
	 * @param event - a persisted or live assistant/message event.
	 */
	#priceEventInto(record, event) {
		const data = event.data;
		const usage = data?.usage;
		if (usage === void 0 || usage === null) return false;
		if (typeof usage.outputTokens !== "number" && typeof usage.inputTokens !== "number") return false;
		const source = data.message?.source;
		const model = typeof source?.model === "string" ? source.model : "unknown";
		const unit = priceAt(model, event.time ?? Date.now());
		const sample = costOf(usage, unit);
		record.calls += 1;
		record.cost += sample.cost;
		record.inputTokens += sample.inputTokens;
		record.cacheReadTokens += sample.cacheReadTokens;
		record.outputTokens += sample.outputTokens;
		record.updatedAt = Math.max(record.updatedAt, event.time ?? 0);
		// Per-bucket × peak/off-peak: price each token group at its own CNY
		// rate, bucketed by whether the message landed in a peak window.
		const peak = isPeak(event.time ?? Date.now());
		const slot = peak ? "peak" : "offPeak";
		record.buckets.input[slot].tokens += sample.inputTokens;
		record.buckets.input[slot].cost += (sample.inputTokens * unit.cny.input) / 1e6;
		record.buckets.cacheRead[slot].tokens += sample.cacheReadTokens;
		record.buckets.cacheRead[slot].cost += (sample.cacheReadTokens * unit.cny.cacheRead) / 1e6;
		record.buckets.output[slot].tokens += sample.outputTokens;
		record.buckets.output[slot].cost += (sample.outputTokens * unit.cny.output) / 1e6;
		return true;
	}

	/**
	 * Replay a session's persisted log and price EVERY assistant/message event,
	 * so the reported usage covers the WHOLE conversation (including messages
	 * that happened before this plugin loaded — the live in-memory ledger alone
	 * would undercount after a restart). Cached per session by the log's stat
	 * revision, with a short minimum re-decode interval.
	 * @param sessionId - session to replay.
	 * @returns the replay record, or `null` when the session has no stored log
	 * or the persistence seam is unavailable.
	 */
	async #replaySession(sessionId) {
		const persistence = this.ctx.get("sessionPersistence");
		if (persistence === void 0 || typeof persistence.readRaw !== "function" || typeof persistence.listSnapshots !== "function") {
			return null;
		}
		let revision;
		try {
			const snapshots = await persistence.listSnapshots();
			revision = snapshots.find((row) => row.header.id === sessionId)?.revision;
		} catch {
			revision = void 0;
		}
		if (revision === void 0) return null;
		const cached = this.#replayCache.get(sessionId);
		if (cached !== void 0) {
			if (cached.revision === revision) return cached.record;
			if (Date.now() - cached.at < BalanceShowHost.#REPLAY_MIN_INTERVAL_MS) return cached.record;
		}
		try {
			const raw = await persistence.readRaw(sessionId);
			if (raw === void 0 || raw === null || typeof raw.content !== "string") return null;
			const record = emptyRecord();
			for (const line of raw.content.split("\n")) {
				if (line === "") continue;
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				if (event === null || typeof event !== "object" || event.type !== "assistant/message") continue;
				try {
					this.#priceEventInto(record, event);
				} catch {
					// one malformed message must not fail the whole replay
				}
			}
			this.#replayCache.set(sessionId, { revision, at: Date.now(), record });
			return record;
		} catch (error) {
			this.ctx.logger?.warn("balance-show: failed to replay session log for costing");
			this.ctx.logger?.warn(error);
			return null;
		}
	}

	/**
	 * Query the DeepSeek balance API with the configured key and fold the
	 * response into a flat snapshot. Throws on transport or shape failure.
	 * @returns the fresh snapshot.
	 */
	async refresh() {
		const cred = await this.ctx.credentials.resolve(credentialRef(CREDENTIAL_KEY));
		if (cred?.value == null || cred.value === "") {
			throw new Error("DEEPSEEK_API_KEY is not configured in .credentials.yaml");
		}
		const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
			? AbortSignal.timeout(FETCH_TIMEOUT_MS)
			: void 0;
		const response = await fetch(BALANCE_URL, {
			headers: { authorization: `Bearer ${cred.value}` },
			...(signal ? { signal } : {})
		});
		if (!response.ok) throw new Error(`balance API responded ${response.status}`);
		const body = await response.json();
		if (typeof body !== "object" || body === null || !Array.isArray(body.balance_infos)) {
			throw new Error("unexpected balance payload shape");
		}
		const info = body.balance_infos[0] ?? {};
		const num = (value) => {
			const n = Number(value);
			return Number.isFinite(n) ? n : 0;
		};
		this.#snapshot = {
			ok: true,
			isAvailable: body.is_available === true,
			currency: typeof info.currency === "string" ? info.currency : "CNY",
			total: num(info.total_balance),
			granted: num(info.granted_balance),
			toppedUp: num(info.topped_up_balance),
			max: BAR_MAX,
			fetchedAt: Date.now()
		};
		this.#lastFetch = Date.now();
		return this.#snapshot;
	}

	/**
	 * Return a cached snapshot when fresh; otherwise fetch once (concurrent
	 * callers share the same in-flight request). Failures fall back to the last
	 * good snapshot with a `stale` marker, or to an `ok: false` payload.
	 * @returns the snapshot to serve.
	 */
	async getSnapshot() {
		if (this.#snapshot !== null && Date.now() - this.#lastFetch < TTL_MS) return this.#snapshot;
		if (this.#inflight !== null) return this.#inflight;
		this.#inflight = this.refresh()
			.catch((error) => this.#snapshot === null
				? {
						ok: false,
						error: String(error instanceof Error ? error.message : error),
						max: BAR_MAX
					}
				: { ...this.#snapshot, ok: false, stale: true, error: String(error instanceof Error ? error.message : error) })
			.finally(() => {
				this.#inflight = null;
			});
		return this.#inflight;
	}

	/** GET/HEAD handler: JSON body, no-store, CORS-open (same-origin anyway). */
	async handle(req, res) {
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405);
			res.end();
			return;
		}
		let payload;
		try {
			payload = await this.getSnapshot();
		} catch (error) {
			payload = {
				ok: false,
				error: String(error instanceof Error ? error.message : error),
				max: BAR_MAX
			};
		}
		const body = JSON.stringify(payload);
		res.writeHead(200, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			"access-control-allow-origin": "*"
		});
		res.end(req.method === "HEAD" ? void 0 : body);
	}

	/**
	 * Session usage/cost handler: REPLAYS the persisted log (covers the whole
	 * conversation, including pre-restart history) and merges the live ledger
	 * as a fallback for messages not yet flushed to disk. `cacheHitRate` =
	 * cacheRead / (input + cacheRead); cost is CNY. `peak` marks whether NOW is
	 * an official peak window (9–12, 14–18, Asia/Shanghai) — the pricing
	 * applied per message already honors the peak/off-peak rate table at each
	 * message's timestamp. `breakdown` lists per-bucket tokens, effective
	 * blended ¥/M rate, and subtotal. Returns an empty record (no error) when
	 * nothing has been metered yet.
	 */
	async handleSessionStats(req, res) {
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405);
			res.end();
			return;
		}
		const url = new URL(req.url ?? "/", "http://x");
		const sessionId = url.searchParams.get("sessionId") ?? "";
		let base = null;
		let source = "live";
		if (sessionId !== "") {
			const replay = await this.#replaySession(sessionId);
			if (replay !== null) {
				base = replay;
				source = "log";
			}
		}
		if (base === null) {
			base = sessionId !== "" ? (this.#bySession.get(sessionId) ?? null) : null;
			source = "live";
		}
		if (base === null) base = emptyRecord();
		const input = base.inputTokens;
		const cacheRead = base.cacheReadTokens;
		const hitInput = input + cacheRead;
		const cacheHitRate = hitInput > 0 ? Math.round((cacheRead / hitInput) * 1000) / 10 : 0;
		const totalTokens = base.inputTokens + base.cacheReadTokens + base.outputTokens;
		const roundCost = (value) => Math.round(value * 1e6) / 1e6;
		const breakdown = [
			{ label: "输入(未命中) · 高峰", key: "input", slot: "peak" },
			{ label: "输入(未命中) · 低谷", key: "input", slot: "offPeak" },
			{ label: "输入(命中) · 高峰", key: "cacheRead", slot: "peak" },
			{ label: "输入(命中) · 低谷", key: "cacheRead", slot: "offPeak" },
			{ label: "输出 · 高峰", key: "output", slot: "peak" },
			{ label: "输出 · 低谷", key: "output", slot: "offPeak" }
		].map(({ label, key, slot }) => {
			const bucket = base.buckets[key][slot];
			const tokens = bucket.tokens;
			const subtotal = roundCost(bucket.cost);
			const rate = tokens > 0 ? roundCost((subtotal / tokens) * 1e6) : 0;
			return { label, tokens, rate, subtotal };
		});
		const payload = {
			ok: true,
			sessionId,
			source,
			calls: base.calls,
			totalTokens,
			inputTokens: base.inputTokens,
			cacheReadTokens: base.cacheReadTokens,
			outputTokens: base.outputTokens,
			cacheHitRate,
			peak: isPeak(Date.now()),
			cost: roundCost(base.cost),
			breakdown,
			updatedAt: base.updatedAt
		};
		res.writeHead(200, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		});
		res.end(req.method === "HEAD" ? void 0 : JSON.stringify(payload));
	}

	/**
	 * Query the npm registry for this package's latest version and compare it
	 * with the locally installed version. Cached for an hour to avoid
	 * hammering npm. Failures degrade to `{ ok: false }` (the card then shows
	 * no update banner rather than an error).
	 * @returns the update-check snapshot.
	 */
	async #checkUpdate() {
		const current = localVersion();
		if (this.#updateCheck !== null && Date.now() - this.#updateCheck.checkedAt < UPDATE_CHECK_MIN_INTERVAL_MS) {
			return { ...this.#updateCheck, current };
		}
		try {
			const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
				? AbortSignal.timeout(FETCH_TIMEOUT_MS)
				: void 0;
			const response = await fetch(NPM_REGISTRY_URL, {
				headers: { accept: "application/json" },
				...(signal ? { signal } : {})
			});
			if (!response.ok) throw new Error(`registry responded ${response.status}`);
			const body = await response.json();
			const latest = typeof body?.["dist-tags"]?.latest === "string" ? body["dist-tags"].latest : current;
			this.#updateCheck = { latest, checkedAt: Date.now() };
			return { latest, current, checkedAt: this.#updateCheck.checkedAt };
		} catch {
			this.#updateCheck = { latest: current, checkedAt: Date.now() };
			return { latest: current, current, checkedAt: this.#updateCheck.checkedAt, error: true };
		}
	}

	/** GET/HEAD handler for the update check. */
	async handleUpdateCheck(req, res) {
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405);
			res.end();
			return;
		}
		let payload;
		try {
			payload = await this.#checkUpdate();
		} catch (error) {
			payload = { ok: false, error: String(error instanceof Error ? error.message : error) };
		}
		if (payload.ok === void 0) {
			const { latest, current, error } = payload;
			payload = {
				ok: true,
				current,
				latest,
				hasUpdate: compareVersions(latest, current) > 0,
				error: error === true
			};
		}
		res.writeHead(200, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		});
		res.end(req.method === "HEAD" ? void 0 : JSON.stringify(payload));
	}

	/**
	 * Read the pnpm store major version the profile's node_modules was linked
	 * from (`node_modules/.modules.yaml` -> `storeDir: .../store/v<N>`).
	 * Returns null when the file is missing/unreadable or the layout is not
	 * recognized; callers then skip the compatibility filter. A pnpm whose
	 * major version differs from the store's (e.g. bundled pnpm 10 reading a
	 * v11 store) aborts with ERR_PNPM_UNEXPECTED_STORE, which is exactly what
	 * made the in-card update button fail on DSH Desktop.
	 */
	async #detectStoreMajor(profileDir) {
		try {
			const text = await readFile(join(profileDir, "node_modules", ".modules.yaml"), "utf8");
			// .modules.yaml 实际为 JSON 风格（`"storeDir": "C:\\...\\store\\v11",`），
			// 路径以双反斜杠字面量写入（92,92），键与值都可能带引号；先取该键的
			// 值，再按分隔符切分取末段 `v<N>`（对单/双反斜杠与正斜杠均健壮）。
			const line = /["']?storeDir["']?\s*:\s*["']?([^"'\r\n]+)["']?/.exec(text);
			if (!line) return null;
			const parts = line[1].trim().split(/[\\/]+/);
			const version = /^v(\d+)$/i.exec(parts[parts.length - 1]);
			return version ? Number(version[1]) : null;
		} catch {
			return null;
		}
	}

	/**
	 * POST handler: run `pnpm update <package>` inside the web profile dir.
	 * Locates the profile via $DSH_HOME (default ~/.dsh) and resolves pnpm by
	 * probing several launchers in order: PATH pnpm, the local dsh-pnpm-bin
	 * shim, corepack pnpm, then npx --yes pnpm. Each candidate is probed with
	 * `--version` and is skipped when its major version does not match the
	 * store major the profile was linked with (see #detectStoreMajor), so the
	 * update never trips ERR_PNPM_UNEXPECTED_STORE. Returns the captured
	 * output; a nonzero exit is reported as ok:false with the tail of the log.
	 * After a successful update the harness needs a restart to load the new
	 * bundle — the caller is told.
	 */
	async handleUpdateRun(req, res) {
		if (req.method !== "POST") {
			res.writeHead(405);
			res.end();
			return;
		}
		const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
		const profileDir = join(dshHome, "profiles", "web");
		// 候选 pnpm 启动器（命令 + 参数 + 是否需 shell）：按优先级探测可用项。
		// local dsh-pnpm-bin 排在 corepack/npx 之前：DSH Desktop 会把捆绑的
		// pnpm 10.x 放进 PATH（.desktop-bin），而 dsh-pnpm-bin 是独立安装的
		// 11.x（实测 11.21.0），更可能与 profile 的 store v11 匹配。
		const candidates = [
			{ args: ["pnpm"], shell: process.platform === "win32", label: "PATH pnpm" },
			{ args: [join(process.env.LOCALAPPDATA || "", "dsh-pnpm-bin", "node_modules", ".bin", process.platform === "win32" ? "pnpm.cmd" : "pnpm")], shell: process.platform === "win32", label: "local dsh-pnpm-bin" },
			{ args: ["corepack", "pnpm"], shell: process.platform === "win32", label: "corepack pnpm" },
			{ args: ["npx", "--yes", "pnpm"], shell: process.platform === "win32", label: "npx pnpm" }
		];
		// profile 的 node_modules 由 pnpm store v<N> 链接；用错大版本会报
		// ERR_PNPM_UNEXPECTED_STORE（典型：DSH Desktop 捆绑 pnpm 10 读 v11
		// store，B-062/B-065 同源问题）。解析 store 主版本后跳过不匹配的
		// 启动器；解析失败（无法读取 .modules.yaml）则不过滤、保持原行为。
		const storeMajor = await this.#detectStoreMajor(profileDir);
		// 探测：跑 `--version` 并解析主版本；能返回且（store 已知时）大版本
		// 匹配才视为可用。
		let chosen = null;
		for (const cand of candidates) {
			if (cand.args.length === 1 && cand.args[0].includes("dsh-pnpm-bin") && !(process.env.LOCALAPPDATA)) continue;
			const probe = await new Promise((resolve) => {
				execFile(cand.args[0], ["--version"], {
					timeout: 8000,
					shell: cand.shell
				}, (error, stdout) => {
					if (error) return resolve(null);
					const m = /^v?(\d+)/.exec(String(stdout || "").trim());
					resolve(m ? Number(m[1]) : null);
				});
			});
			if (probe === null) continue;
			if (storeMajor !== null && probe !== storeMajor) continue;
			chosen = { ...cand, version: probe };
			break;
		}
		if (chosen === null) {
			const payload = {
				ok: false,
				message: storeMajor !== null
					? `No compatible pnpm found for store v${storeMajor} — install pnpm ${storeMajor}.x (or update via the dsh CLI)`
					: "pnpm not found — install pnpm (or enable corepack) to update plugins"
			};
			res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(JSON.stringify(payload));
			return;
		}
		// 执行更新：`<launcher> add <package>@latest`。
		// add @latest 强制解析 npm 最新版并重写依赖范围，避免旧范围（如 ^0.2.2）
		// 把更新限制在旧大版本内。注意：profile 的 pnpm-workspace.yaml 需把
		// @javierni/* 加入 minimumReleaseAgeExclude，否则 pnpm 会因 release-age
		// 门禁静默拒绝刚发布的新版本（README 已说明）。
		const result = await new Promise((resolve) => {
			execFile(chosen.args[0], [...chosen.args.slice(1), "add", `${NPM_PACKAGE}@latest`], {
				cwd: profileDir,
				timeout: 120_000,
				shell: chosen.shell
			}, (error, stdout, stderr) => {
				if (error) {
					resolve({
						ok: false,
						message: `${chosen.label} update failed (exit ${error.code ?? "?"})`,
						output: (stdout || "") + (stderr || "")
					});
					return;
				}
				resolve({ ok: true, launcher: chosen.label, output: (stdout || "") + (stderr || "") });
			});
		});
		if (result.ok) {
			// 更新成功：清掉缓存，下次检查重新对比。
			this.#updateCheck = null;
		}
		const payload = {
			...result,
			message: result.ok
				? "更新成功。请重启 dsh web 以加载新版本。"
				: result.message || "更新失败。"
		};
		res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify(payload));
	}
}
