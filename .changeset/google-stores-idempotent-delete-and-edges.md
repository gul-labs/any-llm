---
'@gullabs/google': minor
---

Deleting a file or cache that Google no longer has is success, and cache and upload edges are fixed.

- `GoogleFileStore.delete` and `GoogleCacheStore.delete` treat HTTP 404, `NOT_FOUND` and the HTTP 403 whose message says the resource is not found or "may not exist" as already gone. Google answers an unknown or expired file id with that 403 (the wording is quoted from public bug reports and is not captured here; the `CachedContent not found` 403 is a live capture), and files expire after about 48 hours, so late deletes are routine. `failClosed: true` used to throw for them and fail-open logged them; `GoogleCacheStore.delete` had no not-found branch at all.
- `GoogleCacheStore.create` rejects a `ttlSeconds` that is not a positive integer before any call; an `expireTime` Google sends that does not parse falls back to now plus the TTL (an Invalid Date made every `getOrCreate` create a new, billed cache); `getOrCreate` drops an expired entry from its in-process map.
- `GoogleFileStore.upload` observes its abort promise from the start and removes its abort listener on every way out: a poll deadline that passed before the first wait, followed by a later abort of the caller's signal, was an unhandled rejection, which ends a Node process by default.

What hosts must change: nothing; delete-failure logs for already-gone resources stop.
