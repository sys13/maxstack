# File storage

Declared `file` fields, signed reads, and image derivatives — the `storage`
bundle. The generated catalog entry lives in
[`bundle-reference.md`](bundle-reference.md#storage--file-storage); this page is
the narrative half: what the design is and why it is shaped this way.

```sh
maxstack add storage
```

## A file field declares its own limits

```jsonc
{
  "id": "fld-post-cover",
  "name": "cover",
  "type": "file",
  "required": false,
  "file": {
    "accept": ["image/png", "image/jpeg"],
    "maxSizeBytes": 5242880,
    "derivatives": [{ "name": "thumb", "width": 320 }]
  }
}
```

`accept` and `maxSizeBytes` are **required**, and the op validator refuses a
`file` field without them. That is the central choice on this surface: uploads
are the classic remote-code-execution and storage-exhaustion vector, so "the
server enforces an allowlist and a cap" is a property of the *vocabulary* rather
than something each app remembers to wire. A field that would accept anything at
any size is unspellable — `data.addField` rejects it, and `applyOp` throws.

Limits are **per field**. A 200KB avatar and a 10MB attachment in the same app
get their own walls; there is no single app-wide default they both have to live
with. `POST /api/upload` looks the declaration up from the `resource` + `field`
in the request body — those name the declaration, they never supply it, so
nothing a client sends can widen a limit.

Also refused, all by the same validator: a bare `*` / `*&#47;*` allowlist, a cap
past the 100MB ceiling, a `file` block on a non-file field, a file field that is
also a reference, duplicate derivative names, and a derivative on an allowlist
that admits non-images.

## The column stores a key, never a URL

A `file` column is `text` holding a **storage key** — `<uuid>.png`. Not the
bytes, and specifically not a URL.

A signed URL written into a row is a value that stops working when it expires,
and the row has no way to know. A key is stable forever, and the read path signs
it fresh on every render (`resolveRowFiles` in the loader, handed to the UI as
the `files` prop and read by `<FileField>` / `<ImageField>`).

Keys are minted from the **validated content type**, never from the uploaded
filename:

| uploaded as | stored as |
| --- | --- |
| `avatar.png.php` | `ce0da469-…-d615530c134b.png` |
| `../../etc/passwd` | `<uuid>.png` |
| anything, type we have no entry for | `<uuid>` (no extension) |

The original filename is kept as a display name in the registry and never
touches the key, so double extensions, traversal segments and NULs are inert by
construction rather than by sanitization.

## Reads go through the app, for every driver

`GET /files/:key` is the read gateway. Local disk **and** S3 both serve through
it.

That is deliberate and it is the one place worth being pedantic. A presigned S3
URL is a bearer credential: the object store honors it for whoever holds it, so
handing one to a browser moves the authorization decision out of the app. Two
things follow from routing everything through the gateway instead:

1. **Authorization happens somewhere we control.** The token is an HMAC over
   `key + viewer + expiry`. The key is inside the MAC, so a guessed URL fails;
   the viewer is inside the MAC and re-derived from the *session* (never from
   the URL), so a link copied out of one person's page fails for everyone else.
2. **Dev and deploy behave the same on the security-relevant path.** No project
   works locally and then serves files differently once `S3_BUCKET` is set.

Minting a URL *is* the row-level decision: a gateway URL is only produced by a
loader that already read the owning row through the access-controlled read path.

**The residual window, stated plainly.** A token stays valid until it expires,
so a viewer who loses access to a row keeps a working link for at most 15
minutes. Closing that entirely would mean re-checking the row on every
byte-range request; the answer is a short TTL, not a pretence that the window
is not there.

## Derivatives

A declared derivative is materialized at upload and stored as `<key>@<name>.png`.
The resize itself is an injectable `ImageTransformer` port, because it needs an
image codec and Node has none:

```ts
bind('imageTransformer', createSharpImageTransformer())
```

`sharp` is an **optional dependency** — prebuilt binaries exist for macOS and
Linux on x64/arm64, and it is simply absent elsewhere. A project whose spec
declares derivatives with nothing bound fails at boot, naming the field
(`assertTransformerForDerivatives`), rather than silently never producing a
thumbnail. A `passthrough` transformer exists for tests and reports itself as
`passthrough` in the registry, so a fake variant is never mistaken for a real
one.

A derivative that fails to generate is logged and omitted — it never costs the
user their upload. The original is durable before any resize is attempted, and
the registry records exactly which variants exist, so a missing one is visible
in the data rather than assumed present.

## The registry, and orphans

Every upload writes a `file_object` row: key, validated content type, size,
display name, uploader, the resource/field it was for, and the derivatives that
were actually produced.

`findOrphanedObjects` compares it against the keys live rows reference and
returns a **report** — orphaned records with their keys and byte total, plus
`danglingReferences` (a column pointing at bytes with no record, the more
alarming direction). It has a one-hour grace period by default, because a file
uploaded before a form is submitted legitimately has nothing referencing it yet.

Nothing here deletes. A sweep that deleted on its own would be a background job
destroying user data on the strength of a query that might be wrong — a key
referenced from owned code it cannot see, a row mid-transaction. Cleanup is a
human's call, which is also why the bundle declares no uninstall.

## Driver parity

`testStorageProviderConformance` is one suite run by all three drivers — local
disk, S3, and the in-memory double. It covers put/read round-trips, `null` (not
a throw) for a missing key, overwrite, derivative keys, idempotent delete,
zero-byte and binary payloads, and re-signing.

Deliberate differences go in `ProviderQuirks` and nowhere else — today that is
S3's `bearerUrls` and the memory double's `syntheticUrls`. Adding a divergence
means writing it down at the call site, in the driver's own test file.

## Configuration

| Variable | Effect |
| --- | --- |
| `S3_BUCKET` | Selects the S3-compatible driver; unset means local disk under `<dataDir>/uploads` |
| `S3_REGION` / `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_FORCE_PATH_STYLE` | Standard S3-compatible connection settings (R2, MinIO, B2, …) |
| `STORAGE_SIGNING_SECRET` | Gateway token signing key. Set it in any real deployment — without it a random per-process secret is used, which invalidates outstanding links on restart |
