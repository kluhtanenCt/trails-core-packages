// SPDX-FileCopyrightText: 2023-2025 Open Pioneer project (https://github.com/open-pioneer)
// SPDX-License-Identifier: Apache-2.0

import { createService } from "@open-pioneer/test-utils/services";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStorageServiceImpl } from "./LocalStorageServiceImpl";
import { SessionStorageServiceImpl } from "./SessionStorageServiceImpl";

const MOCKED_SESSION_STORAGE = new Map<string, string>();
const MOCKED_LOCAL_STORAGE = new Map<string, string>();

const DEFAULT_STORAGE_ID = "test-storage-id";

beforeEach(() => {
    vi.useFakeTimers();
    mockSessionStorage();
});

afterEach(() => {
    MOCKED_SESSION_STORAGE.clear();
    MOCKED_LOCAL_STORAGE.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it("Supports session storage by default", async () => {
    const storageService = setup();
    expect(storageService.isSupported).toBe(true);
});

it("Detects missing session storage", async () => {
    vi.spyOn(window, "sessionStorage", "get").mockReturnValue(undefined as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const storageService = setup();
    expect(storageService.isSupported).toBe(false);
    expect(warnSpy).toMatchInlineSnapshot(`
      [MockFunction warn] {
        "calls": [
          [
            "[WARN] @open-pioneer/local-storage/SessionStorageServiceImpl: This browser does not support session storage.",
          ],
        ],
        "results": [
          {
            "type": "return",
            "value": undefined,
          },
        ],
      }
    `);

    expect(() => storageService.get("foo")).toThrowErrorMatchingInlineSnapshot(
        `[Error: local-storage:not-supported: This browser does not support session storage.]`
    );
});

it("Reports errors if session storage does not work", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
        throw new Error("Some problem!");
    });

    const _storageService = setup();
    expect(warnSpy).toMatchInlineSnapshot(`
      [MockFunction warn] {
        "calls": [
          [
            "[WARN] @open-pioneer/local-storage/SessionStorageServiceImpl: This browser does not support session storage.",
            [Error: Some problem!],
          ],
        ],
        "results": [
          {
            "type": "return",
            "value": undefined,
          },
        ],
      }
    `);
});

it("Persists data to session storage", async () => {
    const storageService = setup();
    storageService.set("foo", "bar");
    storageService.set("answer", 42);
    storageService.set("object", { baz: "qux" });

    expect(getStorageData()).toMatchInlineSnapshot(`
      {
        "answer": 42,
        "foo": "bar",
        "object": {
          "baz": "qux",
        },
      }
    `);
});

it("Restores previous data on next run", async () => {
    MOCKED_SESSION_STORAGE.set(
        DEFAULT_STORAGE_ID,
        JSON.stringify({
            answer: 42
        })
    );

    const storageService = setup();
    expect(storageService.get("answer")).toBe(42);
});

it("Throws for invalid values", async () => {
    const storageService = setup();
    expect(() => storageService.set("foo", () => 1)).toThrowErrorMatchingInlineSnapshot(
        `[Error: local-storage:invalid-value: The value is not supported by session storage.]`
    );
});

it("Detects missing storage id", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const storageService = setup({
        storageId: undefined
    });
    expect(storageService.isSupported).toBe(true);
    expect(warnSpy).toMatchInlineSnapshot(`
      [MockFunction warn] {
        "calls": [
          [
            "[WARN] @open-pioneer/local-storage/SessionStorageServiceImpl: The 'storageId' property of the 'local-storage' package should be set to a valid string to avoid collisions with other applications. Defaulting to 'trails-state'.",
          ],
        ],
        "results": [
          {
            "type": "return",
            "value": undefined,
          },
        ],
      }
    `);
});

it("Flushes pending changes on destroy()", async () => {
    const storageService = setup();
    storageService.set("foo", "bar");

    // No timer advance: the debounced save is still pending.
    storageService.destroy();

    expect(JSON.parse(MOCKED_SESSION_STORAGE.get(DEFAULT_STORAGE_ID)!)).toEqual({ foo: "bar" });
});

describe("nested namespaces", () => {
    it("supports creating a nested namespace", async () => {
        const storageService = setup();
        const namespace = storageService.getNamespace("toc");
        namespace.set("foo", "bar");

        expect(getStorageData()).toMatchInlineSnapshot(`
          {
            "toc": {
              "foo": "bar",
            },
          }
        `);
    });
});

describe("independence from local storage", () => {
    it("writes to session storage even if local storage uses the same storage id", async () => {
        // Separate maps per storage area; same storage id on purpose.
        mockLocalStorage();

        const sessionService = createService(SessionStorageServiceImpl, {
            properties: { storageId: DEFAULT_STORAGE_ID }
        });
        const localService = createService(LocalStorageServiceImpl, {
            properties: { storageId: DEFAULT_STORAGE_ID }
        });

        sessionService.set("foo", "session-value");
        localService.set("foo", "local-value");
        vi.advanceTimersByTime(25);

        expect(JSON.parse(MOCKED_SESSION_STORAGE.get(DEFAULT_STORAGE_ID)!)).toEqual({
            foo: "session-value"
        });
        expect(JSON.parse(MOCKED_LOCAL_STORAGE.get(DEFAULT_STORAGE_ID)!)).toEqual({
            foo: "local-value"
        });
    });
});

function setup(options?: { storageId?: string }) {
    const storageId = options && "storageId" in options ? options.storageId : DEFAULT_STORAGE_ID;
    const storageService = createService(SessionStorageServiceImpl, {
        properties: {
            storageId
        }
    });
    return storageService;
}

function getStorageData() {
    // Wait for internal timeouts (debounced save)
    vi.advanceTimersByTime(25);

    const entry = MOCKED_SESSION_STORAGE.get(DEFAULT_STORAGE_ID);
    if (entry == null) {
        throw new Error("No data in session storage");
    }
    return JSON.parse(entry);
}

function mockSessionStorage() {
    const storage = window.sessionStorage;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) =>
        MOCKED_SESSION_STORAGE.set(key, value)
    );
    vi.spyOn(storage, "getItem").mockImplementation(
        (key) => MOCKED_SESSION_STORAGE.get(key) ?? null
    );

    vi.spyOn(storage, "removeItem").mockImplementation(notImplemented);
    vi.spyOn(storage, "clear").mockImplementation(notImplemented);
    vi.spyOn(storage, "length", "get").mockImplementation(notImplemented);
}

function mockLocalStorage() {
    const storage = window.localStorage;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) =>
        MOCKED_LOCAL_STORAGE.set(key, value)
    );
    vi.spyOn(storage, "getItem").mockImplementation((key) => MOCKED_LOCAL_STORAGE.get(key) ?? null);

    vi.spyOn(storage, "removeItem").mockImplementation(notImplemented);
    vi.spyOn(storage, "clear").mockImplementation(notImplemented);
    vi.spyOn(storage, "length", "get").mockImplementation(notImplemented);
}

function notImplemented(): never {
    throw new Error("not implemented");
}
