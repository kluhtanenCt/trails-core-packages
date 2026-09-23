// SPDX-FileCopyrightText: 2023-2025 Open Pioneer project (https://github.com/open-pioneer)
// SPDX-License-Identifier: Apache-2.0

import { Error, type Logger } from "@open-pioneer/core";
import { ServiceOptions } from "@open-pioneer/runtime";
import { StorageNamespace, StorageProperties, StorageService } from "./api";

const SAVE_TIMEOUT = 0;

const DEFAULT_KEY = "trails-state";

// NOTE: Error ids are scoped to the package, not to the kind of storage (see `Error` in
// `@open-pioneer/core`), so session storage errors use this prefix as well.
const ERROR_IDS = {
    CORRUPTED_DATA: "local-storage:corrupted-data",
    INVALID_PATH: "local-storage:invalid-path",
    INVALID_VALUE: "local-storage:invalid-value",
    NOT_SUPPORTED: "local-storage:not-supported",
    INTERNAL: "local-storage:internal-error"
} as const;

/** Configures a concrete storage service implementation. */
export interface StorageServiceConfig {
    /**
     * The logger used for diagnostic messages.
     *
     * NOTE: Must be created by the subclass' module so that messages are attributed to the
     * concrete service, e.g. `@open-pioneer/local-storage/LocalStorageServiceImpl`.
     */
    readonly log: Logger;

    /** Human readable name of the storage, in lower case (e.g. `"local storage"`). */
    readonly label: string;

    /**
     * Returns the browser storage used by this service.
     * May return `undefined` - or throw - if the storage is not available.
     */
    getStorage(): Storage | undefined;
}

/**
 * Shared implementation for services that provide access to one of the browser's storage areas.
 *
 * > NOTE for subclasses: this constructor already loads the persisted state, so it must not rely
 * > on the subclass' own field initializers (those run _after_ `super()`).
 */
export abstract class StorageServiceImpl implements StorageService {
    // Logger of the concrete service.
    #log: Logger;

    // Human readable name of the storage, used in messages ("local storage" / "Local storage").
    #label: string;
    #labelCapitalized: string;

    // Key in the browser storage.
    #rootKey: string;

    // Root value. A (possibly nested) JSON structure that is persisted into the browser storage.
    // This value (or its children) are modified via the various `get` / `set` / `clear` / etc. methods
    // on the service itself and on the namespace objects obtained through the service.
    #rootValue: Record<string, unknown> = {};

    // Reference to the browser storage (if supported).
    #storage: Storage | undefined;

    // The root namespace works on `rootValue` directly.
    #rootNamespace: StorageNamespaceImpl | undefined;

    constructor(options: ServiceOptions, config: StorageServiceConfig) {
        this.#log = config.log;
        this.#label = config.label;
        this.#labelCapitalized = capitalize(config.label);
        this.#rootKey = getRootKey(options.properties, this.#log);
        this.#storage = this.#initStorage(config.getStorage);
        if (this.#storage) {
            this.#load();
            this.#rootNamespace = this.#createRootNamespace();
        }
    }

