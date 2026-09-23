import { A as e, C as t, D as n, E as r, F as i, I as a, L as o, M as s, N as c, O as l, P as u, S as d, T as f, _ as p, a as m, b as h, d as g, f as _, g as v, h as y, i as ee, j as te, k as ne, l as re, m as b, n as ie, o as ae, p as oe, r as se, s as ce, u as le, v as ue, w as x, x as S, y as C } from "./share.js";
//#region src/reader/zxing_reader.js
async function w(e = {}) {
	var t, n, r, i = e, a = !!globalThis.window, o = typeof Bun < "u", s = !!globalThis.WorkerGlobalScope;
	(n = globalThis.process) != null && (n = n.versions) != null && n.node && ((r = globalThis.process) == null || r.type);
	var c, l = "";
	function u(e) {
		return i.locateFile ? i.locateFile(e, l) : l + e;
	}
	var d, f;
	if (a || s || o) {
		try {
			l = new URL(".", c).href;
		} catch {}
		s && (f = (e) => {
			var t = new XMLHttpRequest();
			return t.open("GET", e, !1), t.responseType = "arraybuffer", t.send(null), new Uint8Array(t.response);
		}), d = async (e) => {
			var t = await fetch(e, { credentials: "same-origin" });
			if (t.ok) return t.arrayBuffer();
			throw Error(t.status + " : " + t.url);
		};
	}
	console.log.bind(console);
	var p = console.error.bind(console), m, h = !1, g, _, v = !1;
	function y() {
		var e = Fn.buffer;
		C = new Int8Array(e), x = new Int16Array(e), i.HEAPU8 = O = new Uint8Array(e), E = new Uint16Array(e), S = new Int32Array(e), D = new Uint32Array(e), w = new Float32Array(e), T = new Float64Array(e);
	}
	function ee() {
		if (i.preRun) for (typeof i.preRun == "function" && (i.preRun = [i.preRun]); i.preRun.length;) me(i.preRun.shift());
		k(pe);
	}
	function te() {
		v = !0, $.ra();
	}
	function ne() {
		if (i.postRun) for (typeof i.postRun == "function" && (i.postRun = [i.postRun]); i.postRun.length;) fe(i.postRun.shift());
		k(de);
	}
	function re(e) {
		var t, n;
		(t = i.onAbort) == null || t.call(i, e), e = "Aborted(" + e + ")", p(e), h = !0, e += ". Build with -sASSERTIONS for more info.";
		var r = new WebAssembly.RuntimeError(e);
		throw (n = _) == null || n(r), r;
	}
	var b;
	function ie() {
		return u("zxing_reader.wasm");
	}
	function ae(e) {
		if (e == b && m) return new Uint8Array(m);
		if (f) return f(e);
		throw "both async and sync fetching of the wasm failed";
	}
	async function oe(e) {
		if (!m) try {
			var t = await d(e);
			return new Uint8Array(t);
		} catch {}
		return ae(e);
	}
	async function se(e, t) {
		try {
			var n = await oe(e);
			return await WebAssembly.instantiate(n, t);
		} catch (e) {
			p(`failed to asynchronously prepare wasm: ${e}`), re(e);
		}
	}
	async function ce(e, t, n) {
		if (!e && WebAssembly.instantiateStreaming) try {
			var r = fetch(t, { credentials: "same-origin" });
			return await WebAssembly.instantiateStreaming(r, n);
		} catch (e) {
			p(`wasm streaming compile failed: ${e}`), p("falling back to ArrayBuffer instantiation");
		}
		return se(t, n);
	}
	function le() {
		return { a: Rn };
	}
	async function ue() {
		function e(e, t) {
			return $ = e.exports, Ln($), y(), $;
		}
		function t(t) {
			return e(t.instance);
		}
		var n = le();
		return i.instantiateWasm ? new Promise((t, r) => {
			i.instantiateWasm(n, (n, r) => {
				t(e(n, r));
			});
		}) : (b != null || (b = ie()), t(await ce(m, b, n)));
	}
	var x, S, C, w, T, E, D, O, k = (e) => {
		for (; e.length > 0;) e.shift()(i);
	}, de = [], fe = (e) => de.push(e), pe = [], me = (e) => pe.push(e), A = (e) => On(e), j = () => kn(), M = [], he = 0, ge = (e) => {
		var t = new ve(e);
		return t.get_caught() || (t.set_caught(!0), he--), t.set_rethrown(!1), M.push(t), En(e);
	}, N = 0, _e = () => {
		Q(0, 0);
		var e = M.pop();
		jn(e.excPtr), N = 0;
	};
	class ve {
		constructor(e) {
			this.excPtr = e, this.ptr = e - 24;
		}
		set_type(e) {
			D[this.ptr + 4 >> 2] = e;
		}
		get_type() {
			return D[this.ptr + 4 >> 2];
		}
		set_destructor(e) {
			D[this.ptr + 8 >> 2] = e;
		}
		get_destructor() {
			return D[this.ptr + 8 >> 2];
		}
		set_caught(e) {
			e = +!!e, C[this.ptr + 12] = e;
		}
		get_caught() {
			return C[this.ptr + 12] != 0;
		}
		set_rethrown(e) {
			e = +!!e, C[this.ptr + 13] = e;
		}
		get_rethrown() {
			return C[this.ptr + 13] != 0;
		}
		init(e, t) {
			this.set_adjusted_ptr(0), this.set_type(e), this.set_destructor(t);
		}
		set_adjusted_ptr(e) {
			D[this.ptr + 16 >> 2] = e;
		}
		get_adjusted_ptr() {
			return D[this.ptr + 16 >> 2];
		}
	}
	var P = (e) => Dn(e), ye = (e) => {
		var t = N;
		if (!t) return P(0), 0;
		var n = new ve(t);
		n.set_adjusted_ptr(t);
		var r = n.get_type();
		if (!r) return P(0), t;
		for (var i of e) {
			if (i === 0 || i === r) break;
			var a = n.ptr + 16;
			if (Mn(i, r, a)) return P(i), t;
		}
		return P(r), t;
	}, be = () => ye([]), xe = (e) => ye([e]), Se = (e, t) => ye([e, t]), Ce = () => {
		var e = M.pop();
		e || re("no exception to throw");
		var t = e.excPtr;
		throw e.get_rethrown() || (M.push(e), e.set_rethrown(!0), e.set_caught(!1), he++), An(t), N = t, N;
	}, we = (e, t, n) => {
		throw new ve(e).init(t, n), An(e), N = e, he++, N;
	}, Te = (e) => {
		throw N || (N = e), N;
	}, Ee = () => re(""), F = {}, De = (e) => {
		for (; e.length;) {
			var t = e.pop();
			e.pop()(t);
		}
	};
	function I(e) {
		return this.fromWireType(D[e >> 2]);
	}
	var L = {}, R = {}, z = {}, Oe = class extends Error {
		constructor(e) {
			super(e), this.name = "InternalError";
		}
	}, B = (e) => {
		throw new Oe(e);
	}, V = (e, t, n) => {
		e.forEach((e) => z[e] = t);
		function r(t) {
			var r = n(t);
			r.length !== e.length && B("Mismatched type converter count");
			for (var i = 0; i < e.length; ++i) G(e[i], r[i]);
		}
		var i = Array(t.length), a = [], o = 0;
		{
			let e = t;
			for (let t = 0; t < e.length; ++t) {
				let n = e[t];
				R.hasOwnProperty(n) ? i[t] = R[n] : (a.push(n), L.hasOwnProperty(n) || (L[n] = []), L[n].push(() => {
					i[t] = R[n], ++o, o === a.length && r(i);
				}));
			}
		}
		a.length === 0 && r(i);
	}, ke = (e) => {
		var t = F[e];
		delete F[e];
		var n = t.rawConstructor, r = t.rawDestructor, i = t.fields, a = i.map((e) => e.getterReturnType).concat(i.map((e) => e.setterArgumentType));
		V([e], a, (e) => {
			var a = {};
			{
				let t = i;
				for (let n = 0; n < t.length; ++n) {
					let r = t[n], o = e[n], s = r.getter, c = r.getterContext, l = e[n + i.length], u = r.setter, d = r.setterContext;
					a[r.fieldName] = {
						read: (e) => o.fromWireType(s(c, e)),
						write: (e, t) => {
							var n = [];
							u(d, e, l.toWireType(n, t)), De(n);
						},
						optional: o.optional
					};
				}
			}
			return [{
				name: t.name,
				fromWireType: (e) => {
					var t = {};
					for (var n in a) t[n] = a[n].read(e);
					return r(e), t;
				},
				toWireType: (e, t) => {
					for (var i in a) if (!(i in t) && !a[i].optional) throw TypeError(`Missing field: "${i}"`);
					var o = n();
					for (i in a) a[i].write(o, t[i]);
					return e !== null && e.push(r, o), o;
				},
				readValueFromPointer: I,
				destructorFunction: r
			}];
		});
	}, Ae = (e, t, n, r, i) => {}, H = (e) => {
		for (var t = "";;) {
			var n = O[e++];
			if (!n) return t;
			t += String.fromCharCode(n);
		}
	}, U = class extends Error {
		constructor(e) {
			super(e), this.name = "BindingError";
		}
	}, W = (e) => {
		throw new U(e);
	};
	function je(e, t) {
		let n = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : {};
		var r = t.name;
		if (e || W(`type "${r}" must have a positive integer typeid pointer`), R.hasOwnProperty(e)) {
			if (n.ignoreDuplicateRegistrations) return;
			W(`Cannot register type '${r}' twice`);
		}
		if (R[e] = t, delete z[e], L.hasOwnProperty(e)) {
			var i = L[e];
			delete L[e], i.forEach((e) => e());
		}
	}
	function G(e, t) {
		return je(e, t, arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : {});
	}
	var Me = (e, t, n, r) => {
		t = H(t), G(e, {
			name: t,
			fromWireType: function(e) {
				return !!e;
			},
			toWireType: function(e, t) {
				return t ? n : r;
			},
			readValueFromPointer: function(e) {
				return this.fromWireType(O[e]);
			},
			destructorFunction: null
		});
	}, Ne = (e) => ({
		count: e.count,
		deleteScheduled: e.deleteScheduled,
		preservePointerOnDelete: e.preservePointerOnDelete,
		ptr: e.ptr,
		ptrType: e.ptrType,
		smartPtr: e.smartPtr,
		smartPtrType: e.smartPtrType
	}), Pe = (e) => {
		function t(e) {
			return e.$$.ptrType.registeredClass.name;
		}
		W(t(e) + " instance already deleted");
	}, Fe = !1, Ie = (e) => {}, Le = (e) => {
		e.smartPtr ? e.smartPtrType.rawDestructor(e.smartPtr) : e.ptrType.registeredClass.rawDestructor(e.ptr);
	}, Re = (e) => {
		--e.count.value, e.count.value === 0 && Le(e);
	}, K = (e) => globalThis.FinalizationRegistry ? (Fe = new FinalizationRegistry((e) => {
		Re(e.$$);
	}), K = (e) => {
		var t = e.$$;
		if (t.smartPtr) {
			var n = { $$: t };
			Fe.register(e, n, e);
		}
		return e;
	}, Ie = (e) => Fe.unregister(e), K(e)) : (K = (e) => e, e), ze = [], Be = () => {
		for (; ze.length;) {
			var e = ze.pop();
			e.$$.deleteScheduled = !1, e.delete();
		}
	}, Ve, He = () => {
		let e = Ue.prototype;
		Object.assign(e, {
			isAliasOf(e) {
				if (!(this instanceof Ue) || !(e instanceof Ue)) return !1;
				var t = this.$$.ptrType.registeredClass, n = this.$$.ptr;
				e.$$ = e.$$;
				for (var r = e.$$.ptrType.registeredClass, i = e.$$.ptr; t.baseClass;) n = t.upcast(n), t = t.baseClass;
				for (; r.baseClass;) i = r.upcast(i), r = r.baseClass;
				return t === r && n === i;
			},
			clone() {
				if (this.$$.ptr || Pe(this), this.$$.preservePointerOnDelete) return this.$$.count.value += 1, this;
				var e = K(Object.create(Object.getPrototypeOf(this), { $$: { value: Ne(this.$$) } }));
				return e.$$.count.value += 1, e.$$.deleteScheduled = !1, e;
			},
			delete() {
				this.$$.ptr || Pe(this), this.$$.deleteScheduled && !this.$$.preservePointerOnDelete && W("Object already scheduled for deletion"), Ie(this), Re(this.$$), this.$$.preservePointerOnDelete || (this.$$.smartPtr = void 0, this.$$.ptr = void 0);
			},
			isDeleted() {
				return !this.$$.ptr;
			},
			deleteLater() {
				return this.$$.ptr || Pe(this), this.$$.deleteScheduled && !this.$$.preservePointerOnDelete && W("Object already scheduled for deletion"), ze.push(this), ze.length === 1 && Ve && Ve(Be), this.$$.deleteScheduled = !0, this;
			}
		});
		let t = Symbol.dispose;
		t && (e[t] = e.delete);
	};
	function Ue() {}
	var We = (e, t) => Object.defineProperty(t, "name", { value: e }), Ge = {}, Ke = (e, t, n) => {
		if (e[t].overloadTable === void 0) {
			var r = e[t];
			e[t] = function() {
				var r = [...arguments];
				return e[t].overloadTable.hasOwnProperty(r.length) || W(`Function '${n}' called with an invalid number of arguments (${r.length}) - expects one of (${e[t].overloadTable})!`), e[t].overloadTable[r.length].apply(this, r);
			}, e[t].overloadTable = [], e[t].overloadTable[r.argCount] = r;
		}
	}, qe = (e, t, n) => {
		i.hasOwnProperty(e) ? ((n === void 0 || i[e].overloadTable !== void 0 && i[e].overloadTable[n] !== void 0) && W(`Cannot register public name '${e}' twice`), Ke(i, e, e), i[e].overloadTable.hasOwnProperty(n) && W(`Cannot register multiple overloads of a function with the same number of arguments (${n})!`), i[e].overloadTable[n] = t) : (i[e] = t, i[e].argCount = n);
	}, Je = 48, Ye = 57, Xe = (e) => {
		e = e.replace(/[^a-zA-Z0-9_]/g, "$");
		var t = e.charCodeAt(0);
		return t >= Je && t <= Ye ? `_${e}` : e;
	};
	function Ze(e, t, n, r, i, a, o, s) {
		this.name = e, this.constructor = t, this.instancePrototype = n, this.rawDestructor = r, this.baseClass = i, this.getActualType = a, this.upcast = o, this.downcast = s, this.pureVirtualFunctions = [];
	}
	var Qe = (e, t, n) => {
		for (; t !== n;) t.upcast || W(`Expected null or instance of ${n.name}, got an instance of ${t.name}`), e = t.upcast(e), t = t.baseClass;
		return e;
	}, $e = (e) => {
		if (e === null) return "null";
		var t = typeof e;
		return t === "object" || t === "array" || t === "function" ? e.toString() : "" + e;
	};
	function et(e, t) {
		if (t === null) return this.isReference && W(`null is not a valid ${this.name}`), 0;
		t.$$ || W(`Cannot pass "${$e(t)}" as a ${this.name}`), t.$$.ptr || W(`Cannot pass deleted object as a pointer of type ${this.name}`);
		var n = t.$$.ptrType.registeredClass;
		return Qe(t.$$.ptr, n, this.registeredClass);
	}
	function tt(e, t) {
		var n;
		if (t === null) return this.isReference && W(`null is not a valid ${this.name}`), this.isSmartPointer ? (n = this.rawConstructor(), e !== null && e.push(this.rawDestructor, n), n) : 0;
		(!t || !t.$$) && W(`Cannot pass "${$e(t)}" as a ${this.name}`), t.$$.ptr || W(`Cannot pass deleted object as a pointer of type ${this.name}`), !this.isConst && t.$$.ptrType.isConst && W(`Cannot convert argument of type ${t.$$.smartPtrType ? t.$$.smartPtrType.name : t.$$.ptrType.name} to parameter type ${this.name}`);
		var r = t.$$.ptrType.registeredClass;
		if (n = Qe(t.$$.ptr, r, this.registeredClass), this.isSmartPointer) switch (t.$$.smartPtr === void 0 && W("Passing raw pointer to smart pointer is illegal"), this.sharingPolicy) {
			case 0:
				t.$$.smartPtrType === this ? n = t.$$.smartPtr : W(`Cannot convert argument of type ${t.$$.smartPtrType ? t.$$.smartPtrType.name : t.$$.ptrType.name} to parameter type ${this.name}`);
				break;
			case 1:
				n = t.$$.smartPtr;
				break;
			case 2:
				if (t.$$.smartPtrType === this) n = t.$$.smartPtr;
				else {
					var i = t.clone();
					n = this.rawShare(n, X.toHandle(() => i.delete())), e !== null && e.push(this.rawDestructor, n);
				}
				break;
			default: W("Unsupported sharing policy");
		}
		return n;
	}
	function nt(e, t) {
		if (t === null) return this.isReference && W(`null is not a valid ${this.name}`), 0;
		t.$$ || W(`Cannot pass "${$e(t)}" as a ${this.name}`), t.$$.ptr || W(`Cannot pass deleted object as a pointer of type ${this.name}`), t.$$.ptrType.isConst && W(`Cannot convert argument of type ${t.$$.ptrType.name} to parameter type ${this.name}`);
		var n = t.$$.ptrType.registeredClass;
		return Qe(t.$$.ptr, n, this.registeredClass);
	}
	var rt = (e, t, n) => {
		if (t === n) return e;
		if (n.baseClass === void 0) return null;
		var r = rt(e, t, n.baseClass);
		return r === null ? null : n.downcast(r);
	}, it = {}, at = (e, t) => {
		for (t === void 0 && W("ptr should not be undefined"); e.baseClass;) t = e.upcast(t), e = e.baseClass;
		return t;
	}, ot = (e, t) => (t = at(e, t), it[t]), st = (e, t) => ((!t.ptrType || !t.ptr) && B("makeClassHandle requires ptr and ptrType"), !!t.smartPtrType != !!t.smartPtr && B("Both smartPtrType and smartPtr must be specified"), t.count = { value: 1 }, K(Object.create(e, { $$: {
		value: t,
		writable: !0
	} })));
	function ct(e) {
		var t = this.getPointee(e);
		if (!t) return this.destructor(e), null;
		var n = ot(this.registeredClass, t);
		if (n !== void 0) {
			if (n.$$.count.value === 0) return n.$$.ptr = t, n.$$.smartPtr = e, n.clone();
			var r = n.clone();
			return this.destructor(e), r;
		}
		function i() {
			return this.isSmartPointer ? st(this.registeredClass.instancePrototype, {
				ptrType: this.pointeeType,
				ptr: t,
				smartPtrType: this,
				smartPtr: e
			}) : st(this.registeredClass.instancePrototype, {
				ptrType: this,
				ptr: e
			});
		}
		var a = Ge[this.registeredClass.getActualType(t)];
		if (!a) return i.call(this);
		var o = this.isConst ? a.constPointerType : a.pointerType, s = rt(t, this.registeredClass, o.registeredClass);
		return s === null ? i.call(this) : this.isSmartPointer ? st(o.registeredClass.instancePrototype, {
			ptrType: o,
			ptr: s,
			smartPtrType: this,
			smartPtr: e
		}) : st(o.registeredClass.instancePrototype, {
			ptrType: o,
			ptr: s
		});
	}
	var lt = () => {
		Object.assign(ut.prototype, {
			getPointee(e) {
				return this.rawGetPointee && (e = this.rawGetPointee(e)), e;
			},
			destructor(e) {
				var t;
				(t = this.rawDestructor) == null || t.call(this, e);
			},
			readValueFromPointer: I,
			fromWireType: ct
		});
	};
	function ut(e, t, n, r, i, a, o, s, c, l, u) {
		this.name = e, this.registeredClass = t, this.isReference = n, this.isConst = r, this.isSmartPointer = i, this.pointeeType = a, this.sharingPolicy = o, this.rawGetPointee = s, this.rawConstructor = c, this.rawShare = l, this.rawDestructor = u, !i && t.baseClass === void 0 ? r ? (this.toWireType = et, this.destructorFunction = null) : (this.toWireType = nt, this.destructorFunction = null) : this.toWireType = tt;
	}
	var dt = (e, t, n) => {
		i.hasOwnProperty(e) || B("Replacing nonexistent public symbol"), i[e].overloadTable !== void 0 && n !== void 0 ? i[e].overloadTable[n] = t : (i[e] = t, i[e].argCount = n);
	}, ft = {}, pt = (e, t, n) => {
		e = e.replace(/p/g, "i");
		var r = ft[e];
		return r(t, ...n);
	}, mt = [], q = (e) => {
		var t = mt[e];
		return t || (mt[e] = t = In.get(e)), t;
	}, ht = function(e, t) {
		let n = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : [];
		if (arguments.length > 3 && arguments[3] !== void 0 && arguments[3], e.includes("j")) return pt(e, t, n);
		var r = q(t)(...n);
		function i(e) {
			return e;
		}
		return i(r);
	}, gt = function(e, t) {
		let n = arguments.length > 2 && arguments[2] !== void 0 && arguments[2];
		return function() {
			return ht(e, t, [...arguments], n);
		};
	}, J = function(e, t) {
		arguments.length > 2 && arguments[2] !== void 0 && arguments[2], e = H(e);
		function n() {
			return e.includes("j") ? gt(e, t) : q(t);
		}
		var r = n();
		return typeof r != "function" && W(`unknown function pointer with signature ${e}: ${t}`), r;
	};
	class _t extends Error {}
	var vt = (e) => {
		var t = wn(e), n = H(t);
		return Z(t), n;
	}, yt = (e, t) => {
		var n = [], r = {};
		function i(e) {
			if (!r[e] && !R[e]) {
				if (z[e]) {
					z[e].forEach(i);
					return;
				}
				n.push(e), r[e] = !0;
			}
		}
		throw t.forEach(i), new _t(`${e}: ` + n.map(vt).join([", "]));
	}, bt = (e, t, n, r, i, a, o, s, c, l, u, d, f) => {
		u = H(u), a = J(i, a), s && (s = J(o, s)), l && (l = J(c, l)), f = J(d, f);
		var p = Xe(u);
		qe(p, function() {
			yt(`Cannot construct ${u} due to unbound types`, [r]);
		}), V([
			e,
			t,
			n
		], r ? [r] : [], (t) => {
			t = t[0];
			var n, i;
			r ? (n = t.registeredClass, i = n.instancePrototype) : i = Ue.prototype;
			var o = We(u, function() {
				if (Object.getPrototypeOf(this) !== c) throw new U(`Use 'new' to construct ${u}`);
				if (d.constructor_body === void 0) throw new U(`${u} has no accessible constructor`);
				var e = [...arguments], t = d.constructor_body[e.length];
				if (t === void 0) throw new U(`Tried to invoke ctor of ${u} with invalid number of parameters (${e.length}) - expected (${Object.keys(d.constructor_body).toString()}) parameters instead!`);
				return t.apply(this, e);
			}), c = Object.create(i, { constructor: { value: o } });
			o.prototype = c;
			var d = new Ze(u, o, c, f, n, a, s, l);
			if (d.baseClass) {
				var m;
				(m = d.baseClass).__derivedClasses != null || (m.__derivedClasses = []), d.baseClass.__derivedClasses.push(d);
			}
			var h = new ut(u, d, !0, !1, !1), g = new ut(u + "*", d, !1, !1, !1), _ = new ut(u + " const*", d, !1, !0, !1);
			return Ge[e] = {
				pointerType: g,
				constPointerType: _
			}, dt(p, o), [
				h,
				g,
				_
			];
		});
	}, xt = (e, t) => {
		for (var n = [], r = 0; r < e; r++) n.push(D[t + r * 4 >> 2]);
		return n;
	};
	function St(e) {
		for (var t = 1; t < e.length; ++t) if (e[t] !== null && e[t].destructorFunction === void 0) return !0;
		return !1;
	}
	function Ct(e, t, n, r, i, a) {
		var o = t.length;
		o < 2 && W("argTypes array size mismatch! Must at least get return value and 'this' types!");
		var s = t[1] !== null && n !== null, c = St(t), l = !t[0].isVoid, u = o - 2, d = Array(u), f = [], p = [];
		return We(e, function() {
			p.length = 0;
			var e;
			f.length = s ? 2 : 1, f[0] = i, s && (e = t[1].toWireType(p, this), f[1] = e);
			for (var n = 0; n < u; ++n) d[n] = t[n + 2].toWireType(p, n < 0 || arguments.length <= n ? void 0 : arguments[n]), f.push(d[n]);
			var a = r(...f);
			function o(n) {
				if (c) De(p);
				else for (var r = s ? 1 : 2; r < t.length; r++) {
					var i = r === 1 ? e : d[r - 2];
					t[r].destructorFunction !== null && t[r].destructorFunction(i);
				}
				if (l) return t[0].fromWireType(n);
			}
			return o(a);
		});
	}
	var wt = (e, t, n, r, i, a) => {
		var o = xt(t, n);
		i = J(r, i), V([], [e], (e) => {
			e = e[0];
			var n = `constructor ${e.name}`;
			if (e.registeredClass.constructor_body === void 0 && (e.registeredClass.constructor_body = []), e.registeredClass.constructor_body[t - 1] !== void 0) throw new U(`Cannot register multiple constructors with identical number of parameters (${t - 1}) for class '${e.name}'! Overload resolution is currently only performed using the parameter count, not actual type info!`);
			return e.registeredClass.constructor_body[t - 1] = () => {
				yt(`Cannot construct ${e.name} due to unbound types`, o);
			}, V([], o, (r) => (r.splice(1, 0, null), e.registeredClass.constructor_body[t - 1] = Ct(n, r, null, i, a), [])), [];
		});
	}, Tt = (e) => {
		e = e.trim();
		let t = e.indexOf("(");
		return t === -1 ? e : e.slice(0, t);
	}, Et = (e, t, n, r, i, a, o, s, c, l) => {
		var u = xt(n, r);
		t = H(t), t = Tt(t), a = J(i, a, c), V([], [e], (e) => {
			e = e[0];
			var r = `${e.name}.${t}`;
			t.startsWith("@@") && (t = Symbol[t.substring(2)]), s && e.registeredClass.pureVirtualFunctions.push(t);
			function i() {
				yt(`Cannot call ${r} due to unbound types`, u);
			}
			var l = e.registeredClass.instancePrototype, d = l[t];
			return d === void 0 || d.overloadTable === void 0 && d.className !== e.name && d.argCount === n - 2 ? (i.argCount = n - 2, i.className = e.name, l[t] = i) : (Ke(l, t, r), l[t].overloadTable[n - 2] = i), V([], u, (i) => {
				var s = Ct(r, i, e, a, o, c);
				return l[t].overloadTable === void 0 ? (s.argCount = n - 2, l[t] = s) : l[t].overloadTable[n - 2] = s, [];
			}), [];
		});
	}, Dt = [], Y = [
		0,
		1,
		,
		1,
		null,
		1,
		!0,
		1,
		!1,
		1
	], Ot = (e) => {
		e > 9 && --Y[e + 1] === 0 && (Y[e] = void 0, Dt.push(e));
	}, X = {
		toValue: (e) => (e || W(`Cannot use deleted val. handle = ${e}`), Y[e]),
		toHandle: (e) => {
			switch (e) {
				case void 0: return 2;
				case null: return 4;
				case !0: return 6;
				case !1: return 8;
				default: {
					let t = Dt.pop() || Y.length;
					return Y[t] = e, Y[t + 1] = 1, t;
				}
			}
		}
	}, kt = {
		name: "emscripten::val",
		fromWireType: (e) => {
			var t = X.toValue(e);
			return Ot(e), t;
		},
		toWireType: (e, t) => X.toHandle(t),
		readValueFromPointer: I,
		destructorFunction: null
	}, At = (e) => G(e, kt), jt = (e, t) => {
		switch (t) {
			case 4: return function(e) {
				return this.fromWireType(w[e >> 2]);
			};
			case 8: return function(e) {
				return this.fromWireType(T[e >> 3]);
			};
			default: throw TypeError(`invalid float width (${t}): ${e}`);
		}
	}, Mt = (e, t, n) => {
		t = H(t), G(e, {
			name: t,
			fromWireType: (e) => e,
			toWireType: (e, t) => t,
			readValueFromPointer: jt(t, n),
			destructorFunction: null
		});
	}, Nt = (e, t, n, r, i, a, o, s) => {
		var c = xt(t, n);
		e = H(e), e = Tt(e), i = J(r, i, o), qe(e, function() {
			yt(`Cannot call ${e} due to unbound types`, c);
		}, t - 1), V([], c, (n) => {
			var r = [n[0], null].concat(n.slice(1));
			return dt(e, Ct(e, r, null, i, a, o), t - 1), [];
		});
	}, Pt = (e, t, n) => {
		switch (t) {
			case 1: return n ? (e) => C[e] : (e) => O[e];
			case 2: return n ? (e) => x[e >> 1] : (e) => E[e >> 1];
			case 4: return n ? (e) => S[e >> 2] : (e) => D[e >> 2];
			default: throw TypeError(`invalid integer width (${t}): ${e}`);
		}
	}, Ft = (e, t, n, r, i) => {
		t = H(t);
		let a = r === 0, o = (e) => e;
		if (a) {
			var s = 32 - 8 * n;
			o = (e) => e << s >>> s, i = o(i);
		}
		G(e, {
			name: t,
			fromWireType: o,
			toWireType: (e, t) => t,
			readValueFromPointer: Pt(t, n, r !== 0),
			destructorFunction: null
		});
	}, It = (e, t, n) => {
		let r = (e, t) => {
			let n = 0;
			return {
				next() {
					if (n >= e) return { done: !0 };
					let r = n;
					return n++, {
						value: t(r),
						done: !1
					};
				},
				[Symbol.iterator]() {
					return this;
				}
			};
		};
		e[Symbol.iterator] || (e[Symbol.iterator] = function() {
			let e = this[t]();
			return r(e, (e) => this[n](e));
		});
	}, Lt = (e, t, n, r) => {
		n = H(n), r = H(r), V([], [e, t], (e) => {
			let t = e[0];
			return It(t.registeredClass.instancePrototype, n, r), [];
		});
	}, Rt = (e, t, n) => {
		var r = [
			Int8Array,
			Uint8Array,
			Int16Array,
			Uint16Array,
			Int32Array,
			Uint32Array,
			Float32Array,
			Float64Array
		][t];
		function i(e) {
			var t = D[e >> 2], n = D[e + 4 >> 2];
			return new r(C.buffer, n, t);
		}
		n = H(n), G(e, {
			name: n,
			fromWireType: i,
			readValueFromPointer: i
		}, { ignoreDuplicateRegistrations: !0 });
	}, zt = Object.assign({ optional: !0 }, kt), Bt = (e, t) => {
		G(e, zt);
	}, Vt = (e, t, n, r) => {
		if (!(r > 0)) return 0;
		for (var i = n, a = n + r - 1, o = 0; o < e.length; ++o) {
			var s = e.codePointAt(o);
			if (s <= 127) {
				if (n >= a) break;
				t[n++] = s;
			} else if (s <= 2047) {
				if (n + 1 >= a) break;
				t[n++] = 192 | s >> 6, t[n++] = 128 | s & 63;
			} else if (s <= 65535) {
				if (n + 2 >= a) break;
				t[n++] = 224 | s >> 12, t[n++] = 128 | s >> 6 & 63, t[n++] = 128 | s & 63;
			} else {
				if (n + 3 >= a) break;
				t[n++] = 240 | s >> 18, t[n++] = 128 | s >> 12 & 63, t[n++] = 128 | s >> 6 & 63, t[n++] = 128 | s & 63, o++;
			}
		}
		return t[n] = 0, n - i;
	}, Ht = (e, t, n) => Vt(e, O, t, n), Ut = (e) => {
		for (var t = 0, n = 0; n < e.length; ++n) {
			var r = e.charCodeAt(n);
			r <= 127 ? t++ : r <= 2047 ? t += 2 : r >= 55296 && r <= 57343 ? (t += 4, ++n) : t += 3;
		}
		return t;
	}, Wt = globalThis.TextDecoder && new TextDecoder(), Gt = (e, t, n, r) => {
		var i = t + n;
		if (r) return i;
		for (; e[t] && !(t >= i);) ++t;
		return t;
	}, Kt = function(e) {
		let t = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : 0, n = arguments.length > 2 ? arguments[2] : void 0, r = arguments.length > 3 ? arguments[3] : void 0;
		var i = Gt(e, t, n, r);
		if (i - t > 16 && e.buffer && Wt) return Wt.decode(e.subarray(t, i));
		for (var a = ""; t < i;) {
			var o = e[t++];
			if (!(o & 128)) {
				a += String.fromCharCode(o);
				continue;
			}
			var s = e[t++] & 63;
			if ((o & 224) == 192) {
				a += String.fromCharCode((o & 31) << 6 | s);
				continue;
			}
			var c = e[t++] & 63;
			if (o = (o & 240) == 224 ? (o & 15) << 12 | s << 6 | c : (o & 7) << 18 | s << 12 | c << 6 | e[t++] & 63, o < 65536) a += String.fromCharCode(o);
			else {
				var l = o - 65536;
				a += String.fromCharCode(55296 | l >> 10, 56320 | l & 1023);
			}
		}
		return a;
	}, qt = (e, t, n) => e ? Kt(O, e, t, n) : "", Jt = (e, t) => {
		t = H(t);
		var n = !0;
		G(e, {
			name: t,
			fromWireType(e) {
				var t = D[e >> 2], r = e + 4, i;
				if (n) i = qt(r, t, !0);
				else {
					i = "";
					for (var a = 0; a < t; ++a) i += String.fromCharCode(O[r + a]);
				}
				return Z(e), i;
			},
			toWireType(e, t) {
				t instanceof ArrayBuffer && (t = new Uint8Array(t));
				var r, i = typeof t == "string";
				i || ArrayBuffer.isView(t) && t.BYTES_PER_ELEMENT == 1 || W("Cannot pass non-string to std::string"), r = n && i ? Ut(t) : t.length;
				var a = Tn(4 + r + 1), o = a + 4;
				if (D[a >> 2] = r, i) {
					if (n) Ht(t, o, r + 1);
					else for (var s = 0; s < r; ++s) {
						var c = t.charCodeAt(s);
						c > 255 && (Z(a), W("String has UTF-16 code units that do not fit in 8 bits")), O[o + s] = c;
					}
				} else O.set(t, o);
				return e !== null && e.push(Z, a), a;
			},
			readValueFromPointer: I,
			destructorFunction(e) {
				Z(e);
			}
		});
	}, Yt = globalThis.TextDecoder ? new TextDecoder("utf-16le") : void 0, Xt = (e, t, n) => {
		var r = e >> 1, i = Gt(E, r, t / 2, n);
		if (i - r > 16 && Yt) return Yt.decode(E.subarray(r, i));
		for (var a = "", o = r; o < i; ++o) {
			var s = E[o];
			a += String.fromCharCode(s);
		}
		return a;
	}, Zt = (e, t, n) => {
		if (n != null || (n = 2147483647), n < 2) return 0;
		n -= 2;
		for (var r = t, i = n < e.length * 2 ? n / 2 : e.length, a = 0; a < i; ++a) {
			var o = e.charCodeAt(a);
			x[t >> 1] = o, t += 2;
		}
		return x[t >> 1] = 0, t - r;
	}, Qt = (e) => e.length * 2, $t = (e, t, n) => {
		for (var r = "", i = e >> 2, a = 0; !(a >= t / 4); a++) {
			var o = D[i + a];
			if (!o && !n) break;
			r += String.fromCodePoint(o);
		}
		return r;
	}, en = (e, t, n) => {
		if (n != null || (n = 2147483647), n < 4) return 0;
		for (var r = t, i = r + n - 4, a = 0; a < e.length; ++a) {
			var o = e.codePointAt(a);
			if (o > 65535 && a++, S[t >> 2] = o, t += 4, t + 4 > i) break;
		}
		return S[t >> 2] = 0, t - r;
	}, tn = (e) => {
		for (var t = 0, n = 0; n < e.length; ++n) e.codePointAt(n) > 65535 && n++, t += 4;
		return t;
	}, nn = (e, t, n) => {
		n = H(n);
		var r, i, a;
		t === 2 ? (r = Xt, i = Zt, a = Qt) : (r = $t, i = en, a = tn), G(e, {
			name: n,
			fromWireType: (e) => {
				var n = D[e >> 2], i = r(e + 4, n * t, !0);
				return Z(e), i;
			},
			toWireType: (e, r) => {
				typeof r != "string" && W(`Cannot pass non-string to C++ string type ${n}`);
				var o = a(r), s = Tn(4 + o + t);
				return D[s >> 2] = o / t, i(r, s + 4, o + t), e !== null && e.push(Z, s), s;
			},
			readValueFromPointer: I,
			destructorFunction(e) {
				Z(e);
			}
		});
	}, rn = (e, t, n, r, i, a) => {
		F[e] = {
			name: H(t),
			rawConstructor: J(n, r),
			rawDestructor: J(i, a),
			fields: []
		};
	}, an = (e, t, n, r, i, a, o, s, c, l) => {
		F[e].fields.push({
			fieldName: H(t),
			getterReturnType: n,
			getter: J(r, i),
			getterContext: a,
			setterArgumentType: o,
			setter: J(s, c),
			setterContext: l
		});
	}, on = (e, t) => {
		t = H(t), G(e, {
			isVoid: !0,
			name: t,
			fromWireType: () => void 0,
			toWireType: (e, t) => void 0
		});
	}, sn = [], cn = (e) => {
		var t = sn.length;
		return sn.push(e), t;
	}, ln = (e, t) => {
		var n = R[e];
		return n === void 0 && W(`${t} has unknown type ${vt(e)}`), n;
	}, un = (e, t) => {
		for (var n = Array(e), r = 0; r < e; ++r) n[r] = ln(D[t + r * 4 >> 2], `parameter ${r}`);
		return n;
	}, dn = (e, t, n) => {
		var r = [], i = e(r, n);
		return r.length && (D[t >> 2] = X.toHandle(r)), i;
	}, fn = {}, pn = (e) => {
		var t = fn[e];
		return t === void 0 ? H(e) : t;
	}, mn = (e, t, n) => {
		var [r, ...i] = un(e, t), a = r.toWireType.bind(r), o = i.map((e) => e.readValueFromPointer.bind(e));
		e--;
		var s = Array(e);
		return cn(We(`methodCaller<(${i.map((e) => e.name)}) => ${r.name}>`, (t, r, i, c) => {
			for (var l = 0, u = 0; u < e; ++u) s[u] = o[u](c + l), l += 8;
			var d;
			switch (n) {
				case 0:
					d = X.toValue(t).apply(null, s);
					break;
				case 2:
					d = Reflect.construct(X.toValue(t), s);
					break;
				case 3:
					d = s[0];
					break;
				case 1: d = X.toValue(t)[pn(r)](...s);
			}
			return dn(a, i, d);
		}));
	}, hn = (e) => e ? (e = pn(e), X.toHandle(globalThis[e])) : X.toHandle(globalThis), gn = (e) => {
		e > 9 && (Y[e + 1] += 1);
	}, _n = (e, t, n, r, i) => sn[e](t, n, r, i), vn = (e) => {
		De(X.toValue(e)), Ot(e);
	}, yn = () => 2147483648, bn = (e, t) => Math.ceil(e / t) * t, xn = (e) => {
		var t = (e - Fn.buffer.byteLength + 65535) / 65536 | 0;
		try {
			return Fn.grow(t), y(), 1;
		} catch {}
	}, Sn = (e) => {
		var t = O.length;
		e >>>= 0;
		var n = yn();
		if (e > n) return !1;
		for (var r = 1; r <= 4; r *= 2) {
			var i = t * (1 + .2 / r);
			if (i = Math.min(i, e + 100663296), xn(Math.min(n, bn(Math.max(e, i), 65536)))) return !0;
		}
		return !1;
	}, Cn = (e) => e;
	if (He(), lt(), i.noExitRuntime && i.noExitRuntime, i.print && i.print, i.printErr && (p = i.printErr), i.wasmBinary && (m = i.wasmBinary), i.arguments && i.arguments, i.thisProgram && i.thisProgram, i.preInit) for (typeof i.preInit == "function" && (i.preInit = [i.preInit]); i.preInit.length > 0;) i.preInit.shift()();
	var wn, Z, Tn, En, Q, Dn, On, kn, An, jn, Mn, Nn, Pn, Fn, In;
	function Ln(e) {
		wn = e.sa, Z = i._free = e.ta, Tn = i._malloc = e.va, En = e.wa, Q = e.xa, Dn = e.ya, On = e.za, kn = e.Aa, An = e.Ba, jn = e.Ca, Mn = e.Da, Nn = ft.viijjijjjjjj = e.Ea, Pn = ft.iiijj = e.Fa, Fn = e.qa, In = e.ua;
	}
	var Rn = {
		r: ge,
		J: _e,
		a: be,
		i: xe,
		l: Se,
		T: Ce,
		q: we,
		e: Te,
		Z: Ee,
		na: ke,
		Y: Ae,
		ha: Me,
		la: bt,
		ka: wt,
		E: Et,
		fa: At,
		U: Mt,
		V: Nt,
		x: Ft,
		ja: Lt,
		s: Rt,
		ma: Bt,
		ga: Jt,
		P: nn,
		F: rn,
		oa: an,
		ia: on,
		I: mn,
		pa: Ot,
		C: hn,
		Q: gn,
		H: _n,
		aa: vn,
		_: Sn,
		da: ar,
		S: cr,
		z: mr,
		K: Kn,
		b: Vn,
		A: sr,
		ba: fr,
		d: Un,
		M: pr,
		h: Gn,
		j: Qn,
		p: $n,
		N: or,
		w: nr,
		O: tr,
		B: rr,
		W: yr,
		c: qn,
		m: zn,
		$: hr,
		g: Hn,
		R: lr,
		L: _r,
		f: Wn,
		G: gr,
		k: Bn,
		ca: ur,
		n: er,
		u: Yn,
		D: ir,
		y: Zn,
		t: dr,
		o: Jn,
		ea: Xn,
		X: vr,
		v: Cn
	};
	function zn(e, t) {
		var n = j();
		try {
			q(e)(t);
		} catch (e) {
			if (A(n), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function Bn(e, t, n, r, i) {
		var a = j();
		try {
			q(e)(t, n, r, i);
		} catch (e) {
			if (A(a), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function Vn(e, t) {
		var n = j();
		try {
			return q(e)(t);
		} catch (e) {
			if (A(n), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function Hn(e, t, n) {
		var r = j();
		try {
			q(e)(t, n);
		} catch (e) {
			if (A(r), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function Un(e, t, n) {
		var r = j();
		try {
			return q(e)(t, n);
		} catch (e) {
			if (A(r), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function Wn(e, t, n, r) {
		var i = j();
		try {
			q(e)(t, n, r);
		} catch (e) {
			if (A(i), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function Gn(e, t, n, r) {
		var i = j();
		try {
			return q(e)(t, n, r);
		} catch (e) {
			if (A(i), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function Kn(e, t, n, r, i, a) {
		var o = j();
		try {
			return q(e)(t, n, r, i, a);
		} catch (e) {
			if (A(o), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function qn(e) {
		var t = j();
		try {
			q(e)();
		} catch (e) {
			if (A(t), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function Jn(e, t, n, r, i, a, o, s, c, l, u) {
		var d = j();
		try {
			q(e)(t, n, r, i, a, o, s, c, l, u);
		} catch (e) {
			if (A(d), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function Yn(e, t, n, r, i, a, o) {
		var s = j();
		try {
			q(e)(t, n, r, i, a, o);
		} catch (e) {
			if (A(s), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function Xn(e, t, n, r, i, a, o, s, c, l, u, d, f, p, m, h, g) {
		var _ = j();
		try {
			q(e)(t, n, r, i, a, o, s, c, l, u, d, f, p, m, h, g);
		} catch (e) {
			if (A(_), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function Zn(e, t, n, r, i, a, o, s, c) {
		var l = j();
		try {
			q(e)(t, n, r, i, a, o, s, c);
		} catch (e) {
			if (A(l), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function Qn(e, t, n, r, i) {
		var a = j();
		try {
			return q(e)(t, n, r, i);
		} catch (e) {
			if (A(a), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function $n(e, t, n, r, i, a) {
		var o = j();
		try {
			return q(e)(t, n, r, i, a);
		} catch (e) {
			if (A(o), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function er(e, t, n, r, i, a) {
		var o = j();
		try {
			q(e)(t, n, r, i, a);
		} catch (e) {
			if (A(o), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function tr(e, t, n, r, i, a, o, s) {
		var c = j();
		try {
			return q(e)(t, n, r, i, a, o, s);
		} catch (e) {
			if (A(c), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function nr(e, t, n, r, i, a, o) {
		var s = j();
		try {
			return q(e)(t, n, r, i, a, o);
		} catch (e) {
			if (A(s), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function rr(e, t, n, r, i, a, o, s, c) {
		var l = j();
		try {
			return q(e)(t, n, r, i, a, o, s, c);
		} catch (e) {
			if (A(l), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function ir(e, t, n, r, i, a, o, s) {
		var c = j();
		try {
			q(e)(t, n, r, i, a, o, s);
		} catch (e) {
			if (A(c), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function ar(e, t, n) {
		var r = j();
		try {
			return q(e)(t, n);
		} catch (e) {
			if (A(r), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function or(e, t, n, r, i, a, o) {
		var s = j();
		try {
			return q(e)(t, n, r, i, a, o);
		} catch (e) {
			if (A(s), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function sr(e, t, n, r) {
		var i = j();
		try {
			return q(e)(t, n, r);
		} catch (e) {
			if (A(i), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function cr(e, t, n, r) {
		var i = j();
		try {
			return q(e)(t, n, r);
		} catch (e) {
			if (A(i), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function lr(e, t, n, r, i, a, o, s, c) {
		var l = j();
		try {
			q(e)(t, n, r, i, a, o, s, c);
		} catch (e) {
			if (A(l), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function ur(e, t, n, r, i, a, o, s) {
		var c = j();
		try {
			q(e)(t, n, r, i, a, o, s);
		} catch (e) {
			if (A(c), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function dr(e, t, n, r, i, a, o, s, c, l) {
		var u = j();
		try {
			q(e)(t, n, r, i, a, o, s, c, l);
		} catch (e) {
			if (A(u), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function fr(e, t, n) {
		var r = j();
		try {
			return q(e)(t, n);
		} catch (e) {
			if (A(r), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function pr(e, t, n, r, i) {
		var a = j();
		try {
			return q(e)(t, n, r, i);
		} catch (e) {
			if (A(a), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function mr(e, t, n, r, i, a) {
		var o = j();
		try {
			return q(e)(t, n, r, i, a);
		} catch (e) {
			if (A(o), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function hr(e, t, n) {
		var r = j();
		try {
			q(e)(t, n);
		} catch (e) {
			if (A(r), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function gr(e, t, n, r, i, a, o) {
		var s = j();
		try {
			q(e)(t, n, r, i, a, o);
		} catch (e) {
			if (A(s), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function _r(e, t, n, r, i) {
		var a = j();
		try {
			q(e)(t, n, r, i);
		} catch (e) {
			if (A(a), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function vr(e, t, n, r, i, a, o, s, c, l, u, d, f, p, m, h, g, _, v, y) {
		var ee = j();
		try {
			Nn(e, t, n, r, i, a, o, s, c, l, u, d, f, p, m, h, g, _, v, y);
		} catch (e) {
			if (A(ee), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function yr(e, t, n, r, i, a, o) {
		var s = j();
		try {
			return Pn(e, t, n, r, i, a, o);
		} catch (e) {
			if (A(s), e !== e + 0) throw e;
			Q(1, 0);
		}
	}
	function br() {
		ee();
		function e() {
			var e, t;
			i.calledRun = !0, !h && (te(), (e = g) == null || e(i), (t = i.onRuntimeInitialized) == null || t.call(i), ne());
		}
		i.setStatus ? (i.setStatus("Running..."), setTimeout(() => {
			setTimeout(() => i.setStatus(""), 1), e();
		}, 1)) : e();
	}
	var $ = await ue();
	return br(), t = v ? i : new Promise((e, t) => {
		g = e, _ = t;
	}), t;
}
//#endregion
//#region src/reader/index.ts
function T(e) {
	return m(w, e);
}
function E() {
	return ae(w);
}
function D(e) {
	return T({
		overrides: e,
		equalityFn: Object.is,
		fireImmediately: !0
	});
}
function O(e) {
	T({
		overrides: e,
		equalityFn: Object.is,
		fireImmediately: !1
	});
}
async function k(e, t) {
	return ce(w, e, t);
}
async function de(e, t) {
	return k(e, t);
}
async function fe(e, t) {
	return k(e, t);
}
var pe = "e8af31edb56d0522f4de74495839385ef019ba8bc90d38e5ecb2f18795d86fb2";
//#endregion
export { C as BARCODE_FORMATS, h as BARCODE_HRI_LABELS, S as BARCODE_META_FORMATS, d as BARCODE_SYMBOLOGIES, p as BINARIZERS, y as CHARACTER_SETS, oe as CONTENT_TYPES, t as CREATABLE_BARCODE_FORMATS, g as EAN_ADD_ON_SYMBOLS, x as GS1_BARCODE_FORMATS, f as INDUSTRIAL_BARCODE_FORMATS, r as LINEAR_BARCODE_FORMATS, n as MATRIX_BARCODE_FORMATS, l as READABLE_BARCODE_FORMATS, ne as RETAIL_BARCODE_FORMATS, re as TEXT_MODES, se as ZXING_CPP_COMMIT, pe as ZXING_WASM_SHA256, ee as ZXING_WASM_VERSION, e as barcodeFormats, ue as binarizers, v as characterSets, b as contentTypes, ie as defaultReaderOptions, _ as eanAddOnSymbols, te as encodeFormat, s as encodeFormats, c as formatToLabel, u as formatToSymbology, D as getZXingModule, i as linearBarcodeFormats, a as matrixBarcodeFormats, T as prepareZXingModule, E as purgeZXingModule, k as readBarcodes, fe as readBarcodesFromImageData, de as readBarcodesFromImageFile, O as setZXingModuleOverrides, o as symbologyToFormats, le as textModes };
