---
'@gullabs/xai': patch
'@gullabs/google': patch
---

xAI no longer counts line breaks in an inline image's base64 against the 20 MiB ceiling, and the Gemini request-size check no longer allocates an encoded copy of every text part.

A line-wrapped (MIME) base64 image of about 19.5 MiB decoded was rejected as over 20 MiB because the adapter counted every character of the string. The size is now taken from the base64 characters only; an image that really is over the ceiling is still rejected, wrapped or not. In `@gullabs/google` the lower-bound request size counts UTF-8 bytes without building the encoded array (same number, no allocation).

What hosts must change: nothing.