    destroy() {
        if (this.#saveTimeout) {
            clearTimeout(this.#saveTimeout);
            this.#saveTimeout = undefined;
        }
        if (this.#storage) {
            this.#save();
        }
    }

    get isSupported(): boolean {
        return !!this.#rootNamespace;
    }

    get(key: string): unknown {
        return this.#getRootNamespace().get(key);
    }

    set(key: string, value: unknown): void {
        return this.#getRootNamespace().set(key, value);
    }

    remove(key: string): void {
        return this.#getRootNamespace().remove(key);
    }

    removeAll(): void {
        return this.#getRootNamespace().removeAll();
    }

    getNamespace(key: string): StorageNamespace {
        return this.#getRootNamespace().getNamespace(key);
    }

    // Debounce save() calls to avoid saving after every 'set'.
    // This gives us some improved performance when there are multiple sets
    // in quick succession.
    #saveTimeout: ReturnType<(typeof globalThis)["setTimeout"]> | undefined;
    #triggerSave(): void {
        if (this.#saveTimeout) {
            clearTimeout(this.#saveTimeout);
        }
        this.#saveTimeout = setTimeout(() => {
            this.#saveTimeout = undefined;
            this.#save();
        }, SAVE_TIMEOUT);
    }

    /**
     * Detects the browser storage used by this service.
     * Returns `undefined` (and logs a warning) if the storage is not available.
     */
    #initStorage(getStorage: () => Storage | undefined): Storage | undefined {
        const notSupported = `${this.#labelCapitalized} is not supported by this browser.`;
        if (typeof Storage === "undefined") {
            this.#log.warn(notSupported);
            return undefined;
        }

        try {
            const storage = getStorage();
            if (!storage) {
                this.#log.warn(notSupported);
                return undefined;
            }
            return storage;
        } catch (e) {
            this.#log.warn(notSupported, e);
            return undefined;
        }
    }

    /**
     * Loads persisted data from the browser storage.
     * If the data is invalid (e.g. bad json), this will revert to the default (an empty object).
     *
     * This method is called during service startup to load the initial state.
     */
    #load() {
        try {
            const storage = this.#storage;
            if (!storage) {
                // Should not happen (load is called only when storage is available).
                throw new Error(ERROR_IDS.INTERNAL, `${this.#labelCapitalized} is not available.`);
            }

            const json = storage.getItem(this.#rootKey);
            if (json == null) {
                // No previous value
                this.#rootValue = {};
                this.#save();
                return;
            }

            try {
                const data = JSON.parse(json);
                if (!isObject(data)) {
                    throw new Error(
                        ERROR_IDS.CORRUPTED_DATA,
                        "Persisted value should be an object."
                    );
                }
                this.#rootValue = data;
            } catch (jsonError) {
                this.#log.warn("Invalid persisted data, reverting to default.", jsonError);
                this.#rootValue = {};
                this.#save();
            }
        } catch (e) {
            this.#log.error(`Failed to load from ${this.#label}`, e);
        }
    }

    /**
     * Persists the current state of `rootValue` to the browser storage.
     * This method is called whenever the state was modified.
     */
    #save() {
        try {
            const storage = this.#storage;
            if (!storage) {
                // Should not happen (setting values is only possible if supported).
                throw new Error(ERROR_IDS.INTERNAL, `${this.#labelCapitalized} is not available.`);
            }

            const json = JSON.stringify(this.#rootValue);
            storage.setItem(this.#rootKey, json);
        } catch (e) {
            this.#log.error(`Failed to save to ${this.#label}`, e);
        }
    }

    #getRootNamespace(): StorageNamespaceImpl {
        const root = this.#rootNamespace;
        if (!root) {
            throw new Error(
                ERROR_IDS.NOT_SUPPORTED,
                `${this.#labelCapitalized} is not supported by this browser.`
            );
        }
        return root;
    }

    #createRootNamespace(): StorageNamespaceImpl {
        const storageAccess: StorageAccess = {
            getByPath: (path) => {
                // Clone to protect against side effects on internal value
                return cloneJSON(getPath(this.#rootValue, path));
            },
            setByPath: (path, value) => {
                if (!isSupportedValue(value)) {
                    throw new Error(
                        ERROR_IDS.INVALID_VALUE,
                        `The value is not supported by ${this.#label}.`
                    );
                }

                // Clone to protect against side effects on original value
                value = cloneJSON(value);

                // Rewrite root object if path is empty.
                if (path.length === 0) {
                    if (!isObject(value)) {
                        throw new Error(
                            ERROR_IDS.INVALID_VALUE,
                            "The root value must be a plain object."
                        );
                    }
                    this.#rootValue = value;
                } else {
                    setPath(this.#rootValue, path, value);
                }

                this.#triggerSave();
            }
        };
        return new StorageNamespaceImpl([], storageAccess);
    }
}

interface StorageAccess {
    getByPath(path: string[]): unknown;
    setByPath(path: string[], value: unknown): void;
}

class StorageNamespaceImpl implements StorageNamespace {
    #path: string[];
    #access: StorageAccess;

    constructor(path: string[], access: StorageAccess) {
        this.#path = path;
        this.#access = access;
    }

    get(key: string): unknown {
        return this.#access.getByPath([...this.#path, key]);
    }

    set(key: string, value: unknown): void {
        this.#access.setByPath([...this.#path, key], value);
    }

    remove(key: string): void {
        this.#access.setByPath([...this.#path, key], undefined);
    }

    removeAll(): void {
        this.#access.setByPath(this.#path, {});
    }

    getNamespace(key: string): StorageNamespaceImpl {
        const existingValue = this.get(key);
        if (existingValue === undefined) {
            this.set(key, {});
        } else if (!isObject(existingValue)) {
            throw new Error(
                ERROR_IDS.INVALID_PATH,
                `Cannot use '${key}' as a namespace because it is not associated with an object.`
            );
        }

        return new StorageNamespaceImpl(this.#path.concat([key]), this.#access);
    }
}

function capitalize(text: string): string {
    // NOTE: charAt() instead of [0] because of `noUncheckedIndexedAccess`.
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Retrieves the property at `path` from the nested `object`.
 * Returns `object` if path is empty.
 */
function getPath(object: Record<string, unknown>, path: string[]): unknown {
    let current: unknown = object;
    for (const p of path) {
        if (!isObject(current)) {
            throw new Error(
                ERROR_IDS.INVALID_PATH,
                `Cannot get nested property '${p}' because the parent is no object.`
            );
        }
        current = current[p];
    }
    return current;
}

/**
 * Sets the property at `path` in the nested `object` to `value`.
 * Throws an error if the path is empty.
 */
function setPath(object: Record<string, unknown>, path: string[], value: unknown): void {
    if (!path.length) {
        throw new Error(ERROR_IDS.INTERNAL, "Path must not be empty.");
    }

    let current = object;
    for (let i = 0, n = path.length - 1; i < n; ++i) {
        // oxlint-disable-next-line @typescript-eslint/no-non-null-assertion
        const p = path[i]!;

        const next = current[p];
        if (!isObject(next)) {
            throw new Error(
                ERROR_IDS.INVALID_PATH,
                `Cannot set property on '${p}' because it is no object.`
            );
        }
        current = next;
    }

    // oxlint-disable-next-line @typescript-eslint/no-non-null-assertion
    const prop = path[path.length - 1]!;
    current[prop] = value;
}

/**
 * Returns true if `object` is a plain object (or record).
 */
function isObject(object: unknown): object is Record<string, unknown> {
    return !!(object && typeof object === "object" && !Array.isArray(object));
}

/**
 * Returns true if `value` looks like a JSON value.
 */
function isSupportedValue(value: unknown) {
    const type = typeof value;
    return (
        type === "boolean" ||
        type === "number" ||
        type === "string" ||
        type === "undefined" ||
        value === null ||
        Array.isArray(value) ||
        isObject(value)
    );
}

function getRootKey(properties: Partial<StorageProperties>, log: Logger): string {
    const storageId = properties.storageId;
    if (!storageId || typeof storageId !== "string") {
        log.warn(
            `The 'storageId' property of the 'local-storage' package should be set to a valid string to avoid collisions with other applications.` +
                ` Defaulting to '${DEFAULT_KEY}'.`
        );
        return DEFAULT_KEY;
    }
    return storageId;
}

function cloneJSON(value: unknown): unknown {
    if (value != null) {
        value = JSON.parse(JSON.stringify(value));
    }
    return value;
}
