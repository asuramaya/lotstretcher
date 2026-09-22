/* tslint:disable */
/* eslint-disable */

/**
 * Composed RGB bytes for the request, or a thrown Error.
 */
export function compose_hero(request: string, arena: Uint8Array): Uint8Array;

/**
 * [left, top, right, bottom] of an RGBA border's transparent window.
 */
export function detect_window(border: Uint8Array, width: number, height: number): Int32Array;

/**
 * [r,g,b, r,g,b] for the exterior and interior stops.
 */
export function vehicle_gradient_colors(exterior: string | null | undefined, interior: string | null | undefined, sample: Uint8Array, width: number, height: number): Uint8Array;

export function version(): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly compose_hero: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly detect_window: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly vehicle_gradient_colors: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly version: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
