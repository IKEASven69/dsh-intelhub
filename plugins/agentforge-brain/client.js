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
			lastInteract = 0;
			hovered = -1;
			hoveredSat = -1;
			selectedId = null;
			selectedIdx = -1;
			filterKind = null;
			searchQuery = "";
			turnLimit = null;
			/** cross-turn lexical associations of the current selection (node indices) */
			assoc = [];
			assocFor = -2;
			/** host-provided cosine similarity matrix (embedding), null = lexical mode */
			semantic = null;
			nodeBorn = /* @__PURE__ */ new Map();
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
				const onOpenSession = opts.onOpenSession !== void 0 ? opts.onOpenSession : this.opts.onOpenSession;
				const prevFirst = this.opts.nodes[0]?.id;
				const merged = {
					nodes: opts.nodes,
					edges: opts.edges
				};
				const sats = opts.satellites ?? this.opts.satellites;
				if (sats !== void 0) merged.satellites = sats;
				if (onHover !== void 0) merged.onHover = onHover;
				if (onClick !== void 0) merged.onClick = onClick;
				if (onOpenSession !== void 0) merged.onOpenSession = onOpenSession;
				this.opts = merged;
				const nextFirst = merged.nodes[0]?.id;
				if (nextFirst !== void 0 && nextFirst !== prevFirst) this.born = performance.now();
				this.rebuildParticles();
				this.resolveSelected();
			}
			/** persistent selection: only this neuron stays bright, the rest dim */
			setSelected(id) {
				this.selectedId = id;
				this.resolveSelected();
			}
			/** kind filter: non-matching neurons fade to ghosts */
			setFilter(kind) {
				this.filterKind = kind;
			}
			/** content search: neurons whose text doesn't match fade to ghosts */
			setSearch(q) {
				this.searchQuery = q.trim().toLowerCase();
			}
			/** timeline replay: only turns < limit stay visible (null = all) */
			setTurnLimit(limit) {
				this.turnLimit = limit;
			}
			/** host embedding similarity matrix (index-aligned with nodes); null = lexical */
			setSemantic(matrix) {
				this.semantic = matrix;
				this.assocFor = -2;
			}
			resolveSelected() {
				this.selectedIdx = this.selectedId === null ? -1 : this.opts.nodes.findIndex((n) => n.id === this.selectedId);
			}
			/** each node = ONE identity triangle (the neuron) + a dim dust swarm that
			* never highlights — clicking always lights exactly one triangle */
			rebuildParticles() {
				const sig = this.opts.nodes.map((n) => n.id).join("|");
				if (sig === this.particlesFor) return;
				this.particlesFor = sig;
				const now = performance.now();
				const prevBorn = this.nodeBorn;
				this.nodeBorn = /* @__PURE__ */ new Map();
				for (const n of this.opts.nodes) this.nodeBorn.set(n.id, prevBorn.get(n.id) ?? now);
				const out = [];
				const push = (idx, id, main, k, spread, size, light) => {
					const ra = hash01(id, k * 13 + 2) * Math.PI * 2;
					const rb = Math.acos(2 * hash01(id, k * 17 + 3) - 1);
					const [h0, h1] = KIND_HUE[this.opts.nodes[idx]?.kind ?? "assistant"] ?? KIND_HUE.assistant;
					const sr = 1.7 + hash01(id, k * 61 + 12) * 1;
					out.push({
						nodeIdx: idx,
						main,
						ox: Math.sin(rb) * Math.cos(ra) * spread,
						oy: Math.cos(rb) * spread,
						oz: Math.sin(rb) * Math.sin(ra) * spread,
						sx: sr * Math.sin(rb) * Math.cos(ra),
						sy: sr * Math.cos(rb),
						sz: sr * Math.sin(rb) * Math.sin(ra),
						size,
						hue: h0 + (h1 - h0) * hash01(id, k * 29 + 5),
						sat: .75 + hash01(id, k * 31 + 6) * .25,
						light,
						rim: main,
						rot: hash01(id, k * 41 + 8) * Math.PI * 2,
						rotSpeed: (hash01(id, k * 43 + 9) - .5) * .8,
						phase: hash01(id, k * 47 + 10) * Math.PI * 2,
						phase2: hash01(id, k * 53 + 11) * Math.PI * 2
					});
				};
				this.opts.nodes.forEach((n, idx) => {
					const rimBoost = n.rim === true ? 1.3 : 1;
					push(idx, n.id + "#m", true, 0, .003 + hash01(n.id, 901) * .006, (4.2 + hash01(n.id, 902) * 2.4) * rimBoost, .66 + hash01(n.id, 903) * .16);
					const density = Math.min(1, 260 / Math.max(1, this.opts.nodes.length));
					const base = n.kind === "user" ? 7 : n.kind === "thought" ? 3 : 5;
					const fan = Math.max(1, Math.round(base * density));
					for (let k = 0; k < fan; k++) push(idx, `${n.id}#d${String(k)}`, false, k + 1, .02 + hash01(n.id, 801 + k) * .04, 1.2 + hash01(n.id, 802 + k) * 1.8, .3 + hash01(n.id, 803 + k) * .14);
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
				this.canvas.addEventListener("dblclick", this.onDblClick);
			}
			unbind() {
				this.canvas.removeEventListener("pointerdown", this.onDown);
				this.canvas.removeEventListener("pointermove", this.onMove);
				this.canvas.removeEventListener("pointerup", this.onUp);
				this.canvas.removeEventListener("pointerleave", this.onLeave);
				this.canvas.removeEventListener("click", this.onClick);
				this.canvas.removeEventListener("wheel", this.onWheel);
				this.canvas.removeEventListener("dblclick", this.onDblClick);
			}
			onDown = (e) => {
				this.dragging = true;
				this.lastX = e.clientX;
				this.lastY = e.clientY;
				this.lastMove = performance.now();
				this.lastInteract = performance.now();
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
				const sat = this.pickSat(e.clientX - rect.left, e.clientY - rect.top);
				if (sat >= 0) {
					this.hoveredSat = sat;
					this.hovered = -1;
					const s = this.opts.satellites?.[sat];
					this.opts.onHover?.(s === void 0 ? null : {
						id: s.id,
						kind: "assistant",
						label: `星系 · ${s.title}${s.sub !== void 0 ? ` · ${s.sub}` : ""}`,
						detail: s.title,
						x: s.x,
						y: s.y,
						z: s.z,
						grow: 1
					}, e.clientX, e.clientY);
					this.canvas.style.cursor = "pointer";
					return;
				}
				this.hoveredSat = -1;
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
				this.hoveredSat = -1;
				this.opts.onHover?.(null, 0, 0);
			};
			onWheel = (e) => {
				e.preventDefault();
				this.tZoom = Math.max(.5, Math.min(2.4, this.tZoom * (e.deltaY > 0 ? .92 : 1.08)));
				this.lastInteract = performance.now();
			};
			/** double-click resets the view */
			onDblClick = () => {
				this.tRotX = .3;
				this.tRotY = -.5;
				this.tZoom = 1;
				this.vRotX = 0;
				this.vRotY = 0;
				this.lastInteract = performance.now();
			};
			clickTimer;
			onClick = (e) => {
				const rect = this.canvas.getBoundingClientRect();
				if (e.detail >= 2) {
					if (this.clickTimer !== void 0) {
						clearTimeout(this.clickTimer);
						this.clickTimer = void 0;
					}
					return;
				}
				const sat = this.pickSat(e.clientX - rect.left, e.clientY - rect.top);
				if (sat >= 0) {
					const s = this.opts.satellites?.[sat];
					if (s !== void 0) this.opts.onOpenSession?.(s.id);
					return;
				}
				const hit = this.pick(e.clientX - rect.left, e.clientY - rect.top);
				const node = hit >= 0 ? this.opts.nodes[hit] ?? null : null;
				if (this.clickTimer !== void 0) clearTimeout(this.clickTimer);
				this.clickTimer = setTimeout(() => {
					this.clickTimer = void 0;
					this.opts.onClick?.(node);
				}, 240);
			};
			/** screen → satellite hit test (bigger target, they sit far out) */
			pickSat(px, py) {
				const sats = this.opts.satellites;
				if (sats === void 0 || sats.length === 0) return -1;
				const m = this.metrics();
				const cosX = Math.cos(this.rotX), sinX = Math.sin(this.rotX);
				const cosY = Math.cos(this.rotY), sinY = Math.sin(this.rotY);
				let best = -1;
				let bestD = 484;
				for (let i = 0; i < sats.length; i++) {
					const s = sats[i];
					const q = this.projectRaw(s.x, s.y, s.z, cosX, sinX, cosY, sinY, m.scale);
					if (q === void 0) continue;
					const dx = q[0] + m.cx - px;
					const dy = q[1] + m.cy - py;
					const d = dx * dx + dy * dy;
					if (d < bestD) {
						bestD = d;
						best = i;
					}
				}
				return best;
			}
			/** assemble once on load (opening ritual), then stay a still brain.
			*  No perpetual flying cycle — motion only from user drag/zoom and the
			*  subtle per-particle breathing. */
			born = performance.now();
			morphAt(_t) {
				return ease((performance.now() - this.born) / 4e3);
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
				let bestD = 196;
				for (const p of this.particles) {
					if (!p.main) continue;
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
				if (!this.dragging && performance.now() - this.lastInteract > 6e3) this.tRotY += 9e-4;
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
				const selIdx = this.selectedIdx;
				const selNode = selIdx >= 0 ? nodes[selIdx] : void 0;
				const selTurn = selNode?.turn;
				if (selIdx >= 0 && this.assocFor !== selIdx) this.computeAssoc(selIdx);
				const assocSet = selIdx >= 0 ? new Set(this.assoc) : void 0;
				const rels = [];
				const now = performance.now();
				for (const q of proj) {
					const p = q.p;
					const n = nodes[p.nodeIdx];
					if (n === void 0) continue;
					const depth = 1 - Math.max(-1, Math.min(1, q.z)) * .26;
					const fog = p.main ? 1 : Math.pow(.72, Math.max(0, q.z));
					const flick = .62 + .2 * Math.sin(t * 1.6 + p.phase * 5) + .14 * Math.sin(t * 5.3 + p.phase2 * 7);
					const fresh = n.fresh ?? 1;
					let alpha = (p.main ? Math.max(flick, .55) * (.55 + .45 * fresh) : flick) * depth * fog * n.grow;
					let r = p.size * (.7 + depth * .4) * this.zoom * (p.main ? .85 + .3 * fresh : 1);
					let lw = p.main ? 1.4 : 1;
					const text = this.searchQuery === "" ? null : `${n.label}\n${n.detail ?? ""}`.toLowerCase();
					const pass = (this.filterKind === null || n.kind === this.filterKind) && (text === null || text.includes(this.searchQuery)) && (this.turnLimit === null || (n.turn ?? 0) < this.turnLimit);
					if (!pass) {
						alpha *= .08;
						r *= .7;
					}
					if (selNode !== void 0) if (p.main && p.nodeIdx === selIdx) {
						alpha = .85 + .15 * Math.sin(t * 3 + p.phase);
						r *= 2.2;
						lw = 2;
					} else if (selTurn !== void 0 && n.turn === selTurn && n !== selNode && pass) {
						alpha = Math.min(1, alpha * 1.8 + .18);
						r *= p.main ? 1.25 : 1;
						if (p.main) lw = 1.6;
					} else if (assocSet !== void 0 && assocSet.has(p.nodeIdx) && pass) {
						alpha = Math.min(1, alpha * 1.7 + .15);
						if (p.main) {
							r *= 1.3;
							lw = 1.6;
						}
					} else {
						alpha *= .34;
						r *= .82;
					}
					else if (p.main && hoveredNode !== void 0 && n === hoveredNode) {
						alpha = Math.min(1, alpha + .25);
						r *= 1.7;
						lw = 1.8;
					}
					this.tri(q.px, q.py, r, p.rot + t * p.rotSpeed, hsla(p.hue, p.sat, p.light, alpha), lw);
					if (p.main && pass) {
						this.glyph(q.px, q.py, n.kind, alpha);
						if (selNode !== void 0 && selTurn !== void 0 && n.turn === selTurn && n !== selNode) rels.push({
							x: q.px,
							y: q.py,
							hue: p.hue
						});
					}
				}
				if (selNode !== void 0) {
					const sq = this.projectRaw(selNode.x, selNode.y, selNode.z, cosX, sinX, cosY, sinY, scale);
					if (sq !== void 0) {
						const sx = sq[0] + cx;
						const sy = sq[1] + cy;
						this.ctx.lineWidth = 1;
						for (const rel of rels) {
							this.ctx.strokeStyle = hsla(rel.hue, .8, .72, .3);
							this.ctx.beginPath();
							this.ctx.moveTo(sx, sy);
							this.ctx.lineTo(rel.x, rel.y);
							this.ctx.stroke();
						}
						this.ctx.setLineDash([4, 5]);
						for (const ai of this.assoc) {
							const an = nodes[ai];
							if (an === void 0) continue;
							const aq = this.projectRaw(an.x, an.y, an.z, cosX, sinX, cosY, sinY, scale);
							if (aq === void 0) continue;
							const [h0, h1] = KIND_HUE[an.kind] ?? KIND_HUE.assistant;
							this.ctx.strokeStyle = hsla((h0 + h1) / 2, .5, .85, .38);
							this.ctx.beginPath();
							this.ctx.moveTo(sx, sy);
							this.ctx.lineTo(aq[0] + cx, aq[1] + cy);
							this.ctx.stroke();
						}
						this.ctx.setLineDash([]);
					}
				}
				for (const n of nodes) {
					if (n === void 0) continue;
					const bornAt = this.nodeBorn.get(n.id);
					if (bornAt === void 0) continue;
					const age = now - bornAt;
					if (age > 1400) {
						this.nodeBorn.delete(n.id);
						continue;
					}
					const pr = age / 1400;
					const q = this.projectRaw(n.x, n.y, n.z, cosX, sinX, cosY, sinY, scale);
					if (q === void 0) continue;
					const [h0, h1] = KIND_HUE[n.kind] ?? KIND_HUE.assistant;
					this.ctx.strokeStyle = hsla((h0 + h1) / 2, .85, .7, (1 - pr) * .5);
					this.ctx.lineWidth = 1.2;
					this.ctx.beginPath();
					this.ctx.arc(q[0] + cx, q[1] + cy, (6 + pr * 46) * this.zoom, 0, Math.PI * 2);
					this.ctx.stroke();
				}
				const sats = this.opts.satellites;
				if (sats !== void 0) {
					const dimAll = selNode !== void 0;
					for (let i = 0; i < sats.length; i++) {
						const s = sats[i];
						const wob = .05 * Math.sin(t * .22 + hash01(s.id, 3) * 6.28);
						const q = this.projectRaw(s.x + wob, s.y + wob * .4, s.z, cosX, sinX, cosY, sinY, scale);
						if (q === void 0) continue;
						const px = q[0] + cx;
						const py = q[1] + cy;
						const hue = hash01(s.id, 7) * 360;
						const hov = i === this.hoveredSat;
						const flick2 = .5 + .16 * Math.sin(t * .9 + hash01(s.id, 11) * 6.28);
						const alpha = (hov ? .95 : flick2) * (dimAll ? .3 : 1);
						const rr = (hov ? 13 : 9) * this.zoom;
						this.tri(px, py, rr, t * .12 + hash01(s.id, 13) * 6.28, hsla(hue, .8, .66, alpha), hov ? 1.8 : 1.2);
						this.tri(px + 14 + 3 * Math.sin(t * .5 + i), py + 6, 3.2 * this.zoom, t * .4, hsla(hue, .75, .6, alpha * .55), 1);
						this.tri(px - 12, py + 10 + 2 * Math.cos(t * .45 + i), 2.4 * this.zoom, -t * .35, hsla(hue, .75, .6, alpha * .45), 1);
						if (hov) {
							this.ctx.strokeStyle = hsla(hue, .85, .7, .5);
							this.ctx.lineWidth = 1;
							this.ctx.beginPath();
							this.ctx.arc(px, py, rr + 7 * this.zoom, 0, Math.PI * 2);
							this.ctx.stroke();
						}
					}
				}
			};
			/** associations for the selection: embedding cosine when the host bridge is
			*  up, lexical Jaccard otherwise — semantic-lite fallback */
			computeAssoc(selIdx) {
				const nodes = this.opts.nodes;
				const sel = nodes[selIdx];
				this.assoc = [];
				this.assocFor = selIdx;
				if (sel === void 0) return;
				const scored = [];
				const sem = this.semantic;
				if (sem !== null && sem.length === nodes.length && sem[selIdx] !== void 0) for (let i = 0; i < nodes.length; i++) {
					const n = nodes[i];
					if (n === void 0 || i === selIdx || n.turn === sel.turn) continue;
					const s = sem[selIdx]?.[i] ?? 0;
					if (s >= .35) scored.push({
						i,
						s
					});
				}
				else if (sel.tokens !== void 0 && sel.tokens.length > 0) {
					const a = new Set(sel.tokens);
					for (let i = 0; i < nodes.length; i++) {
						const n = nodes[i];
						if (n === void 0 || i === selIdx || n.turn === sel.turn || n.tokens === void 0 || n.tokens.length === 0) continue;
						let inter = 0;
						const b = new Set(n.tokens);
						for (const tk of a) if (b.has(tk)) inter++;
						const uni = a.size + b.size - inter;
						if (uni === 0) continue;
						const s = inter / uni;
						if (s >= .12) scored.push({
							i,
							s
						});
					}
				}
				scored.sort((x, y) => y.s - x.s);
				this.assoc = scored.slice(0, 3).map((x) => x.i);
			}
			/** tiny inner mark so kinds stay distinguishable beyond colour */
			glyph(px, py, kind, alpha) {
				if (kind === "assistant" || alpha < .25) return;
				const ctx = this.ctx;
				ctx.strokeStyle = ctx.fillStyle = `rgba(255,255,255,${Math.min(.8, alpha * .7).toFixed(3)})`;
				if (kind === "user") {
					ctx.beginPath();
					ctx.arc(px, py, 1.5, 0, Math.PI * 2);
					ctx.fill();
				} else if (kind === "tool") ctx.fillRect(px - 1.2, py - 1.2, 2.4, 2.4);
				else {
					ctx.beginPath();
					ctx.arc(px, py, 1.8, 0, Math.PI * 2);
					ctx.stroke();
				}
			}
		};
		//#endregion
		//#region \0dsh-css:D:\coding\deepseek-harness\packages\client\ui-agentforge-brain\src\client\brain-view.module.css.mjs
		const css = ".SNAY-a_root{background:#000;height:100%;position:relative;overflow:hidden}.SNAY-a_canvas{cursor:grab;touch-action:none;width:100%;height:100%;position:absolute;inset:0}.SNAY-a_canvas:active{cursor:grabbing}.SNAY-a_tooltip{z-index:10;backdrop-filter:blur(10px);color:#cdd6f2eb;letter-spacing:.04em;pointer-events:none;overflow-wrap:anywhere;background:#0a0d1ec7;border:1px solid #8ca0ff38;border-radius:4px;max-width:280px;padding:6px 10px;font-family:SF Mono,Cascadia Code,JetBrains Mono,Consolas,monospace;font-size:11px;line-height:1.5;position:fixed;box-shadow:0 6px 24px #00000080,0 0 16px #6e82ff14}.SNAY-a_inspect{backdrop-filter:blur(14px);background:#090c1cd1;border:1px solid #8ca0ff33;border-radius:6px;flex-direction:column;width:min(560px,100% - 32px);max-height:46%;display:flex;position:absolute;bottom:44px;left:50%;overflow:hidden;transform:translate(-50%);box-shadow:0 18px 48px #0009,0 0 28px #6478ff1a}.SNAY-a_inspectHeader{background:linear-gradient(#788cff0d,#0000);border-bottom:1px solid #8ca0ff24;justify-content:space-between;align-items:center;padding:8px 12px;display:flex}.SNAY-a_inspectKind{letter-spacing:.22em;text-shadow:0 0 8px;border:1px solid;border-radius:999px;padding:2px 9px;font-family:SF Mono,Cascadia Code,Consolas,monospace;font-size:10px}.SNAY-a_inspectKind[data-kind=user]{color:#b79cff}.SNAY-a_inspectKind[data-kind=assistant]{color:#5eead4}.SNAY-a_inspectKind[data-kind=thought]{color:#8ea2ff}.SNAY-a_inspectKind[data-kind=tool]{color:#ffd166}.SNAY-a_inspectId{letter-spacing:.08em;color:#96a2cd73;margin-left:auto;margin-right:8px;font-family:SF Mono,Cascadia Code,Consolas,monospace;font-size:9px}.SNAY-a_inspectClose{color:#a0acd299;cursor:pointer;background:0 0;border:0;padding:2px 4px;font-size:12px}.SNAY-a_inspectClose:hover{color:#ebf0fff2}.SNAY-a_inspectBody{color:#c8d0ebe0;white-space:pre-wrap;overflow-wrap:anywhere;padding:10px 12px;font-size:12px;line-height:1.65;overflow-y:auto}.SNAY-a_search{backdrop-filter:blur(10px);background:linear-gradient(#10142c66,#080a1894);border:1px solid #8ca0ff29;border-radius:4px;align-items:center;gap:6px;padding:5px 10px;transition:border-color .2s;display:flex;position:absolute;top:12px;left:50%;transform:translate(-50%);box-shadow:0 0 20px #5a6eff12}.SNAY-a_search:focus-within{border-color:#96afff66}.SNAY-a_searchInput{color:#d7def5eb;letter-spacing:.06em;background:0 0;border:0;outline:none;width:200px;font-family:SF Mono,Cascadia Code,JetBrains Mono,Consolas,monospace;font-size:11px}.SNAY-a_searchInput::placeholder{color:#8c9bc873}.SNAY-a_searchClear{color:#a0acd299;cursor:pointer;background:0 0;border:0;padding:1px 3px;font-size:10px}.SNAY-a_searchClear:hover{color:#ebf0fff2}.SNAY-a_timeline{backdrop-filter:blur(10px);background:linear-gradient(#10142c66,#080a1894);border:1px solid #8ca0ff29;border-radius:4px;align-items:center;gap:10px;padding:6px 12px;display:flex;position:absolute;bottom:12px;left:50%;transform:translate(-50%);box-shadow:0 0 20px #5a6eff12}.SNAY-a_playBtn{color:#bec8ebd9;cursor:pointer;background:#788cff14;border:1px solid #8ca0ff4d;border-radius:3px;padding:4px 7px;font-family:SF Mono,Cascadia Code,Consolas,monospace;font-size:9px;line-height:1}.SNAY-a_playBtn:hover{color:#f0f4ff;border-color:#a0b4ff80}.SNAY-a_range{-webkit-appearance:none;appearance:none;cursor:pointer;background:linear-gradient(90deg,#8ca0ff73,#8ca0ff1f);border-radius:2px;outline:none;width:180px;height:2px}.SNAY-a_range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;cursor:pointer;background:#9db4ff;border-radius:50%;width:10px;height:10px;box-shadow:0 0 8px #9db4ffcc}.SNAY-a_timelineLabel{letter-spacing:.1em;color:#b4bee1b3;white-space:nowrap;font-family:SF Mono,Cascadia Code,JetBrains Mono,Consolas,monospace;font-size:10px}.SNAY-a_legend{backdrop-filter:blur(10px);letter-spacing:.2em;color:#bec8ebbf;pointer-events:none;background:linear-gradient(#10142c66,#080a1894);border:1px solid #8ca0ff29;border-radius:4px;align-items:center;gap:13px;padding:7px 14px 7px 12px;font-family:SF Mono,Cascadia Code,JetBrains Mono,Consolas,monospace;font-size:10px;display:flex;position:absolute;bottom:12px;left:14px;box-shadow:0 0 20px #5a6eff12,inset 0 0 14px #6e82ff0a}.SNAY-a_legend:before,.SNAY-a_legend:after{content:\"\";border:0 solid #96aaff8c;width:7px;height:7px;position:absolute}.SNAY-a_legend:before{border-top-width:1px;border-left-width:1px;top:-1px;left:-1px}.SNAY-a_legend:after{border-bottom-width:1px;border-right-width:1px;bottom:-1px;right:-1px}.SNAY-a_legendTitle{color:#96a2cd8c;letter-spacing:.28em;border-right:1px solid #8ca0ff2e;margin-right:2px;padding-right:13px}.SNAY-a_legendItem{pointer-events:auto;cursor:pointer;padding:1px 0;transition:color .15s,text-shadow .15s}.SNAY-a_legendItem:hover{color:#e1e8fff2}.SNAY-a_legendItem[data-on=true]{color:#f0f4ff;text-shadow:0 0 10px #96aaff8c}.SNAY-a_legendItem:before{content:\"\";vertical-align:1px;filter:drop-shadow(0 0 3px);border-bottom:6px solid;border-left:3.5px solid #0000;border-right:3.5px solid #0000;width:0;height:0;margin-right:7px;animation:3.4s ease-in-out infinite SNAY-a_hud-twinkle;display:inline-block}.SNAY-a_legendItem[data-k=user]:before{color:#b79cff;animation-delay:0s}.SNAY-a_legendItem[data-k=assistant]:before{color:#5eead4;animation-delay:.9s}.SNAY-a_legendItem[data-k=thought]:before{color:#8ea2ff;animation-delay:1.7s}.SNAY-a_legendItem[data-k=tool]:before{color:#ffd166;animation-delay:2.6s}.SNAY-a_stats{backdrop-filter:blur(10px);letter-spacing:.14em;color:#b4bee1b3;pointer-events:none;background:linear-gradient(#10142c66,#080a1894);border:1px solid #8ca0ff29;border-radius:4px;align-items:center;padding:7px 13px;font-family:SF Mono,Cascadia Code,JetBrains Mono,Consolas,monospace;font-size:10px;display:flex;position:absolute;bottom:12px;right:14px;overflow:hidden;box-shadow:0 0 20px #5a6eff12}.SNAY-a_stats:after{content:\"\";background:linear-gradient(105deg,#0000 42%,#a0b4ff14 50%,#0000 58%);animation:7s linear infinite SNAY-a_hud-sweep;position:absolute;inset:0}.SNAY-a_beacon{background:#7dd3fc;border-radius:50%;width:5px;height:5px;margin-right:9px;animation:2.4s ease-in-out infinite SNAY-a_hud-beacon;box-shadow:0 0 6px #7dd3fc,0 0 14px #7dd3fc73}.SNAY-a_empty{letter-spacing:.42em;color:#96a2cd6b;pointer-events:none;justify-content:center;align-items:center;font-family:SF Mono,Cascadia Code,JetBrains Mono,Consolas,monospace;font-size:12px;animation:2.8s ease-in-out infinite SNAY-a_hud-beacon;display:flex;position:absolute;inset:0}@keyframes SNAY-a_hud-twinkle{0%,to{opacity:.5}50%{opacity:1}}@keyframes SNAY-a_hud-beacon{0%,to{opacity:.45}50%{opacity:1}}@keyframes SNAY-a_hud-sweep{0%{transform:translate(-100%)}to{transform:translate(100%)}}";
		const tagId = "@deepseek-ai/dsh-client-ui-agentforge-brain/brain-view.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-agentforge-brain";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var brain_view_module_css_default = {
			"searchClear": "SNAY-a_searchClear",
			"legend": "SNAY-a_legend",
			"inspect": "SNAY-a_inspect",
			"hud-beacon": "SNAY-a_hud-beacon",
			"inspectBody": "SNAY-a_inspectBody",
			"legendTitle": "SNAY-a_legendTitle",
			"canvas": "SNAY-a_canvas",
			"inspectId": "SNAY-a_inspectId",
			"hud-sweep": "SNAY-a_hud-sweep",
			"search": "SNAY-a_search",
			"searchInput": "SNAY-a_searchInput",
			"inspectClose": "SNAY-a_inspectClose",
			"tooltip": "SNAY-a_tooltip",
			"empty": "SNAY-a_empty",
			"root": "SNAY-a_root",
			"timeline": "SNAY-a_timeline",
			"hud-twinkle": "SNAY-a_hud-twinkle",
			"playBtn": "SNAY-a_playBtn",
			"range": "SNAY-a_range",
			"stats": "SNAY-a_stats",
			"timelineLabel": "SNAY-a_timelineLabel",
			"beacon": "SNAY-a_beacon",
			"legendItem": "SNAY-a_legendItem",
			"inspectKind": "SNAY-a_inspectKind",
			"inspectHeader": "SNAY-a_inspectHeader"
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
			const cy = 1 - (clusterCount <= 2 ? .5 : Math.floor(index / 2) / Math.ceil(clusterCount / 2 - 1 || 1)) * 2;
			const cr = Math.sqrt(Math.max(0, 1 - cy * cy));
			const theta = golden * index + (right ? 0 : Math.PI * .5);
			const rand = seeded(index * 71 + 13);
			const lobe = .2 * Math.pow(Math.max(0, Math.cos(theta)), 2) - .08 * Math.pow(Math.sin(theta), 2) + .045 * Math.sin(theta * 3 + 1.2);
			const radial = rand() < .74 ? .9 + rand() * .13 : .32 + rand() * .42;
			const rf = radial * (1 + lobe);
			const RX = .64 * rf, RY = .74 * rf, RZ = .96 * rf;
			let cx = (.15 + .07 * (1 - Math.abs(cy)) + RX * Math.abs(Math.cos(theta)) * cr) * (right ? 1 : -1);
			const FISSURE = .11 + .05 * (1 - Math.abs(cy));
			if (Math.abs(cx) < FISSURE) cx = (right ? 1 : -1) * FISSURE;
			const cyy = cy * RY;
			const cz = Math.sin(theta) * RZ * cr * (right ? 1 : -1);
			const rim = radial > .85;
			const bundleR = .075 + Math.min(.12, Math.sqrt(clusterSize) * .045);
			if (inCluster <= 0) return {
				x: cx,
				y: cyy,
				z: cz,
				rim
			};
			const gy = inCluster === 1 ? 0 : 1 - (inCluster - 1) / (clusterSize - 1 || 1) * 2;
			const gr = Math.sqrt(Math.max(0, 1 - gy * gy));
			const gtheta = golden * (inCluster - 1) + index * 2.399;
			const jitter = .55 + seeded(index * 71 + inCluster * 997 + 29)() * .9;
			return {
				x: cx + Math.cos(gtheta) * gr * bundleR * jitter * (right ? 1 : -1),
				y: cyy + gy * bundleR * jitter,
				z: cz + Math.sin(gtheta) * gr * bundleR * 1.7 * jitter,
				rim
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
		const STOP = new Set([
			"the",
			"and",
			"for",
			"with",
			"that",
			"this",
			"from",
			"not",
			"are",
			"was",
			"you",
			"your",
			"have",
			"has",
			"will",
			"can",
			"into",
			"但是",
			"然后",
			"以及",
			"因为",
			"所以",
			"一个",
			"我们",
			"可以",
			"没有"
		]);
		/** tokens for lexical association: latin words + CJK bigrams, stopwords dropped */
		function tokenize(s) {
			const out = [];
			const lower = s.toLowerCase();
			for (const w of lower.match(/[a-z][a-z0-9_-]{1,}/g) ?? []) if (!STOP.has(w)) out.push(w);
			for (const seg of lower.match(/[\u4e00-\u9fa5]{2,}/g) ?? []) for (let i = 0; i + 2 <= seg.length; i++) {
				const bg = seg.slice(i, i + 2);
				if (!STOP.has(bg)) out.push(bg);
			}
			return out;
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
						turn: ci,
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
							turn: ci,
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
								turn: ci,
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
			for (const n of out) n.tokens = tokenize(`${n.label} ${n.detail ?? ""}`);
			const MIN = .055;
			for (let iter = 0; iter < 10; iter++) {
				let moved = false;
				for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
					const a = out[i];
					const b = out[j];
					let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
					const d2 = dx * dx + dy * dy + dz * dz;
					if (d2 >= MIN * MIN) continue;
					const d = Math.sqrt(d2) || 1e-4;
					const push = (MIN - d) / 2;
					dx /= d;
					dy /= d;
					dz /= d;
					a.x -= dx * push;
					a.y -= dy * push;
					a.z -= dz * push;
					b.x += dx * push;
					b.y += dy * push;
					b.z += dz * push;
					moved = true;
				}
				if (!moved) break;
			}
			const CAP = 600;
			if (out.length > CAP) {
				const keep = /* @__PURE__ */ new Set();
				out.forEach((n, i) => {
					if (n.kind === "user" || n.kind === "tool") keep.add(i);
				});
				const others = [];
				out.forEach((_, i) => {
					if (!keep.has(i)) others.push(i);
				});
				const budget = Math.max(0, CAP - keep.size);
				const step = others.length > budget ? Math.ceil(others.length / budget) : 1;
				others.forEach((oi, j) => {
					if (j % step === 0) keep.add(oi);
				});
				const kept = out.filter((_, i) => keep.has(i));
				kept.forEach((n, i) => {
					n.fresh = kept.length > 1 ? i / (kept.length - 1) : 1;
				});
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
			out.forEach((n, i) => {
				n.fresh = out.length > 1 ? i / (out.length - 1) : 1;
			});
			return {
				nodes: out,
				edges
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
			const { useSession, useSessions, openSession } = props;
			const canvasRef = (0, react.useRef)(null);
			const brainRef = (0, react.useRef)(null);
			const [hover, setHover] = (0, react.useState)(null);
			const [selected, setSelected] = (0, react.useState)(null);
			const [filter, setFilter] = (0, react.useState)(null);
			const [query, setQuery] = (0, react.useState)("");
			const [turnLimit, setTurnLimit] = (0, react.useState)(null);
			const [playing, setPlaying] = (0, react.useState)(false);
			const nodes = useSession((s) => s.nodes ?? []);
			const sessionState = useSessions !== void 0 ? useSessions((s) => s) : {
				ids: [],
				byId: {},
				current: void 0
			};
			const mapped = (0, react.useMemo)(() => mapConversation(nodes), [nodes]);
			const counts = (0, react.useMemo)(() => {
				const c = {
					user: 0,
					assistant: 0,
					thought: 0,
					tool: 0
				};
				for (const n of mapped.nodes) c[n.kind] += 1;
				return c;
			}, [mapped]);
			const maxTurn = (0, react.useMemo)(() => {
				let m = 0;
				for (const n of mapped.nodes) m = Math.max(m, (n.turn ?? 0) + 1);
				return Math.max(1, m);
			}, [mapped]);
			const [galaxy, setGalaxy] = (0, react.useState)([]);
			(0, react.useEffect)(() => {
				let cancelled = false;
				fetch("/agentforge-brain/galaxy").then((r) => r.ok ? r.json() : Promise.reject(/* @__PURE__ */ new Error(`HTTP ${String(r.status)}`))).then((j) => {
					if (!cancelled && Array.isArray(j.items)) setGalaxy(j.items);
				}).catch(() => {});
				return () => {
					cancelled = true;
				};
			}, []);
			const satellites = (0, react.useMemo)(() => {
				const st = sessionState;
				const host = new Map(galaxy.map((g) => [g.id, g]));
				const list = [];
				for (const id of st.ids) {
					const s = st.byId[id];
					if (s === void 0 || id === st.current || s.blank === true) continue;
					const hg = host.get(String(id));
					list.push({
						id: String(id),
						title: s.displayTitle || s.title || hg?.firstUser.slice(0, 30) || "未命名会话",
						date: s.updatedAt !== void 0 ? new Date(s.updatedAt).toLocaleDateString() : ""
					});
				}
				return list.slice(0, 40).map((entry, i, arr) => {
					const h = hashId(entry.id);
					const a = i / arr.length * Math.PI * 2 + h(1) * .6;
					const r = 1.68 + h(3) * .22;
					const sat = {
						id: entry.id,
						title: entry.title,
						x: r * Math.cos(a),
						y: (h(2) - .5) * .55,
						z: r * Math.sin(a)
					};
					const hg = host.get(entry.id);
					if (hg !== void 0) sat.sub = `${String(hg.turns)} 轮 · ${String(hg.users)} 条${entry.date !== "" ? ` · ${entry.date}` : ""}`;
					else if (entry.date !== "") sat.sub = entry.date;
					return sat;
				});
			}, [sessionState, galaxy]);
			(0, react.useEffect)(() => {
				const canvas = canvasRef.current;
				if (canvas === null) return;
				if (brainRef.current === null) brainRef.current = new Brain3D(canvas, {
					...mapped,
					satellites,
					onHover: (node, x, y) => {
						if (node === null) {
							setHover(null);
							return;
						}
						setHover({
							label: `[${KIND_LABEL[node.kind]}] ${node.label}`,
							x: Math.min(x + 12, window.innerWidth - 290),
							y: Math.min(y + 12, window.innerHeight - 70)
						});
					},
					onClick: (node) => {
						setSelected(node);
					},
					onOpenSession: (id) => {
						openSession?.(id);
					}
				});
				else brainRef.current.update({
					nodes: mapped.nodes,
					edges: mapped.edges,
					satellites
				});
			}, [mapped, satellites]);
			(0, react.useEffect)(() => {
				const brain = brainRef.current;
				if (brain === null) return;
				if (selected !== null && !mapped.nodes.some((n) => n.id === selected.id)) {
					setSelected(null);
					return;
				}
				brain.setSelected(selected?.id ?? null);
			}, [selected, mapped]);
			(0, react.useEffect)(() => {
				brainRef.current?.setFilter(filter);
			}, [filter, mapped]);
			(0, react.useEffect)(() => {
				brainRef.current?.setSearch(query);
			}, [query, mapped]);
			(0, react.useEffect)(() => {
				brainRef.current?.setTurnLimit(turnLimit);
			}, [turnLimit, mapped]);
			const semFailed = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (semFailed.current || mapped.nodes.length < 2) return;
				const texts = mapped.nodes.slice(0, 200).map((n) => `${n.label}\n${(n.detail ?? "").slice(0, 220)}`);
				fetch("/agentforge-brain/embed-sim", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ texts })
				}).then((r) => {
					if (!r.ok) throw new Error(`HTTP ${String(r.status)}`);
					return r.json();
				}).then((j) => {
					if (Array.isArray(j.matrix) && j.matrix.length === texts.length) brainRef.current?.setSemantic(j.matrix);
				}).catch(() => {
					semFailed.current = true;
				});
			}, [mapped]);
			(0, react.useEffect)(() => {
				if (!playing) return;
				const timer = window.setInterval(() => {
					setTurnLimit((cur) => {
						const next = (cur ?? 0) + 1;
						if (next >= maxTurn) {
							setPlaying(false);
							return cur;
						}
						return next;
					});
				}, 700);
				return () => {
					window.clearInterval(timer);
				};
			}, [playing, maxTurn]);
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
					mapped.nodes.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: brain_view_module_css_default.empty,
						children: "等待第一段记忆 …"
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
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: brain_view_module_css_default.inspectKind,
									"data-kind": selected.kind,
									children: KIND_LABEL[selected.kind]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: brain_view_module_css_default.inspectId,
									children: ["#", selected.id]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: brain_view_module_css_default.inspectClose,
									ref: (el) => {
										if (el !== null) el.onclick = () => {
											setSelected(null);
										};
									},
									children: "✕"
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: brain_view_module_css_default.inspectBody,
							children: selected.detail || selected.label
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: brain_view_module_css_default.search,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: brain_view_module_css_default.searchInput,
							type: "text",
							value: query,
							placeholder: "搜索记忆…",
							onChange: (e) => {
								setQuery(e.target.value);
							}
						}), query !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: brain_view_module_css_default.searchClear,
							ref: (el) => {
								if (el !== null) el.onclick = () => {
									setQuery("");
								};
							},
							children: "✕"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: brain_view_module_css_default.timeline,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: brain_view_module_css_default.playBtn,
								ref: (el) => {
									if (el !== null) el.onclick = () => {
										if (playing) {
											setPlaying(false);
											return;
										}
										setTurnLimit(turnLimit === null ? 1 : turnLimit);
										setPlaying(true);
									};
								},
								children: playing ? "❚❚" : "▶"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: brain_view_module_css_default.range,
								type: "range",
								min: 1,
								max: maxTurn,
								value: turnLimit ?? maxTurn,
								onChange: (e) => {
									setPlaying(false);
									const v = Number(e.target.value);
									setTurnLimit(v >= maxTurn ? null : v);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: brain_view_module_css_default.timelineLabel,
								children: turnLimit === null ? `共 ${maxTurn} 轮` : `回放 ${turnLimit}/${maxTurn} 轮`
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: brain_view_module_css_default.legend,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: brain_view_module_css_default.legendTitle,
							children: "记忆星图"
						}), Object.keys(KIND_LABEL).map((k) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: brain_view_module_css_default.legendItem,
							"data-k": k,
							"data-on": filter === k ? "true" : void 0,
							ref: (el) => {
								if (el !== null) el.onclick = () => {
									setFilter((f) => f === k ? null : k);
								};
							},
							children: KIND_LABEL[k]
						}, k))]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: brain_view_module_css_default.stats,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: brain_view_module_css_default.beacon }),
							mapped.nodes.length,
							" 神经元 · 用户 ",
							counts.user,
							" · 回复 ",
							counts.assistant,
							" · 思考 ",
							counts.thought,
							" · 工具 ",
							counts.tool,
							filter !== null ? ` · 仅看${KIND_LABEL[filter]}` : "",
							query.trim() !== "" ? ` · 搜索"${query.trim()}"` : "",
							satellites.length > 0 ? ` · ${satellites.length} 星系` : ""
						]
					})
				]
			});
		}
		/** deterministic hash → [0,1) generator for session orbit placement */
		function hashId(id) {
			let h = 2166136261;
			for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
			return (salt) => {
				let v = (h ^ Math.imul(salt, 2654435761)) >>> 0;
				v ^= v >>> 15;
				v = Math.imul(v, 2246822519);
				v ^= v >>> 13;
				return (v >>> 0) / 4294967296;
			};
		}
		//#endregion
		//#region src/client/index.ts
		const inject = ["slots", "sessions"];
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
			}, (props) => BrainView({
				...props,
				openSession: (id) => {
					ctx.sessions.open(id);
				}
			})));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map