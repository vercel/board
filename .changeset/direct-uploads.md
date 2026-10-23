---
"vboard": minor
---

Files over 4 MB, up to 100 MB, upload straight to the board's blob store: `client.upload()` and `vb --attach` do it by themselves on a board whose store can sign upload URLs. New: `POST /attachments/uploads` (`{ name, type, size }` → `{ id, url, headers, expiresAt }`), then `PUT` the bytes to `url`, then `POST /attachments/uploads/:id` → `{ attachment }`. `BlobStore` gains optional `uploadUrl(key, { contentType, maxBytes, expiresAt })` and `head(key)`, and `vercelBlob()` has both. Other stores keep the 4 MB limit and answer 501 `no_direct_uploads`.
