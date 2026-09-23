---
"@open-pioneer/local-storage": minor
---

Add a new `SessionStorageService`, which provides the same API as the existing `LocalStorageService`, but for [session storage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage) instead.
Reference the interface name `local-storage.SessionStorageService` to inject an instance of the service:

```js
// build.config.mjs
export default defineBuildConfig({
    services: {
        MyService: {
            references: {
                sessionStorage: "local-storage.SessionStorageService"
            }
        }
    }
});
```

Both services read the `storageId` package property and use that key in their respective storage area.
The storage API types have been renamed to storage-kind-neutral names: `StorageAPI`, `StorageNamespace`, `StorageProperties` and the new common interface `StorageService`. The previous names `LocalStorageAPI`, `LocalStorageNamespace` and `LocalStorageProperties` remain exported as deprecated aliases, so no changes are required in existing code.
