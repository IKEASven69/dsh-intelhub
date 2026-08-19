window.__ModuleLoader__.load({
	id: "dsh-agentforge-brain",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/brain3d.ts
		/** full-spectrum hue bands per kind (violet/amber/teal/magenta/blue family) */
		const KIND_HUE = {
			user: [255, 300],
			assistant: [155, 195],
			thought: [200, 250],
			tool: [30, 55]
		};
		function hsla(h, s, l, a) {
			return `hsla(${(h % 360 + 360) % 360} ${Math.round(s * 100)}% ${Math.round(l * 100)}% / ${a.toFixed(3)})`;
		}
		function hash01(s, salt) {
			let h = salt | 0;
			for (let i = 0; i < s.length; i++) h = h * 31 + s.charCodeAt(i) | 0;
			return (h >>> 0) % 1e4 / 1e4;
		}
		const DPR_CAP = 2;
		function ease(x) {
			const c = Math.max(0, Math.min(1, x));
			return c * c * (3 - 2 * c);
		}
		var Brain3D = class {
			canvas;
			ctx;
			opts;
			raf = 0;
			rotX = .3;
			rotY = -.5;
			vRotX = 0;
			vRotY = 0;
			tRotX = .3;
			tRotY = -.5;
			zoom = 1;
			tZoom = 1;
			dragging = false;
			lastX = 0;
			lastY = 0;
			lastMove = 0;
			hovered = -1;
			disposed = false;
			particles = [];
			particlesFor = "";
			ambient = [];
			constructor(canvas, opts) {
				this.canvas = canvas;
				this.ctx = canvas.getContext("2d");
				this.opts = opts;
				this.rebuildParticles();
				for (let i = 0; i < 52; i++) {
					const a = Math.random() * Math.PI * 2;
					const b = Math.acos(2 * Math.random() - 1);
					const r = 2.2 + Math.random() * 1.6;
					this.ambient.push({
						x: r * Math.sin(b) * Math.cos(a),
						y: r * Math.cos(b),
						z: r * Math.sin(b) * Math.sin(a),
						size: 2.5 + Math.random() * 4,
						hue: Math.random() * 360,
						alpha: .05 + Math.random() * .09,
						rot: Math.random() * Math.PI * 2,
						driftPhase: Math.random() * Math.PI * 2
					});
				}
				this.bind();
				this.loop();
			}
			update(opts) {
				const onHover = opts.onHover !== void 0 ? opts.onHover : this.opts.onHover;
				const onClick = opts.onClick !== void 0 ? opts.onClick : this.opts.onClick;
				const merged = {
					nodes: opts.nodes,
					edges: opts.edges
				};
				if (onHover !== void 0) merged.onHover = onHover;
				if (onClick !== void 0) merged.onClick = onClick;
				this.opts = merged;
				this.rebuildParticles();
			}
			/** each node fans out into drifting particles — thousands total */
			rebuildParticles() {
				const sig = this.opts.nodes.map((n) => n.id).join("|");
				if (sig === this.particlesFor) return;
				this.particlesFor = sig;
				const out = [];
				this.opts.nodes.forEach((n, idx) => {
					const [h0, h1] = KIND_HUE[n.kind] ?? KIND_HUE.assistant;
					const fan = n.kind === "user" ? 9 : n.kind === "thought" ? 4 : 6;
					for (let k = 0; k < fan; k++) {
						const rr = hash01(n.id, k * 7 + 1);
						const ra = hash01(n.id, k * 13 + 2) * Math.PI * 2;
						const rb = Math.acos(2 * hash01(n.id, k * 17 + 3) - 1);
						const spread = .02 + rr * .09;
						const sr = 1.7 + hash01(n.id, k * 61 + 12) * 1;
						out.push({
							nodeIdx: idx,
							ox: Math.sin(rb) * Math.cos(ra) * spread,
							oy: Math.cos(rb) * spread,
							oz: Math.sin(rb) * Math.sin(ra) * spread,
							sx: sr * Math.sin(rb) * Math.cos(ra),
							sy: sr * Math.cos(rb),
							sz: sr * Math.sin(rb) * Math.sin(ra),
							size: 3 + hash01(n.id, k * 23 + 4) * 6,
							hue: h0 + (h1 - h0) * hash01(n.id, k * 29 + 5),
							sat: .75 + hash01(n.id, k * 31 + 6) * .25,
							light: .55 + hash01(n.id, k * 37 + 7) * .25,
							rot: hash01(n.id, k * 41 + 8) * Math.PI * 2,
							rotSpeed: (hash01(n.id, k * 43 + 9) - .5) * .8,
							phase: hash01(n.id, k * 47 + 10) * Math.PI * 2,
							phase2: hash01(n.id, k * 53 + 11) * Math.PI * 2
						});
					}
				});
				this.particles = out;
			}
			dispose() {
				this.disposed = true;
				cancelAnimationFrame(this.raf);
				this.unbind();
			}
			bind() {
				this.canvas.addEventListener("pointerdown", this.onDown);
				this.canvas.addEventListener("pointermove", this.onMove);
				this.canvas.addEventListener("pointerup", this.onUp);
				this.canvas.addEventListener("pointerleave", this.onLeave);
				this.canvas.addEventListener("click", this.onClick);
				this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
			}
			unbind() {
				this.canvas.removeEventListener("pointerdown", this.onDown);
				this.canvas.removeEventListener("pointermove", this.onMove);
				this.canvas.removeEventListener("pointerup", this.onUp);
				this.canvas.removeEventListener("pointerleave", this.onLeave);
				this.canvas.removeEventListener("click", this.onClick);
				this.canvas.removeEventListener("wheel", this.onWheel);
			}
			onDown = (e) => {
				this.dragging = true;
				this.lastX = e.clientX;
				this.lastY = e.clientY;
				this.lastMove = performance.now();
				this.canvas.setPointerCapture(e.pointerId);
			};
			onMove = (e) => {
				if (this.dragging) {
					const now = performance.now();
					const dt = Math.max(1, now - this.lastMove);
					const dx = e.clientX - this.lastX;
					const dy = e.clientY - this.lastY;
					this.tRotY += dx * .008;
					this.tRotX = Math.max(-1.4, Math.min(1.4, this.tRotX + dy * .008));
					this.vRotY = dx / dt * .008;
					this.vRotX = dy / dt * .008;
					this.lastX = e.clientX;
					this.lastY = e.clientY;
					this.lastMove = now;
					return;
				}
				const rect = this.canvas.getBoundingClientRect();
				const hit = this.pick(e.clientX - rect.left, e.clientY - rect.top);
				if (hit !== this.hovered) {
					this.hovered = hit;
					const node = hit >= 0 ? this.opts.nodes[hit] ?? null : null;
					this.opts.onHover?.(node, e.clientX, e.clientY);
					this.canvas.style.cursor = node ? "pointer" : "grab";
				} else if (hit >= 0) this.opts.onHover?.(this.opts.nodes[hit] ?? null, e.clientX, e.clientY);
			};
			onUp = (e) => {
				this.dragging = false;
				this.canvas.releasePointerCapture(e.pointerId);
			};
			onLeave = () => {
				this.dragging = false;
				this.hovered = -1;
				this.opts.onHover?.(null, 0, 0);
			};
			onWheel = (e) => {
				e.preventDefault();
				this.tZoom = Math.max(.5, Math.min(2.4, this.tZoom * (e.deltaY > 0 ? .92 : 1.08)));
			};
			onClick = (e) => {
				const rect = this.canvas.getBoundingClientRect();
				const hit = this.pick(e.clientX - rect.left, e.clientY - rect.top);
				this.opts.onClick?.(hit >= 0 ? this.opts.nodes[hit] ?? null : null);
			};
			/** current morph factor, shared by loop and pick (0 scattered … 1 brain) */
			morphAt(t) {
				const CYCLE = 14;
				const ph = t % CYCLE / CYCLE;
				if (ph < 3 / CYCLE) return ease(ph / (3 / CYCLE));
				if (ph < 8 / CYCLE) return 1;
				if (ph < 11 / CYCLE) return 1 - ease((ph - 8 / CYCLE) / (3 / CYCLE));
				return 0;
			}
			/** screen → node hit test against ACTUAL particle positions (morph-aware) */
			pick(px, py) {
				const m = this.metrics();
				const t = performance.now() / 1e3;
				const morph = this.morphAt(t);
				const cosX = Math.cos(this.rotX), sinX = Math.sin(this.rotX);
				const cosY = Math.cos(this.rotY), sinY = Math.sin(this.rotY);
				const nodes = this.opts.nodes;
				let best = -1;
				let bestD = 400;
				for (const p of this.particles) {
					const n = nodes[p.nodeIdx];
					if (n === void 0) continue;
					const g = n.grow;
					const stag = Math.max(0, Math.min(1, morph * 1.35 - p.phase2 * .35));
					const bx = n.x + p.ox, by = n.y + p.oy, bz = n.z + p.oz;
					const ex = (p.sx + (bx - p.sx) * stag) * g;
					const ey = (p.sy + (by - p.sy) * stag) * g;
					const ez = (p.sz + (bz - p.sz) * stag) * g;
					const q = this.projectRaw(ex, ey, ez, cosX, sinX, cosY, sinY, m.scale);
					if (q === void 0) continue;
					const dx = q[0] + m.cx - px;
					const dy = q[1] + m.cy - py;
					const d = dx * dx + dy * dy;
					if (d < bestD) {
						bestD = d;
						best = p.nodeIdx;
					}
				}
				return best;
			}
			metrics() {
				const w = this.canvas.clientWidth || 1;
				const h = this.canvas.clientHeight || 1;
				return {
					cx: w / 2,
					cy: h / 2,
					scale: Math.min(w, h) * .36 * this.zoom
				};
			}
			projectRaw(ex, ey, ez, cosX, sinX, cosY, sinY, scale) {
				const x1 = ex * cosY + ez * sinY;
				const z1 = -ex * sinY + ez * cosY;
				const y2 = ey * cosX - z1 * sinX;
				const z2 = ey * sinX + z1 * cosX;
				const persp = 3.2 / (3.2 + z2);
				return [
					x1 * persp * scale,
					y2 * persp * scale,
					z2
				];
			}
			tri(px, py, r, rot, stroke, lw) {
				const ctx = this.ctx;
				ctx.strokeStyle = stroke;
				ctx.lineWidth = lw;
				ctx.beginPath();
				for (let k = 0; k < 3; k++) {
					const a = rot + k * Math.PI * 2 / 3;
					const vx = px + Math.cos(a) * r;
					const vy = py + Math.sin(a) * r;
					if (k === 0) ctx.moveTo(vx, vy);
					else ctx.lineTo(vx, vy);
				}
				ctx.closePath();
				ctx.stroke();
			}
			loop = () => {
				if (this.disposed) return;
				this.raf = requestAnimationFrame(this.loop);
				const t = performance.now() / 1e3;
				if (!this.dragging && (Math.abs(this.vRotX) > 1e-4 || Math.abs(this.vRotY) > 1e-4)) {
					this.tRotY += this.vRotY * 16;
					this.tRotX = Math.max(-1.4, Math.min(1.4, this.tRotX + this.vRotX * 16));
					this.vRotX *= .94;
					this.vRotY *= .94;
				}
				this.rotX += (this.tRotX - this.rotX) * .1;
				this.rotY += (this.tRotY - this.rotY) * .1;
				this.zoom += (this.tZoom - this.zoom) * .12;
				for (const n of this.opts.nodes) if (n.grow < 1) n.grow = Math.min(1, n.grow + .02);
				const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
				const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
				if (w === 0 || h === 0) return;
				if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
					this.canvas.width = Math.round(w * dpr);
					this.canvas.height = Math.round(h * dpr);
				}
				const ctx = this.ctx;
				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				ctx.clearRect(0, 0, w, h);
				const { cx, cy, scale } = this.metrics();
				const cosX = Math.cos(this.rotX), sinX = Math.sin(this.rotX);
				const cosY = Math.cos(this.rotY), sinY = Math.sin(this.rotY);
				for (const amb of this.ambient) {
					const drift = .12 * Math.sin(t * .22 + amb.driftPhase);
					const p = this.projectRaw(amb.x, amb.y + drift, amb.z, cosX, sinX, cosY, sinY, scale);
					if (p === void 0) continue;
					const alpha = amb.alpha * (.7 + .3 * Math.sin(t * .6 + amb.driftPhase * 3));
					this.tri(p[0] + cx, p[1] + cy, amb.size * (.8 + .2 * this.zoom), amb.rot + t * .05, hsla(amb.hue, .85, .62, alpha), 1);
				}
				const morph = this.morphAt(t);
				const nodes = this.opts.nodes;
				const proj = [];
				for (const p of this.particles) {
					const n = nodes[p.nodeIdx];
					if (n === void 0) continue;
					const g = n.grow;
					const stag = Math.max(0, Math.min(1, morph * 1.35 - p.phase2 * .35));
					const drift = .012 * Math.sin(t * .5 + p.phase);
					const bx = n.x + p.ox + drift;
					const by = n.y + p.oy + .012 * Math.sin(t * .42 + p.phase2);
					const bz = n.z + p.oz + .012 * Math.cos(t * .48 + p.phase);
					const wob = .18 * Math.sin(t * .3 + p.phase * 3);
					const sxp = p.sx + wob;
					const syp = p.sy + .14 * Math.cos(t * .26 + p.phase2 * 2);
					const szp = p.sz + wob * .7;
					const ex = (sxp + (bx - sxp) * stag) * g;
					const ey = (syp + (by - syp) * stag) * g;
					const ez = (szp + (bz - szp) * stag) * g;
					const q = this.projectRaw(ex, ey, ez, cosX, sinX, cosY, sinY, scale);
					if (q === void 0) continue;
					proj.push({
						px: q[0] + cx,
						py: q[1] + cy,
						z: q[2],
						p
					});
				}
				proj.sort((a, b) => b.z - a.z);
				const hoveredNode = this.hovered >= 0 ? nodes[this.hovered] : void 0;
				for (const q of proj) {
					const p = q.p;
					const n = nodes[p.nodeIdx];
					if (n === void 0) continue;
					const depth = 1 - Math.max(-1, Math.min(1, q.z)) * .26;
					const flick = .62 + .2 * Math.sin(t * 1.6 + p.phase * 5) + .14 * Math.sin(t * 5.3 + p.phase2 * 7);
					const alpha = Math.max(.18, Math.min(1, flick)) * depth * n.grow;
					const isHoverGroup = hoveredNode !== void 0 && n === hoveredNode;
					const r = p.size * (isHoverGroup ? 1.6 : 1) * (.7 + depth * .4) * this.zoom;
					this.tri(q.px, q.py, r, p.rot + t * p.rotSpeed, hsla(p.hue, p.sat, p.light, isHoverGroup ? Math.min(1, alpha + .25) : alpha), isHoverGroup ? 1.8 : 1.2);
				}
			};
		};
		//#endregion
		//#region \0dsh-css:D:\coding\deepseek-harness\packages\client\ui-agentforge-brain\src\client\brain-view.module.css.mjs
		const css = ".SNAY-a_root{background:#000;height:100%;position:relative;overflow:hidden}.SNAY-a_canvas{cursor:grab;touch-action:none;width:100%;height:100%;position:absolute;inset:0}.SNAY-a_canvas:active{cursor:grabbing}.SNAY-a_tooltip{z-index:10;border:1px solid var(--dsw-alias-border-secondary);background:var(--dsw-alias-background-secondary);max-width:260px;color:var(--dsw-alias-label-secondary);pointer-events:none;overflow-wrap:anywhere;border-radius:8px;padding:5px 9px;font-size:11px;line-height:1.45;position:fixed}.SNAY-a_inspect{border:1px solid var(--dsw-alias-border-secondary);background:var(--dsw-alias-background-secondary);border-radius:12px;flex-direction:column;width:min(560px,100% - 32px);max-height:46%;display:flex;position:absolute;bottom:44px;left:50%;overflow:hidden;transform:translate(-50%);box-shadow:0 18px 48px #00000073}.SNAY-a_inspectHeader{border-bottom:1px solid var(--dsw-alias-border-tertiary);justify-content:space-between;align-items:center;padding:8px 12px;display:flex}.SNAY-a_inspectKind{letter-spacing:.1em;border:1px solid;border-radius:999px;padding:2px 8px;font-size:10px}.SNAY-a_inspectKind[data-kind=user]{color:#a78bfa}.SNAY-a_inspectKind[data-kind=assistant]{color:#5eead4}.SNAY-a_inspectKind[data-kind=thought]{color:#818cf8}.SNAY-a_inspectKind[data-kind=tool]{color:#fbbf24}.SNAY-a_inspectClose{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;padding:2px 4px;font-size:12px}.SNAY-a_inspectClose:hover{color:var(--dsw-alias-label-primary)}.SNAY-a_inspectBody{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;padding:10px 12px;font-size:12px;line-height:1.6;overflow-y:auto}.SNAY-a_stats{letter-spacing:.06em;color:var(--dsw-alias-label-tertiary);pointer-events:none;font-size:10px;position:absolute;bottom:10px;right:12px}";
		const tagId = "@deepseek-ai/dsh-client-ui-agentforge-brain/brain-view.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-agentforge-brain";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var brain_view_module_css_default = {
			"tooltip": "SNAY-a_tooltip",
			"inspect": "SNAY-a_inspect",
			"stats": "SNAY-a_stats",
			"inspectBody": "SNAY-a_inspectBody",
			"inspectClose": "SNAY-a_inspectClose",
			"root": "SNAY-a_root",
			"inspectHeader": "SNAY-a_inspectHeader",
			"inspectKind": "SNAY-a_inspectKind",
			"canvas": "SNAY-a_canvas"
		};
		//#endregion
		//#region src/client/BrainView.tsx
		/**
		* 🧠 AgentForge Brain — interactive 3D memory constellation over the
		* conversation snapshot. Drag to rotate, wheel to zoom, hover for a quick
		* label, click a neuron to open the full-text inspect card.
		*/
		/** deterministic pseudo-random per cluster so layouts stay stable across renders */
		function seeded(seed) {
			let s = seed * 9301 + 49297;
			return () => {
				s = (s * 9301 + 49297) % 233280;
				return s / 233280;
			};
		}
		/**
		* Clustered brain layout: each conversation turn becomes one tight "neural
		* bundle" (fibonacci micro-cloud); bundle centers spiral over the sphere so
		* the whole reads as a multi-lobe constellation instead of a uniform ball.
		*/
		function clusterLayout(index, inCluster, clusterSize, clusterCount) {
			const right = index % 2 === 0;
			const golden = Math.PI * (3 - Math.sqrt(5));
			const u = clusterCount <= 2 ? .5 : Math.floor(index / 2) / Math.ceil(clusterCount / 2 - 1 || 1);
			const cy = 1 - u * 2;
			const cr = Math.sqrt(Math.max(0, 1 - cy * cy));
			const theta = golden * index + (right ? 0 : Math.PI * .5);
			const RY = .74, RZ = .98;
			const rand = seeded(index * 71 + 13);
			const radial = .45 + .55 * Math.pow(rand(), 1.35);
			const RX = .6 * (.78 + .42 * (.5 + .5 * Math.sin(theta)));
			const GAP = .16 + .05 * (1 - Math.abs(cy));
			const rf = radial * (1 + .13 * Math.sin(theta * 6.3 + cy * 7.2) * Math.cos(u * Math.PI * 3.4));
			const cx = (GAP + RX * Math.abs(Math.cos(theta)) * cr) * rf * (right ? 1 : -1);
			const cyy = cy * RY * rf;
			const cz = Math.sin(theta) * RZ * cr * rf * (right ? 1 : -1) * .92;
			const bundleR = .08 + Math.min(.16, Math.sqrt(clusterSize) * .045);
			if (inCluster <= 0) return {
				x: cx,
				y: cyy,
				z: cz
			};
			const gy = inCluster === 1 ? 0 : 1 - (inCluster - 1) / (clusterSize - 1 || 1) * 2;
			const gr = Math.sqrt(Math.max(0, 1 - gy * gy));
			const gtheta = golden * (inCluster - 1) + index * 2.399;
			const jitter = .55 + rand() * .9;
			return {
				x: cx + Math.cos(gtheta) * gr * bundleR * jitter * (right ? 1 : -1),
				y: cyy + gy * bundleR * jitter,
				z: cz + Math.sin(gtheta) * gr * bundleR * jitter
			};
		}
		function textOf(node) {
			const t = node.text;
			return typeof t === "string" ? t : "";
		}
		/** safe block text: streaming/partial blocks may miss fields at runtime */
		function blockText(b) {
			return typeof b.text === "string" ? b.text : "";
		}
		/**
		* Map conversation nodes to brain neurons: one neuron per user message and per
		* assistant block (text / reasoning / tool-call), chained by adjacency.
		* Decimates huge sessions to a cap so the canvas stays fluid.
		*/
		function mapConversation(nodesRaw) {
			const nodes = nodesRaw ?? [];
			const chunks = [];
			for (const cn of nodes) if (cn.kind === "user") chunks.push([{
				kind: "user",
				node: cn
			}]);
			else if (cn.kind === "assistant" && chunks.length > 0) (chunks[chunks.length - 1] ?? chunks[0]).push({
				kind: "assistant",
				node: cn
			});
			const out = [];
			const edges = [];
			let prev = -1;
			let blockSeq = 0;
			chunks.forEach((chunk, ci) => {
				let size = 0;
				for (const c of chunk) {
					if (c.kind !== "user" && c.node.kind !== "assistant") continue;
					const blocks = c.kind === "user" ? [] : c.node.blocks ?? [];
					size += c.kind === "user" ? 1 : blocks.filter((b) => {
						const k = b.kind;
						return k !== "other" && k !== "image";
					}).length;
				}
				if (size === 0) size = 1;
				let inCluster = 0;
				let chunkPrev = -1;
				for (const c of chunk) if (c.kind === "user") {
					const text = textOf(c.node);
					const p = clusterLayout(ci, inCluster++, size, chunks.length);
					out.push({
						id: `u${String(c.node.seq ?? out.length)}`,
						kind: "user",
						label: text.slice(0, 40) || "(user)",
						detail: text,
						...p,
						grow: 1
					});
					const idx = out.length - 1;
					if (chunkPrev >= 0) edges.push({
						a: chunkPrev,
						b: idx
					});
					else if (prev >= 0) edges.push({
						a: prev,
						b: idx
					});
					chunkPrev = idx;
					prev = idx;
				} else if (c.node.kind === "assistant") {
					const blocks = c.node.blocks ?? [];
					for (const block of blocks) {
						if (block.kind === "other" || block.kind === "image") continue;
						const p = clusterLayout(ci, inCluster++, size, chunks.length);
						if (block.kind === "tool-call") out.push({
							id: `a${String(c.node.seq ?? 0)}-${blockSeq++}`,
							kind: "tool",
							label: `🔧 ${block.name ?? "tool"}`,
							detail: `${block.name ?? "tool"}(${(block.argsRaw ?? "").slice(0, 400)})`,
							...p,
							grow: 1
						});
						else {
							const kind = block.kind === "reasoning" ? "thought" : "assistant";
							out.push({
								id: `a${String(c.node.seq ?? 0)}-${blockSeq++}`,
								kind,
								label: blockText(block).slice(0, 40),
								detail: blockText(block),
								...p,
								grow: 1
							});
						}
						const idx = out.length - 1;
						if (chunkPrev >= 0) edges.push({
							a: chunkPrev,
							b: idx
						});
						chunkPrev = idx;
						prev = idx;
					}
				}
			});
			const CAP = 600;
			if (out.length <= CAP) return {
				nodes: out,
				edges
			};
			const step = Math.ceil(out.length / CAP);
			const kept = out.filter((_, i) => i % step === 0);
			const index = new Map(kept.map((n, i) => [n.id, i]));
			return {
				nodes: kept,
				edges: edges.map((e) => {
					const a = index.get(out[e.a]?.id ?? "");
					const b = index.get(out[e.b]?.id ?? "");
					return a !== void 0 && b !== void 0 && a !== b ? {
						a,
						b
					} : void 0;
				}).filter((e) => e !== void 0)
			};
		}
		const KIND_LABEL = {
			user: "用户",
			assistant: "回复",
			thought: "思考",
			tool: "工具"
		};
		function BrainView(props) {
			try {
				return BrainViewInner(props);
			} catch (e) {
				console.error("[brain-debug] render crashed:", e.message, e.stack);
				return null;
			}
		}
		function BrainViewInner(props) {
			const { useSession } = props;
			const canvasRef = (0, react.useRef)(null);
			const brainRef = (0, react.useRef)(null);
			const [hover, setHover] = (0, react.useState)(null);
			const [selected, setSelected] = (0, react.useState)(null);
			const nodes = useSession((s) => s.nodes ?? []);
			const mapped = (0, react.useMemo)(() => mapConversation(nodes), [nodes]);
			(0, react.useEffect)(() => {
				const canvas = canvasRef.current;
				if (canvas === null) return;
				if (brainRef.current === null) brainRef.current = new Brain3D(canvas, {
					...mapped,
					onHover: (node, x, y) => {
						setHover(node ? {
							label: node.label,
							x,
							y
						} : null);
					},
					onClick: (node) => {
						setSelected(node);
					}
				});
				else brainRef.current.update(mapped);
			}, [mapped]);
			(0, react.useEffect)(() => () => {
				brainRef.current?.dispose();
				brainRef.current = null;
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: brain_view_module_css_default.root,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("canvas", {
						ref: canvasRef,
						className: brain_view_module_css_default.canvas
					}),
					hover !== null && selected === null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: brain_view_module_css_default.tooltip,
						style: {
							left: hover.x + 12,
							top: hover.y + 12
						},
						children: hover.label
					}),
					selected !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: brain_view_module_css_default.inspect,
						role: "dialog",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: brain_view_module_css_default.inspectHeader,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: brain_view_module_css_default.inspectKind,
								"data-kind": selected.kind,
								children: KIND_LABEL[selected.kind]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: brain_view_module_css_default.inspectClose,
								onClick: () => {
									setSelected(null);
								},
								children: "✕"
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: brain_view_module_css_default.inspectBody,
							children: selected.detail || selected.label
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: brain_view_module_css_default.stats,
						children: [mapped.nodes.length, " 神经元 · 拖拽旋转 · 滚轮缩放 · 点击查看"]
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		const inject = ["slots"];
		/**
		* Register the brain view tab. The registration rides the slot service's
		* declaration-aware inject wrapper, so it waits for the conversation view
		* ring and unregisters when the plugin fiber disposes.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "agentforge-brain",
				order: 15,
				label: "🧠 大脑"
			}, BrainView));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map