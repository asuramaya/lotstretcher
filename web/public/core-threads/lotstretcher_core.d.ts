/* tslint:disable */
/* eslint-disable */

/**
 * The general entry point (see frame.rs::Op). Returns a JS object
 * {kind: "image", width, height, channels, data} or {kind: "json", text}.
 */
export function call(op: string, arena: Uint8Array): any;

/**
 * Composed RGB bytes for the request, or a thrown Error.
 */
export function compose_hero(request: string, arena: Uint8Array): Uint8Array;

/**
 * [left, top, right, bottom] of an RGBA border's transparent window.
 */
export function detect_window(border: Uint8Array, width: number, height: number): Int32Array;

export function initThreadPool(num_threads: number): Promise<any>;

/**
 * [r,g,b, r,g,b] for the exterior and interior stops.
 */
export function vehicle_gradient_colors(exterior: string | null | undefined, interior: string | null | undefined, sample: Uint8Array, width: number, height: number): Uint8Array;

export function version(): number;

export class wbg_rayon_PoolBuilder {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    build(): void;
    mainJS(): string;
    numThreads(): number;
    receiver(): number;
}

export function wbg_rayon_start_worker(receiver: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void;
    readonly call: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly compose_hero: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly detect_window: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly initThreadPool: (a: number) => any;
    readonly vehicle_gradient_colors: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly version: () => number;
    readonly wbg_rayon_poolbuilder_build: (a: number) => void;
    readonly wbg_rayon_poolbuilder_mainJS: (a: number) => any;
    readonly wbg_rayon_poolbuilder_numThreads: (a: number) => number;
    readonly wbg_rayon_poolbuilder_receiver: (a: number) => number;
    readonly wbg_rayon_start_worker: (a: number) => void;
    readonly memory: WebAssembly.Memory;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
    readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
